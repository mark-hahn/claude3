<script setup lang="ts">
// claude2's Re-Auth button, up while any host's Claude login has expired. Each host has its own
// login, so one click signs in on every backend in turn, each with its own sign-in page and code.
// The page is a link, not claude2's openExternal: after the first host there is no recent click
// for the browser to allow a pop-up on.
import { nextTick, ref } from "vue";
import { HOSTS, type HostName } from "../../shared/config.ts";
import { postHost } from "../api.ts";

defineProps<{ needed: boolean }>();
const emit = defineEmits<{ closed: [] }>();

const dialog = ref<HTMLDialogElement>();
const codeEl = ref<HTMLInputElement>();
// The host being signed in, its URL once the CLI has printed one; null when the walk is over.
const step = ref<{ host: HostName; url: string } | null>(null);
const code = ref("");
const sending = ref(false);
const results = ref<string[]>([]);
let skipped = false;
// Bumped by each walk and by closing the dialog, so a walk left behind stops by itself.
let walk = 0;

const messageOf = (problem: unknown): string => (problem instanceof Error ? problem.message : String(problem));

async function signIn(host: HostName, mine: number): Promise<string> {
  skipped = false;
  sending.value = false;
  code.value = "";
  step.value = { host, url: "" };
  try {
    const { url } = await postHost<{ url: string }>(host, "login", {});
    if (mine !== walk || skipped) return "skipped";
    step.value = { host, url };
    await nextTick();
    codeEl.value?.focus();
    while (mine === walk && !skipped) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const result = await postHost<{ done: boolean; account: string; error: string }>(host, "loginResult", {});
      if (result.done && !skipped) return result.error ? `failed: ${result.error}` : `signed in as ${result.account}`;
    }
    return "skipped";
  } catch (problem) {
    return skipped ? "skipped" : `failed: ${messageOf(problem)}`;
  }
}

async function reAuth(): Promise<void> {
  const mine = ++walk;
  results.value = [];
  dialog.value?.showModal();
  for (const host of Object.keys(HOSTS) as HostName[]) {
    const outcome = await signIn(host, mine);
    if (mine !== walk) return;
    results.value.push(`${host}: ${outcome}`);
  }
  step.value = null;
}

function sendCode(): void {
  if (!step.value?.url || !code.value.trim() || sending.value) return;
  sending.value = true;
  // A refusal means the CLI is gone, which the next loginResult reports.
  void postHost(step.value.host, "loginCode", { code: code.value.trim() }).catch(() => undefined);
}

function cancelStep(): void {
  if (step.value) void postHost(step.value.host, "loginCancel", {}).catch(() => undefined);
}

function skip(): void {
  skipped = true;
  cancelStep();
}

function onClose(): void {
  walk++;
  cancelStep();
  step.value = null;
  emit("closed");
}
</script>

<template>
  <button v-if="needed" class="re-auth" data-help="Re-Auth button" @click="reAuth">Re-Auth</button>
  <dialog ref="dialog" closedby="any" class="auth-pop" @close="onClose">
    <div class="auth-title">Claude sign-in</div>
    <div v-for="line in results" :key="line" class="auth-line">{{ line }}</div>
    <form v-if="step" class="auth-step" @submit.prevent="sendCode">
      <div v-if="step.url"><strong>{{ step.host }}:</strong> <a :href="step.url" target="_blank" rel="noreferrer">open the sign-in page</a>, approve, then paste the code it shows.</div>
      <div v-else><strong>{{ step.host }}:</strong> starting…</div>
      <input ref="codeEl" v-model="code" data-help="Re-Auth code box" spellcheck="false" autocomplete="off" placeholder="authorization code" :disabled="!step.url || sending" />
      <div class="auth-buttons" data-help="Re-Auth buttons">
        <button :disabled="!code.trim() || sending">{{ sending ? "Checking…" : "Send code" }}</button>
        <button type="button" @click="skip">Skip this host</button>
      </div>
    </form>
    <div v-else class="auth-buttons" data-help="Re-Auth buttons"><button @click="dialog?.close()">Close</button></div>
  </dialog>
</template>

<style scoped>
.re-auth { background: #fbd9d9; border-color: #e4a7a7; }
.re-auth:hover { background: #f5c7c7; }
.auth-pop { width: min(560px, 92vw); padding: 12px; border: 1px solid #000; border-radius: 8px; background: var(--surface); color: var(--ink); box-shadow: 0 4px 14px rgba(0, 0, 0, 0.2); }
.auth-pop[open] { display: flex; flex-direction: column; gap: 8px; }
.auth-pop::backdrop { background: rgba(0, 0, 0, 0.15); }
.auth-title { font-weight: 600; }
.auth-line { overflow-wrap: anywhere; white-space: pre-wrap; }
.auth-step { display: flex; flex-direction: column; gap: 8px; }
.auth-step input { padding: 5px 8px; border: 1px solid var(--border); border-radius: 6px; background: #fff; color: var(--ink); font: inherit; }
.auth-step input::placeholder { color: var(--ink); opacity: 1; }
.auth-buttons { display: flex; gap: 8px; }
</style>
