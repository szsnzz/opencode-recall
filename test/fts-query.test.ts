import { describe, expect, test } from "bun:test";

import { buildMatchQuery, tokenize } from "../src/storage/fts-query.ts";

describe("tokenize", () => {
  test("splits on punctuation and whitespace", () => {
    expect(tokenize("hello, world! foo-bar")).toEqual([
      "hello",
      "world",
      "foo",
      "bar",
    ]);
  });

  test("lowercases", () => {
    expect(tokenize("Foo BAR")).toEqual(["foo", "bar"]);
  });

  test("dedupes preserving order", () => {
    expect(tokenize("foo foo bar foo")).toEqual(["foo", "bar"]);
  });

  test("keeps unicode letters (CJK)", () => {
    expect(tokenize("记忆 检索")).toEqual(["记忆", "检索"]);
  });

  test("empty / non-string yields empty", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("!!! @@@")).toEqual([]);
    // @ts-expect-error testing runtime guard
    expect(tokenize(undefined)).toEqual([]);
  });
});

describe("buildMatchQuery", () => {
  test("phrases each token and ORs them", () => {
    expect(buildMatchQuery("foo bar")).toBe('"foo" OR "bar"');
  });

  test("neutralizes FTS5 operator characters", () => {
    // These would otherwise break the MATCH parser.
    const q = buildMatchQuery('NEAR("a" b) AND c* -d ^e :f');
    // Every token is quoted; no raw operators leak through.
    expect(q).not.toMatch(/[*^:()-]/);
    expect(q.startsWith('"')).toBe(true);
    expect(q).toContain(" OR ");
  });

  test("empty query yields empty match", () => {
    expect(buildMatchQuery("")).toBe("");
    expect(buildMatchQuery("???")).toBe("");
  });

  test("single token has no OR", () => {
    expect(buildMatchQuery("solo")).toBe('"solo"');
  });
});
