let React;
let Fragment;
let ReactNoop;
let AsyncBoundary;
let Timeout;

let textCache;
let pendingTextCache;

describe('ReactBlocking', () => {
  beforeEach(() => {
    jest.resetModules();
    React = require('react');
    Fragment = React.Fragment;
    ReactNoop = require('react-noop-renderer');
    AsyncBoundary = React.AsyncBoundary;
    Timeout = React.Timeout;

    textCache = new Set();
    pendingTextCache = new Map();
  });

  // Throws the first time a string is requested. After the specified
  // duration, subsequent calls will return the text synchronously.
  function readText(text, ms = 0) {
    if (textCache.has(text)) {
      return text;
    }
    if (pendingTextCache.has(text)) {
      throw pendingTextCache.get(text);
    }
    const promise = new Promise(resolve =>
      setTimeout(() => {
        ReactNoop.yield(`Promise resolved [${text}]`);
        textCache.add(text);
        pendingTextCache.delete(text);
        resolve(text);
      }, ms),
    );
    pendingTextCache.set(text, promise);
    throw promise;
  }

  function advanceTimers(ms) {
    // Note: This advances Jest's virtual time but not React's. Use
    // ReactNoop.expire for that.
    if (ms === undefined) {
      jest.runAllTimers();
    } else {
      jest.advanceTimersByTime(ms);
    }
    // Wait until the end of the current tick
    return new Promise(resolve => {
      setImmediate(resolve);
    });
  }

  function div(...children) {
    children = children.map(c => (typeof c === 'string' ? {text: c} : c));
    return {type: 'div', children, prop: undefined};
  }

  function span(prop) {
    return {type: 'span', children: [], prop};
  }

  function Text(props) {
    ReactNoop.yield(props.text);
    return <span prop={props.text} />;
  }

  function AsyncText(props) {
    const text = props.text;
    try {
      readText(text, props.ms);
    } catch (promise) {
      ReactNoop.yield(`Blocked! [${text}]`);
      throw promise;
    }
    ReactNoop.yield(text);
    return <span prop={text} />;
  }

  function Fallback(props) {
    return (
      <Timeout ms={props.timeout}>
        {didExpire => (didExpire ? props.placeholder : props.children)}
      </Timeout>
    );
  }
  it('blocks rendering and continues later', async () => {
    function Bar(props) {
      ReactNoop.yield('Bar');
      return props.children;
    }

    function Foo() {
      ReactNoop.yield('Foo');
      return (
        <Bar>
          <AsyncText text="A" ms={100} />
          <Text text="B" />
        </Bar>
      );
    }

    ReactNoop.render(<Foo />);
    expect(ReactNoop.flush()).toEqual([
      'Foo',
      'Bar',
      // A blocks
      'Blocked! [A]',
      // But we keep rendering the siblings
      'B',
    ]);
    expect(ReactNoop.getChildren()).toEqual([]);

    // Flush some of the time
    await advanceTimers(50);
    // Still nothing...
    expect(ReactNoop.flush()).toEqual([]);
    expect(ReactNoop.getChildren()).toEqual([]);

    // Flush the promise completely
    await advanceTimers();
    // Renders successfully
    expect(ReactNoop.flush()).toEqual([
      'Promise resolved [A]',
      'Foo',
      'Bar',
      'A',
      'B',
    ]);
    expect(ReactNoop.getChildren()).toEqual([span('A'), span('B')]);
  });

  it('continues rendering siblings after a block', async () => {
    ReactNoop.render(
      <Fragment>
        <Text text="A" />
        <AsyncText text="B" />
        <Text text="C" />
        <Text text="D" />
      </Fragment>,
    );
    // B blocks. Continue rendering the remaining siblings.
    expect(ReactNoop.flush()).toEqual(['A', 'Blocked! [B]', 'C', 'D']);
    // Did not commit yet.
    expect(ReactNoop.getChildren()).toEqual([]);

    // Wait for data to resolve
    await advanceTimers();
    // Renders successfully
    expect(ReactNoop.flush()).toEqual([
      'Promise resolved [B]',
      'A',
      'B',
      'C',
      'D',
    ]);
    expect(ReactNoop.getChildren()).toEqual([
      span('A'),
      span('B'),
      span('C'),
      span('D'),
    ]);
  });

  it('can render an alternate view at a higher priority', async () => {
    function App(props) {
      return (
        <AsyncBoundary>
          {isLoading => (
            <Fragment>
              {isLoading ? <Text text="Loading..." /> : null}
              <Text text="A" />
              <Text text="B" />
              <Text text="C" />
              {props.step >= 1 ? <AsyncText text="D" /> : null}
            </Fragment>
          )}
        </AsyncBoundary>
      );
    }

    ReactNoop.render(<App step={0} />);
    expect(ReactNoop.flush()).toEqual(['A', 'B', 'C']);
    expect(ReactNoop.getChildren()).toEqual([span('A'), span('B'), span('C')]);

    ReactNoop.render(<App step={1} />);
    expect(ReactNoop.flush()).toEqual([
      'A',
      'B',
      'C',
      // D blocks, which triggers the loading state.
      'Blocked! [D]',
      'Loading...',
      'A',
      'B',
      'C',
    ]);
    expect(ReactNoop.getChildren()).toEqual([
      span('Loading...'),
      span('A'),
      span('B'),
      span('C'),
    ]);

    // Wait for data to resolve
    await advanceTimers();
    expect(ReactNoop.flush()).toEqual([
      'Promise resolved [D]',
      'A',
      'B',
      'C',
      'D',
    ]);
    expect(ReactNoop.getChildren()).toEqual([
      span('A'),
      span('B'),
      span('C'),
      span('D'),
    ]);
  });

  it('can block inside a boundary', async () => {
    function App(props) {
      return (
        <AsyncBoundary defaultState={false} updateOnBlock={() => true}>
          {isLoading => {
            if (isLoading) {
              return <AsyncText text="Loading..." ms={50} />;
            }
            return props.step > 0 ? (
              <AsyncText text="Final result" ms={100} />
            ) : (
              <Text text="Initial text" />
            );
          }}
        </AsyncBoundary>
      );
    }

    // Initial mount
    ReactNoop.render(<App step={0} />);
    expect(ReactNoop.flush()).toEqual(['Initial text']);
    expect(ReactNoop.getChildren()).toEqual([span('Initial text')]);

    ReactNoop.render(<App step={1} />);
    expect(ReactNoop.flush()).toEqual([
      'Blocked! [Final result]',
      'Blocked! [Loading...]',
    ]);
    expect(ReactNoop.getChildren()).toEqual([span('Initial text')]);

    // Unblock the "Loading..." view
    await advanceTimers(50);

    expect(ReactNoop.flush()).toEqual([
      // Renders the loading view,
      'Promise resolved [Loading...]',
      'Loading...',
    ]);
    expect(ReactNoop.getChildren()).toEqual([span('Loading...')]);

    // Unblock the rest.
    await advanceTimers();

    // Now we can render the final result.
    expect(ReactNoop.flush()).toEqual([
      'Promise resolved [Final result]',
      'Final result',
    ]);
    expect(ReactNoop.getChildren()).toEqual([span('Final result')]);
  });

  it('nested boundaries do not capture if an outer boundary is blocked', async () => {
    function App(props) {
      return (
        <AsyncBoundary>
          {() => (
            <AsyncBoundary>
              {() =>
                props.text ? (
                  <AsyncText text={props.text} />
                ) : (
                  <Text text="Initial text" />
                )
              }
            </AsyncBoundary>
          )}
        </AsyncBoundary>
      );
    }
    ReactNoop.render(<App />);
    expect(ReactNoop.flush()).toEqual(['Initial text']);
    expect(ReactNoop.getChildren()).toEqual([span('Initial text')]);

    ReactNoop.render(<App text="A" />);
    expect(ReactNoop.flush()).toEqual(['Blocked! [A]', 'Initial text']);
    expect(ReactNoop.getChildren()).toEqual([span('Initial text')]);

    // Move B into a later expiration bucket
    ReactNoop.expire(2000);
    ReactNoop.render(<App text="B" />);
    expect(ReactNoop.flush()).toEqual([
      // B is blocked
      'Blocked! [B]',
      // It doesn't bother trying to render a loading state because it
      // would be based on A, which we already know is blocked.
    ]);
    expect(ReactNoop.getChildren()).toEqual([span('Initial text')]);

    // Unblock
    await advanceTimers();
    expect(ReactNoop.flush()).toEqual([
      'Promise resolved [A]',
      'Promise resolved [B]',
      'B',
    ]);
    expect(ReactNoop.getChildren()).toEqual([span('B')]);
  });

  it('can block, unblock, then block again in a later update, with correct bubbling', async () => {
    function App(props) {
      return (
        <AsyncBoundary>
          {isLoading => (
            <Fragment>
              {isLoading ? <Text text="Loading..." /> : null}
              <AsyncText text={props.text} />
            </Fragment>
          )}
        </AsyncBoundary>
      );
    }

    ReactNoop.render(<App text="Initial text" />);
    ReactNoop.flush();
    await advanceTimers();
    ReactNoop.flush();
    expect(ReactNoop.getChildren()).toEqual([span('Initial text')]);

    ReactNoop.render(<App text="Update" />);
    ReactNoop.flush();
    expect(ReactNoop.getChildren()).toEqual([
      span('Loading...'),
      span('Initial text'),
    ]);
    await advanceTimers();
    ReactNoop.flush();
    expect(ReactNoop.getChildren()).toEqual([span('Update')]);

    ReactNoop.render(<App text="Another update" />);
    ReactNoop.flush();
    expect(ReactNoop.getChildren()).toEqual([
      span('Loading...'),
      span('Update'),
    ]);
    await advanceTimers();
    ReactNoop.flush();
    expect(ReactNoop.getChildren()).toEqual([span('Another update')]);
  });

  it('bubbles to next boundary if it blocks', async () => {
    function App(props) {
      return (
        <AsyncBoundary>
          {isLoadingOuter => (
            <Fragment>
              {isLoadingOuter ? <Text text="Loading (outer)..." /> : null}
              <AsyncBoundary>
                {isLoadingInner => (
                  <div>
                    {isLoadingInner ? (
                      <AsyncText text="Loading (inner)..." ms={100} />
                    ) : null}
                    {props.step > 0 ? (
                      <AsyncText text="Final result" ms={200} />
                    ) : (
                      <Text text="Initial text" />
                    )}
                  </div>
                )}
              </AsyncBoundary>
            </Fragment>
          )}
        </AsyncBoundary>
      );
    }

    ReactNoop.render(<App step={0} />);
    ReactNoop.flush();
    expect(ReactNoop.getChildren()).toEqual([div(span('Initial text'))]);

    // Update to display "Final result"
    ReactNoop.render(<App step={1} />);
    expect(ReactNoop.flush()).toEqual([
      // "Final result" blocks.
      'Blocked! [Final result]',
      // The inner boundary renders a loading view. The loading view also blocks.
      'Blocked! [Loading (inner)...]',
      // (Continues rendering siblings even though something blocked)
      'Initial text',
      // Bubble up and retry at the next boundary. This time it's successful.
      'Loading (outer)...',
      'Initial text',
    ]);
    expect(ReactNoop.getChildren()).toEqual([
      span('Loading (outer)...'),
      div(span('Initial text')),
    ]);

    // Unblock the inner boundary.
    await advanceTimers(100);
    expect(ReactNoop.flush()).toEqual([
      'Promise resolved [Loading (inner)...]',
      // Now the inner loading view should display, not the outer one.
      'Loading (inner)...',
      'Initial text',
    ]);
    expect(ReactNoop.getChildren()).toEqual([
      div(span('Loading (inner)...'), span('Initial text')),
    ]);

    // Flush all the promises.
    await advanceTimers();

    // Now the final result should display, with no loading state.
    expect(ReactNoop.flush()).toEqual([
      'Promise resolved [Final result]',
      'Final result',
    ]);
    expect(ReactNoop.getChildren()).toEqual([div(span('Final result'))]);
  });

  it('does not bubble through a boundary unless that boundary already captured', () => {
    function App(props) {
      return (
        <AsyncBoundary>
          {isLoading => (
            <Fragment>
              <AsyncBoundary>
                {spinnerIsLoading => (
                  <Fragment>
                    {spinnerIsLoading && <Text text="(fallback spinner)" />}
                    {isLoading && <AsyncText text="(spinner)" />}
                  </Fragment>
                )}
              </AsyncBoundary>
              <Text text="Initial text" />
              {props.step > 0 && <AsyncText text="More" />}
            </Fragment>
          )}
        </AsyncBoundary>
      );
    }

    ReactNoop.render(<App step={0} />);
    expect(ReactNoop.flush()).toEqual(['Initial text']);
    expect(ReactNoop.getChildren()).toEqual([span('Initial text')]);

    ReactNoop.render(<App step={1} />);
    expect(ReactNoop.flush()).toEqual([
      'Initial text',
      'Blocked! [More]',
      'Blocked! [(spinner)]',
      'Initial text',
      '(fallback spinner)',
    ]);
  });

  it('can unblock with a lower priority update', () => {
    function App(props) {
      return (
        <AsyncBoundary>
          {isLoading => (
            <Fragment>
              {isLoading ? <Text text="Loading..." /> : null}
              {props.showContent ? (
                <AsyncText text="Content" />
              ) : (
                <Text text="(empty)" />
              )}
            </Fragment>
          )}
        </AsyncBoundary>
      );
    }

    // Mount the initial view
    ReactNoop.render(<App showContent={false} />);
    expect(ReactNoop.flush()).toEqual(['(empty)']);
    expect(ReactNoop.getChildren()).toEqual([span('(empty)')]);

    // Toggle to show the content, which is async
    ReactNoop.render(<App showContent={true} />);
    expect(ReactNoop.flush()).toEqual([
      // The content blocks because it's async
      'Blocked! [Content]',
      // Show the loading view
      'Loading...',
      '(empty)',
    ]);
  });

  it('can update at a higher priority while in a blocked state', async () => {
    function App(props) {
      return (
        <Fragment>
          <Text text={props.highPri} />
          <AsyncText text={props.lowPri} />
        </Fragment>
      );
    }

    // Initial mount
    ReactNoop.render(<App highPri="A" lowPri="1" />);
    ReactNoop.flush();
    await advanceTimers();
    ReactNoop.flush();
    expect(ReactNoop.getChildren()).toEqual([span('A'), span('1')]);

    // Update the low-pri text
    ReactNoop.render(<App highPri="A" lowPri="2" />);
    expect(ReactNoop.flush()).toEqual([
      'A',
      // Blocks
      'Blocked! [2]',
    ]);

    // While we're still waiting for the low-pri update to complete, update the
    // high-pri text at high priority.
    ReactNoop.flushSync(() => {
      ReactNoop.render(<App highPri="B" lowPri="1" />);
    });
    expect(ReactNoop.flush()).toEqual(['B', '1']);
    expect(ReactNoop.getChildren()).toEqual([span('B'), span('1')]);

    // Unblock the low-pri text and finish
    await advanceTimers();
    expect(ReactNoop.flush()).toEqual(['Promise resolved [2]']);
    expect(ReactNoop.getChildren()).toEqual([span('B'), span('1')]);
  });

  it('keeps working on lower priority work after being unblocked', async () => {
    function App(props) {
      return (
        <Fragment>
          <AsyncText text="A" />
          {props.showB && <Text text="B" />}
        </Fragment>
      );
    }

    ReactNoop.render(<App showB={false} />);
    expect(ReactNoop.flush()).toEqual(['Blocked! [A]']);
    expect(ReactNoop.getChildren()).toEqual([]);

    // Advance React's virtual time by enough to fall into a new async bucket.
    ReactNoop.expire(1200);
    ReactNoop.render(<App showB={true} />);
    expect(ReactNoop.flush()).toEqual(['Blocked! [A]', 'B']);
    expect(ReactNoop.getChildren()).toEqual([]);

    await advanceTimers();
    expect(ReactNoop.flush()).toEqual(['Promise resolved [A]', 'A', 'B']);
    expect(ReactNoop.getChildren()).toEqual([span('A'), span('B')]);
  });

  it('coalesces all async updates when in a blocked state', async () => {
    ReactNoop.render(<AsyncText text="A" />);
    ReactNoop.flush();
    await advanceTimers();
    ReactNoop.flush();
    expect(ReactNoop.getChildren()).toEqual([span('A')]);

    ReactNoop.render(<AsyncText text="B" ms={50} />);
    expect(ReactNoop.flush()).toEqual(['Blocked! [B]']);
    expect(ReactNoop.getChildren()).toEqual([span('A')]);

    // Advance React's virtual time so that C falls into a new expiration bucket
    ReactNoop.expire(1000);
    ReactNoop.render(<AsyncText text="C" ms={100} />);
    expect(ReactNoop.flush()).toEqual([
      // Tries C first, since it has a later expiration time
      'Blocked! [C]',
      // Does not retry B, because its promise has not resolved yet.
    ]);

    expect(ReactNoop.getChildren()).toEqual([span('A')]);

    // Unblock B
    await advanceTimers(90);
    // Even though B's promise resolved, the view is still blocked because it
    // coalesced with C.
    expect(ReactNoop.flush()).toEqual(['Promise resolved [B]']);
    expect(ReactNoop.getChildren()).toEqual([span('A')]);

    // Unblock C
    await advanceTimers(50);
    expect(ReactNoop.flush()).toEqual(['Promise resolved [C]', 'C']);
    expect(ReactNoop.getChildren()).toEqual([span('C')]);
  });

  it('forces an expiration after an update times out', async () => {
    ReactNoop.render(
      <Fragment>
        <Fallback placeholder={<Text text="Loading..." />}>
          <AsyncText text="Async" ms={20000} />
        </Fallback>
        <Text text="Sync" />
      </Fragment>,
    );

    expect(ReactNoop.flush()).toEqual([
      // The async child blocks
      'Blocked! [Async]',
      // Continue on the sibling
      'Sync',
    ]);
    // The update hasn't expired yet, so we commit nothing.
    expect(ReactNoop.getChildren()).toEqual([]);

    // Advance both React's virtual time and Jest's timers by enough to expire
    // the update, but not by enough to flush the blocking promise.
    ReactNoop.expire(10000);
    await advanceTimers(10000);
    expect(ReactNoop.flushExpired()).toEqual([
      // Still blocked.
      'Blocked! [Async]',
      // Now that the update has expired, we render the fallback UI
      'Loading...',
      'Sync',
    ]);
    expect(ReactNoop.getChildren()).toEqual([span('Loading...'), span('Sync')]);

    // Once the promise resolves, we render the blocked view
    await advanceTimers();
    expect(ReactNoop.flush()).toEqual(['Promise resolved [Async]', 'Async']);
    expect(ReactNoop.getChildren()).toEqual([span('Async'), span('Sync')]);
  });

  it('renders an expiration boundary synchronously', async () => {
    // Synchronously render a tree with blockers
    ReactNoop.flushSync(() =>
      ReactNoop.render(
        <Fragment>
          <Fallback placeholder={<Text text="Loading..." />}>
            <AsyncText text="Async" />
          </Fallback>
          <Text text="Sync" />
        </Fragment>,
      ),
    );
    expect(ReactNoop.clearYields()).toEqual([
      // The async child blocks
      'Blocked! [Async]',
      // We immediately render the fallback UI
      'Loading...',
      // Continue on the sibling
      'Sync',
    ]);
    // The tree commits synchronously
    expect(ReactNoop.getChildren()).toEqual([span('Loading...'), span('Sync')]);

    // Once the promise resolves, we render the blocked view
    await advanceTimers();
    expect(ReactNoop.flush()).toEqual(['Promise resolved [Async]', 'Async']);
    expect(ReactNoop.getChildren()).toEqual([span('Async'), span('Sync')]);
  });

  it('blocking inside an expired expiration boundary will bubble to the next one', async () => {
    ReactNoop.flushSync(() =>
      ReactNoop.render(
        <Fragment>
          <Fallback placeholder={<Text text="Loading (outer)..." />}>
            <Fallback placeholder={<AsyncText text="Loading (inner)..." />}>
              <AsyncText text="Async" />
            </Fallback>
            <Text text="Sync" />
          </Fallback>
        </Fragment>,
      ),
    );
    expect(ReactNoop.clearYields()).toEqual([
      'Blocked! [Async]',
      'Blocked! [Loading (inner)...]',
      'Sync',
      'Loading (outer)...',
    ]);
    // The tree commits synchronously
    expect(ReactNoop.getChildren()).toEqual([span('Loading (outer)...')]);
  });

  it('expires early with a `timeout` option', async () => {
    ReactNoop.render(
      <Fragment>
        <Fallback timeout={100} placeholder={<Text text="Loading..." />}>
          <AsyncText text="Async" ms={1000} />
        </Fallback>
        <Text text="Sync" />
      </Fragment>,
    );

    expect(ReactNoop.flush()).toEqual([
      // The async child blocks
      'Blocked! [Async]',
      // Continue on the sibling
      'Sync',
    ]);
    // The update hasn't expired yet, so we commit nothing.
    expect(ReactNoop.getChildren()).toEqual([]);

    // Advance both React's virtual time and Jest's timers by enough to trigger
    // the timeout, but not by enough to flush the promise or reach the true
    // expiration time.
    ReactNoop.expire(120);
    await advanceTimers(120);
    expect(ReactNoop.flush()).toEqual([
      // Still blocked.
      'Blocked! [Async]',
      // Now that the expiration view has timed out, we render the fallback UI
      'Loading...',
      'Sync',
    ]);
    expect(ReactNoop.getChildren()).toEqual([span('Loading...'), span('Sync')]);

    // Once the promise resolves, we render the blocked view
    await advanceTimers();
    expect(ReactNoop.flush()).toEqual(['Promise resolved [Async]', 'Async']);
    expect(ReactNoop.getChildren()).toEqual([span('Async'), span('Sync')]);
  });
  it('throws a helpful error when a synchronous update is suspended', () => {
    expect(() => {
      ReactNoop.flushSync(() => ReactNoop.render(<AsyncText text="Async" />));
    }).toThrow(
      'A synchronous update was suspended, but no fallback UI was provided.',
    );
  });

  it('throws a helpful error when an expired update is suspended', async () => {
    ReactNoop.render(<AsyncText text="Async" ms={20000} />);
    expect(ReactNoop.flush()).toEqual(['Blocked! [Async]']);
    await advanceTimers(10000);
    ReactNoop.expire(10000);
    expect(() => {
      expect(ReactNoop.flush()).toEqual(['Blocked! [Async]']);
    }).toThrow(
      'An update was suspended for longer than the timeout, but no fallback ' +
        'UI was provided.',
    );
  });

  it('can resume rendering earlier than a timeout', async () => {
    ReactNoop.render(
      <Fallback timeout={1000} placeholder={<Text text="Loading..." />}>
        <AsyncText text="Async" ms={100} />
      </Fallback>,
    );
    expect(ReactNoop.flush()).toEqual(['Blocked! [Async]']);
    expect(ReactNoop.getChildren()).toEqual([]);

    // Advance time by an amount slightly smaller than what's necessary to
    // resolve the promise
    await advanceTimers(99);

    // Nothing has rendered yet
    expect(ReactNoop.flush()).toEqual([]);
    expect(ReactNoop.getChildren()).toEqual([]);

    // Resolve the promise
    await advanceTimers(1);
    // We can now resume rendering
    expect(ReactNoop.flush()).toEqual(['Promise resolved [Async]', 'Async']);
    expect(ReactNoop.getChildren()).toEqual([span('Async')]);
  });

  describe('splitting a high-pri update into high and low', () => {
    React = require('react');

    class AsyncValue extends React.Component {
      state = {asyncValue: this.props.defaultValue};
      componentDidMount() {
        ReactNoop.deferredUpdates(() => {
          this.setState((state, props) => ({asyncValue: props.value}));
        });
      }
      componentDidUpdate() {
        if (this.props.value !== this.state.asyncValue) {
          ReactNoop.deferredUpdates(() => {
            this.setState((state, props) => ({asyncValue: props.value}));
          });
        }
      }
      render() {
        return this.props.children(this.state.asyncValue);
      }
    }

    it('coalesces async values when in a blocked state', async () => {
      function App(props) {
        const highPriText = props.text;
        return (
          <AsyncValue value={highPriText} defaultValue={null}>
            {lowPriText => (
              <Fragment>
                <Text text={`High-pri: ${highPriText}`} />
                {lowPriText && (
                  <AsyncText text={`Low-pri: ${lowPriText}`} ms={100} />
                )}
              </Fragment>
            )}
          </AsyncValue>
        );
      }

      function renderAppSync(props) {
        ReactNoop.flushSync(() => ReactNoop.render(<App {...props} />));
      }

      // Initial mount
      renderAppSync({text: 'A'});
      expect(ReactNoop.flush()).toEqual([
        // First we render at high priority
        'High-pri: A',
        // Then we come back later to render a low priority
        'High-pri: A',
        // The low-pri view blocks
        'Blocked! [Low-pri: A]',
      ]);
      expect(ReactNoop.getChildren()).toEqual([span('High-pri: A')]);

      // Partially flush the promise for 'A', not by enough to resolve it.
      await advanceTimers(99);

      // Advance React's virtual time so that the next update falls into a new
      // expiration bucket
      ReactNoop.expire(2000);
      // Update to B. At this point, the low-pri view still hasn't updated
      // to 'A'.
      renderAppSync({text: 'B'});
      expect(ReactNoop.flush()).toEqual([
        // First we render at high priority
        'High-pri: B',
        // Then we come back later to render a low priority
        'High-pri: B',
        // The low-pri view blocks
        'Blocked! [Low-pri: B]',
      ]);
      expect(ReactNoop.getChildren()).toEqual([span('High-pri: B')]);

      // Flush the rest of the promise for 'A', without flushing the one
      // for 'B'.
      await advanceTimers(1);
      expect(ReactNoop.flush()).toEqual([
        // A is unblocked
        'Promise resolved [Low-pri: A]',
        // But we don't try to render it, because there's a lower priority
        // update that is also blocked.
      ]);
      expect(ReactNoop.getChildren()).toEqual([span('High-pri: B')]);

      // Flush the remaining work.
      await advanceTimers();
      expect(ReactNoop.flush()).toEqual([
        // B is unblocked
        'Promise resolved [Low-pri: B]',
        // Now we can continue rendering the async view
        'High-pri: B',
        'Low-pri: B',
      ]);
      expect(ReactNoop.getChildren()).toEqual([
        span('High-pri: B'),
        span('Low-pri: B'),
      ]);
    });
  });

  describe('a Delay component', () => {
    function Never() {
      // Throws a promise that resolves after some arbitrarily large
      // number of seconds. The idea is that this component will never
      // resolve. It's always wrapped by a Timeout.
      throw new Promise(resolve => setTimeout(() => resolve(), 10000));
    }

    function Delay({ms}) {
      return (
        <Timeout ms={ms}>
          {didTimeout => {
            if (didTimeout) {
              // Once ms has elapsed, render null. This allows the rest of the
              // tree to resume rendering.
              return null;
            }
            return <Never />;
          }}
        </Timeout>
      );
    }

    function DebouncedText({text, ms}) {
      return (
        <Fragment>
          <Delay ms={ms} />
          <Text text={text} />
        </Fragment>
      );
    }

    it('works', async () => {
      ReactNoop.render(<DebouncedText text="A" ms={1000} />);
      ReactNoop.flush();
      expect(ReactNoop.getChildren()).toEqual([]);

      await advanceTimers(999);
      ReactNoop.expire(999);
      ReactNoop.flush();
      expect(ReactNoop.getChildren()).toEqual([]);

      await advanceTimers(1);
      ReactNoop.expire(1);
      ReactNoop.flush();
      expect(ReactNoop.getChildren()).toEqual([span('A')]);
    });

    it('uses the most recent update as its start time', async () => {
      ReactNoop.render(<DebouncedText text="A" ms={1000} />);
      ReactNoop.flush();
      expect(ReactNoop.getChildren()).toEqual([]);

      // Advance time by a little, but not by enough to move this into a new
      // expiration bucket.
      await advanceTimers(10);
      ReactNoop.expire(10);
      ReactNoop.flush();
      expect(ReactNoop.getChildren()).toEqual([]);

      // Schedule an update. It should have the same expiration as the first one.
      ReactNoop.render(<DebouncedText text="B" ms={1000} />);

      // Advance time by enough that it would have timed-out the first update,
      // but not enough that it times out the second one.
      await advanceTimers(999);
      ReactNoop.expire(999);
      ReactNoop.flush();
      expect(ReactNoop.getChildren()).toEqual([]);

      // Advance time by just a bit more to trigger the timeout.
      await advanceTimers(1);
      ReactNoop.expire(1);
      ReactNoop.flush();
      expect(ReactNoop.getChildren()).toEqual([span('B')]);
    });
  });

  // TODO:
  // Timeout inside an async boundary
  // Start time of expiration bucket is time of most recent update
  // Promise rejection
  // Warns if promise reaches the root
  // Multiple timeouts with different values
  // Blocking inside an offscreen tree
  // Timeout for CPU-bound work
});
