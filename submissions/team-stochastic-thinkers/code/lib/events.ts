/**
 * Sahaya in-process event bus (README §6 "Realtime", §10 rule 4; CONTRACTS §5, §8).
 *
 * SINGLE-PROCESS ASSUMPTION
 * -------------------------
 * The whole API runs as ONE Node process on a laptop (Ollama already forces this),
 * so a plain Node `EventEmitter` is the entire realtime layer: `lib/waves.ts` and the
 * helper routes emit here *after* persisting through the store, and the SSE routes
 * (`/api/requests/:id/stream`, `/api/helpers/:id/stream`, `/api/ops/stream`) forward
 * the events to browsers. There is NO multi-instance pub/sub by design (README §10
 * rule 4): events never leave this process, and the store never emits (CONTRACTS §3).
 *
 * If a multi-process deploy ever happens (several Next instances, serverless, a
 * separate worker), this file is the single place to replace: swap the transport
 * underneath for Redis pub/sub, Firestore listeners or a change stream and keep the
 * exported API (`ResqEvents`, `emit`, `on`, `off`) so nothing else changes.
 *
 * The emitter lives on `globalThis.__resq_events` so Turbopack module re-evaluation
 * in `next dev` (HMR) never creates a second emitter and silently orphans the SSE
 * subscribers registered on the first one (CONTRACTS §8).
 */
import { EventEmitter } from "node:events";
import type { Dispatch, Helper, HelpRequest } from "./types";

/** Event names and payloads (CONTRACTS §5). */
export type ResqEvents = {
  "request:updated": { request: HelpRequest };
  "dispatch:created": { dispatch: Dispatch; request: HelpRequest };
  "dispatch:updated": { dispatch: Dispatch; request: HelpRequest };
  "helper:updated": { helper: Helper };
};

export type ResqEventName = keyof ResqEvents;

/** A subscriber. May be async; a rejected promise is logged, never rethrown. */
export type ResqHandler<K extends ResqEventName> = (payload: ResqEvents[K]) => void | Promise<void>;

// The emitter itself is untyped on purpose: Node's generic `EventEmitter<Map>` cannot be
// resolved for an unresolved `K` inside the generic wrappers below. Type safety comes from
// the exported `emit` / `on` / `off` signatures, which are the only way in or out.
const g = globalThis as unknown as { __resq_events?: EventEmitter };

function createEmitter(): EventEmitter {
  const e = new EventEmitter();
  // Every SSE connection subscribes; the default limit of 10 would only produce
  // spurious MaxListenersExceededWarning noise (CONTRACTS §5).
  e.setMaxListeners(0);
  return e;
}

const emitter: EventEmitter = (g.__resq_events ??= createEmitter());

/**
 * Deliver `payload` to every current subscriber of `name`.
 *
 * Iterates the listeners itself (not `emitter.emit`) and wraps each call — and any
 * promise it returns — in try/catch, logging `[events]` and never rethrowing, so one
 * broken subscriber can neither block the others nor throw into the emitting route
 * (CONTRACTS §5). Callers must persist their writes before emitting (CONTRACTS §4).
 */
export function emit<K extends ResqEventName>(name: K, payload: ResqEvents[K]): void {
  // listeners() returns a copy, so a handler that unsubscribes mid-dispatch is safe.
  for (const listener of emitter.listeners(name)) {
    try {
      const result: unknown = listener(payload);
      if (result instanceof Promise) {
        result.catch((err: unknown) => {
          console.error("[events]", name, err);
        });
      }
    } catch (err) {
      console.error("[events]", name, err);
    }
  }
}

/** Subscribe to `name`. Returns an unsubscribe function (safe to call more than once). */
export function on<K extends ResqEventName>(name: K, handler: ResqHandler<K>): () => void {
  emitter.on(name, handler);
  return () => off(name, handler);
}

/** Remove a handler previously passed to `on`. No-op when it is not subscribed. */
export function off<K extends ResqEventName>(name: K, handler: ResqHandler<K>): void {
  emitter.off(name, handler);
}
