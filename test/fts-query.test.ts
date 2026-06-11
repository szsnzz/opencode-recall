import { describe, expect, test } from "bun:test";

import { buildMatchQuery, tokenize } from "../src/storage/fts-query.ts";
import { segment } from "../src/storage/segment.ts";

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

  test("keeps underscore identifiers intact", () => {
    expect(tokenize("save_checkpoint")).toEqual(["save_checkpoint"]);
  });

  test("CJK is expanded into bigrams", () => {
    // "提交信息" -> 提交 / 交信 / 信息
    expect(tokenize("提交信息")).toEqual(["提交", "交信", "信息"]);
  });

  test("lone CJK char survives as a single token", () => {
    expect(tokenize("简")).toEqual(["简"]);
  });

  test("mixed CJK + english", () => {
    // 写入 -> 写入 (single bigram); english kept whole
    expect(tokenize("写入 logic")).toEqual(["写入", "logic"]);
  });

  test("empty / non-string yields empty", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("!!! @@@")).toEqual([]);
    // @ts-expect-error testing runtime guard
    expect(tokenize(undefined)).toEqual([]);
  });
});

describe("buildMatchQuery", () => {
  test("restricts to the search column and ORs tokens", () => {
    expect(buildMatchQuery("foo bar")).toBe('{search} : ("foo" OR "bar")');
  });

  test("neutralizes FTS5 operator characters", () => {
    const q = buildMatchQuery('NEAR("a" b) AND c* -d ^e :f');
    // Operator chars must not leak as bare operators; everything is quoted
    // inside the column-filtered group.
    expect(q.startsWith("{search} : (")).toBe(true);
    expect(q).toContain('"');
    // No raw star/caret/colon-as-operator outside the quoted phrases.
    expect(q).not.toMatch(/[*^]/);
  });

  test("empty query yields empty match", () => {
    expect(buildMatchQuery("")).toBe("");
    expect(buildMatchQuery("???")).toBe("");
  });

  test("single token is column-filtered with no OR", () => {
    expect(buildMatchQuery("solo")).toBe('{search} : ("solo")');
  });

  test("CJK query expands to bigram OR group", () => {
    expect(buildMatchQuery("提交信息")).toBe(
      '{search} : ("提交" OR "交信" OR "信息")',
    );
  });
});

describe("segment", () => {
  test("expands CJK runs into overlapping bigrams", () => {
    expect(segment("并且简洁")).toBe("并且 且简 简洁");
  });

  test("keeps a lone CJK char", () => {
    expect(segment("简")).toBe("简");
  });

  test("preserves non-CJK runs verbatim (identifiers/english)", () => {
    expect(segment("save_checkpoint")).toBe("save_checkpoint");
    expect(segment("running tests")).toBe("running tests");
  });

  test("splits CJK at punctuation boundaries", () => {
    // comma is non-CJK, so the two CJK runs are segmented independently
    expect(segment("中文，简洁")).toBe("中文 ， 简洁");
  });

  test("empty / non-string yields empty", () => {
    expect(segment("")).toBe("");
    // @ts-expect-error runtime guard
    expect(segment(undefined)).toBe("");
  });
});
