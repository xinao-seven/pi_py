<!-- Rendered HTML is sanitized with DOMPurify before it reaches v-html. -->
<script setup lang="ts">
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { marked } from "marked";
import { computed } from "vue";

const props = defineProps<{ content: string }>();

const html = computed(() => {
  const renderer = new marked.Renderer();
  renderer.code = ({ text, lang }) => {
    const language = lang && hljs.getLanguage(lang) ? lang : "plaintext";
    const highlighted = hljs.highlight(text, { language }).value;
    return `<pre><code class="hljs language-${language}">${highlighted}</code></pre>`;
  };
  const rendered = marked.parse(props.content, {
    async: false,
    breaks: true,
    gfm: true,
    renderer,
  });
  return DOMPurify.sanitize(String(rendered));
});
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -->
  <div class="markdown-content" v-html="html" />
</template>
