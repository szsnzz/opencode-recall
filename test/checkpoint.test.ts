import { describe, expect, test } from "./helpers/bun-test-shim.ts";

import {
  mergeCheckpoint,
  parseCheckpoint,
  serializeCheckpoint,
} from "../src/storage/markdown.ts";

describe("checkpoint parse/serialize roundtrip", () => {
  test("serializes provided fields in canonical order", () => {
    const doc = parseCheckpoint("");
    mergeCheckpoint(doc, {
      intent: "build M2",
      next_action: "write tests",
      files: ["src/write.ts — checkpoint logic"],
    });
    const md = serializeCheckpoint(doc);
    expect(md).toContain("# Session checkpoint");
    expect(md).toContain("## 当前意图");
    expect(md).toContain("build M2");
    expect(md).toContain("## 下一步");
    expect(md).toContain("## 涉及文件");
    expect(md).toContain("- src/write.ts — checkpoint logic");
    // intent section must appear before next_action section.
    expect(md.indexOf("## 当前意图")).toBeLessThan(md.indexOf("## 下一步"));
  });

  test("omits empty sections", () => {
    const doc = parseCheckpoint("");
    mergeCheckpoint(doc, { intent: "only intent" });
    const md = serializeCheckpoint(doc);
    expect(md).toContain("## 当前意图");
    expect(md).not.toContain("## 下一步");
    expect(md).not.toContain("## 涉及文件");
  });

  test("roundtrips through parse", () => {
    const doc = parseCheckpoint("");
    mergeCheckpoint(doc, {
      intent: "intent text",
      current_work: "doing work\nacross lines",
      files: ["a.ts", "b.ts"],
    });
    const md = serializeCheckpoint(doc);
    const reparsed = parseCheckpoint(md);
    expect(reparsed.text.get("intent")).toBe("intent text");
    expect(reparsed.text.get("current_work")).toBe("doing work\nacross lines");
    expect(reparsed.files).toEqual(["a.ts", "b.ts"]);
  });
});

describe("mergeCheckpoint", () => {
  test("text fields are replaced on update", () => {
    const doc = parseCheckpoint("");
    mergeCheckpoint(doc, { intent: "first" });
    const r = mergeCheckpoint(doc, { intent: "second" });
    expect(doc.text.get("intent")).toBe("second");
    expect(r.changed).toContain("intent");
  });

  test("files list dedupes and appends", () => {
    const doc = parseCheckpoint("");
    mergeCheckpoint(doc, { files: ["a.ts", "b.ts"] });
    mergeCheckpoint(doc, { files: ["b.ts", "c.ts"] });
    expect(doc.files).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  test("ignores empty/whitespace updates", () => {
    const doc = parseCheckpoint("");
    const r = mergeCheckpoint(doc, { intent: "   ", next_action: "" });
    expect(r.changed).toEqual([]);
  });

  test("reports changed fields", () => {
    const doc = parseCheckpoint("");
    const r = mergeCheckpoint(doc, {
      intent: "x",
      decisions: "y",
      files: ["z.ts"],
    });
    expect([...r.changed].sort()).toEqual(
      (["decisions", "files", "intent"] as const).slice().sort(),
    );
  });

  test("truncates an over-budget field", () => {
    const doc = parseCheckpoint("");
    const huge = "word ".repeat(5000);
    mergeCheckpoint(doc, { intent: huge }); // intent budget = 500 tokens
    expect(doc.text.get("intent")!).toContain("[截断]");
    expect(doc.text.get("intent")!.length).toBeLessThan(huge.length);
  });
});
