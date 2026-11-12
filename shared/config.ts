// The hosts the backends run on, who may call those backends, and the projects they start with.
// Read by the page and by every backend, so the deploy copies this file to each host along with
// the server.

export type HostName = "wsl" | "win" | "srv";

// A project. Each backend keeps its own list of them in ~/.claude3/projects.json.
export interface Tab {
  // Never changes: what its backend record and browser storage go by, so a rename loses nothing.
  id: string;
  // The project's name, shown in its tab.
  label: string;
  host: HostName;
  // The project folder, as the host's own OS writes it.
  path: string;
  // A closed project keeps its state and its running sessions; only its tab and UI are hidden.
  open: boolean;
  // The Files tree's list of roots above the project folder; Back and Fwd move rootIdx along it. A root on
  // another host than the tab's is "<host>:<path>" (Files.vue).
  roots?: string[];
  // The root on show: -1 is the project folder, absent is the last in the list.
  rootIdx?: number;
  // Whether ./run is set up for the Run button (the deployable skill). Absent: the page asks before
  // a prompt; "started": Claude was set to it, the page asks to check; "done": the check passed;
  // "none": nothing to deploy. Either of the last two and the page stops asking.
  deploySetup?: "started" | "done" | "none";
}

// What a backend starts from until it has a list of its own. Their ids are the labels they had
// when this was the only list, which is what their drafts and pictures are stored under.
export const FIRST_TABS: Tab[] = ([
  { label: "tv", host: "wsl", path: "/root/apps/tv" },
  { label: "tv srvr", host: "srv", path: "/root/dev/apps/tv" },
  { label: "claude2", host: "wsl", path: "/root/apps/claude2" },
  { label: "claude3", host: "wsl", path: "/root/apps/claude3" },
  { label: "finance", host: "srv", path: "/root/dev/apps/finance" },
  { label: "ham win", host: "win", path: "C:\\Users\\mark\\apps\\ham" },
] satisfies Omit<Tab, "id" | "open">[]).map((tab) => ({ ...tab, id: tab.label, open: true }));

export interface Host {
  port: number;
  // The folder the Tabs dialog's picker opens on.
  appsFolder: string;
  // The folder a Term pane's terminal starts in when it was added for this host, not for the project.
  home: string;
  // Where the page (in Firefox on the laptop) reaches this backend.
  url: string;
  // The interface the backend listens on: WSL and Windows stay on the laptop, the server is on the LAN.
  bind: string;
  // The Host header names a request may carry. Anything else is a DNS-rebinding page, refused.
  names: string[];
}

export const HOSTS: Record<HostName, Host> = {
  wsl: { port: 7310, appsFolder: "/root/apps/", home: "/root", url: "http://localhost:7310", bind: "127.0.0.1", names: ["localhost", "127.0.0.1"] },
  win: { port: 7311, appsFolder: "C:\\Users\\mark\\apps", home: "C:\\Users\\mark", url: "http://localhost:7311", bind: "127.0.0.1", names: ["localhost", "127.0.0.1"] },
  srv: { port: 7312, appsFolder: "/root/dev/apps", home: "/root", url: "http://hahnca.com:7312", bind: "0.0.0.0", names: ["hahnca.com", "192.168.1.103", "localhost", "127.0.0.1"] },
};

// claude-stats (claude-stats/server.mjs, on hahnca.com): the quota history, the lease on reading it
// and the Snips, one copy for every backend.
export const STATS_URL = "http://hahnca.com:7313";

// The page's own origins: vite dev (the usual one, with hot update), vite preview, and the build
// the WSL backend serves; vite.config.ts pins the first two. A request from any other origin is
// another website reaching in, refused.
export const ORIGINS = ["5310", "4310", "7310"].flatMap((port) => [`http://localhost:${port}`, `http://127.0.0.1:${port}`]);
