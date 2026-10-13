/**
 * Heuristic multiplier from a commit's stored size to the memory it occupies
 * while read and parsed: body chunks, the decoded string and the parsed
 * writes. Not a proof: JSON with many small keys can exceed it. With ~900 KB
 * commits the opt-in benchmark measured no peak-heap increase over
 * sequential reads under the default budget.
 */
export const READ_EXPANSION = 4;

/** Proof of one granted read-ahead: its bytes and one request slot. */
export interface Reservation {
  readonly bytes: number;
}

/**
 * A budget shared by every read of one store service, in bytes held and in
 * requests in flight. First come, first served: a read that keeps refilling
 * can hold other reads to sequential fetching (slower, never stalled), since
 * each read's next item is outside the budget.
 */
export class ReadAheadBudget {
  #bytes: number;
  #requests: number;
  readonly #outstanding = new Set<Reservation>();
  constructor(
    readonly limitBytes: number,
    readonly limitRequests: number = Number.POSITIVE_INFINITY,
  ) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 0)
      throw new RangeError('Read-ahead budget must be a non-negative integer');
    if (
      limitRequests !== Number.POSITIVE_INFINITY &&
      (!Number.isSafeInteger(limitRequests) || limitRequests < 0)
    )
      throw new RangeError(
        'Read-ahead request limit must be a non-negative integer',
      );
    this.#bytes = limitBytes;
    this.#requests = limitRequests;
  }
  get availableBytes() {
    return this.#bytes;
  }
  get availableRequests() {
    return this.#requests;
  }
  tryAcquire(bytes: number): Reservation | undefined {
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new RangeError('Read-ahead cost must be a non-negative integer');
    if (bytes > this.#bytes || this.#requests < 1) return undefined;
    this.#bytes -= bytes;
    this.#requests -= 1;
    const reservation: Reservation = Object.freeze({ bytes });
    this.#outstanding.add(reservation);
    return reservation;
  }
  release(reservation: Reservation | undefined) {
    if (!reservation) return;
    // A second or foreign release would silently lift the cap.
    if (!this.#outstanding.delete(reservation))
      throw new Error('Read-ahead reservation released twice or unknown');
    this.#bytes += reservation.bytes;
    this.#requests += 1;
  }
}

/**
 * Runs `fetch` over `items` and yields results strictly in input order,
 * refilling only when the consumer asks for the next result.
 *
 * Memory and requests are bounded across reads, not per read: the next item
 * in order is always fetched (a plain sequential read), and every fetch
 * beyond it must first reserve `cost(item)` bytes and one request slot from
 * the shared `budget`. When the budget is
 * exhausted, reads degrade to sequential instead of buffering more. A
 * reservation is released once the consumer takes the result, or when the
 * generator finishes, throws or is `return()`ed. A consumer that stops calling
 * `next()` without `return()` keeps its reservations; `for await` always
 * returns.
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
    budget: ReadAheadBudget;
    cost: (item: T) => number;
  },
  fetch: (item: T, signal: AbortSignal) => Promise<R>,
  callerSignal?: AbortSignal,
): AsyncGenerator<R> {
  const stop = new AbortController();
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, stop.signal])
    : stop.signal;
  const pending: { result: Promise<R>; reserved?: Reservation }[] = [];
  // Boxed: a thrown value may itself be falsy.
  let failure: { error: unknown } | undefined;
  let next = 0;
  const fill = () => {
    while (
      !signal.aborted &&
      next < items.length &&
      pending.length < options.concurrency
    ) {
      let reserved: Reservation | undefined;
      if (pending.length > 0) {
        // Read-ahead: only within the shared budget.
        reserved = options.budget.tryAcquire(options.cost(items[next]));
        if (!reserved) return;
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
        options.budget.release(head.reserved);
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
    for (const entry of pending) options.budget.release(entry.reserved);
  }
}
