"use client";
import { useState } from "react";
import { LANGUAGES, languageOf, type LanguageCode } from "@/lib/languages";
import { getHelperToken } from "@/lib/client/api";

/**
 * Choosing the language you read, speak and are phoned in.
 *
 * Each option is labelled in its OWN script — മലയാളം, தமிழ், ಕನ್ನಡ — because a picker that lists "Malayalam" in
 * Latin letters is useless to the person most likely to need it. The English name sits underneath as a hint for
 * anyone who is helping them set the phone up.
 *
 * Two shapes, one behaviour:
 *   - `variant="grid"` for onboarding, where there is room and the choice deserves a moment.
 *   - `variant="compact"` for the header, where it is a quiet control you can change mid-job.
 *
 * The change is optimistic. Language is the one setting where waiting on a round trip is actively unkind: if the
 * save fails we roll back and say so, rather than leaving the screen in a language they cannot read.
 */
export function LanguagePicker({ value, onChange, variant = "grid", className = "" }: {
  value: LanguageCode;
  onChange: (next: LanguageCode) => void;
  variant?: "grid" | "compact";
  className?: string;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async (next: LanguageCode) => {
    if (next === value || saving) return;
    const previous = value;
    onChange(next);            // optimistic: the screen switches immediately
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/me/language", {
        method: "PUT",
        headers: { "content-type": "application/json", "x-resq-session": getHelperToken() ?? "none" },
        body: JSON.stringify({ language: next }),
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      onChange(previous);      // never strand someone in a language they did not choose
      setError("Could not save your language. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  if (variant === "compact") {
    return (
      <label className={`relative inline-flex items-center ${className}`}>
        <span className="sr-only">Language</span>
        <select
          value={value} disabled={saving}
          onChange={(e) => void pick(e.target.value as LanguageCode)}
          className="card-shadow min-h-10 appearance-none rounded-full bg-white py-1.5 pl-3.5 pr-8 text-xs font-semibold text-ink outline-none focus-visible:ring-2 focus-visible:ring-violet disabled:opacity-60"
          title="Language"
        >
          {LANGUAGES.map((l) => (
            // The option list is rendered by the OS, which cannot be styled — endonym first is all we control.
            <option key={l.code} value={l.code} className="text-ink">{l.endonym}</option>
          ))}
        </select>
        <svg aria-hidden viewBox="0 0 20 20" className="pointer-events-none absolute right-3 h-3 w-3 fill-mist">
          <path d="M5 7l5 6 5-6z" />
        </svg>
      </label>
    );
  }

  return (
    <div className={className}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {LANGUAGES.map((l) => {
          const active = l.code === value;
          return (
            <button
              key={l.code} type="button" onClick={() => void pick(l.code)} disabled={saving}
              aria-pressed={active}
              className={`min-h-14 rounded-2xl border px-3 py-2 text-left transition disabled:opacity-60 ${
                active ? "border-resq-cyan bg-resq-cyan/10 ring-2 ring-resq-cyan/40" : "border-slate-200 bg-white hover:border-slate-300"
              }`}
            >
              <span className="block font-display text-base font-bold leading-tight text-resq-navy">{l.endonym}</span>
              {l.endonym !== l.english && <span className="block text-xs text-resq-slate">{l.english}</span>}
            </button>
          );
        })}
      </div>
      {error && <p className="mt-2 text-sm text-resq-red">{error}</p>}
    </div>
  );
}

/** "We will speak to you in മലയാളം." — used under the picker so the consequence of the choice is concrete. */
export function LanguageNote({ code }: { code: LanguageCode }) {
  const l = languageOf(code);
  return (
    <p className="mt-2 text-sm text-resq-slate">
      Messages from the other person are translated into <span className="font-semibold text-resq-navy">{l.endonym}</span>,
      and Sahaya calls you in {l.english}.
    </p>
  );
}
