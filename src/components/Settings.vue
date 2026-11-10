<script setup lang="ts">
// claude2's management pane, in the column the Snips use. Only its Quotas tab so far, ported from
// claude2's quotaHtml (webviews.ts) nearly verbatim: the graphs are built by script, as there, so
// the styles are global, prefixed `.settings`. Data comes from the tab's backend (server/quota.ts).
// The script uses element ids, looked up inside this pane: every tab with it open has its own.
import { onBeforeUnmount, onMounted, ref } from "vue";
import type { Tab } from "../../shared/config.ts";
import { post } from "../api.ts";

// active: this is the tab on show; a tab out of sight stops asking the backend.
const props = defineProps<{ tab: Tab; active: boolean }>();
const emit = defineEmits<{ close: [] }>();

// claude2's "Quota pane timezone" setting, at its default. ponytail: fixed until a Settings tab exists.
const timeZone = "America/Los_Angeles";
const zoom = 1;

type Reply = { ok: boolean; payload?: any; error?: string };
const backs: Record<string, number> = { five: 0, seven: 0 };
// Months back from the current one that the credits bar shows.
let creditMonth = 0;
// The tv project's Speechmatics spend by month: { usd, hrs, at, error }, undefined while an ask is out.
const speechmatics: Record<string, any> = {};
let payload: any = { readAt: null, rows: [], state: { error: null } };
let expanded: string | null = null;
let loading = true;
let updating = false;
let resizeObserver: ResizeObserver | null = null;
let unmounted = false;
const timers: number[] = [];
// Plots are drawn at their real pixel size so the axis text stays at the pane's CSS size.
const plotObserver = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const plot = entry.target as any;
    if (plot.clientWidth > 0 && plot.clientHeight > 0) plot.innerHTML = plot.draw(plot.clientWidth, plot.clientHeight);
  }
});
const root = ref<HTMLElement>();
const byId = (id: string): HTMLElement => root.value?.querySelector<HTMLElement>(`#${id}`) as HTMLElement;

// claude2's request(): the webview's message round trip, here a POST to the tab's backend.
async function request(action: string, data: Record<string, unknown>): Promise<Reply> {
  try {
    const reply = await post<any>(props.tab, action, data);
    return { ok: true, payload: "payload" in reply ? reply.payload : reply };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function load(force: boolean): Promise<void> {
  updating = force;
  // The first render asks for the current month itself; later loads refresh it, and only Update
  // makes the server rescan Speechmatics' job list instead of serving its copy.
  if (force || !loading) loadSpeechmatics(new Date().toISOString().slice(0, 7), force);
  render();
  const reply = await request("quota", { force });
  if (unmounted) return;
  loading = false;
  updating = false;
  if (reply.ok) payload = reply.payload;
  else payload.state = Object.assign({}, payload.state, { error: reply.error || "Could not load quota history." });
  render();
}

// Every 30s the stats server's newest reading (never the usage endpoint), so the panes of every
// window match. apiCosts comes only with a full load, so it is kept.
async function sync(): Promise<void> {
  if (!loading && !updating) {
    const reply = await request("quotaSync", { readAt: payload.readAt || 0, error: (payload.state && payload.state.error) || "" });
    if (unmounted) return;
    if (reply.ok && reply.payload && !updating) payload = Object.assign({}, payload, reply.payload);
  }
  render();
}

// A rescan shows "..." while it runs.
function loadSpeechmatics(month: string, rescan = false): void {
  const prior = speechmatics[month];
  if (rescan || !(month in speechmatics)) speechmatics[month] = undefined;
  void request("speechmatics", { month, rescan }).then((reply) => {
    if (unmounted) return;
    speechmatics[month] = reply.ok && reply.payload ? reply.payload : Object.assign({}, prior, { error: true });
    renderCredits();
  });
}

function render(): void {
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const update = byId("q-update") as HTMLButtonElement;
  update.disabled = updating;
  update.textContent = updating ? "Updating..." : "Update";
  const errorNode = byId("q-error");
  const error = payload.state && payload.state.error ? payload.state.error : null;
  errorNode.hidden = !error;
  errorNode.textContent = error || "";
  renderAge();
  renderCredits();
  const graphsNode = byId("q-graphs");
  const pane = root.value!;
  const five = buildWindowGraph("five", "5h", 5 * 60 * 60 * 1000, [{ field: "five_pct", reset: "five_resets", name: "5h", color: "#000" }], rows);
  const seven = buildWindowGraph("seven", "7d", 7 * 24 * 60 * 60 * 1000, [{ field: "seven_pct", reset: "seven_resets", name: "7d", color: "#2457d6" }, { field: "fable_pct", reset: "fable_resets", name: modelLabel(), color: "#c62828" }], rows);
  const graphs = [five, seven];
  const visibleGraphs = expanded ? graphs.filter((graph) => graph.key === expanded) : graphs;
  pane.className = "settings" + (expanded ? " expanded" : "");
  graphsNode.className = "graphs" + (expanded ? " single" : "");
  plotObserver.disconnect();
  graphsNode.replaceChildren();
  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = loading ? "Taking a reading..." : "Nothing recorded yet...";
    graphsNode.appendChild(empty);
    return;
  }
  for (const graph of visibleGraphs) graphsNode.appendChild(graphElement(graph));
  bindGraphControls(graphsNode);
  measureExpandedPlot();
}

function renderAge(): void {
  const age = byId("q-age");
  if (!age) return;
  age.textContent = payload.readAt ? elapsed(payload.readAt) : "";
  age.style.background = payload.state && payload.state.pausedUntil > Date.now() ? "#ffd0d0" : "";
  const asrAge = byId("q-asr-age");
  if (asrAge) asrAge.textContent = elapsed(Number(asrAge.dataset.at));
}

function elapsed(at: number): string {
  const ageMs = Math.max(0, Date.now() - at);
  return Math.floor(ageMs / 60000) + ":" + String(Math.floor((ageMs % 60000) / 1000)).padStart(2, "0");
}

// The month selector drives all three figures. Usage is the extra-usage credits spent: the current
// month takes the live reading first; otherwise, and for past months, the newest row in that
// month with a credits block. Months are UTC: credits reset at 00:00 UTC on the 1st.
function renderCredits(): void {
  const node = byId("q-credits");
  if (!node) return;
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const now = new Date();
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - creditMonth, 1);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - creditMonth + 1, 1);
  const key = new Date(start).toISOString().slice(0, 7);
  const label = new Date(start).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
  // The API key's spend (claude2's Git changes checks) is billed apart from the credits.
  const costs = payload.apiCosts && typeof payload.apiCosts === "object" ? payload.apiCosts : null;
  const older = (rows.length > 0 && rows[0].at < start) || (costs !== null && Object.keys(costs).some((month) => month < key));
  const nav = '<button data-month="older"' + (older ? "" : " disabled") + ">‹</button><span>" + label + '</span><button data-month="newer"' + (creditMonth === 0 ? " disabled" : "") + ">›</button>";
  const live = creditMonth === 0 && payload.state && payload.state.credits;
  let spent = live ? numeric(live.spentUsd) : null;
  if (spent === null) {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (rows[index].at >= start && rows[index].at < end && numeric(rows[index].spent_usd) !== null) {
        spent = numeric(rows[index].spent_usd);
        break;
      }
    }
  }
  const usage = spent === null ? "" : "<span>Sub " + escapeHtml(money(spent)) + "</span>";
  const month = costs ? costs[key] : null;
  const api = costs ? '<span title="Claude API key spend for the month: ' + (month ? month.count : 0) + ' Git changes checks">API ' + escapeHtml(money(month ? numeric(month.usd) || 0 : 0)) + "</span>" : "";
  // Speechmatics months are Los Angeles time. ERR marks a failed latest read; the age is since the last good one.
  if (!(key in speechmatics)) loadSpeechmatics(key);
  const asr = speechmatics[key];
  let speech = "<span>ASR ...</span>";
  if (asr !== undefined) {
    const parts = ["ASR"];
    if (asr.error) parts.push("ERR");
    if (typeof asr.usd === "number") parts.push(escapeHtml(money(asr.usd)));
    if (typeof asr.at === "number") parts.push('<span id="q-asr-age" data-at="' + asr.at + '">' + elapsed(asr.at) + "</span>");
    const hours = typeof asr.hrs === "number" ? escapeHtml(asr.hrs.toFixed(1)) + " audio hours" : "never read";
    speech = '<span title="tv ASR on Speechmatics: ' + hours + '">' + parts.join(" ") + "</span>";
  }
  node.innerHTML = nav + usage + api + speech;
}

function creditsClick(event: MouseEvent): void {
  const button = (event.target as HTMLElement).closest("button");
  if (!button) return;
  creditMonth += button.dataset.month === "older" ? 1 : -1;
  renderCredits();
}

function money(value: number): string {
  return "$" + Number(value).toFixed(2);
}

function graphElement(graph: any): HTMLElement {
  const graphNode = document.createElement("section");
  graphNode.className = "graph";
  const periods = graph.periods;
  const back = Math.min(backs[graph.key] || 0, Math.max(0, periods.length - 1));
  backs[graph.key] = back;
  const period = periods[periods.length - 1 - back];
  graphNode.innerHTML = '<div class="graph-head"><span class="graph-name">' + escapeHtml(graph.title) + "</span>" + legendHtml(graph) + "</div>";
  if (!period) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Nothing recorded yet...";
    graphNode.appendChild(empty);
    return graphNode;
  }
  const periodBar = document.createElement("div");
  periodBar.className = "period";
  periodBar.innerHTML = '<button data-page="older" data-key="' + graph.key + '" ' + (back >= periods.length - 1 ? "disabled" : "") + ">‹</button><span>" + escapeHtml(period.label) + '</span><button data-page="newer" data-key="' + graph.key + '" ' + (back === 0 ? "disabled" : "") + ">›</button>";
  const plot = document.createElement("div") as any;
  plot.className = "plot";
  plot.dataset.expand = graph.key;
  plot.draw = (width: number, height: number) => drawSvg(period, width, height);
  plot.innerHTML = plot.draw(256, 140);
  plotObserver.observe(plot);
  const figures = document.createElement("div");
  figures.className = "figures";
  figures.innerHTML = figuresHtml(period);
  graphNode.append(periodBar, plot, figures);
  return graphNode;
}

function bindGraphControls(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>("[data-page]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const key = button.dataset.key!;
      backs[key] = Math.max(0, (backs[key] || 0) + (button.dataset.page === "older" ? 1 : -1));
      render();
    });
  });
  root.querySelectorAll<HTMLElement>("[data-expand]").forEach((plot) => {
    plot.addEventListener("click", () => {
      expanded = expanded === plot.dataset.expand ? null : plot.dataset.expand!;
      render();
    });
  });
}

function measureExpandedPlot(): void {
  resizeObserver?.disconnect();
  resizeObserver = null;
  if (!expanded) return;
  fitExpanded();
  resizeObserver = new ResizeObserver(() => fitExpanded());
  resizeObserver.observe(byId("q-graphs"));
}

// The expanded card keeps the small graphs' 256x140 plot shape, so its width is whatever
// the leftover height allows (capped by the pane width); the flex row then centres it.
function fitExpanded(): void {
  const container = byId("q-graphs");
  const card = container && container.querySelector<HTMLElement>(".graph");
  const plot = card && card.querySelector(".plot");
  if (!container || !card || !plot) return;
  const styles = getComputedStyle(card);
  const frameX = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight) + parseFloat(styles.borderLeftWidth) + parseFloat(styles.borderRightWidth);
  const chromeY = card.getBoundingClientRect().height - plot.getBoundingClientRect().height;
  const roomWidth = container.clientWidth - frameX;
  const roomHeight = container.clientHeight - chromeY;
  const width = Math.max(256, Math.floor(Math.min(roomWidth, roomHeight * (256 / 140))));
  card.style.width = width + frameX + "px";
}

function buildWindowGraph(key: string, title: string, lengthMs: number, seriesDefs: { field: string; reset: string; name: string; color: string }[], rows: any[]): any {
  const periods: any[] = [];
  function findPeriod(end: number): any {
    let existing = periods.find((period) => Math.abs(period.end - end) <= 600000);
    if (!existing) {
      existing = { key, start: end - lengthMs, end, label: title === "5h" ? stamp(end) : dayStamp(end), series: seriesDefs.map((def) => ({ name: def.name, color: def.color, points: [] })) };
      periods.push(existing);
    }
    return existing;
  }
  for (const row of rows) {
    seriesDefs.forEach((def, index) => {
      const value = numeric(row[def.field]);
      const resetSeconds = numeric(row[def.reset]) || (key === "seven" ? numeric(row.seven_resets) : null);
      if (value === null || resetSeconds === null) return;
      const end = resetSeconds * 1000;
      if (row.at <= end || (value > 0 && row.at - end < 600000)) {
        findPeriod(end).series[index].points.push({ t: Math.min(row.at, end), v: value });
      }
    });
  }
  return { key, title, periods: periods.filter((period) => period.series.some((series: any) => series.points.length > 0)).sort((left, right) => left.end - right.end) };
}

function drawSvg(period: any, width: number, height: number): string {
  const yMax = 100;
  const yMin = 0;
  const fractions = [0, 0.5, 1];
  const labels = fractions.map((fraction) => axisLabel(yMin + (yMax - yMin) * fraction));
  // The gutter grows with the widest label or the labels run off the left edge of the viewBox.
  const fontSize = 14 * zoom;
  const labelWidth = Math.max(...labels.map((label) => label.length)) * 0.62 * fontSize;
  const margin = { left: Math.ceil(labelWidth) + 8, right: 6, top: Math.ceil(fontSize * 0.6), bottom: Math.ceil(fontSize * 0.6) + 12 };
  const plotWidth = Math.max(1, width - margin.left - margin.right);
  const plotHeight = Math.max(1, height - margin.top - margin.bottom);
  const x = (time: number) => margin.left + ((time - period.start) / (period.end - period.start)) * plotWidth;
  const y = (value: number) => margin.top + (1 - (Math.min(yMax, Math.max(yMin, value)) - yMin) / (yMax - yMin)) * plotHeight;
  let svg = '<svg viewBox="0 0 ' + width + " " + height + '" role="img">';
  fractions.forEach((fraction, index) => {
    const yValue = y(yMin + (yMax - yMin) * fraction);
    svg += '<line x1="' + margin.left + '" x2="' + (width - margin.right) + '" y1="' + yValue + '" y2="' + yValue + '" stroke="rgba(0,0,0,0.15)" />';
    svg += '<text x="' + (margin.left - 5) + '" y="' + (yValue + fontSize * 0.35) + '">' + escapeHtml(labels[index]!) + "</text>";
  });
  for (const time of gridTimes(period)) {
    const xValue = x(time);
    svg += '<line x1="' + xValue + '" x2="' + xValue + '" y1="' + margin.top + '" y2="' + (height - margin.bottom) + '" stroke="rgba(0,0,0,0.15)" />';
  }
  svg += '<line x1="' + margin.left + '" y1="' + y(0) + '" x2="' + (width - margin.right) + '" y2="' + y(yMax) + '" stroke="rgba(0,0,0,0.45)" stroke-dasharray="5 4" stroke-width="1" />';
  for (const series of period.series) {
    const points = carriedPoints(series.points, period).sort((left, right) => left.t - right.t);
    if (points.length === 1) {
      svg += '<circle cx="' + x(points[0]!.t) + '" cy="' + y(points[0]!.v) + '" r="2.4" fill="' + series.color + '" />';
    } else if (points.length > 1) {
      svg += '<polyline points="' + points.map((point) => x(point.t) + "," + y(point.v)).join(" ") + '" fill="none" stroke="' + series.color + '" stroke-width="1.6" />';
    }
  }
  return svg + "</svg>";
}

function carriedPoints(points: { t: number; v: number }[], period: any): { t: number; v: number }[] {
  const sorted = points.slice().sort((left, right) => left.t - right.t);
  if (sorted.length === 0) return sorted;
  const knownTo = Math.min(period.end, payload.readAt || Date.now());
  const last = sorted[sorted.length - 1]!;
  if (last.t < knownTo) sorted.push({ t: knownTo, v: last.v });
  return sorted;
}

function figuresHtml(period: any): string {
  const parts: string[] = [];
  for (const series of period.series) {
    const points = carriedPoints(series.points, period);
    if (points.length) parts.push("<span>" + escapeHtml(series.name + " " + axisLabel(points[points.length - 1]!.v)) + "</span>");
  }
  const done = Math.max(0, Math.min(1, (Date.now() - period.start) / (period.end - period.start)));
  parts.push("<span>" + Math.round(done * 100) + "%</span>");
  parts.push("<span>" + escapeHtml(timeLeft(period.end - Date.now())) + "</span>");
  return parts.join("");
}

function gridTimes(period: any): number[] {
  const times: number[] = [];
  const step = period.end - period.start <= 6 * 60 * 60 * 1000 ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  for (let cursor = Math.ceil(period.start / step) * step; cursor < period.end; cursor += step) {
    if (cursor > period.start) times.push(cursor);
  }
  return times;
}

function modelLabel(): string {
  const windows = payload.state && Array.isArray(payload.state.windows) ? payload.state.windows : [];
  const model = windows.find((windowState: any) => windowState.key === "model");
  return model && model.label ? model.label : "Fable";
}

function legendHtml(graph: any): string {
  if (graph.key !== "seven") return "";
  return '<span class="legend"><span class="swatch blue"></span>7d <span class="swatch red"></span>' + escapeHtml(modelLabel()) + "</span>";
}

function axisLabel(value: number): string {
  return Math.round(value) + "%";
}
function timeLeft(ms: number): string {
  if (ms <= 0) return "period over";
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return days + "d " + (hours % 24) + "h left";
  if (hours > 0) return hours + "h " + (minutes % 60) + "m left";
  return minutes + "m left";
}
function stamp(ms: number): string {
  return new Date(ms).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone });
}
function dayStamp(ms: number): string {
  return new Date(ms).toLocaleString([], { weekday: "short", month: "numeric", day: "numeric", timeZone });
}
function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

onMounted(() => {
  window.addEventListener("focus", renderAge);
  document.addEventListener("visibilitychange", renderAge);
  document.addEventListener("click", renderAge);
  timers.push(window.setInterval(() => void (props.active && load(false)), 5 * 60 * 1000), window.setInterval(renderAge, 10 * 1000), window.setInterval(() => void (props.active && sync()), 30 * 1000));
  void load(false);
});
onBeforeUnmount(() => {
  unmounted = true;
  window.removeEventListener("focus", renderAge);
  document.removeEventListener("visibilitychange", renderAge);
  document.removeEventListener("click", renderAge);
  timers.forEach((timer) => window.clearInterval(timer));
  plotObserver.disconnect();
  resizeObserver?.disconnect();
});
</script>

<template>
  <div id="q-pane" ref="root" class="settings">
    <div class="title">
      <div class="title-row">
        <!-- Tabs act as radio buttons; Quotas is the only one so far, so clicking it does nothing. -->
        <div class="tab-row"><button class="tab selected">Quotas</button></div>
        <div class="actions"><button id="q-update" @click="load(true)">Update</button><button @click="emit('close')">Close</button></div>
      </div>
      <div class="title-row"><div id="q-credits" class="credits" @click="creditsClick"></div><span id="q-age"></span></div>
    </div>
    <div id="q-error" class="error" hidden></div>
    <div id="q-graphs" class="graphs"></div>
  </div>
</template>

<style>
/* claude2's Quotas pane styles at zoom 1, under .settings. */
.settings { --blue: #2457d6; --red: #c62828; min-height: 0; display: flex; flex-direction: column; gap: 16px; padding: 4px 32px 28px; background: var(--page); font-size: 16px; line-height: 1.4; overflow: hidden; }
.settings button { padding: 7px 8px; min-height: 34px; }
/* The tabs and actions on the first line, the month's costs and the reading's age on the second. */
.settings .title { display: flex; flex-direction: column; align-items: flex-start; gap: 15px; flex: none; padding-top: 6px; }
.settings .title-row { display: flex; align-items: center; gap: 15px 30px; }
.settings .tab-row { display: flex; gap: 6px; flex: none; }
.settings .tab-row .tab.selected { background: #e2e2e2; }
.settings .actions { display: flex; align-items: center; gap: 12px; font-size: 14px; }
.settings #q-age { font-size: 14px; font-variant-numeric: tabular-nums; }
.settings .credits { display: flex; align-items: center; gap: 8px; font-size: 14px; font-variant-numeric: tabular-nums; }
.settings .credits button { min-height: 26px; padding: 2px 5px; }
.settings .graphs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; align-items: start; min-height: 0; overflow: auto; }
.settings .graphs.single { display: flex; flex: 1; min-height: 0; justify-content: center; align-items: flex-start; }
.settings .graph { width: 80%; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); padding: 11px; min-width: 0; }
.settings .graphs.single .graph { flex: none; display: flex; flex-direction: column; min-height: 0; max-width: 100%; }
.settings .graph-head { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; }
.settings .graph-name { font-weight: 700; }
.settings .legend { display: flex; align-items: center; gap: 8px; font-size: 14px; }
.settings .swatch { width: 12px; height: 2px; display: inline-block; background: var(--ink); vertical-align: middle; }
.settings .swatch.blue { background: var(--blue); }
.settings .swatch.red { background: var(--red); }
.settings .period { display: flex; align-items: center; justify-content: center; gap: 8px; margin-bottom: 8px; font-variant-numeric: tabular-nums; }
.settings .period button { min-height: 26px; padding: 2px 5px; }
.settings .plot { position: relative; width: 100%; aspect-ratio: 256 / 140; border: 1px solid var(--border); cursor: pointer; background: #fff; }
.settings .graphs.single .plot { flex: none; }
.settings .plot svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.settings svg text { font-size: 14px; fill: var(--ink); text-anchor: end; }
.settings .figures { margin-top: 8px; font-size: 14px; font-variant-numeric: tabular-nums; display: flex; gap: 10px; flex-wrap: wrap; }
.settings .empty, .settings .error { border: 1px dashed var(--border); border-radius: 8px; padding: 18px; }
.settings .error { background: #fdecec; border-style: solid; }
.settings .error[hidden] { display: none; }
/* claude2's webview-width breakpoints, measured on this column. */
.settings { container-type: inline-size; }
@container (max-width: 900px) { .settings .title-row, .settings .actions { align-items: flex-start; flex-wrap: wrap; } }
@container (max-width: 640px) { .settings .graphs { grid-template-columns: 1fr; } }
</style>
