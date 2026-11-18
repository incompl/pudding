// The station list lives natively (Stations.swift, as an app setting); this is
// the web layer's view of it, over the `stations` script message handler.

// Same shape as desktop's Stream (apps/desktop/src/types.ts).
export interface Station {
  name: string;
  url: string;
  image?: string | null;
}

type Request = { op: "list" } | { op: "save"; stations: Station[] };

interface Handler {
  postMessage(request: Request): Promise<unknown>;
}

declare global {
  interface Window {
    webkit?: { messageHandlers?: { stations?: Handler } };
  }
}

function bridge(): Handler {
  const handler = window.webkit?.messageHandlers?.stations;
  if (!handler) throw new Error("No native shell: open the app in the simulator (pnpm sim)");
  return handler;
}

export async function listStations(): Promise<Station[]> {
  return (await bridge().postMessage({ op: "list" })) as Station[];
}

export async function saveStations(stations: Station[]): Promise<void> {
  await bridge().postMessage({ op: "save", stations });
}
