<!--
  提问弹窗（M4.1）：Agent 通过 ask_user 工具向用户提问时的交互界面。

  中文说明：与「危险命令审批弹窗」并列的第二种外部输入。设计要点：
  - 一次可以问多个问题，填完一起提交（减少来回）；
  - 每题按声明渲染：有 options 就是单选/多选（multiSelect），否则自由输入；
    `allowFreeText !== false` 时总是保留「其他（自行输入）」——选项永远可能不全；
  - 未回答的题按「跳过」提交（服务端也会补齐），不会因为漏填而卡住；
  - 「让 AI 自己决定」= 取消回答，模型会按最合理的假设继续并写明假设（不是报错）。
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { PendingQuestion, QuestionAnswer } from '@/types';

const props = defineProps<{
  pending: PendingQuestion;
  busy?: boolean;
}>();

const emit = defineEmits<{
  submit: [answers: QuestionAnswer[]];
  cancel: [];
}>();

/** 每题的作答状态：选中的选项 + 自由输入文本。 */
const draft = ref<Record<string, { selected: string[]; text: string }>>({});

function reset(pending: PendingQuestion): void {
  const next: Record<string, { selected: string[]; text: string }> = {};
  for (const question of pending.questions) next[question.id] = { selected: [], text: '' };
  draft.value = next;
}
watch(() => props.pending.questionId, () => reset(props.pending), { immediate: true });

function stateOf(id: string): { selected: string[]; text: string } {
  return draft.value[id] ?? { selected: [], text: '' };
}

function toggleOption(id: string, option: string, multiSelect: boolean): void {
  const current = stateOf(id);
  if (multiSelect) {
    const selected = current.selected.includes(option)
      ? current.selected.filter((item) => item !== option)
      : [...current.selected, option];
    draft.value = { ...draft.value, [id]: { ...current, selected } };
    return;
  }
  // 单选：再点一次取消选择（允许「不选任何项但自由输入」）
  const selected = current.selected.includes(option) ? [] : [option];
  draft.value = { ...draft.value, [id]: { ...current, selected } };
}

function setText(id: string, text: string): void {
  draft.value = { ...draft.value, [id]: { ...stateOf(id), text } };
}

/** 是否每题都有答复（选了选项或写了文本）；没有则提示但仍允许提交（按跳过处理）。 */
const answeredCount = computed(
  () =>
    props.pending.questions.filter((question) => {
      const state = stateOf(question.id);
      return state.selected.length > 0 || state.text.trim().length > 0;
    }).length,
);
const allAnswered = computed(() => answeredCount.value === props.pending.questions.length);

function submit(): void {
  if (props.busy) return;
  emit(
    'submit',
    props.pending.questions.map((question) => {
      const state = stateOf(question.id);
      const text = state.text.trim();
      return {
        id: question.id,
        selected: state.selected,
        ...(text.length === 0 ? {} : { text }),
        ...(state.selected.length === 0 && text.length === 0 ? { skipped: true } : {}),
      };
    }),
  );
}
</script>

<template>
  <div class="dialog-backdrop" role="presentation">
    <section class="question-dialog" role="dialog" aria-modal="true" aria-label="Agent 的提问">
      <header class="question-head">
        <span class="question-badge">Agent 提问</span>
        <span class="question-progress">{{ answeredCount }}/{{ pending.questions.length }} 已答</span>
      </header>

      <p class="question-intro">
        回答会直接作为工具结果交给 Agent（它正在等这一步），因此不必再发一条消息。
      </p>

      <ol class="question-list">
        <li v-for="(question, index) in pending.questions" :key="question.id" class="question-item">
          <div class="question-title">
            <span class="question-index">{{ index + 1 }}</span>
            <div>
              <strong>{{ question.question }}</strong>
              <small v-if="question.details">{{ question.details }}</small>
              <small v-if="question.multiSelect" class="question-hint">可多选</small>
            </div>
          </div>

          <!--
            选项用 button + aria-checked 而不是原生 radio/checkbox：
            中文说明：原生控件在「label 包裹 input」时点击会同时触发 label 激活与 change，
            很容易变成「点一下切换两次」（测试与真实浏览器都踩过）。这里自己管状态，
            键盘用 Enter/Space 天然可用，语义靠 role/aria-checked 保留。
          -->
          <div v-if="question.options?.length" class="question-options">
            <button
              v-for="option in question.options"
              :key="option"
              type="button"
              class="question-option"
              :class="{ 'question-option--selected': stateOf(question.id).selected.includes(option) }"
              :role="question.multiSelect ? 'checkbox' : 'radio'"
              :aria-checked="stateOf(question.id).selected.includes(option)"
              :disabled="busy"
              @click="toggleOption(question.id, option, question.multiSelect === true)"
            >
              <span class="question-mark" aria-hidden="true">
                {{ stateOf(question.id).selected.includes(option) ? '✓' : '' }}
              </span>
              <span>{{ option }}</span>
            </button>
          </div>

          <textarea
            v-if="question.allowFreeText !== false"
            class="question-text"
            rows="2"
            :placeholder="question.options?.length ? '其他 / 补充说明（可留空）' : '请输入你的回答'"
            :value="stateOf(question.id).text"
            :disabled="busy"
            @input="setText(question.id, ($event.target as HTMLTextAreaElement).value)"
          />
          <p v-else class="question-hint">此題只能从上面的选项中选择。</p>
        </li>
      </ol>

      <footer class="question-actions">
        <span v-if="!allAnswered" class="question-warn">
          还有 {{ pending.questions.length - answeredCount }} 题没答（未答的会按「跳过」提交）
        </span>
        <span class="question-spacer" />
        <button class="question-cancel" type="button" :disabled="busy" @click="emit('cancel')">
          让 AI 自己决定
        </button>
        <button class="question-submit" type="button" :disabled="busy" @click="submit">
          {{ busy ? '提交中…' : '提交回答' }}
        </button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
/* 提问弹窗：与审批弹窗同风格（居中卡片 + 半透明遮罩） */
.dialog-backdrop {
  position: fixed;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.55);
  inset: 0;
}

.question-dialog {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(560px, 100%);
  max-height: min(80vh, 720px);
  padding: 14px 16px;
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
}

.question-head {
  display: flex;
  gap: 8px;
  align-items: center;
}

.question-badge {
  padding: 1px 7px;
  border: 1px solid var(--accent);
  border-radius: 999px;
  color: var(--accent);
  font-size: 10px;
}

.question-progress {
  color: var(--faint);
  font-size: 10px;
}

.question-intro {
  margin: 0;
  color: var(--faint);
  font-size: 11px;
}

.question-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.question-item {
  padding-top: 10px;
  border-top: 1px solid var(--line);
}

.question-item:first-child {
  padding-top: 0;
  border-top: 0;
}

.question-title {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  font-size: 12px;
}

.question-index {
  min-width: 16px;
  color: var(--faint);
  font-variant-numeric: tabular-nums;
  font-size: 10px;
}

.question-title small {
  display: block;
  margin-top: 3px;
  color: var(--faint);
  font-size: 10px;
}

.question-hint {
  color: var(--faint);
  font-size: 10px;
}

.question-options {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 8px 0 0;
}

.question-option {
  display: flex;
  gap: 7px;
  align-items: center;
  padding: 5px 8px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  font-family: inherit;
  font-size: 12px;
  text-align: left;
}

.question-option:hover:not(:disabled) {
  border-color: var(--accent);
}

.question-option:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.question-mark {
  display: inline-block;
  width: 12px;
  color: var(--accent);
}

.question-option--selected {
  border-color: var(--accent);
  background: rgba(231, 255, 111, 0.08);
}

.question-text {
  width: 100%;
  margin-top: 8px;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
  font-family: inherit;
  font-size: 12px;
  resize: vertical;
}

.question-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.question-warn {
  color: var(--faint);
  font-size: 10px;
}

.question-spacer {
  flex: 1;
}

.question-cancel,
.question-submit {
  padding: 4px 11px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 11px;
}

.question-submit {
  border-color: var(--accent);
  color: var(--accent);
}

.question-submit:hover:not(:disabled) {
  background: rgba(231, 255, 111, 0.08);
}

.question-cancel:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--text);
}

.question-cancel:disabled,
.question-submit:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
</style>
