/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
'use strict';

const fs = require('fs');
const invertObject = require('./invertObject');

const {
  evalStringConcat,
  evalStringAndTemplateConcat,
} = require('../shared/evalStringConcat');

module.exports = function(babel) {
  const t = babel.types;

  const DEV_EXPRESSION = t.identifier('__DEV__');

  const SEEN_SYMBOL = Symbol('minify-error-messages.seen');

  return {
    visitor: {
      CallExpression(path, file) {
        const node = path.node;
        if (path.get('callee').isIdentifier({name: 'invariant'})) {
          // Turns this code:
          //
          // invariant(condition, 'A %s message that contains %s`, adj, noun);
          //
          // into this:
          //
          // if (!condition) {
          //   if (__DEV__) {
          //     throw ReactError(`A ${adj} message that contains ${noun}`);
          //   } else {
          //     throw ReactProdError(ERR_CODE, [adj, noun]);
          //   }
          // }
          //
          // where ERR_CODE is an error code: a unique identifier (a number
          // string) that references a verbose error message. The mapping is
          // stored in `scripts/error-codes/codes.json`.
          const condition = node.arguments[0];
          const errorMsgLiteral = evalStringConcat(node.arguments[1]);
          const errorMsgExpressions = Array.from(node.arguments.slice(2));
          const errorMsgQuasis = errorMsgLiteral
            .split('%s')
            .map(raw => t.templateElement({raw, cooked: String.raw({raw})}));

          // Import ReactError
          const reactErrorIdentfier = file.addImport(
            'shared/ReactError',
            'default',
            'ReactError'
          );

          // Outputs:
          //   throw ReactError(`A ${adj} message that contains ${noun}`);
          const devThrow = t.throwStatement(
            t.callExpression(reactErrorIdentfier, [
              t.templateLiteral(errorMsgQuasis, errorMsgExpressions),
            ])
          );

          // Avoid caching because we write it as we go.
          const existingErrorMap = JSON.parse(
            fs.readFileSync(__dirname + '/codes.json', 'utf-8')
          );
          const errorMap = invertObject(existingErrorMap);

          const prodErrorId = errorMap[errorMsgLiteral];
          if (prodErrorId === undefined) {
            // There is no error code for this message. We use a lint rule to
            // enforce that messages can be minified, so assume this is
            // intentional and exit gracefully.
            //
            // Outputs:
            //   if (!condition) {
            //     throw ReactError(`A ${adj} message that contains ${noun}`);
            //   }
            path.replaceWith(
              t.ifStatement(
                t.unaryExpression('!', condition),
                t.blockStatement([devThrow])
              )
            );
            return;
          }

          // Import ReactErrorProd
          const reactErrorProdIdentfier = file.addImport(
            'shared/ReactErrorProd',
            'default',
            'ReactErrorProd'
          );

          // Outputs:
          //   throw ReactProdError(ERR_CODE, [adj, noun]);
          const prodThrow = t.throwStatement(
            t.callExpression(
              reactErrorProdIdentfier,
              [
                t.stringLiteral(prodErrorId),
                errorMsgExpressions.length > 0
                  ? t.arrayExpression(errorMsgExpressions)
                  : undefined,
              ].filter(arg => arg !== undefined)
            )
          );

          // Outputs:
          //   if (!condition) {
          //     if (__DEV__) {
          //       throw ReactError(`A ${adj} message that contains ${noun}`);
          //     } else {
          //       throw ReactProdError(ERR_CODE, [adj, noun]);
          //     }
          //   }
          path.replaceWith(
            t.ifStatement(
              t.unaryExpression('!', condition),
              t.blockStatement([
                t.ifStatement(
                  DEV_EXPRESSION,
                  t.blockStatement([devThrow]),
                  t.blockStatement([prodThrow])
                ),
              ])
            )
          );
        }
      },
      NewExpression(path, file) {
        // Similar to previous visitor but for error constructors.
        //
        // Turns this code:
        //
        // new Error(`A ${adj} message that contains ${noun}`);
        //
        // into this:
        // __DEV__
        //   ? ReactError(`A ${adj} message that contains ${noun}`)
        //   : ReactProdError(ERR_CODE, [adj, noun]);
        const node = path.node;
        if (node[SEEN_SYMBOL]) {
          return;
        }
        node[SEEN_SYMBOL] = true;

        if (node.callee.name !== 'Error') {
          return;
        }

        const errorMsgNode = node.arguments[0];
        if (errorMsgNode === undefined) {
          // TODO: Throw?
          return;
        }

        const errorMsgExpressions = [];
        let errorMsgLiteral;
        try {
          errorMsgLiteral = evalStringAndTemplateConcat(
            errorMsgNode,
            errorMsgExpressions
          );
        } catch (error) {
          // We use a lint rule to enforce that error messages are written in
          // a format that can be minified. If they aren't, assume this is
          // intentional and skip over it gracefully.
          // TODO: Write this lint rule.
          return;
        }

        // Import ReactError
        const reactErrorIdentfier = file.addImport(
          'shared/ReactError',
          'default',
          'ReactError'
        );

        // Outputs:
        //   ReactError(`A ${adj} message that contains ${noun}`);
        const devCallExpression = t.callExpression(reactErrorIdentfier, [
          errorMsgNode,
        ]);

        // Avoid caching because we write it as we go.
        const existingErrorMap = JSON.parse(
          fs.readFileSync(__dirname + '/codes.json', 'utf-8')
        );
        const errorMap = invertObject(existingErrorMap);

        const prodErrorId = errorMap[errorMsgLiteral];
        if (prodErrorId === undefined) {
          // There is no error code for this message. We use a lint rule to
          // enforce that messages can be minified, so assume this is
          // intentional and exit gracefully.
          // TODO: Write this lint rule.
          //
          // Outputs:
          //   ReactError(`A ${adj} message that contains ${noun}`);
          path.replaceWith(devCallExpression);
          return;
        }

        // Import ReactErrorProd
        const reactErrorProdIdentfier = file.addImport(
          'shared/ReactErrorProd',
          'default',
          'ReactErrorProd'
        );

        // Outputs:
        //   ReactProdError(ERR_CODE, [adj, noun]);
        const prodCallExpression = t.callExpression(
          reactErrorProdIdentfier,
          [
            t.stringLiteral(prodErrorId),
            errorMsgExpressions.length > 0
              ? t.arrayExpression(errorMsgExpressions)
              : undefined,
          ].filter(arg => arg !== undefined)
        );
        // Outputs:
        //   __DEV__
        //     ? ReactError(`A ${adj} message that contains ${noun}`)
        //     : ReactProdError(ERR_CODE, [adj, noun]);
        path.replaceWith(
          t.conditionalExpression(
            DEV_EXPRESSION,
            devCallExpression,
            prodCallExpression
          )
        );
      },
    },
  };
};
