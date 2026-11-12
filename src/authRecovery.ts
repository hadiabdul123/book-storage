export const authStorageKey = import.meta.env.VITE_SUPABASE_URL
  ? `sb-${new URL(import.meta.env.VITE_SUPABASE_URL).hostname.split(".")[0]}-auth-token`
  : "";

export async function withDeadline<T>(promise: Promise<T>, ms = 15000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Sign-in took too long. Check your connection, or use Repair sign-in below. Your books and notes are safe.")), ms);
    })]);
  } finally { clearTimeout(timer!); }
}

export function repairSignIn() {
  // Clear only this project's login tokens, never the owner binding, IndexedDB,
  // downloads, drafts, preferences or queued sync operations.
  if (!authStorageKey) return;
  for (const suffix of ["", "-user", "-code-verifier"])
    localStorage.removeItem(authStorageKey + suffix);
  location.reload();
}
