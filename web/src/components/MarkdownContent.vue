<!-- Rendered HTML is sanitized with DOMPurify before it reaches v-html. -->
<!-- 中文说明：Markdown/GFM 渲染组件：marked 渲染 + highlight.js 代码高亮，
     输出在进入 v-html 前一律经 DOMPurify 清洗。 -->
<script setup lang="ts">
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import { marked } from 'marked';
import { computed } from 'vue';

const props = defineProps<{ content: string }>();

const html = computed(() => {
  // 渲染管线：自定义代码块高亮 -> marked 渲染 -> DOMPurify 清洗
  const renderer = new marked.Renderer();
  renderer.code = ({ text, lang }) => {
    const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
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
