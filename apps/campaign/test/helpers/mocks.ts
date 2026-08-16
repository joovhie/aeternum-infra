/**
 * test/helpers/mocks.ts
 *
 * Shared test doubles for apps/campaign. Two different mocking needs here,
 * matching two different call patterns in the source:
 *
 * 1. Most of the app calls through named functions in db/queries.ts and
 *    indexerReads/queries.ts (insertLedgerEntries, getTransactionsByType,
 *    etc.) — those get mocked at the module level with `vi.mock(...)`,
 *    same pattern as apps/keeper uses for getDueVaults. No helper needed
 *    here beyond `vi.mocked()`.
 *
 * 2. A few functions build a Drizzle query inline instead of calling a
 *    named helper — antiGaming.ts's underDailyRateLimit is the one that
 *    matters for testing. For those, `chainable()` below builds a fake
 *    query-builder object: every method call (`.select()`, `.from()`,
 *    `.where()`, ...) returns the same object again, and the object
 *    itself is awaitable, resolving to whatever result you give it. That
 *    lets a test write `db.select = vi.fn(() => chainable([{ count: 5 }]))`
 *    without caring what chain of methods the real code happens to call.
 */

import { vi } from "vitest";

/**
 * Builds a fake Drizzle query-builder chain that resolves to `result`
 * when awaited, regardless of which methods get called on it first.
 *
 * @example
 * const db = { select: vi.fn(() => chainable([{ count: 3 }])) };
 * const rows = await db.select().from(table).where(...); // → [{ count: 3 }]
 */
export function chainable<T>(result: T): T {
  const thenable = {
    then: (resolve: (value: T) => void) => resolve(result),
    catch: () => proxy,
    finally: (fn?: () => void) => {
      fn?.();
      return proxy;
    },
  };

  const proxy = new Proxy(thenable, {
    get(target, prop) {
      if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
      return () => proxy;
    },
  }) as unknown as T;

  return proxy;
}

/**
 * Deterministic Ethereum address from a number, matching apps/keeper's
 * fixture convention: makeAddress(1) → 0x0000...0001
 */
export const makeAddress = (n: number): `0x${string}` =>
  `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;

/**
 * Deterministic transaction hash from a number: makeTxHash(1) → 0x0000...0001
 */
export const makeTxHash = (n: number): `0x${string}` =>
  `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;

/** Creates a bare mock DB client — used when every real call goes through a mocked query helper, so the client itself never needs real methods. */
export function createBareMockDb<T>(): T {
  return {} as T;
}
