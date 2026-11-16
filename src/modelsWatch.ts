// The Settings Models pane's content, asked of every host: when the Models button opens it, and once
// an hour in the background. `modelsChanged` is on while any host's list or CLI version differs from
// what the pane last showed (it lights the gear and the Models button). Kept in localStorage so a
// reload keeps both the flag and the hour's count. The Default checkbox is the user's own, so it isn't compared.
import { ref } from "vue";
import { HOSTS, type HostName } from "../shared/config.ts";
import { sortModels, type ModelPick } from "../shared/types.ts";
import { postHost } from "./api.ts";

export type ModelRow = { model: string; id: string; name: string; effort: string; tokens: string };
export type HostModels = { rows: ModelRow[]; version: string; defaultModel: string; limitsError: string };

const KEY = "claude3.models";
const HOUR = 3600e3;
const hosts = Object.keys(HOSTS) as HostName[];
// Per host, a string of what its pane would show: `seen` when the pane last opened, `latest` at the last check.
type Saved = { at: number; seen: Partial<Record<HostName, string>>; latest: Partial<Record<HostName, string>> };
const saved = (): Saved => JSON.parse(localStorage.getItem(KEY) ?? "null") ?? { at: 0, seen: {}, latest: {} };
const differs = (s: Saved): boolean => hosts.some((host) => s.seen[host] !== s.latest[host]);
export const modelsChanged = ref(differs(saved()));

async function loadHost(host: HostName): Promise<HostModels> {
  const [reply, version] = await Promise.all([
    postHost<{ payload: ModelPick & { contextTokens: Record<string, number>; limitsError: string } }>(host, "models", {}),
    postHost<{ version: string }>(host, "cliVersion", {}).then((r) => r.version, () => "?"),
  ]);
  const { models, names, ids, contextTokens, limitsError, default: defaultModel } = reply.payload;
  // The CLI lists a model's efforts weakest first, so the last is its max (none for Haiku 4.5).
  const rows = sortModels(Object.keys(models), ids).map((model) => {
    const tokens = contextTokens[ids[model] ?? ""];
    return { model, id: ids[model] || "", name: names[model] || "", effort: models[model].at(-1) ?? "", tokens: !tokens ? "" : tokens >= 1e6 ? `${tokens / 1e6}M` : `${tokens / 1000}K` };
  });
  return { rows, version, defaultModel, limitsError };
}

// Asks every host. `opened`: the pane is showing this, so it counts as seen. A host that didn't answer
// (an Error, or a CLI version of "?") leaves its last state alone, so an outage is no change.
export async function checkModels(opened = false): Promise<Record<HostName, HostModels | Error>> {
  const got = await Promise.all(hosts.map((host) => loadHost(host).catch((error) => (error instanceof Error ? error : new Error(String(error))))));
  const s = saved();
  s.at = Date.now();
  hosts.forEach((host, i) => {
    const m = got[i];
    if (m instanceof Error || m.version === "?") return;
    s.latest[host] = JSON.stringify([m.version, m.rows]);
    if (opened || s.seen[host] === undefined) s.seen[host] = s.latest[host];
  });
  localStorage.setItem(KEY, JSON.stringify(s));
  modelsChanged.value = differs(s);
  return Object.fromEntries(hosts.map((host, i) => [host, got[i]])) as Record<HostName, HostModels | Error>;
}

// The hourly check, the first one an hour after the last (any page's, kept in localStorage).
export function watchModels(): void {
  const tick = (): void => void checkModels().finally(() => setTimeout(tick, HOUR));
  setTimeout(tick, Math.max(0, saved().at + HOUR - Date.now()));
}
