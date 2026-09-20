"use client";
/**
 * Tap to record, tap again to stop. That is the whole contract, and it is deliberately not the browser's
 * SpeechRecognition.
 *
 * SpeechRecognition decides for itself when you have finished talking, and in Malayalam it frequently decided
 * nothing at all: the session never ended, `listening` stayed true, and the button sat on "Listening…" with no
 * way out but a page reload. Worse, the user is not in charge — someone pausing to think gets cut off, and
 * someone the engine cannot hear waits forever.
 *
 * MediaRecorder inverts that. Recording starts when the person taps and ends when the person taps again (or when
 * the safety cap is reached). Nothing depends on the browser recognising a language, because the audio is sent to
 * Sarvam, which does. The mic light is on exactly while it is recording, which is the honest signal.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type RecorderError = "not-allowed" | "no-microphone" | "unsupported" | "too-short" | "unknown";

export type RecorderControls = {
  supported: boolean;
  recording: boolean;
  seconds: number;           // how long this take has been running, for the UI
  error: RecorderError | null;
  start: () => void;
  stop: () => void;          // finish and hand the audio to onClip
  cancel: () => void;        // throw the take away
  toggle: () => void;
};

export function recorderErrorText(e: RecorderError): string {
  if (e === "not-allowed") return "Microphone is blocked. Allow microphone access in your browser, or type instead.";
  if (e === "no-microphone") return "No microphone found. Type what is wrong instead.";
  if (e === "unsupported") return "This browser cannot record audio. Type what is wrong instead.";
  if (e === "too-short") return "That was too short to hear. Hold the mic a little longer, or type it.";
  return "Could not record that. Type what is wrong instead.";
}

/** Recording stops itself here even if nobody taps again — a phone in a pocket must not record forever. */
export const MAX_RECORD_SECONDS = 60;
const MIN_RECORD_MS = 700;

export function useRecorder(handlers: {
  onClip: (clip: Blob, seconds: number) => void;
  onError?: (e: RecorderError) => void;
}): RecorderControls {
  const [supported, setSupported] = useState(false);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<RecorderError | null>(null);

  const h = useRef(handlers);
  h.current = handlers;
  const session = useRef<{
    rec: MediaRecorder; stream: MediaStream; chunks: BlobPart[];
    cancelled: boolean; startedAt: number; timers: ReturnType<typeof setInterval>[];
  } | null>(null);

  const teardown = useCallback(() => {
    const s = session.current;
    session.current = null;
    if (!s) return;
    for (const t of s.timers) clearInterval(t);
    for (const track of s.stream.getTracks()) track.stop();   // releases the mic light
    setRecording(false);
    setSeconds(0);
  }, []);

  // Decided after mount so the server render and the first client render agree.
  useEffect(() => {
    setSupported(typeof window !== "undefined" && typeof window.MediaRecorder !== "undefined"
      && !!navigator.mediaDevices?.getUserMedia);
    return () => { const s = session.current; if (s) { s.cancelled = true; try { s.rec.stop(); } catch { /* not started */ } } teardown(); };
  }, [teardown]);

  const fail = useCallback((e: RecorderError) => {
    setError(e);
    h.current.onError?.(e);
  }, []);

  const start = useCallback(() => {
    if (session.current) return;
    setError(null);
    void (async () => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        const name = (e as { name?: string })?.name ?? "";
        fail(name === "NotAllowedError" || name === "SecurityError" ? "not-allowed" : name === "NotFoundError" ? "no-microphone" : "unknown");
        return;
      }
      let rec: MediaRecorder;
      try {
        // Let the browser pick its own container: Chrome gives webm/opus, Safari mp4. Sarvam accepts both, and
        // naming a mimeType Safari does not implement throws instead of degrading.
        rec = new MediaRecorder(stream);
      } catch {
        for (const t of stream.getTracks()) t.stop();
        fail("unsupported");
        return;
      }
      const s = { rec, stream, chunks: [] as BlobPart[], cancelled: false, startedAt: Date.now(), timers: [] as ReturnType<typeof setInterval>[] };
      rec.ondataavailable = (e) => { if (e.data.size) s.chunks.push(e.data); };
      rec.onstop = () => {
        const ms = Date.now() - s.startedAt;
        const cancelled = s.cancelled;
        const blob = new Blob(s.chunks, { type: rec.mimeType || "audio/webm" });
        teardown();
        if (cancelled) return;
        // A stray double-tap produces a few milliseconds of silence; say so rather than sending it off.
        if (ms < MIN_RECORD_MS || blob.size < 1024) { fail("too-short"); return; }
        h.current.onClip(blob, Math.round(ms / 1000));
      };
      s.timers.push(setInterval(() => {
        const elapsed = Math.floor((Date.now() - s.startedAt) / 1000);
        setSeconds(elapsed);
        if (elapsed >= MAX_RECORD_SECONDS) { try { rec.stop(); } catch { /* already stopped */ } }
      }, 250));
      session.current = s;
      try { rec.start(); setRecording(true); setSeconds(0); }
      catch { teardown(); fail("unknown"); }
    })();
  }, [fail, teardown]);

  const stop = useCallback(() => {
    const s = session.current;
    if (!s) return;
    try { s.rec.stop(); } catch { teardown(); }
  }, [teardown]);

  const cancel = useCallback(() => {
    const s = session.current;
    if (!s) return;
    s.cancelled = true;
    try { s.rec.stop(); } catch { teardown(); }
  }, [teardown]);

  const toggle = useCallback(() => { if (session.current) stop(); else start(); }, [start, stop]);

  return { supported, recording, seconds, error, start, stop, cancel, toggle };
}
