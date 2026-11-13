<script setup lang="ts">
// The VS Code-style folder picker on any host, a modal dialog fed by the backend's `folders`. Shared
// by the Tabs dialog and the Files pane; its styles are Tabs.vue's. Files are listed after the folders
// (folders bold); they can't be clicked unless `files`, when it picks a file instead (the footer's File).
// The slot is left of the box: the Term pane's host selector, which calls open again for another host.
import { computed, ref } from "vue";
import { HOSTS, type HostName, type Tab } from "../../shared/config.ts";
import { postHost } from "../api.ts";

// project: the tab it serves (none in the Tabs dialog), whose folder `root` goes to on its host.
const props = defineProps<{ host: HostName; files?: boolean; project?: Tab }>();
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
  // Already open when the Term pane's selector moves it to another host.
  if (!dialog.value?.open) dialog.value?.showModal();
}

function pick(): void {
  if (!canPick.value) return;
  emit("pick", found.value.path);
  dialog.value?.close();
}

defineExpose({ open });
</script>

<template>
  <dialog ref="dialog" class="tabs-pop tabs-picker" closedby="any">
    <div class="tabs-row">
      <slot />
      <input class="tabs-input" :value="typed" autofocus spellcheck="false" aria-label="Folder path" data-help="folder picker path box" @input="list(($event.target as HTMLInputElement).value)" @keydown.enter.prevent="pick" />
      <button data-help="folder picker root" @click="list(project && host === project.host ? project.path : HOSTS[host].home)">root</button>
      <button data-help="folder picker Cancel" @click="dialog?.close()">Cancel</button>
      <button :disabled="!canPick" data-help="folder picker Ok" @click="pick">Ok</button>
    </div>
    <div v-if="error" class="tabs-error">{{ error }}</div>
    <div class="tabs-folders">
      <button v-for="entry in found.entries" :key="entry.path" class="tabs-folder" :class="{ 'tabs-dir': !entry.file }" data-help="folder picker entry" :disabled="entry.file && !files" @click="list(entry.path).then(() => entry.file && pick())">{{ entry.name }}</button>
    </div>
  </dialog>
</template>
