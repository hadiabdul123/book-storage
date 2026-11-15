/** Only availability failures can fall back to the already-bound local library. */
export function connectionFailure(error: unknown): boolean {
  const e = error as { name?: string; message?: string; status?: number; code?: string } | null;
  if (!e) return false;
  return e.name === "AuthRetryableFetchError" || e.name === "TimeoutError" ||
    e.name === "AbortError" || e.status === 0 || (typeof e.status === "number" && e.status >= 500) ||
    /fetch|network|timed? ?out|too long|abort|offline|connection/i.test(e.message || "");
}
