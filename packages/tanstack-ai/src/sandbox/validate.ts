import {
  SandboxCheckpointInvalidEntryError,
  SandboxCheckpointInvalidIdError,
  type SandboxCheckpoint,
} from "@tanstack/ai-sandbox";

// Input checks shared by the checkpoint store. They mirror `@tanstack/ai-sandbox`'s own in-memory
// store (which does not export them) so both stores refuse the same inputs with the same codes.

const utf8 = new TextEncoder();

/** Order by UTF-8 bytes, the order the contract specifies for checkpoint ids and blob keys. */
export function compareUtf8Bytes(a: string, b: string): number {
  const x = utf8.encode(a);
  const y = utf8.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

export function assertValidIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || hasUnpairedSurrogate(value)) {
    throw new SandboxCheckpointInvalidIdError(
      `${label} must be a non-empty well-formed Unicode string`,
    );
  }
}

const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const FILE_KEY = /^sandbox-files\/sha256\/[0-9a-f]{64}$/;
const ARTIFACT_KEY = /^sandbox-artifacts\/sha256\/[0-9a-f]{64}$/;

function validateEntries(checkpoint: SandboxCheckpoint): void {
  if (!Array.isArray(checkpoint.files)) {
    throw new SandboxCheckpointInvalidEntryError("Checkpoint files must be an array");
  }
  const paths = new Set<string>();
  const kinds = new Map<string, string>();
  for (const entry of checkpoint.files as unknown[]) {
    if (entry === null || typeof entry !== "object") {
      throw new SandboxCheckpointInvalidEntryError("Checkpoint entry must be an object");
    }
    const c = entry as Record<string, unknown>;
    const path = c.path;
    if (
      typeof path !== "string" ||
      path.length === 0 ||
      path.includes("\0") ||
      path.startsWith("/") ||
      path.startsWith("\\") ||
      /^[A-Za-z]:([\\/]|$)/.test(path) ||
      path.includes("\\") ||
      path.split("/").some((part) => part.length === 0 || part === "." || part === "..")
    ) {
      throw new SandboxCheckpointInvalidEntryError(
        "Checkpoint entry path must be a normalized workspace-relative path",
      );
    }
    if (paths.has(path)) {
      throw new SandboxCheckpointInvalidEntryError(
        `Checkpoint contains duplicate entry path '${path}'`,
      );
    }
    for (let s = path.indexOf("/"); s !== -1; s = path.indexOf("/", s + 1)) {
      const ancestor = path.slice(0, s);
      if (kinds.get(ancestor) === "file") {
        throw new SandboxCheckpointInvalidEntryError(
          `Checkpoint entry '${path}' is beneath file '${ancestor}'`,
        );
      }
    }
    if (c.kind === "file" && [...kinds.keys()].some((other) => other.startsWith(`${path}/`))) {
      throw new SandboxCheckpointInvalidEntryError(
        `Checkpoint file '${path}' is an ancestor of another entry`,
      );
    }
    paths.add(path);
    if (c.kind === "file") {
      if (
        typeof c.blobKey !== "string" ||
        hasUnpairedSurrogate(c.blobKey) ||
        !FILE_KEY.test(c.blobKey)
      ) {
        throw new SandboxCheckpointInvalidEntryError(
          "File entries require a valid content-addressed blobKey",
        );
      }
      if (
        !hasOwn(c, "size") ||
        typeof c.size !== "number" ||
        !Number.isSafeInteger(c.size) ||
        c.size < 0
      ) {
        throw new SandboxCheckpointInvalidEntryError(
          "File entry size must be a non-negative safe integer",
        );
      }
    } else if (c.kind === "dir") {
      if (hasOwn(c, "blobKey") || hasOwn(c, "size")) {
        throw new SandboxCheckpointInvalidEntryError(
          "Directory entries cannot contain file fields",
        );
      }
    } else {
      throw new SandboxCheckpointInvalidEntryError("Checkpoint entry kind must be file or dir");
    }
    kinds.set(path, c.kind);
  }
}

function validateArtifacts(checkpoint: SandboxCheckpoint): void {
  if (!Array.isArray(checkpoint.artifacts)) {
    throw new SandboxCheckpointInvalidEntryError("Checkpoint artifacts must be an array");
  }
  for (const artifact of checkpoint.artifacts as unknown[]) {
    if (artifact === null || typeof artifact !== "object") {
      throw new SandboxCheckpointInvalidEntryError("Checkpoint artifact must be an object");
    }
    const a = artifact as Record<string, unknown>;
    const ok =
      typeof a.artifactId === "string" &&
      a.artifactId.length > 0 &&
      !hasUnpairedSurrogate(a.artifactId) &&
      typeof a.name === "string" &&
      a.name.length > 0 &&
      typeof a.mimeType === "string" &&
      a.mimeType.length > 0 &&
      typeof a.blobKey === "string" &&
      !hasUnpairedSurrogate(a.blobKey) &&
      ARTIFACT_KEY.test(a.blobKey) &&
      typeof a.size === "number" &&
      Number.isSafeInteger(a.size) &&
      a.size >= 0 &&
      typeof a.createdAt === "number" &&
      Number.isFinite(a.createdAt);
    if (!ok) throw new SandboxCheckpointInvalidEntryError("Checkpoint artifact has invalid fields");
  }
}

/** Every field check the contract makes on a checkpoint, ids included. */
export function validateCheckpoint(checkpoint: SandboxCheckpoint): void {
  assertValidIdentifier(checkpoint.id, "Checkpoint id");
  assertValidIdentifier(checkpoint.threadId, "Checkpoint thread id");
  if (checkpoint.parentCheckpointId != null) {
    assertValidIdentifier(checkpoint.parentCheckpointId, "Parent checkpoint id");
  }
  if (typeof checkpoint.createdAt !== "number" || !Number.isFinite(checkpoint.createdAt)) {
    throw new SandboxCheckpointInvalidEntryError("Checkpoint createdAt must be a finite number");
  }
  validateEntries(checkpoint);
  validateArtifacts(checkpoint);
}

/** The distinct blob keys a checkpoint references (files and artifacts). */
export function blobKeysOf(checkpoint: SandboxCheckpoint): string[] {
  const keys = new Set<string>();
  for (const entry of checkpoint.files) if (entry.kind === "file") keys.add(entry.blobKey);
  for (const artifact of checkpoint.artifacts) keys.add(artifact.blobKey);
  return [...keys];
}
