import { getStations } from "@/lib/trafikverket";

export const dynamic = "force-dynamic";

/** Passenger stations: [{ sig, name, lat, lon }] */
export async function GET() {
  try {
    return Response.json(await getStations(), { headers: { "Cache-Control": "public, max-age=3600" } });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
