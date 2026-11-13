/**
 * Minimal React 19 client hooks dispatcher for SOURCE-ONLY component callers.
 *
 * A number of this repository's readers call the exported function of a *client* module directly
 * (`Component(props)`) to inspect the element tree it returns — no React render pass happens
 * anywhere near them, so no dispatcher exists and every hook in the body throws
 * "Invalid hook call". Those readers still want to know what the component renders
 * (or whether it renders at all), so this module installs a benign client dispatcher into
 * React's own `__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H` slot:
 *
 *   useState / useReducer     -> initial-state pair, never updates
 *   useEffect / useLayoutEffect / useInsertionEffect -> no-ops
 *   useMemo                   -> fn()
 *   useCallback               -> fn
 *   useRef                    -> a ref with null current
 *   useContext                -> empty object
 *   useId                     -> ':r0:'
 *   useTransition / useDeferredValue / useOptimistic / useActionState -> their values / shape
 *   useImperativeHandle / useDebugValue / useSyncExternalStore / useCacheRefresh / use -> benign values
 *
 * THE POINT IS NOT FIDELITY. The corpus components this runs are never wired to refs,
 * effects or state in a way a source reader could distinguish from the benign values above;
 * the dispatcher exists so a plain call does not crash. Anything more, and the gate would
 * pretend to be a renderer — it is not.
 */

export function installClientDispatcher(React) {
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  if (!internals) {
    throw new Error('check_duplicate_keys: React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE is missing — React 19+ required for this reader');
  }
  const previousH = internals.H;
  const previousA = internals.A;
  const noop = () => undefined;
  internals.H = {
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, noop],
    useReducer: (_reducer, initial, init) => [init ? init(initial) : initial, noop],
    useEffect: noop,
    useLayoutEffect: noop,
    useInsertionEffect: noop,
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useContext: () => ({}),
    useId: () => ':r0:',
    useImperativeHandle: noop,
    useDebugValue: noop,
    useSyncExternalStore: () => undefined,
    useTransition: () => [false, noop],
    useDeferredValue: (value) => value,
    useOptimistic: (value) => [value, noop],
    useActionState: (_action, initial) => [initial, _action],
    getOwner: () => null,
    useCacheRefresh: noop,
    use: () => undefined,
  };
  internals.A = internals.H;
  return function restoreClientDispatcher() {
    internals.H = previousH;
    internals.A = previousA;
  };
}
