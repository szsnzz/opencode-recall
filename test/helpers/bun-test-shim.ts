/**
 * Minimal bun:test-compatible shim over Node's built-in `node:test` runner.
 *
 * WHY: the plugin runs under Node.js (opencode desktop), and our storage layer
 * uses `node:sqlite`, which Bun does not provide. Running tests under `bun test`
 * therefore fails on every DB-backed test. We run tests with `node --test`
 * instead, so the test runtime matches production. This shim lets the existing
 * specs keep their `describe / test / expect(...).matcher` style unchanged —
 * only the import line points here instead of "bun:test".
 *
 * Supported surface (everything the suite actually uses):
 *   describe, test, beforeEach, afterEach
 *   expect(x).toBe / toEqual / toContain / toMatch / toThrow
 *            / toBeGreaterThan / toBeGreaterThanOrEqual
 *            / toBeLessThan / toBeLessThanOrEqual
 *   expect(x).not.<above>
 *   await expect(promise).rejects.toThrow()
 */
import {
  describe as nodeDescribe,
  test as nodeTest,
  beforeEach as nodeBeforeEach,
  afterEach as nodeAfterEach,
} from "node:test";
import assert from "node:assert/strict";

export const describe = nodeDescribe;
export const test = nodeTest;
export const beforeEach = nodeBeforeEach;
export const afterEach = nodeAfterEach;

function contains(actual: unknown, expected: unknown): boolean {
  if (typeof actual === "string") {
    return actual.includes(String(expected));
  }
  if (Array.isArray(actual)) {
    return actual.some((v) => {
      try {
        assert.deepStrictEqual(v, expected);
        return true;
      } catch {
        return false;
      }
    });
  }
  return false;
}

function callAndCatch(fn: () => unknown): { threw: boolean; error?: unknown } {
  try {
    fn();
    return { threw: false };
  } catch (error) {
    return { threw: true, error };
  }
}

class Matchers {
  private readonly actual: unknown;
  private readonly negated: boolean;

  constructor(actual: unknown, negated: boolean) {
    this.actual = actual;
    this.negated = negated;
  }

  get not(): Matchers {
    return new Matchers(this.actual, !this.negated);
  }

  private check(pass: boolean, msg: string): void {
    if (this.negated) {
      assert.ok(!pass, `expected NOT: ${msg}`);
    } else {
      assert.ok(pass, msg);
    }
  }

  toBe(expected: unknown): void {
    this.check(
      Object.is(this.actual, expected),
      `expected ${stringify(this.actual)} to be ${stringify(expected)}`,
    );
  }

  toBeDefined(): void {
    this.check(
      this.actual !== undefined,
      `expected ${stringify(this.actual)} to be defined`,
    );
  }

  toBeUndefined(): void {
    this.check(
      this.actual === undefined,
      `expected ${stringify(this.actual)} to be undefined`,
    );
  }

  toBeNull(): void {
    this.check(
      this.actual === null,
      `expected ${stringify(this.actual)} to be null`,
    );
  }

  toBeTruthy(): void {
    this.check(Boolean(this.actual), `expected ${stringify(this.actual)} to be truthy`);
  }

  toBeFalsy(): void {
    this.check(!this.actual, `expected ${stringify(this.actual)} to be falsy`);
  }

  toHaveLength(n: number): void {
    const len = (this.actual as { length?: number } | null | undefined)?.length;
    this.check(
      len === n,
      `expected ${stringify(this.actual)} to have length ${n} (got ${len})`,
    );
  }

  toEqual(expected: unknown): void {
    let equal = true;
    try {
      assert.deepStrictEqual(this.actual, expected);
    } catch {
      equal = false;
    }
    this.check(
      equal,
      `expected ${stringify(this.actual)} to equal ${stringify(expected)}`,
    );
  }

  toContain(expected: unknown): void {
    this.check(
      contains(this.actual, expected),
      `expected ${stringify(this.actual)} to contain ${stringify(expected)}`,
    );
  }

  toMatch(re: RegExp | string): void {
    const pattern = typeof re === "string" ? new RegExp(re) : re;
    this.check(
      typeof this.actual === "string" && pattern.test(this.actual),
      `expected ${stringify(this.actual)} to match ${pattern}`,
    );
  }

  toBeGreaterThan(n: number): void {
    this.check(
      (this.actual as number) > n,
      `expected ${stringify(this.actual)} > ${n}`,
    );
  }

  toBeGreaterThanOrEqual(n: number): void {
    this.check(
      (this.actual as number) >= n,
      `expected ${stringify(this.actual)} >= ${n}`,
    );
  }

  toBeLessThan(n: number): void {
    this.check(
      (this.actual as number) < n,
      `expected ${stringify(this.actual)} < ${n}`,
    );
  }

  toBeLessThanOrEqual(n: number): void {
    this.check(
      (this.actual as number) <= n,
      `expected ${stringify(this.actual)} <= ${n}`,
    );
  }

  toThrow(expected?: string | RegExp): void {
    assert.ok(
      typeof this.actual === "function",
      "toThrow expects a function",
    );
    const { threw, error } = callAndCatch(this.actual as () => unknown);
    if (this.negated) {
      assert.ok(!threw, `expected function NOT to throw, but it threw ${stringify(error)}`);
      return;
    }
    assert.ok(threw, "expected function to throw, but it did not");
    if (expected !== undefined) {
      const message = error instanceof Error ? error.message : String(error);
      const ok =
        typeof expected === "string"
          ? message.includes(expected)
          : expected.test(message);
      assert.ok(ok, `expected error message ${stringify(message)} to match ${stringify(expected)}`);
    }
  }
}

class AsyncMatchers {
  private readonly promise: Promise<unknown>;

  constructor(promise: Promise<unknown>) {
    this.promise = promise;
  }

  get rejects(): { toThrow: (expected?: string | RegExp) => Promise<void> } {
    const promise = this.promise;
    return {
      toThrow: async (expected?: string | RegExp): Promise<void> => {
        let threw = false;
        let error: unknown;
        try {
          await promise;
        } catch (e) {
          threw = true;
          error = e;
        }
        assert.ok(threw, "expected promise to reject, but it resolved");
        if (expected !== undefined) {
          const message = error instanceof Error ? error.message : String(error);
          const ok =
            typeof expected === "string"
              ? message.includes(expected)
              : expected.test(message);
          assert.ok(ok, `expected rejection ${stringify(message)} to match ${stringify(expected)}`);
        }
      },
    };
  }
}

function stringify(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (v instanceof Error) return v.message;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function expect(actual: unknown): Matchers & AsyncMatchers {
  // Return an object that supports both sync matchers and async .rejects.
  const sync = new Matchers(actual, false);
  if (actual instanceof Promise) {
    const asyncM = new AsyncMatchers(actual);
    // Merge: async only needs .rejects; everything else from sync.
    return Object.assign(sync, { rejects: asyncM.rejects }) as Matchers &
      AsyncMatchers;
  }
  return sync as Matchers & AsyncMatchers;
}
