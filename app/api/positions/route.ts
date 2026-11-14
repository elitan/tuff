import { getPositionStream, getTrains, slim, type Position, type RawPosition } from "@/lib/trafikverket";
import { onTrack } from "@/lib/tracking";

export const dynamic = "force-dynamic";

// End each stream after a while so the browser's EventSource reconnects with a fresh upstream URL.
const STREAM_LIFETIME_MS = 10 * 60_000;

/**
 * Server-sent events proxy: relays Trafikverket's live TrainPosition stream for
 * every advertised passenger train in Sweden, so the API key never reaches the browser.
 *   event: snapshot  → Position[]   (sent once on connect)
 *   message          → Position[]   (live updates)
 */
export async function GET(req: Request) {
  const enc = new TextEncoder();
  const upstreamAbort = new AbortController();
  req.signal.addEventListener("abort", () => upstreamAbort.abort());

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: unknown, event?: string) =>
        controller.enqueue(enc.encode(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`));
      const close = () => { try { controller.close(); } catch {} };
      const timer = setTimeout(() => { upstreamAbort.abort(); close(); }, STREAM_LIFETIME_MS);

      try {
        // Trafikverket streams every train, freight included; keep advertised passenger trains.
        // getTrains() is cached (5 min), so checking it per event is cheap and picks up new trains.
        const passenger = async (ps: Position[]) => {
          const trains = await getTrains();
          return ps.filter(p => p.n in trains).sort((a, b) => a.ts - b.ts).map(onTrack);
        };

        const { snapshot, sseUrl } = await getPositionStream();
        send(await passenger(snapshot), "snapshot");

        const upstream = await fetch(sseUrl, { signal: upstreamAbort.signal, cache: "no-store" });
        if (!upstream.ok || !upstream.body) throw new Error(`upstream SSE HTTP ${upstream.status}`);

        const reader = upstream.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value.replace(/\r\n?/g, "\n");   // upstream uses CRLF line endings
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = block.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5)).join("");
            if (!data) continue;
            try {
              const positions = await passenger(
                (JSON.parse(data).RESPONSE.RESULT as { TrainPosition?: RawPosition[] }[])
                  .flatMap(r => r.TrainPosition ?? []).map(slim).filter((p): p is Position => !!p));
              if (positions.length) send(positions);
            } catch { /* ignore malformed event */ }
          }
        }
      } catch (e) {
        if (!upstreamAbort.signal.aborted) send({ error: (e as Error).message }, "upstream-error");
      } finally {
        clearTimeout(timer);
        close();
      }
    },
    cancel() { upstreamAbort.abort(); },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
