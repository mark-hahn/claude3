// The tabs, the hosts their backends run on, and who may call those backends. Read by the page and
// by every backend, so the deploy copies this file to each host along with the server.

export type HostName = "wsl" | "win" | "srv";

export interface Tab {
  label: string;
  host: HostName;
  // The project folder, as the host's own OS writes it.
  path: string;
}

export const TABS: Tab[] = [
  { label: "tv", host: "wsl", path: "/root/apps/tv" },
  { label: "tv srvr", host: "srv", path: "/root/dev/apps/tv" },
  { label: "claude2", host: "wsl", path: "/root/apps/claude2" },
  { label: "claude3", host: "wsl", path: "/root/apps/claude3" },
  { label: "finance", host: "srv", path: "/root/dev/apps/finance" },
  { label: "ham win", host: "win", path: "C:\\Users\\mark\\apps\\ham" },
];

export interface Host {
  port: number;
  // Where the page (in Firefox on the laptop) reaches this backend.
  url: string;
  // The interface the backend listens on: WSL and Windows stay on the laptop, the server is on the LAN.
  bind: string;
  // The Host header names a request may carry. Anything else is a DNS-rebinding page, refused.
  names: string[];
}

export const HOSTS: Record<HostName, Host> = {
  wsl: { port: 7310, url: "http://localhost:7310", bind: "127.0.0.1", names: ["localhost", "127.0.0.1"] },
  win: { port: 7311, url: "http://localhost:7311", bind: "127.0.0.1", names: ["localhost", "127.0.0.1"] },
  srv: { port: 7312, url: "http://hahnca.com:7312", bind: "0.0.0.0", names: ["hahnca.com", "192.168.1.103", "localhost", "127.0.0.1"] },
};

// The page's own origins: vite dev (the usual one, with hot update), vite preview, and the build
// the WSL backend serves; vite.config.ts pins the first two. A request from any other origin is
// another website reaching in, refused.
export const ORIGINS = ["5310", "4310", "7310"].flatMap((port) => [`http://localhost:${port}`, `http://127.0.0.1:${port}`]);
