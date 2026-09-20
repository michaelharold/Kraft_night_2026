/**
 * Who has the app open right now (isAppOnline). Counted from live dashboard streams (SSE), so it flips the moment a
 * provider opens or closes the app. Single-process by design, like lib/events.ts.
 */
const g = globalThis as unknown as { __resq_presence?: Map<string, number> };
const open = (g.__resq_presence ??= new Map());

export function markOnline(helperId: string): () => void {
  open.set(helperId, (open.get(helperId) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (open.get(helperId) ?? 1) - 1;
    if (n <= 0) open.delete(helperId); else open.set(helperId, n);
  };
}
export const isAppOnline = (helperId: string): boolean => (open.get(helperId) ?? 0) > 0;
