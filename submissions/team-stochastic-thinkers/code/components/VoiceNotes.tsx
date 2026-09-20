"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { getHelperToken } from "@/lib/client/api";
import { speechErrorText, useSpeech } from "@/lib/client/speech";
import { MAX_RECORD_SECONDS, recorderErrorText, useRecorder } from "@/lib/client/recorder";
import { languageOf, type LanguageCode } from "@/lib/languages";
import type { VoiceMessage } from "@/lib/types";
import { Icon } from "./icons";
import { VoiceMic } from "./VoiceMic";

/**
 * The conversation between the two people on a job, across a language barrier.
 *
 * Both halves of every message are on screen, never just the translation. You read the translation — that is the
 * point — but the speaker's own words sit underneath in a quieter type, and the recording (when the message came
 * in by phone) can be played. If a name or a house number looks wrong in the translation, you can check what was
 * actually said instead of guessing. Hiding the original would make the machine the only witness.
 *
 * Speech is recognised in the BROWSER, in the speaker's own language, and only the text is sent. That keeps a
 * voice note free and instant, and means the server never handles raw audio for the in-app path.
 *
 * "Sent by call" on a message means the other person was not in the app, so Sahaya rang them and read it aloud —
 * the thing that makes this work for someone under a sink with a phone in their pocket.
 */
export function VoiceNotes({ requestId, myLanguage, className = "" }: {
  requestId: string;
  myLanguage: LanguageCode;
  className?: string;
}) {
  const [messages, setMessages] = useState<VoiceMessage[]>([]);
  const [me, setMe] = useState<"requester" | "helper" | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  const headers = () => ({ "content-type": "application/json", "x-resq-session": getHelperToken() ?? "none" });

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/requests/${requestId}/voice`, { headers: { "x-resq-session": getHelperToken() ?? "none" } });
      if (!res.ok) return;
      const data = (await res.json()) as { messages: VoiceMessage[]; me: "requester" | "helper" };
      setMessages(data.messages);
      setMe(data.me);
    } catch { /* a dropped poll is not worth telling anyone about */ }
  }, [requestId]);

  // The job screen already re-renders on every SSE change; this keeps the thread fresh in between.
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: "nearest" }); }, [messages.length]);

  /**
   * Play incoming turns out loud, once each. This is what makes it a call rather than a transcript, and the
   * `played` set is what stops a re-render or a poll replaying something the person already heard.
   * Browsers block autoplay until the page has been interacted with; tapping the talk button counts, and if it
   * is still refused the message stays on screen with its own play button.
   */
  const played = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (me === null) return;
    for (const m of messages) {
      if (m.fromRole === me || !m.hasSpokenAudio || played.current.has(m.id)) continue;
      played.current.add(m.id);
      const el = new Audio(`/api/requests/${requestId}/voice/${m.id}/audio?s=${encodeURIComponent(getHelperToken() ?? "none")}`);
      void el.play().catch(() => { /* autoplay refused; the play button below still works */ });
    }
  }, [messages, me, requestId]);

  const send = async (text: string) => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch(`/api/requests/${requestId}/voice`, {
        method: "POST", headers: headers(), body: JSON.stringify({ text: body, lang: myLanguage }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error === "no_counterpart"
          ? "Nobody has accepted this job yet, so there is no one to send it to."
          : "Could not send that message. Please try again.");
        return;
      }
      const data = (await res.json()) as { message: VoiceMessage; deliveredBy: "app" | "call" };
      setDraft("");
      setNote(data.deliveredBy === "call"
        ? "They are not in the app — Sahaya is calling them and reading it out."
        : "Delivered to their screen.");
      setMessages((cur) => [...cur, data.message]);
    } catch {
      setError("Could not send that message. Please try again.");
    } finally {
      setSending(false);
    }
  };

  /**
   * A call turn. The clip goes up, and what comes back is the same message in the other person's language,
   * already spoken. Nothing is typed and nothing has to be read.
   */
  const [talking, setTalking] = useState(false);
  const sendTurn = async (clip: Blob) => {
    setTalking(true);
    setError(null);
    setNote(null);
    try {
      const fd = new FormData();
      fd.append("audio", clip, `turn.${(clip.type.split("/")[1] ?? "webm").split(";")[0]}`);
      const res = await fetch(`/api/requests/${requestId}/voice/audio`, {
        method: "POST", body: fd, headers: { "x-resq-session": getHelperToken() ?? "none" },
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error === "speech_not_configured" ? "Voice is not set up on this server."
          : j.error === "no_counterpart" ? "Nobody has accepted this job yet."
          : j.error === "transcribe_failed" ? "Could not make out that recording. Try again."
          : "Could not send that. Try again.");
        return;
      }
      const data = (await res.json()) as { message: VoiceMessage; heard: string; spoken: boolean };
      setMessages((cur) => [...cur, data.message]);
      setNote(data.spoken ? "Sent — they will hear it in their language." : "Sent as text; the spoken version failed.");
    } catch {
      setError("Could not send that. Try again.");
    } finally {
      setTalking(false);
    }
  };
  const recorder = useRecorder({ onClip: (clip) => { void sendTurn(clip); }, onError: (e) => setError(recorderErrorText(e)) });

  const speech = useSpeech({
    lang: myLanguage,
    onText: setDraft,
    onFinal: (t) => { setDraft(t); void send(t); },  // stop speaking → it sends itself
    onError: (e) => setError(speechErrorText(e)),
  });

  const mine = languageOf(myLanguage);

  return (
    <section className={`rounded-2xl bg-white p-4 card-shadow ${className}`}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-display text-base font-bold text-resq-navy">Talk to them</h3>
        <span className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-semibold text-resq-slate">{mine.endonym}</span>
      </div>
      <p className="mt-1 text-xs text-resq-slate">
        Speak in {mine.english}. They hear it in their own language, and their reply plays here in {mine.endonym}.
      </p>

      {messages.length > 0 && (
        <ul className="mt-3 max-h-80 space-y-2 overflow-y-auto pr-1">
          {messages.map((m) => <MessageRow key={m.id} m={m} mine={me !== null && m.fromRole === me} />)}
          <div ref={endRef} />
        </ul>
      )}

      {/* Talking is the primary action here; typing is the fallback for a noisy room or a broken mic. */}
      {recorder.supported ? (
        <>
          <button
            type="button" onClick={recorder.toggle} disabled={talking} aria-pressed={recorder.recording}
            className={`mt-3 flex min-h-16 w-full items-center justify-center gap-3 rounded-2xl font-display text-lg font-bold text-white transition disabled:bg-slate-200 disabled:text-slate-500 ${
              recorder.recording ? "bg-resq-red shadow-lg" : "bg-resq-navy"}`}
          >
            {recorder.recording ? (
              <>
                <span aria-hidden className="flex items-end gap-[3px]">
                  <span className="typing-dot-1 h-3 w-1 rounded-full bg-white" />
                  <span className="typing-dot-2 h-5 w-1 rounded-full bg-white" />
                  <span className="typing-dot-3 h-4 w-1 rounded-full bg-white" />
                </span>
                Tap to send · {recorder.seconds}s
              </>
            ) : talking ? (
              <><span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />Translating…</>
            ) : (
              <><Icon.Mic size={20} />Tap to talk</>
            )}
          </button>
          {recorder.recording && recorder.seconds >= MAX_RECORD_SECONDS - 10 && (
            <p className="mt-1 text-center text-xs text-resq-slate">Stops on its own at {MAX_RECORD_SECONDS}s.</p>
          )}
        </>
      ) : null}

      <details className="mt-2">
        <summary className="cursor-pointer text-xs font-semibold text-resq-slate">Type instead</summary>
        <div className="mt-2 flex items-end gap-2">
          <textarea
            value={draft} onChange={(e) => setDraft(e.target.value)} rows={2}
            placeholder={speech.listening ? "Listening…" : `Type in ${mine.english}…`}
            className="min-h-14 flex-1 resize-none rounded-2xl border border-slate-200 p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-resq-cyan"
          />
          {!recorder.supported && speech.supported && (
            <VoiceMic listening={speech.listening} onToggle={speech.toggle} disabled={sending} className="scale-75 origin-bottom" />
          )}
        </div>
        <button
          type="button" onClick={() => void send(draft)} disabled={!draft.trim() || sending}
          className="mt-2 min-h-12 w-full rounded-2xl bg-slate-100 font-semibold text-resq-navy disabled:text-slate-400"
        >
          {sending ? "Sending…" : "Send as text"}
        </button>
      </details>

      {note && <p className="mt-2 text-sm text-resq-green">{note}</p>}
      {error && <p className="mt-2 text-sm text-resq-red">{error}</p>}
    </section>
  );
}

function MessageRow({ m, mine }: { m: VoiceMessage; mine: boolean }) {
  const from = languageOf(m.sourceLang);
  const to = languageOf(m.targetLang);
  // What I see: my own message as I said it; their message as it was translated for me.
  const headline = mine ? m.sourceText : m.translatedText;
  const beneath = mine ? m.translatedText : m.sourceText;
  const beneathLang = mine ? to : from;
  const failed = m.translationSource === "failed";

  return (
    <li className={`rounded-2xl p-3 ${mine ? "ml-6 bg-resq-navy/5" : "mr-6 bg-slate-50"}`}>
      <div className="flex items-center gap-1.5 text-xs font-semibold text-resq-slate">
        <span>{mine ? "You" : "Them"}</span>
        {m.channel === "call" && <span className="flex items-center gap-1 rounded-md bg-white px-1.5 py-0.5"><Icon.Phone size={10} />by phone</span>}
        {m.deliveryRef && <span className="rounded-md bg-white px-1.5 py-0.5">{m.deliveryRef === "simulated" ? "call simulated" : "read out by call"}</span>}
      </div>

      <p className="mt-1 text-sm text-resq-navy">{headline}</p>

      {failed ? (
        <p className="mt-1 rounded-lg bg-amber-50 p-2 text-xs text-amber-800">
          {m.translationNote ?? "Could not translate this message."} Shown in {from.endonym} as it was said.
        </p>
      ) : beneath && beneath !== headline && (
        <p className="mt-1 text-xs text-resq-slate">
          <span className="font-semibold">{beneathLang.endonym}:</span> {beneath}
        </p>
      )}

      {m.hasSpokenAudio && !mine && (
        <audio controls preload="none" className="mt-2 h-8 w-full"
          src={`/api/requests/${m.requestId}/voice/${m.id}/audio`}>
          Your browser cannot play this.
        </audio>
      )}

      {m.recordingUrl && (
        // The real voice, for when a transcript looks wrong. Twilio serves .mp3 from the recording URL.
        <audio controls preload="none" src={`${m.recordingUrl}.mp3`} className="mt-2 h-8 w-full">
          Your browser cannot play this recording.
        </audio>
      )}
    </li>
  );
}
