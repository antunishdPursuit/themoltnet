import { describe, expect, it } from 'vitest';

import { prefetchInOrder, ReadAheadBudget } from './read-ahead.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('ReadAheadBudget', () => {
  it('detects a reservation released twice', () => {
    const budget = new ReadAheadBudget(10, 2);
    const reservation = budget.tryAcquire(4)!;
    expect(budget.availableBytes).toBe(6);
    expect(budget.availableRequests).toBe(1);
    budget.release(reservation);
    expect(() => budget.release(reservation)).toThrow('released twice');
    expect(() => budget.release({ bytes: 1 })).toThrow('released twice');
    expect(budget.availableBytes).toBe(10);
    expect(budget.availableRequests).toBe(2);
  });

  it('rejects invalid costs instead of granting them', () => {
    const budget = new ReadAheadBudget(10);
    expect(() => budget.tryAcquire(-1)).toThrow(RangeError);
    expect(() => budget.tryAcquire(Number.NaN)).toThrow(RangeError);
    expect(budget.tryAcquire(11)).toBeUndefined();
    expect(budget.availableBytes).toBe(10);
  });

  it('refuses a reservation when request slots run out', () => {
    const budget = new ReadAheadBudget(100, 1);
    expect(budget.tryAcquire(1)).toBeDefined();
    expect(budget.tryAcquire(1)).toBeUndefined();
  });

  it('rejects an invalid request limit', () => {
    expect(() => new ReadAheadBudget(10, -1)).toThrow(RangeError);
    expect(() => new ReadAheadBudget(10, 1.5)).toThrow(RangeError);
  });
});

describe('prefetchInOrder ordering', () => {
  it('yields nothing for an empty input without fetching', async () => {
    let fetched = 0;
    const items = prefetchInOrder(
      [],
      { concurrency: 4, budget: new ReadAheadBudget(10), cost: () => 1 },
      () => {
        fetched++;
        return Promise.resolve(0);
      },
    );
    expect(await items.next()).toEqual({ value: undefined, done: true });
    expect(fetched).toBe(0);
  });

  it('yields in input order when fetches complete in reverse', async () => {
    const fetches = [
      deferred<number>(),
      deferred<number>(),
      deferred<number>(),
    ];
    const items = prefetchInOrder(
      [0, 1, 2],
      { concurrency: 3, budget: new ReadAheadBudget(10), cost: () => 1 },
      (index) => fetches[index].promise,
    );
    const collected = (async () => {
      const values: number[] = [];
      for await (const value of items) values.push(value);
      return values;
    })();
    fetches[2].resolve(2);
    fetches[1].resolve(1);
    fetches[0].resolve(0);
    expect(await collected).toEqual([0, 1, 2]);
  });
});

describe('prefetchInOrder failures', () => {
  it.each([undefined, 0, ''])(
    'rethrows a falsy rejection unchanged: %j',
    async (thrown) => {
      const items = prefetchInOrder(
        [0, 1],
        { concurrency: 2, budget: new ReadAheadBudget(10), cost: () => 1 },
        (index, signal) =>
          index === 0
            ? // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
              Promise.reject(thrown)
            : new Promise<number>((_resolve, reject) => {
                signal.addEventListener('abort', () => {
                  reject(new Error('aborted', { cause: signal.reason }));
                });
              }),
      );
      await expect(items.next()).rejects.toBe(thrown);
    },
  );
});

describe('prefetchInOrder reservations', () => {
  it('releases a read-ahead that fails after it became the next item', async () => {
    const budget = new ReadAheadBudget(2);
    const fetches = [
      deferred<number>(),
      deferred<number>(),
      deferred<number>(),
    ];
    const items = prefetchInOrder(
      [0, 1, 2],
      { concurrency: 3, budget, cost: () => 1 },
      (index, signal) => {
        signal.addEventListener('abort', () => {
          fetches[index].reject(new Error('aborted', { cause: signal.reason }));
        });
        return fetches[index].promise;
      },
    );
    const first = items.next();
    expect(budget.availableBytes).toBe(0);
    fetches[0].resolve(0);
    expect(await first).toEqual({ value: 0, done: false });
    // Item 1 is now the next item and still holds its reservation.
    const second = items.next();
    fetches[1].reject(new Error('object store unavailable'));
    await expect(second).rejects.toThrow('object store unavailable');
    expect(budget.availableBytes).toBe(2);
  });

  it('tracks and releases a fetch that throws synchronously', async () => {
    const budget = new ReadAheadBudget(1);
    const items = prefetchInOrder(
      [0, 1],
      { concurrency: 2, budget, cost: () => 1 },
      (index, signal) => {
        if (index === 1) throw new Error('synchronous failure');
        // Honours its signal, as the helper requires.
        return new Promise<number>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('aborted', { cause: signal.reason }));
          });
        });
      },
    );
    await expect(items.next()).rejects.toThrow('synchronous failure');
    expect(budget.availableBytes).toBe(1);
  });
});
