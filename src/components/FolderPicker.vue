<script setup lang="ts">
// The VS Code-style folder picker on any host, a modal dialog fed by the backend's `folders`. Shared
// by the Tabs dialog and the Files pane; its styles are Tabs.vue's.
import { computed, ref } from "vue";
import type { HostName } from "../../shared/config.ts";
import { postHost } from "../api.ts";
import { closeOnBackdrop } from "../tabList.ts";

const props = defineProps<{ host: HostName }>();
const emit = defineEmits<{ pick: [folder: string] }>();

interface Folders {
  path: string;
  entries: { name: string; path: string }[];
}

const dialog = ref<HTMLDialogElement>();
// The box, and the backend's answer for the text it was last asked about.
const typed = ref("");
const found = ref<Folders & { asked: string }>({ asked: "", path: "", entries: [] });
const error = ref("");
// Only when the answer is about what the box says now.
const canPick = computed(() => !!found.value.path && found.value.asked === typed.value);

async function list(folder: string): Promise<void> {
  typed.value = folder;
  error.value = "";
  try {
    const reply = await postHost<Folders>(props.host, "folders", { path: folder });
    if (folder === typed.value) found.value = { asked: folder, ...reply };
  } catch (problem) {
    found.value = { asked: folder, path: "", entries: [] };
    error.value = problem instanceof Error ? problem.message : String(problem);
  }
}

function open(start: string): void {
  found.value = { asked: "", path: "", entries: [] };
  void list(start);
  dialog.value?.showModal();
}

function pick(): void {
  if (!canPick.value) return;
  emit("pick", found.value.path);
  dialog.value?.close();
}

defineExpose({ open });
</script>

<template>
  <dialog ref="dialog" class="tabs-pop tabs-picker" @pointerdown="closeOnBackdrop">
    <div class="tabs-row">
      <input class="tabs-input" :value="typed" autofocus spellcheck="false" aria-label="Folder path" @input="list(($event.target as HTMLInputElement).value)" @keydown.enter.prevent="pick" />
      <button :disabled="!canPick" @click="pick">Ok</button>
    </div>
    <div v-if="error" class="tabs-error">{{ error }}</div>
    <div class="tabs-folders">
      <button v-for="entry in found.entries" :key="entry.path" class="tabs-folder" @click="list(entry.path)">{{ entry.name }}</button>
    </div>
  </dialog>
</template>
