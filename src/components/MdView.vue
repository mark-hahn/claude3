<script setup lang="ts">
// Ctrl-Alt-X in Snips or the file editor: their text rendered as markdown, read-only, laid over the
// editor (which stays put underneath, so its size and scroll are as they were). The parent owns the
// toggle, the key, the text and the size (the editor's, so a ctrl-wheel zoom reaches it, the wheel
// being heard on the frame they share); this shows it, and alt-click copies a code block.
import { ref } from "vue";
import { copyCodeBlock } from "../copy.ts";
import { renderMarkdown } from "../render.ts";

defineProps<{ text: string; size?: number }>();
const el = ref<HTMLElement>();
defineExpose({ focus: () => el.value?.focus() });
</script>

<template>
  <!-- Inside a .pane for Pane.vue's global markdown styles. -->
  <div class="pane md-view" :style="{ fontSize: (size ?? 14) + 'px' }" @click.capture="copyCodeBlock">
    <div ref="el" class="response markdown" tabindex="-1" data-help="markdown view" data-mode="markdown view" v-html="renderMarkdown(text)"></div>
  </div>
</template>

<style scoped>
.md-view { height: auto; display: block; overflow-y: auto; background: var(--surface); }
.md-view > .response { margin: 0; border-left: none; padding: 7px 10px 3px 14px; background: transparent; overflow: visible; outline: none; }
</style>
