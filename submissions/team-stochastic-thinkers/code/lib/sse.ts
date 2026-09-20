/**
 * Server-Sent Events: send a full `snapshot` on connect and after every relevant event. At most one build in
 * flight (dirty flag), so bursts collapse and frames never arrive out of order. `: ping` every 15 s.
 */
import { on, type ResqEventName, type ResqEvents } from "./events";

type Filter = { [K in ResqEventName]?: (p: ResqEvents[K]) => boolean };

export function sseResponse(req: Request, build: () => Promise<unknown>, filter: Filter, minGapMs = 0): Response {
  const enc = new TextEncoder();
  let closed = false;
  const offs: Array<() => void> = [];
  let ping: ReturnType<typeof setInterval> | undefined;
  let building = false, dirty = false, last = 0;
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    offs.forEach((f) => f());
    if (ping) clearInterval(ping);
    try { ctrl.close(); } catch { /* already closed */ }
  };
  const write = (s: string) => {
    if (closed) return;
    try { ctrl.enqueue(enc.encode(s)); } catch { cleanup(); }
  };
  const push = async () => {
    if (closed) return;
    if (building) { dirty = true; return; }
    building = true;
    try {
      do {
        dirty = false;
        const wait = last + minGapMs - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        const data = await build();
        last = Date.now();
        write(`event: snapshot\ndata: ${JSON.stringify(data)}\n\n`);
      } while (dirty && !closed);
    } catch (e) {
      console.error("[sse]", e);
    } finally {
      building = false;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
      write("retry: 2000\n\n");
      for (const name of Object.keys(filter) as ResqEventName[]) {
        const f = filter[name] as ((p: unknown) => boolean) | undefined;
        offs.push(on(name, (p) => { if (!f || f(p)) void push(); }));
      }
      ping = setInterval(() => write(": ping\n\n"), 15_000);
      req.signal.addEventListener("abort", cleanup);
      void push();
    },
    cancel: cleanup,
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream", "cache-control": "no-cache, no-transform",
      connection: "keep-alive", "x-accel-buffering": "no",
    },
  });
}
