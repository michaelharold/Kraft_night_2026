"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Live snapshot: EventSource on streamUrl ("snapshot" events replace state). While disconnected it polls pollUrl
 * every 5 s. Cleans up on unmount (StrictMode double-mount safe).
 */
export function useSnapshot<T>(streamUrl: string | null, pollUrl: string | null, headers?: Record<string, string>) {
  const [data, setData] = useState<T | null>(null);
  const [connected, setConnected] = useState(false);
  const headersRef = useRef(headers);
  headersRef.current = headers;

  const refresh = useCallback(async () => {
    if (!pollUrl) return;
    try {
      const r = await fetch(pollUrl, { headers: headersRef.current, cache: "no-store" });
      if (r.ok) setData((await r.json()) as T);
    } catch { /* offline */ }
  }, [pollUrl]);

  useEffect(() => {
    if (!streamUrl) return;
    let es: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let closed = false;
    const startPoll = () => { if (!poll) poll = setInterval(refresh, 5000); };
    const stopPoll = () => { if (poll) { clearInterval(poll); poll = null; } };
    const open = () => {
      es = new EventSource(streamUrl);
      es.addEventListener("snapshot", (ev) => {
        try { setData(JSON.parse((ev as MessageEvent).data) as T); } catch { /* ignore */ }
      });
      es.onopen = () => { setConnected(true); stopPoll(); };
      es.onerror = () => { setConnected(false); startPoll(); if (es?.readyState === EventSource.CLOSED && !closed) setTimeout(open, 3000); };
    };
    open();
    return () => { closed = true; es?.close(); stopPoll(); };
  }, [streamUrl, refresh]);

  return { data, connected, refresh, setData };
}

/** Seconds left until an ISO deadline, updated every second. */
export function useSecondsLeft(deadline: string | null | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!deadline) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [deadline]);
  return deadline ? Math.max(0, Math.ceil((Date.parse(deadline) - now) / 1000)) : 0;
}
