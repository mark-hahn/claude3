<script setup lang="ts">
// The VS Code-style folder picker on any host, a modal dialog fed by the backend's `folders`. Shared
// by the Tabs dialog and the Files pane; its styles are Tabs.vue's. With `files` it picks a file
// instead (the footer's File): files are listed after the folders, in plain type, and a click picks one.
import { computed, ref } from "vue";
import type { HostName } from "../../shared/config.ts";
import { postHost } from "../api.ts";
import { closeOnBackdrop } from "../tabList.ts";

const props = defineProps<{ host: HostName; files?: boolean }>();
const emit = defineEmits<{ pick: [folder: string] }>();

interface Folders {
  path: string;
  // The path is a file's (file picker only).
  file?: boolean;
  entries: { name: string; path: string; file?: boolean }[];
}

const dialog = ref<HTMLDialogElement>();
// The box, and the backend's answer for the text it was last asked about.
const typed = ref("");
const found = ref<Folders & { asked: string }>({ asked: "", path: "", entries: [] });
const error = ref("");
// The host it was opened on: the prop's, unless open was given another.
let host: HostName = props.host;
// Only when the answer is about what the box says now, and is a folder or a file as wanted.
const canPick = computed(() => !!found.value.path && found.value.asked === typed.value && !!found.value.file === !!props.files);

async function list(folder: string): Promise<void> {
  typed.value = folder;
  error.value = "";
  try {
    const reply = await postHost<Folders>(host, "folders", { path: folder, files: !!props.files });
    if (folder === typed.value) found.value = { asked: folder, ...reply };
  } catch (problem) {
    found.value = { asked: folder, path: "", entries: [] };
    error.value = problem instanceof Error ? problem.message : String(problem);
  }
}

function open(start: string, on: HostName = props.host): void {
  host = on;
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
      <button @click="dialog?.close()">Cancel</button>
    </div>
    <div v-if="error" class="tabs-error">{{ error }}</div>
    <div class="tabs-folders">
      <button v-for="entry in found.entries" :key="entry.path" class="tabs-folder" :class="{ 'tabs-dir': files && !entry.file }" @click="list(entry.path).then(() => entry.file && pick())">{{ entry.name }}</button>
    </div>
  </dialog>
</template>
