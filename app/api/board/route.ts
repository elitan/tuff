import { getBoard } from "@/lib/trafikverket";

export const dynamic = "force-dynamic";

/** Departures and arrivals for one station: /api/board?station=Cst */
export async function GET(req: Request) {
  const sig = new URL(req.url).searchParams.get("station");
  if (!sig) return Response.json({ error: "missing ?station=" }, { status: 400 });
  try {
    const board = await getBoard(sig);
    return board ? Response.json(board) : Response.json({ error: "unknown station" }, { status: 404 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
