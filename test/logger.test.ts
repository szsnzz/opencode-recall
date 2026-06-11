import { describe, expect, test } from "./helpers/bun-test-shim.ts";

import { Logger } from "../src/logger.ts";

interface Captured {
  service: string;
  level: string;
  message: string;
  extra?: Record<string, unknown>;
}

function makeClient(calls: Captured[], opts: { throwSync?: boolean; rejectAsync?: boolean } = {}) {
  return {
    app: {
      log: (options: { body: Captured }) => {
        if (opts.throwSync) throw new Error("sync boom");
        calls.push(options.body);
        return opts.rejectAsync ? Promise.reject(new Error("async boom")) : Promise.resolve({});
      },
    },
  } as never;
}

describe("Logger level gating", () => {
  test("drops entries below threshold", () => {
    const calls: Captured[] = [];
    const log = new Logger(makeClient(calls), "warn");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(calls.map((c) => c.level)).toEqual(["warn", "error"]);
  });

  test("info threshold passes info and above", () => {
    const calls: Captured[] = [];
    const log = new Logger(makeClient(calls), "info");
    log.debug("d");
    log.info("i");
    expect(calls.map((c) => c.level)).toEqual(["info"]);
  });

  test("attaches service and extra", () => {
    const calls: Captured[] = [];
    const log = new Logger(makeClient(calls), "debug");
    log.info("hello", { a: 1 });
    expect(calls[0]!.service).toBe("memory");
    expect(calls[0]!.message).toBe("hello");
    expect(calls[0]!.extra).toEqual({ a: 1 });
  });
});

describe("Logger fault tolerance", () => {
  test("never throws when client.app.log throws synchronously", () => {
    const log = new Logger(makeClient([], { throwSync: true }), "debug");
    expect(() => log.error("x")).not.toThrow();
  });

  test("swallows async rejection", () => {
    const log = new Logger(makeClient([], { rejectAsync: true }), "debug");
    expect(() => log.error("x")).not.toThrow();
  });

  test("works with no client (console fallback), still does not throw", () => {
    const log = new Logger(undefined, "debug");
    expect(() => log.info("no client")).not.toThrow();
  });
});
