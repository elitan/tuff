import { getTrains } from "@/lib/trafikverket";

export const dynamic = "force-dynamic";

/** Mälartåg trains running now: { [trainNumber]: { from, to } } */
export async function GET() {
  try {
    return Response.json(await getTrains());
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
