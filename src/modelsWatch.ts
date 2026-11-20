// The Settings Models pane's content, asked of every host: when the Models button opens it, and once
// an hour in the background. `modelsChanged` is on while any host's list or CLI version differs from
// what the pane last showed (it lights the gear and the Models button). Kept in localStorage so a
// reload keeps both the flag and the hour's count. The Default checkbox is the user's own, so it isn't compared.
import { ref } from "vue";
import { HOSTS, type HostName } from "../shared/config.ts";
import { sortModels, type ModelPick } from "../shared/types.ts";
import { postHost } from "./api.ts";

export type ModelRow = { model: string; id: string; name: string; effort: string; tokens: string };
// aliases: the names in the CLI's binary (server/cliAliases.ts), aliasesError why there are none ("" when read).
export type HostModels = { rows: ModelRow[]; version: string; defaultModel: string; limitsError: string; aliases: string[]; aliasesError: string };

const KEY = "claude3.models";
const HOUR = 3600e3;
const hosts = Object.keys(HOSTS) as HostName[];
// Per host, a string of what its pane would show: `seen` when the pane last opened, `latest` at the last check.
type Saved = { at: number; seen: Partial<Record<HostName, string>>; latest: Partial<Record<HostName, string>> };
const saved = (): Saved => JSON.parse(localStorage.getItem(KEY) ?? "null") ?? { at: 0, seen: {}, latest: {} };
const differs = (s: Saved): boolean => hosts.some((host) => s.seen[host] !== s.latest[host]);
export const modelsChanged = ref(differs(saved()));

async function loadHost(host: HostName): Promise<HostModels> {
  const [reply, version, found] = await Promise.all([
    postHost<{ payload: ModelPick & { contextTokens: Record<string, number>; limitsError: string } }>(host, "models", {}),
    postHost<{ version: string }>(host, "cliVersion", {}).then((r) => r.version, () => "?"),
    postHost<{ aliases: string[] }>(host, "modelAliases", {}).then((r) => ({ aliases: r.aliases, aliasesError: "" }), (error) => ({ aliases: [] as string[], aliasesError: error instanceof Error ? error.message : String(error) })),
  ]);
  const { models, names, ids, contextTokens, limitsError, default: defaultModel } = reply.payload;
  // The CLI lists a model's efforts weakest first, so the last is its max (none for Haiku 4.5).
  const rows = sortModels(Object.keys(models), ids).map((model) => {
    const tokens = contextTokens[ids[model] ?? ""];
    return { model, id: ids[model] || "", name: names[model] || "", effort: models[model].at(-1) ?? "", tokens: !tokens ? "" : tokens >= 1e6 ? `${tokens / 1e6}M` : `${tokens / 1000}K` };
  });
  return { rows, version, defaultModel, limitsError, ...found };
}

// Asks every host. `opened`: the pane is showing this, so it counts as seen. A host that didn't answer
// (an Error, a CLI version of "?", a failed token-limits read, or aliases it couldn't read: an older
// backend, or a binary with no table) leaves its last state alone, so an outage is no change.
export async function checkModels(opened = false): Promise<Record<HostName, HostModels | Error>> {
  const got = await Promise.all(hosts.map((host) => loadHost(host).catch((error) => (error instanceof Error ? error : new Error(String(error))))));
  const s = saved();
  s.at = Date.now();
  hosts.forEach((host, i) => {
    const m = got[i];
    // A failed token-limits read (limitsError) leaves every Tokens cell empty, which would look like a change.
    if (m instanceof Error || m.version === "?" || m.limitsError || m.aliasesError) return;
    s.latest[host] = JSON.stringify([m.version, m.rows, m.aliases]);
    // A copy saved before the aliases were part of it (two parts) is taken as seen, not as a change.
    const before = s.seen[host] === undefined ? undefined : (JSON.parse(s.seen[host]!) as unknown[]).length;
    if (opened || before === undefined || before < 3) s.seen[host] = s.latest[host];
  });
  localStorage.setItem(KEY, JSON.stringify(s));
  modelsChanged.value = differs(s);
  // Debug: what lit the red, per host (seen = what the pane last showed, latest = this check).
  if (modelsChanged.value) console.log("modelsWatch differs", opened ? "(pane open)" : "(hourly)", JSON.stringify(hosts.filter((h) => s.seen[h] !== s.latest[h]).map((h) => ({ host: h, seen: s.seen[h], latest: s.latest[h] }))));
  return Object.fromEntries(hosts.map((host, i) => [host, got[i]])) as Record<HostName, HostModels | Error>;
}

// The hourly check, the first one an hour after the last (any page's, kept in localStorage).
export function watchModels(): void {
  const tick = (): void => void checkModels().finally(() => setTimeout(tick, HOUR));
  setTimeout(tick, Math.max(0, saved().at + HOUR - Date.now()));
}
