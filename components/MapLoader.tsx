"use client";

import dynamic from "next/dynamic";

// Leaflet needs `window`, so render the map only in the browser.
const TrainMap = dynamic(() => import("./TrainMap"), { ssr: false });

export default function MapLoader() {
  return <TrainMap />;
}
