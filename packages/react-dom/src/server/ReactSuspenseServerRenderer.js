/**
 * Copyright (c) 2013-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {TypeOfWork} from 'shared/ReactTypeOfWork';

import {Readable} from 'stream';

import {
  REACT_ELEMENT_TYPE,
  REACT_FRAGMENT_TYPE,
  REACT_ASYNC_MODE_TYPE,
  REACT_STRICT_MODE_TYPE,
  REACT_PLACEHOLDER_TYPE,
} from 'shared/ReactSymbols';

import invariant from 'shared/invariant';
import {Namespaces, getIntrinsicNamespace} from '../shared/DOMNamespaces';
import omittedCloseTags from '../shared/omittedCloseTags';
import {createOpenTagMarkup} from './ReactPartialRenderer';
import {
  HostRoot,
  HostComponent,
  ClassComponent,
  FunctionalComponent,
  Fragment,
  HostText,
  PlaceholderComponent,
} from 'shared/ReactTypeOfWork';
import {
  StrictMode,
  AsyncMode,
} from '../../../react-reconciler/src/ReactTypeOfMode';

const isArray = Array.isArray;

type Stream = {
  openChunk(id: number): void,
  openChild(opening: string, closing: string): void,
  insertSlot(): void,
  closeChild(): void,
  closeChunk(): void,
  finish(): void,
};

type Status = 0 | 1 | 2 | 3;

const Pending = 0;
const PendingChildren = 1;
const Suspended = 2;
const Complete = 3;

type Boundary = {
  id: number,
  startTimeMs: number,
  child: Chunk | null,
  didFinish: boolean,
};

type Chunk = {
  tag: TypeOfWork,
  type: mixed,
  id: number,

  props: ReactNode,
  state: any,

  return: Chunk | null,

  children: Array<Chunk> | null,

  status: Status,

  stateNode: any,

  hasEffect: boolean,
  effects: Array<Chunk> | null,

  shouldRestart: boolean,

  timeoutMs: number,
  hostContext: string,
  legacyContext: Object | null,
};

const GLOBAL_TIMEOUT_MS = 5000;

const EMPTY_ID = 0;
const ROOT_BOUNDARY_ID = 1;

export function ReactHTMLStream(stream: Stream, rootNode: ReactNode) {
  // 0 is reserved for empty, and 1 is reserved for the root boundary ID,
  // so start at 2.
  let idCounter: number = 2;

  let currentTimeMs: number = Date.now();

  const rootChunk = createChunk(HostRoot);
  rootChunk.props = rootNode;
  rootChunk.hostContext = Namespaces.html;
  rootChunk.timeoutMs = GLOBAL_TIMEOUT_MS;

  const rootBoundary = createBoundary(rootChunk, currentTimeMs);
  rootBoundary.id = ROOT_BOUNDARY_ID;

  const pendingBoundaries: Set<Boundary> = new Set([rootBoundary]);

  renderBoundary(rootBoundary);

  function createUniqueId() {
    return idCounter++;
  }

  // function abort() {
  //   stream.closeChunk();
  // }

  function createBoundary(chunk, startTimeMs) {
    return {
      id: EMPTY_ID,
      startTimeMs,
      child: chunk,
    };
  }

  function createChunk(tag: TypeOfWork): Chunk {
    return {
      tag,
      type: null,
      id: EMPTY_ID,

      props: null,
      state: null,

      return: null,

      children: null,

      status: Pending,

      stateNode: null,

      hasEffect: false,
      effects: null,

      shouldRestart: false,

      timeoutMs: 0,
      hostContext: 'TODO',
      legacyContext: null,
    };
  }

  function cloneChunk(chunk: Chunk): Chunk {
    return {
      tag: chunk.tag,
      type: chunk.type,
      id: chunk.id,

      props: chunk.props,
      state: chunk.state,

      return: chunk.return,

      children: chunk.children,

      status: Pending,

      stateNode: chunk.stateNode,

      hasEffect: false,
      effects: null,

      shouldRestart: false,

      timeoutMs: 0,
      hostContext: 'TODO',
      legacyContext: chunk.legacyContext,
    };
  }

  function renderHostRoot(
    boundary,
    chunk,
    typeOfWork,
    type,
    props,
    state,
    hostContext,
    legacyContext,
  ) {
    const startTimeMs = boundary.startTimeMs;
    if (currentTimeMs - startTimeMs >= GLOBAL_TIMEOUT_MS) {
      return null;
    }
    return renderChild(
      boundary,
      chunk,
      props,
      state,
      hostContext,
      legacyContext,
    );
  }

  function shouldConstruct(Component) {
    return Component.prototype && Component.prototype.isReactComponent;
  }

  function renderFunctionalComponent(
    boundary,
    chunk,
    type,
    props,
    hostContext,
    legacyContext,
  ) {
    // TODO: Context
    const children = type(props, null);
    renderChild(boundary, chunk, children, null, hostContext, legacyContext);
  }

  function getStateFromUpdate(update, instance, prevState, props) {
    const partialState = update.partialState;
    if (typeof partialState === 'function') {
      return partialState.call(instance, prevState, props);
    } else {
      return partialState;
    }
  }

  function renderClassComponent(
    boundary,
    chunk,
    Component,
    props,
    instance,
    hostContext,
    legacyContext,
  ) {
    if (instance === null) {
      const updater = {
        queue: [],
        isMounted(publicInstance) {
          return false;
        },
        enqueueForceUpdate(publicInstance) {
          if (instance.updater !== updater) {
            // warnNoop(publicInstance, 'forceUpdate');
            return null;
          }
        },
        enqueueReplaceState(publicInstance, completeState) {
          if (instance.updater !== updater) {
            // warnNoop(publicInstance, 'setState');
            return null;
          }
          updater.queue.push({partialState: completeState, isReplace: true});
        },
        enqueueSetState(publicInstance, partialState) {
          if (instance.updater !== updater) {
            return null;
          }
          updater.queue.push({partialState, isReplace: false});
        },
      };
      instance = new Component(props, legacyContext, updater);
      if (instance.state === undefined) {
        instance.state = null;
      }
    }

    // Call getDerivedStateFromProps
    if (typeof Component.getDerivedStateFromProps === 'function') {
      const derivedState = Component.getDerivedStateFromProps.call(
        null,
        props,
        instance.state,
      );

      if (derivedState !== null && derivedState !== undefined) {
        instance.state = Object.assign({}, instance.state, derivedState);
      }
    } else if (
      typeof instance.UNSAFE_componentWillMount === 'function' ||
      typeof instance.componentWillMount === 'function'
    ) {
      if (typeof instance.componentWillMount === 'function') {
        // In order to support react-lifecycles-compat polyfilled components,
        // Unsafe lifecycles should not be invoked for any component with the new gDSFP.
        instance.componentWillMount();
      }
      if (typeof instance.UNSAFE_componentWillMount === 'function') {
        // In order to support react-lifecycles-compat polyfilled components,
        // Unsafe lifecycles should not be invoked for any component with the new gDSFP.
        instance.UNSAFE_componentWillMount();
      }
      // Process the update queue
      const queue = instance.updater.queue;
      if (queue.length > 0) {
        let state = instance.state;
        let dontMutatePrevState = true;
        for (let i = 0; i < queue.length; i++) {
          const update = queue[i];
          let partialState;
          if (update.isReplace) {
            state = getStateFromUpdate(update, instance, state, props);
            dontMutatePrevState = true;
          } else {
            partialState = getStateFromUpdate(update, instance, state, props);
            if (partialState) {
              if (dontMutatePrevState) {
                // $FlowFixMe: Idk how to type this properly.
                state = Object.assign({}, state, partialState);
              } else {
                state = Object.assign(state, partialState);
              }
              dontMutatePrevState = false;
            }
          }
        }
        queue.length = 0;
        instance.state = state;
      }
    }

    const children = instance.render();
    renderChild(boundary, chunk, children, null, hostContext, legacyContext);
  }

  function renderDOMNode(
    boundary,
    chunk,
    elementType,
    props,
    parentHostContext,
    legacyContext,
  ) {
    const tag = elementType.toLowerCase();

    const hostContext =
      parentHostContext === Namespaces.html
        ? getIntrinsicNamespace(tag)
        : parentHostContext;

    let opening = createOpenTagMarkup(
      elementType,
      tag,
      props,
      hostContext,
      true,
      false,
    );
    let closing = '';
    if (omittedCloseTags.hasOwnProperty(tag)) {
      opening += '/>';
    } else {
      opening += '>';
      closing = `</${elementType}>`;
    }
    stream.openChild(opening, closing);
    // TODO: Host context
    renderChild(
      boundary,
      chunk,
      props.children,
      null,
      hostContext,
      legacyContext,
    );
    stream.closeChild();
  }

  function renderText(text) {
    stream.openChild(text, null);
    stream.closeChild();
  }

  function renderArray(boundary, chunk, array, hostContext, legacyContext) {
    for (let i = 0; i < array.length; i++) {
      const childNode = array[i];
      renderChild(boundary, chunk, childNode, null, hostContext, legacyContext);
    }
  }

  function renderTimeout(boundary, chunk, props, hostContext, legacyContext) {
    const timeoutPropMs = props.ms;
    if (chunk.props !== props) {
      // Timeout components are split into their own chunks.
      // TODO: Is there a better way to check if we're at the top of the stack?
      const childChunk = createChunk(PlaceholderComponent);
      childChunk.return = chunk;
      const childChunkId = createUniqueId();
      childChunk.id = childChunkId;
      childChunk.props = props;
      // Indicates that we have not tried rendering this Timeout yet
      childChunk.state = false;

      // Create a boundary
      const timeoutBoundary = createBoundary(null, currentTimeMs);
      timeoutBoundary.id = createUniqueId();
      childChunk.stateNode = timeoutBoundary;

      const parentTimeoutMs = chunk.timeoutMs;
      childChunk.timeoutMs =
        typeof timeoutPropMs === 'number' && timeoutPropMs < parentTimeoutMs
          ? timeoutPropMs
          : parentTimeoutMs;

      stream.openBoundary(timeoutBoundary.id);
      stream.insertSlot(createUniqueId());
      stream.closeBoundary();

      // Add the chunk to the parent
      let children = chunk.children;
      if (children === null) {
        chunk.children = [childChunk];
      } else {
        children.push(childChunk);
      }
      return;
    }

    const render = props.children;
    const didTimeout = chunk.state;
    let children;
    if (typeof render === "function") {
      children = children(didTimeout);
    } else {
      children = didTimeout ? props.fallback : render;
    }
    renderChild(boundary, chunk, children, null, hostContext, legacyContext);
  }

  function retry(boundary, sourceChunk) {
    sourceChunk.status = Pending;
    renderBoundary(boundary);
  }

  function awaitAndRetryBoundary(promise, boundary, sourceChunk) {
    promise.then(() => {
      retry(boundary, sourceChunk);
    });
  }

  function throwException(
    boundary,
    sourceChunk,
    returnChunk,
    node,
    state,
    hostContext,
    legacyContext,
    value,
  ) {
    if (
      value !== null &&
      typeof value === 'object' &&
      typeof value.then === 'function'
    ) {
      // This is a thenable.
      const promise = value;
      const startTimeMs = boundary.startTimeMs;
      const elapsedTimeMs = currentTimeMs - startTimeMs;
      const timeoutMs = returnChunk.timeoutMs;
      const didTimeout = elapsedTimeMs >= timeoutMs;
      if (didTimeout) {
        let chunk = returnChunk;
        do {
          switch (chunk.tag) {
            case PlaceholderComponent: {
              const timeoutBoundary = chunk.stateNode;
              const didAlreadyTimeout = chunk.state;
              if (!didAlreadyTimeout) {
                if (timeoutBoundary.child === null) {
                  // Create a new chunk by cloning this one
                  const normalChild = cloneChunk(chunk);
                  normalChild.status = Pending;
                  // The new chunk is the root of a new boundary
                  normalChild.return = null;
                  timeoutBoundary.child = normalChild;

                  // The current chunk is now a placeholder. Resume rendering.
                  chunk.status = Pending;
                  chunk.state = true;
                  chunk.shouldRestart = true;
                }
                const effect = promise;
                if (chunk.effects === null) {
                  chunk.effects = [effect];
                } else {
                  chunk.effects.push(effect);
                }
                // Await the promise and retry the boundary
                awaitAndRetryBoundary(promise, timeoutBoundary, sourceChunk);
                return;
              } else {
                boundary.startTimeMs = currentTimeMs;
                // TODO: Await promise and retry this boundary
                return;
              }
            }
          }
          chunk = chunk.return;
        } while (chunk !== null);
        // TODO: The root expired, but no fallback was provided. This is
        // an error.
        throw new Error('Missing timeout');
      } else {
        promise.then(() => {
          retry(boundary, sourceChunk);
        });
        setTimeout(() => {
          retry(boundary, sourceChunk);
        }, timeoutMs);
      }
      return;
    }
    invariant(false, 'TODO: Not yet implemented.');
  }

  function renderChildOfTypeImpl(
    boundary,
    chunk,
    typeOfWork,
    type,
    props,
    state,
    hostContext,
    legacyContext,
  ) {
    switch (typeOfWork) {
      case HostRoot: {
        return renderHostRoot(
          boundary,
          chunk,
          typeOfWork,
          type,
          props,
          state,
          hostContext,
          legacyContext,
        );
      }
      case HostComponent: {
        return renderDOMNode(
          boundary,
          chunk,
          type,
          props,
          hostContext,
          legacyContext,
        );
      }
      case HostText:
        return renderText(props);
      case FunctionalComponent: {
        return renderFunctionalComponent(
          boundary,
          chunk,
          type,
          props,
          hostContext,
          legacyContext,
        );
      }
      case ClassComponent: {
        return renderClassComponent(
          boundary,
          chunk,
          type,
          props,
          state,
          hostContext,
          legacyContext,
        );
      }
      case Fragment:
      case StrictMode:
      case AsyncMode: {
        if (!Array.isArray(props)) {
          return renderChild(
            boundary,
            chunk,
            props,
            state,
            hostContext,
            legacyContext,
          );
        }
        return renderArray(boundary, chunk, props, hostContext, legacyContext);
      }
      case PlaceholderComponent: {
        return renderTimeout(
          boundary,
          chunk,
          props,
          hostContext,
          legacyContext,
        );
      }
      case null:
        // Treat as empty
        return;
    }
  }

  function renderChildOfType(
    boundary,
    chunk,
    typeOfWork,
    type,
    props,
    state,
    hostContext,
    legacyContext,
  ) {
    try {
      renderChildOfTypeImpl(
        boundary,
        chunk,
        typeOfWork,
        type,
        props,
        state,
        hostContext,
        legacyContext,
      );
    } catch (thrownValue) {
      let childChunk;
      if (chunk.props === props) {
        childChunk = chunk;
      } else {
        childChunk = createChunk(typeOfWork);
        childChunk.return = chunk;
        childChunk.type = type;
        childChunk.props = props;
        childChunk.timeoutMs = chunk.timeoutMs;
        stream.insertSlot(createUniqueId());

        // Add the chunk to the parent
        chunk.status = PendingChildren;
        let children = chunk.children;
        if (children === null) {
          chunk.children = [childChunk];
        } else {
          children.push(childChunk);
        }
        const childChunkId = createUniqueId();
        childChunk.id = childChunkId;
      }

      // TODO: Only if this is a thenable
      childChunk.status = Suspended;

      throwException(
        boundary,
        childChunk,
        childChunk.return,
        props,
        state,
        hostContext,
        legacyContext,
        thrownValue,
      );
    }
  }

  function renderChild(
    boundary,
    chunk,
    child,
    state,
    hostContext,
    legacyContext,
  ) {
    let typeOfWork;
    let type;
    let props;

    const isObject = typeof child === 'object' && child !== null;
    if (isObject) {
      switch (child.$$typeof) {
        case REACT_ELEMENT_TYPE: {
          type = child.type;
          switch (typeof type) {
            case 'string':
              typeOfWork = HostComponent;
              props = child.props;
              break;
            case 'function':
              if (shouldConstruct(type)) {
                typeOfWork = ClassComponent;
                props = child.props;
              } else {
                typeOfWork = FunctionalComponent;
                props = child.props;
              }
              break;
            default: {
              switch (type) {
                case REACT_FRAGMENT_TYPE:
                  typeOfWork = Fragment;
                  props = child.props.children;
                  break;
                case REACT_STRICT_MODE_TYPE:
                  typeOfWork = StrictMode;
                  props = child.props.children;
                  break;
                case REACT_ASYNC_MODE_TYPE: {
                  typeOfWork = AsyncMode;
                  props = child.props.children;
                  break;
                }
                case REACT_PLACEHOLDER_TYPE: {
                  typeOfWork = PlaceholderComponent;
                  props = child.props;
                  break;
                }
                default:
                  return null;
              }
            }
          }
          break;
        }
        default: {
          type = null;
          if (isArray(child)) {
            typeOfWork = Fragment;
            props = child;
            break;
          }
          return null;
        }
      }
    } else if (typeof child === 'string') {
      typeOfWork = HostText;
      type = null;
      props = child;
    } else if (typeof child === 'number') {
      typeOfWork = HostText;
      type = null;
      props = child + '';
    } else {
      // Treat everything else as empty.
      return null;
    }

    renderChildOfType(
      boundary,
      chunk,
      typeOfWork,
      type,
      props,
      state,
      hostContext,
      legacyContext,
    );
  }

  function renderChunk(boundary: Boundary, chunk: Chunk) {
    if (chunk.status === Pending) {
      const id = createUniqueId();
      chunk.id = id;
      chunk.children = null;
      stream.openChunk(id);
      renderChildOfType(
        boundary,
        chunk,
        chunk.tag,
        chunk.type,
        chunk.props,
        chunk.state,
        chunk.hostContext,
        chunk.legacyContext,
      );
      stream.closeChunk();
    }

    // Now work on the children, if they exist
    const children = chunk.children;
    if (children !== null) {
      let allChildrenDidComplete = true;
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.status !== Suspended) {
          renderChunk(boundary, child);
        }
        if (child.status !== Complete) {
          allChildrenDidComplete = false;
        }
      }
      if (chunk.shouldRestart) {
        renderChunk(boundary, chunk);
      } else {
        chunk.status = allChildrenDidComplete ? Complete : PendingChildren;
      }
    } else {
      chunk.status = Complete;
    }
  }

  function awaitAndStartBoundary(boundary, promise) {
    pendingBoundaries.add(boundary);
  }

  function commitChunk(chunk, chunkInfo) {
    const chunkChildren = chunk.children;
    if (chunkChildren !== null) {
      let chunkInfoChildren = chunkInfo[1];
      if (chunkInfoChildren === null) {
        chunkInfoChildren = chunkInfo[1] = [];
      }
      for (let i = 0; i < chunkChildren.length; i++) {
        const childChunk = chunkChildren[i];
        // Set the return pointer before starting on child.
        childChunk.return = chunk;
        const childChunkInfo = [childChunk.id, null];
        commitChunk(childChunk, childChunkInfo);
        chunkInfoChildren.push(childChunkInfo);
      }
    }
    const effects = chunk.effects;
    if (effects !== null) {
      for (let i = 0; i < effects.length; i++) {
        const promise = effects[i];
        const boundary = chunk.stateNode;
        awaitAndStartBoundary(boundary, promise);
      }
    }
  }

  function commitBoundary(boundary) {
    const chunk = boundary.child;
    const commitInfo = [chunk.id, null];
    commitChunk(chunk, commitInfo);
    stream.commit(boundary.id, commitInfo);
  }

  function renderBoundary(boundary: Boundary) {
    if (!pendingBoundaries.has(boundary)) {
      // Already committed
      return;
    }

    currentTimeMs = Date.now();
    const child = boundary.child;
    renderChunk(boundary, child);
    if (child.status === Complete) {
      commitBoundary(boundary);
      pendingBoundaries.delete(boundary);
      if (pendingBoundaries.size === 0) {
        stream.finish();
      }
    }
  }
}

const PREFIX = '_ssr';

const SLOT_PREFIX = PREFIX + '_s';
const BOUNDARY_PREFIX = PREFIX + '_b';

const STAGE = PREFIX + '_stage';

const BOUNDARY_MAP = PREFIX + '_boundaries';
const CHUNK_MAP = PREFIX + '_chunks';
const SLOT_MAP = PREFIX + '_slots';

const INIT = PREFIX + '_init';
const CREATE_COMMENT = PREFIX + '_createComment';
const GET_BY_ID = PREFIX + '_get';
const PROCESS_CHUNK = PREFIX + '_process';
const COMMIT = PREFIX + '_commit';
const FINISH = PREFIX + '_finish';

// TODO: Extract this to separate file and minify it
const runtime = `<script>
${GET_BY_ID} = document.getElementById.bind(document);
${STAGE} = ${GET_BY_ID}('${STAGE}');
${CHUNK_MAP} = {};
${SLOT_MAP} = {};
${BOUNDARY_MAP} = {};
${CREATE_COMMENT} = function () {
  return document.createComment('');
};
${PROCESS_CHUNK} = function (id, slotIds, boundaryIds, innerHTML) {
  var container = document.createElement('div');
  container.innerHTML = innerHTML;
  ${STAGE}.appendChild(container)
  for (var i = 0; i < slotIds.length; i++) {
    var slotId = slotIds[i];
    var slot = ${GET_BY_ID}('${SLOT_PREFIX}' + slotId);
    ${SLOT_MAP}[slotId] = slot;
  }
  for (var i = 0; i < boundaryIds.length; i++) {
    var boundaryId = boundaryIds[i];
    var start = ${GET_BY_ID}('${BOUNDARY_PREFIX}' + boundaryId + 'start');
    var parent = start.parentNode;
    var startComment = ${CREATE_COMMENT}();
    parent.insertBefore(startComment, start);
    parent.removeChild(start);  
    
    var end = ${GET_BY_ID}('${BOUNDARY_PREFIX}' + boundaryId + 'end');
    var parent = end.parentNode;
    var endComment = ${CREATE_COMMENT}();
    parent.insertBefore(endComment, end);
    parent.removeChild(end);
    
    ${BOUNDARY_MAP}[boundaryId] = {
      start: startComment,
      end: endComment,
    };
  }
  var fragment = document.createDocumentFragment();
  while (container.firstChild !== null) {
    fragment.appendChild(container.firstChild);
  }
  ${CHUNK_MAP}[id] = {
    fragment: fragment,
    slotIds: slotIds
  };
  ${STAGE}.removeChild(container);
};
${COMMIT} = function (boundaryId, rootInfo) {
  function commit(info, slot) {
    var chunk = ${CHUNK_MAP}[info[0]];
    slot.parentNode.insertBefore(chunk.fragment, slot);
    slot.parentNode.removeChild(slot);
    var children = info[1];
    if (children !== null) {
      var slotIds = chunk.slotIds;
      for (var i = 0; i < children.length; i++) {
        var childSlot = ${SLOT_MAP}[slotIds[i]];
        commit(children[i], childSlot);
      }
    }
  }

  var boundary = ${BOUNDARY_MAP}[boundaryId];
  var start = boundary.start;
  var end = boundary.end;
  var parent = start.parentNode;
  while (start.nextSibling !== end) {
    parent.removeChild(start.nextSibling);
  }
  var stage = ${STAGE};
  var boundarySlot = document.createElement('span');
  parent.insertBefore(boundarySlot, end);
  commit(rootInfo, boundarySlot);
}
${FINISH} = function () {
  var stage = ${STAGE};  
  stage.parentNode.removeChild(stage);
}
${INIT} = function() {
  var stage = ${STAGE};  
  var parent = stage.parentNode;
  var rootStart = ${CREATE_COMMENT}();
  var rootEnd = ${CREATE_COMMENT}();
  parent.insertBefore(rootStart, stage);
  parent.insertBefore(rootEnd, stage);
  ${BOUNDARY_MAP}[${ROOT_BOUNDARY_ID}] = {
    start: rootStart,
    end: rootEnd,
  };
}
${INIT}();
</script>`;

export function renderToNodeStream(children) {
  class ReadableImpl extends Readable {
    _read() {}
  }

  const nodeStream = new ReadableImpl();

  let currentBoundaryId = 0;
  let currentChunkId = 0;
  let boundaryIds = [];
  let closingTags = [];
  let slotIds = [];
  let didFinish = false;

  let bufferedChunk = '';

  const stream = {
    openBoundary(boundaryId) {
      currentBoundaryId = boundaryId;
      bufferedChunk += `<span id="${BOUNDARY_PREFIX +
        boundaryId}start"></span>`;
    },
    openChunk(id) {
      currentChunkId = id;
    },
    openChild(opening, closing) {
      bufferedChunk += opening;
      closingTags.push(closing);
    },
    insertSlot(slotId) {
      slotIds.push(slotId);
      bufferedChunk += `<div id="${SLOT_PREFIX + slotId}"></div>`;
    },
    closeChild() {
      const closingTag = closingTags.pop();
      if (closingTag !== null) {
        bufferedChunk += closingTag;
      }
    },
    closeChunk() {
      const html = bufferedChunk;
      bufferedChunk = '';
      nodeStream.push(
        `<script>window.${PROCESS_CHUNK}('${currentChunkId}', ${JSON.stringify(
          slotIds,
        )}, ${JSON.stringify(boundaryIds)}, ${JSON.stringify(html)})</script>`,
      );
      currentChunkId = 0;
      slotIds = [];
      boundaryIds = [];
    },
    closeBoundary() {
      const boundaryId = currentBoundaryId;
      currentBoundaryId = 0;
      bufferedChunk += `<span id="${BOUNDARY_PREFIX + boundaryId}end"></span>`;
      boundaryIds.push(boundaryId);
    },
    commit(boundaryId, commitLog) {
      nodeStream.push(
        `<script>window.${COMMIT}(${boundaryId}, ${JSON.stringify(
          commitLog,
        )})</script>`,
      );
    },
    finish() {
      if (didFinish) {
        return;
      }
      didFinish = true;
      nodeStream.push(`<script>window.${FINISH}()</script>`);
      nodeStream.push(`</div>`);
      nodeStream.push(null);
    },
  };

  nodeStream.push(`<div id="${STAGE}">`);
  nodeStream.push(runtime);
  ReactHTMLStream(stream, children);
  return nodeStream;
}
