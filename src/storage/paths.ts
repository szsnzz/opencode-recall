import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type Scope = "global" | "projects" | "sessions";
export type DocType = "memory" | "checkpoint" | "notes";

/**
 * Derive a stable project id from a project root absolute path:
 * sha256(normalized path) truncated to 12 hex chars. Same repo -> same id,
 * so all sessions of a repo share one project MEMORY.md.
 */
export function projectIdFromPath(projectRoot: string): string {
  const normalized = resolve(projectRoot);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

/**
 * Guard against path traversal / injection in scope ids. Session and project
 * ids are used as directory names, so they must be simple tokens.
 */
function assertSafeId(id: string, label: string): void {
  if (id.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  if (id.length > 128) {
    throw new Error(`${label} is too long`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error(`${label} contains illegal characters: ${JSON.stringify(id)}`);
  }
  if (id === "." || id === "..") {
    throw new Error(`${label} must not be a relative path segment`);
  }
}

/**
 * Resolve all on-disk paths for the memory store given a root directory.
 * Every returned path is guaranteed to live under `root`.
 */
export class MemoryPaths {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** SQLite index file. */
  get indexDb(): string {
    return resolve(this.root, "index.db");
  }

  get globalDir(): string {
    return resolve(this.root, "global");
  }

  get projectsDir(): string {
    return resolve(this.root, "projects");
  }

  get sessionsDir(): string {
    return resolve(this.root, "sessions");
  }

  /** <root>/global/MEMORY.md */
  globalMemory(): string {
    return this.ensureWithin(resolve(this.globalDir, "MEMORY.md"));
  }

  /** <root>/projects/<projectId>/MEMORY.md */
  projectMemory(projectId: string): string {
    assertSafeId(projectId, "projectId");
    return this.ensureWithin(resolve(this.projectsDir, projectId, "MEMORY.md"));
  }

  /** <root>/projects/<projectId> */
  projectDir(projectId: string): string {
    assertSafeId(projectId, "projectId");
    return this.ensureWithin(resolve(this.projectsDir, projectId));
  }

  /** <root>/sessions/<sessionId>/checkpoint.md */
  sessionCheckpoint(sessionId: string): string {
    assertSafeId(sessionId, "sessionId");
    return this.ensureWithin(
      resolve(this.sessionsDir, sessionId, "checkpoint.md"),
    );
  }

  /** <root>/sessions/<sessionId>/notes.md */
  sessionNotes(sessionId: string): string {
    assertSafeId(sessionId, "sessionId");
    return this.ensureWithin(resolve(this.sessionsDir, sessionId, "notes.md"));
  }

  /** <root>/sessions/<sessionId> */
  sessionDir(sessionId: string): string {
    assertSafeId(sessionId, "sessionId");
    return this.ensureWithin(resolve(this.sessionsDir, sessionId));
  }

  /**
   * Classify an absolute path under root into (scope, scopeId, type).
   * Returns undefined for paths that don't match the known layout.
   */
  classify(
    absPath: string,
  ): { scope: Scope; scopeId: string; type: DocType } | undefined {
    const abs = resolve(absPath);
    const rel = relative(this.root, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
    const parts = rel.split(sep);

    if (parts.length === 2 && parts[0] === "global" && parts[1] === "MEMORY.md") {
      return { scope: "global", scopeId: "", type: "memory" };
    }
    if (parts.length === 3 && parts[0] === "projects" && parts[2] === "MEMORY.md") {
      return { scope: "projects", scopeId: parts[1]!, type: "memory" };
    }
    if (parts.length === 3 && parts[0] === "sessions") {
      const file = parts[2]!;
      if (file === "checkpoint.md") {
        return { scope: "sessions", scopeId: parts[1]!, type: "checkpoint" };
      }
      if (file === "notes.md") {
        return { scope: "sessions", scopeId: parts[1]!, type: "notes" };
      }
    }
    return undefined;
  }

  /** Throw if `p` escapes the memory root. Returns `p` for chaining. */
  private ensureWithin(p: string): string {
    const abs = resolve(p);
    const rel = relative(this.root, abs);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`path escapes memory root: ${abs}`);
    }
    return abs;
  }
}
