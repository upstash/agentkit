/**
 * Detect an error/return that means "the search index doesn't exist yet". A missing Upstash index
 * doesn't fail uniformly: `query` returns `null`, `count` returns `{ count: -1 }`, and `aggregate`
 * throws a `TypeError` (the client reads `.length` of the null HTTP body). Pair this with
 * {@link withIndex}'s `isMissingResult` to cover the sentinel-return cases.
 */
export function isMissingIndexError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof TypeError && /cannot read properties of null|null \(reading/i.test(msg)) {
    return true;
  }
  return /not\s*found|does not exist|no such index|unknown index|no index/i.test(msg);
}

/**
 * Run a search-index operation; if it fails because the index doesn't exist yet — a thrown
 * {@link isMissingIndexError}, or a sentinel return flagged by `isMissingResult` (e.g. `query`→`null`,
 * `count`→`{ count: -1 }`) — provision the index via `provision` (create + `waitIndexing`) and run the
 * op once more. The op is retried at most once.
 */
export async function withIndex<T>(
  provision: () => Promise<void>,
  op: () => Promise<T>,
  isMissingResult?: (result: T) => boolean,
): Promise<T> {
  try {
    const result = await op();
    if (isMissingResult?.(result)) {
      await provision();
      return op();
    }
    return result;
  } catch (err) {
    if (!isMissingIndexError(err)) throw err;
    await provision();
    return op();
  }
}
