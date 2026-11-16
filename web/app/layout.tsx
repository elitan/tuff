// The root layout: the map fills the window, so there's no chrome around pages.
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "leaflet/dist/leaflet.css";
import "./styles.css";
import type { LayoutProps } from "northstack";

export default function RootLayout({ children }: LayoutProps) {
  return <>{children}</>;
}
