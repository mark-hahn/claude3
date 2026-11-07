// The page's side of a backend (server/main.ts): commands go up as POSTs, everything else comes
// down the tab's event stream.
import { HOSTS, type Tab } from "../shared/config.ts";
import type { ServerEvent } from "../shared/types.ts";

export async function post<T = Record<string, unknown>>(tab: Tab, action: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${HOSTS[tab.host].url}/api/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tab: tab.label, ...body }),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `${tab.host} backend: ${res.status} ${res.statusText}`);
  return data;
}

// EventSource reconnects on its own after an error; each reconnect starts with a full state event.
export function listen(tab: Tab, onEvent: (event: ServerEvent) => void, onConnected: (up: boolean) => void): EventSource {
  const source = new EventSource(`${HOSTS[tab.host].url}/events?tab=${encodeURIComponent(tab.label)}`);
  source.onmessage = (message) => onEvent(JSON.parse(message.data as string) as ServerEvent);
  source.onopen = () => onConnected(true);
  source.onerror = () => onConnected(false);
  return source;
}
