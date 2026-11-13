import {
  SandboxCheckpointInvalidEntryError,
  SandboxCheckpointInvalidIdError,
  type SandboxCheckpoint,
} from "@tanstack/ai-sandbox";

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

const FILE_KEY = /^sandbox-files\/sha256\/[0-9a-f]{64}$/;
const ARTIFACT_KEY = /^sandbox-artifacts\/sha256\/[0-9a-f]{64}$/;

const invalid = (message: string) => new SandboxCheckpointInvalidEntryError(message);

// Only what this store relies on: blob keys become Redis hash fields, so they must be well formed.
// TanStack re-checks paths, sizes and file hashes when it restores a snapshot.
function validateEntries(checkpoint: SandboxCheckpoint): void {
  if (!Array.isArray(checkpoint.files)) throw invalid("Checkpoint files must be an array");
  for (const entry of checkpoint.files as unknown[]) {
    const e = entry as Record<string, unknown> | null;
    if (e === null || typeof e !== "object") throw invalid("Checkpoint entry must be an object");
    if (e.kind === "file") {
      if (typeof e.blobKey !== "string" || !FILE_KEY.test(e.blobKey)) {
        throw invalid("File entries require a valid content-addressed blobKey");
      }
    } else if (e.kind !== "dir") {
      throw invalid("Checkpoint entry kind must be file or dir");
    }
  }
}

function validateArtifacts(checkpoint: SandboxCheckpoint): void {
  if (!Array.isArray(checkpoint.artifacts)) throw invalid("Checkpoint artifacts must be an array");
  for (const artifact of checkpoint.artifacts as unknown[]) {
    const a = artifact as Record<string, unknown> | null;
    if (
      a === null ||
      typeof a !== "object" ||
      typeof a.blobKey !== "string" ||
      !ARTIFACT_KEY.test(a.blobKey)
    ) {
      throw invalid("Checkpoint artifact has invalid fields");
    }
  }
}

/** Field checks on a checkpoint; callers check its ids first. */
export function validateCheckpoint(checkpoint: SandboxCheckpoint): void {
  if (typeof checkpoint.createdAt !== "number" || !Number.isFinite(checkpoint.createdAt)) {
    throw invalid("Checkpoint createdAt must be a finite number");
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
