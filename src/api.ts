// The page's side of a backend (server/main.ts): commands go up as POSTs, everything else comes
// down the backend's event stream, one for all its projects.
import { reactive } from "vue";
import { HOSTS, type HostName, type Tab } from "../shared/config.ts";
import type { ServerEvent, StreamEvent } from "../shared/types.ts";

// The backends whose Claude login needs renewing, as each last said.
export const authNeeded = reactive<Record<HostName, boolean>>({ wsl: false, win: false, srv: false });

export async function postHost<T = Record<string, unknown>>(host: HostName, action: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${HOSTS[host].url}/api/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `${host} backend: ${res.status} ${res.statusText}`);
  return data;
}

export function post<T = Record<string, unknown>>(tab: Tab, action: string, body: Record<string, unknown>): Promise<T> {
  return postHost<T>(tab.host, action, { tab: tab.id, ...body });
}

interface Listener {
  onEvent: (event: ServerEvent) => void;
  onConnected: (up: boolean) => void;
}
interface Stream {
  source: EventSource | null;
  up: boolean;
  listeners: Map<string, Listener>;
  // A project's full state that arrived before its Project was mounted.
  held: Map<string, ServerEvent>;
}

// One stream per backend, shared by its projects: an open stream holds a connection and browsers
// allow about 6 per server, so one each would hang the page at a host's 6th project.
const streams = new Map<HostName, Stream>();
let onTabs: (host: HostName, tabs: Tab[]) => void = () => undefined;
import.meta.hot?.dispose(() => streams.forEach((stream) => stream.source?.close()));

function openStream(host: HostName, stream: Stream): void {
  const source = new EventSource(`${HOSTS[host].url}/events`);
  stream.source = source;
  const setUp = (up: boolean): void => {
    stream.up = up;
    stream.listeners.forEach((listener) => listener.onConnected(up));
  };
  source.onopen = () => setUp(true);
  source.onerror = () => {
    setUp(false);
    // A dropped connection reconnects on its own, starting with a full state. A refused one doesn't.
    if (source.readyState === EventSource.CLOSED) window.setTimeout(() => openStream(host, stream), 3000);
  };
  source.onmessage = (message) => {
    const event = JSON.parse(message.data as string) as StreamEvent;
    if (event.type === "projects") return onTabs(host, event.tabs);
    if (event.type === "auth") return void (authNeeded[host] = event.needed);
    const listener = stream.listeners.get(event.tab);
    if (listener) listener.onEvent(event);
    else if (event.type === "state") stream.held.set(event.tab, event);
  };
}

// Starts the streams, once; handed each backend's list of projects as it arrives and changes.
export function connect(tabsChanged: (host: HostName, tabs: Tab[]) => void): void {
  onTabs = tabsChanged;
  for (const host of Object.keys(HOSTS) as HostName[]) {
    if (streams.has(host)) continue;
    const stream: Stream = { source: null, up: false, listeners: new Map(), held: new Map() };
    streams.set(host, stream);
    openStream(host, stream);
  }
}

// One project's events; returns the call that stops them.
export function listen(tab: Tab, onEvent: (event: ServerEvent) => void, onConnected: (up: boolean) => void): () => void {
  const stream = streams.get(tab.host)!;
  stream.listeners.set(tab.id, { onEvent, onConnected });
  onConnected(stream.up);
  const held = stream.held.get(tab.id);
  if (held) {
    stream.held.delete(tab.id);
    onEvent(held);
  }
  return () => void stream.listeners.delete(tab.id);
}
