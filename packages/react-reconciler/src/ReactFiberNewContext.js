/**
 * Copyright (c) 2013-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Fiber} from './ReactFiber';
import type {ReactContext} from 'shared/ReactTypes';

import warning from 'fbjs/lib/warning';

let stack: Array<Fiber> = [];
let index = -1;

export function pushProvider(providerFiber: Fiber): void {
  index += 1;
  stack[index] = providerFiber;
  const context: ReactContext<any> = providerFiber.type.context;
  context.currentProvider = providerFiber;
}

export function popProvider(providerFiber: Fiber): void {
  if (__DEV__) {
    warning(index > -1 && providerFiber === stack[index], 'Unexpected pop.');
  }
  stack[index] = null;
  index -= 1;
  const context: ReactContext<any> = providerFiber.type.context;
  if (index < 0) {
    context.currentProvider = null;
  } else {
    const previousProviderFiber = stack[index];
    context.currentProvider = previousProviderFiber;
  }
}

export function resetProviderStack(): void {
  for (let i = index; i > -1; i--) {
    const providerFiber = stack[i];
    const context: ReactContext<any> = providerFiber.type.context;
    context.currentProvider = null;
    stack[i] = null;
  }
}
