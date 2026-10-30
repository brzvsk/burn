export interface Coalesced<Input, Output> {
  (input: Input): Promise<Output>;
  /** Forget passes now in flight that `match` picks, so a call after an update starts a fresh pass instead of joining them. */
  invalidate(match?: (key: string) => boolean): void;
}

/**
 * One pass per distinct key: a read already under way is joined instead of
 * started again. A pass is forgotten on invalidation or once it settles, so a
 * call after an update never receives figures from before that update.
 */
export function coalesce<Input, Output>(key: (input: Input) => string, run: (input: Input) => Promise<Output>): Coalesced<Input, Output> {
  const pending = new Map<string, Promise<Output>>();
  const call = (input: Input): Promise<Output> => {
    const id = key(input);
    const under = pending.get(id);
    if (under !== undefined) return under;
    const tracked = run(input).finally(() => {
      if (pending.get(id) === tracked) pending.delete(id);
    });
    pending.set(id, tracked);
    return tracked;
  };
  call.invalidate = (match: (key: string) => boolean = () => true): void => {
    for (const id of [...pending.keys()]) if (match(id)) pending.delete(id);
  };
  return call;
}
