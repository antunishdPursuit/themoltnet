/**
 * Heuristic multiplier from a commit's stored size to the memory it occupies
 * while read and parsed: body chunks, the decoded string and the parsed
 * writes. Not a proof: JSON with many small keys can exceed it. With ~900 KB
 * commits the opt-in benchmark measured no peak-heap increase over
 * sequential reads under the default budget.
 */
export const READ_EXPANSION = 4;

/**
 * A byte budget shared by every read of one store service. First come, first
 * served: a read that keeps refilling can hold other reads to sequential
 * fetching (slower, never stalled), since each read's next item is free.
 */
export class ReadAheadBudget {
  #available: number;
  constructor(readonly limitBytes: number) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 0)
      throw new RangeError('readAheadBytes must be a non-negative integer');
    this.#available = limitBytes;
  }
  get availableBytes() {
    return this.#available;
  }
  tryAcquire(bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new RangeError('Read-ahead cost must be a non-negative integer');
    if (bytes > this.#available) return false;
    this.#available -= bytes;
    return true;
  }
  release(bytes: number) {
    // Over-release would silently lift the cap; fail loudly instead.
    if (bytes < 0 || this.#available + bytes > this.limitBytes)
      throw new Error('Read-ahead budget released more than it reserved');
    this.#available += bytes;
  }
}

/**
 * Runs `fetch` over `items` and yields results strictly in input order,
 * refilling only when the consumer asks for the next result.
 *
 * Memory is bounded by bytes, not by item count: the next item in order is
 * always fetched (a plain sequential read), and every fetch beyond it must
 * first reserve `cost(item)` from the shared `budget`. When the budget is
 * exhausted, reads degrade to sequential instead of buffering more. A
 * reservation is released once the consumer takes the result, or when the
 * fetch is abandoned.
 *
 * The first real failure aborts the other fetches and is thrown in place of
 * the abort errors it causes. Early return, failure or caller abort aborts
 * every in-flight fetch and waits for it to settle, so `fetch` must honour its
 * signal or closing will wait for it.
 */
export async function* prefetchInOrder<T, R>(
  items: readonly T[],
  options: {
    concurrency: number;
    budget?: ReadAheadBudget;
    cost: (item: T) => number;
  },
  fetch: (item: T, signal: AbortSignal) => Promise<R>,
  callerSignal?: AbortSignal,
): AsyncGenerator<R> {
  const stop = new AbortController();
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, stop.signal])
    : stop.signal;
  const pending: { result: Promise<R>; reserved: number }[] = [];
  // Boxed: a thrown value may itself be falsy.
  let failure: { error: unknown } | undefined;
  let next = 0;
  const fill = () => {
    while (
      !signal.aborted &&
      next < items.length &&
      pending.length < options.concurrency
    ) {
      let reserved = 0;
      if (pending.length > 0) {
        // Read-ahead: only within the shared byte budget.
        const cost = options.cost(items[next]);
        if (!options.budget?.tryAcquire(cost)) return;
        reserved = cost;
      }
      const item = items[next++];
      // A synchronous throw becomes a rejection, so the entry (and its
      // reservation) is always tracked and released.
      const result = new Promise<R>((resolve) => {
        resolve(fetch(item, signal));
      });
      result.catch((error: unknown) => {
        if (signal.aborted) return;
        failure = { error };
        stop.abort(error);
      });
      pending.push({ result, reserved });
    }
  };
  try {
    callerSignal?.throwIfAborted();
    fill();
    while (pending.length) {
      const head = pending[0];
      let value: R;
      try {
        value = await head.result;
      } catch (error) {
        callerSignal?.throwIfAborted();
        throw failure ? failure.error : error;
      }
      pending.shift();
      try {
        yield value;
      } finally {
        options.budget?.release(head.reserved);
      }
      // Refill only when the consumer asks for more, so concurrency 1 is
      // strictly sequential and a stalled consumer stops further fetches.
      callerSignal?.throwIfAborted();
      fill();
    }
    // An abort must never surface as a normal, short page.
    callerSignal?.throwIfAborted();
  } finally {
    stop.abort();
    await Promise.allSettled(pending.map((entry) => entry.result));
    for (const entry of pending) options.budget?.release(entry.reserved);
  }
}
