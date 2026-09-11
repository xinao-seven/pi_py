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

<style scoped>
/* Markdown 渲染：内部元素由 v-html 动态生成，须经 :deep() 命中；
   hljs token 配色在 globals.css 中全局定义 */
.markdown-content {
  color: var(--text);
  font-size: 14px;
  line-height: 1.75;
  overflow-wrap: anywhere;
}

.markdown-content :deep(> :first-child) {
  margin-top: 0;
}

.markdown-content :deep(> :last-child) {
  margin-bottom: 0;
}

.markdown-content :deep(p),
.markdown-content :deep(ul),
.markdown-content :deep(ol),
.markdown-content :deep(blockquote) {
  margin: 0 0 13px;
}

.markdown-content :deep(ul),
.markdown-content :deep(ol) {
  padding-left: 22px;
}

.markdown-content :deep(li + li) {
  margin-top: 4px;
}

.markdown-content :deep(h1),
.markdown-content :deep(h2),
.markdown-content :deep(h3) {
  margin: 22px 0 9px;
  color: var(--text);
  font-weight: 680;
  line-height: 1.3;
}

.markdown-content :deep(h1) {
  font-size: 21px;
}

.markdown-content :deep(h2) {
  font-size: 18px;
}

.markdown-content :deep(h3) {
  font-size: 15px;
}

.markdown-content :deep(a) {
  color: var(--accent);
  text-underline-offset: 3px;
}

.markdown-content :deep(blockquote) {
  padding: 2px 0 2px 14px;
  border-left: 2px solid #596136;
  color: var(--muted);
}

/* 表格：加边框区分单元格，宽表横向滚动而不是撑出容器（这就是“错位”的根因之一）。 */
.markdown-content :deep(table) {
  display: block;
  width: max-content;
  max-width: 100%;
  overflow-x: auto;
  margin: 13px 0;
  border: 1px solid var(--line);
  border-collapse: collapse;
  font-size: 13px;
}

.markdown-content :deep(th),
.markdown-content :deep(td) {
  padding: 6px 10px;
  border: 1px solid var(--line);
  vertical-align: top;
}

.markdown-content :deep(thead th) {
  background: var(--panel-soft);
  font-weight: 650;
}

.markdown-content :deep(tbody tr:nth-child(even)) {
  background: rgba(255, 255, 255, 0.02);
}

:root[data-theme='light'] .markdown-content :deep(tbody tr:nth-child(even)) {
  background: rgba(0, 0, 0, 0.025);
}

/* marked 把表格对齐写成 align 属性；表头默认左对齐，只在显式声明时才覆盖。 */
.markdown-content :deep(th) {
  text-align: left;
}

.markdown-content :deep(th[align='center']),
.markdown-content :deep(td[align='center']) {
  text-align: center;
}

.markdown-content :deep(th[align='right']),
.markdown-content :deep(td[align='right']) {
  text-align: right;
}

.markdown-content :deep(code:not(pre code)) {
  padding: 2px 5px;
  border: 1px solid var(--line);
  border-radius: 5px;
  color: #e7efbc;
  background: #1a1e24;
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 0.88em;
}

.markdown-content :deep(pre) {
  overflow-x: auto;
  margin: 13px 0;
  padding: 13px 14px;
  border: 1px solid var(--line);
  border-radius: 6px;
  color: #eef0f3;
  background: #0d0f13;
  scrollbar-width: thin;
}

.markdown-content :deep(pre code) {
  color: inherit;
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 12px;
  line-height: 1.65;
}

.markdown-content :deep(pre .hljs) {
  color: #eef0f3;
  background: transparent;
}

:root[data-theme='light'] .markdown-content :deep(pre),
:root[data-theme='light'] .markdown-content :deep(code:not(pre code)) {
  color: #213025;
  background: #f3f5ee;
}

:root[data-theme='light'] .markdown-content :deep(code:not(pre code)) {
  color: #324600;
  background: #edf2dc;
}

:root[data-theme='light'] .markdown-content :deep(pre .hljs) {
  color: #213025;
}
</style>
