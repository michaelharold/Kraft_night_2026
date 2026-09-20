"use client";
import { Icon } from "./icons";

/**
 * Round hands-free microphone button (docs/UPGRADE.md §4). Tap once to start; recognition stops by itself on silence.
 * Idle: a slow soft halo invites the tap. Listening: the button turns red with two fast expanding rings.
 * The parent hides it when speech recognition is unsupported (lib/client/speech.ts → `supported`).
 */
export function VoiceMic({ listening, onToggle, disabled = false, className = "" }: {
  listening: boolean; onToggle: () => void; disabled?: boolean; className?: string;
}) {
  return (
    <span className={`relative inline-flex h-16 w-16 flex-shrink-0 items-center justify-center ${className}`}>
      {listening ? (
        <>
          <span aria-hidden className="absolute inset-0 animate-ping rounded-full bg-resq-red/50" />
          <span aria-hidden className="absolute inset-1.5 animate-ping rounded-full bg-resq-red/40 [animation-delay:.45s]" />
        </>
      ) : !disabled && (
        <span aria-hidden className="absolute inset-3 animate-ping rounded-full bg-resq-red/20 [animation-duration:2.4s]" />
      )}
      <button type="button" onClick={onToggle} disabled={disabled} aria-pressed={listening}
        aria-label={listening ? "Listening. Tap to stop and send what you said" : "Speak your emergency hands-free"}
        title={listening ? "Listening… tap to stop" : "Tap and speak"}
        className={`relative flex h-16 w-16 items-center justify-center rounded-full text-white shadow-lg outline-none transition-transform focus-visible:ring-4 focus-visible:ring-resq-red/40 active:scale-95 disabled:opacity-50 ${listening ? "scale-105 bg-resq-red" : "bg-emergency-gradient"}`}>
        {listening ? (
          <span aria-hidden className="flex items-end gap-[3px]">
            <span className="typing-dot-1 h-3 w-1 rounded-full bg-white" />
            <span className="typing-dot-2 h-5 w-1 rounded-full bg-white" />
            <span className="typing-dot-3 h-4 w-1 rounded-full bg-white" />
            <span className="typing-dot-1 h-2.5 w-1 rounded-full bg-white" />
          </span>
        ) : <Icon.Mic size={26} />}
      </button>
    </span>
  );
}
