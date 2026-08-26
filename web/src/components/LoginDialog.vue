<!-- 访问密码登录弹窗：作为整页门禁，未输入正确密码无法进入。 -->
<script setup lang="ts">
import { ref } from 'vue';

import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const password = ref('');
const pending = ref(false);
const error = ref<string | null>(null);

async function submit(): Promise<void> {
  if (!password.value.trim() || pending.value) return;
  pending.value = true;
  error.value = null;
  try {
    await auth.login(password.value);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '密码错误，请重试';
    password.value = '';
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <div class="modal-backdrop">
    <section
      class="config-dialog login-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="login-title"
    >
      <header class="config-header">
        <div>
          <div class="welcome-kicker">PASSWORD PROTECTED</div>
          <h2 id="login-title">访问需要密码</h2>
          <p>此服务已启用访问密码锁，输入密码后才能继续。</p>
        </div>
      </header>

      <form class="login-form" @submit.prevent="submit">
        <label for="login-password-input">访问密码</label>
        <input
          id="login-password-input"
          v-model="password"
          type="password"
          autofocus
          autocomplete="current-password"
          placeholder="请输入访问密码"
        />
        <button type="submit" class="primary-action" :disabled="!password.trim() || pending">
          {{ pending ? '验证中…' : '进入' }}
        </button>
      </form>

      <div v-if="error" class="config-error" role="alert">{{ error }}</div>
    </section>
  </div>
</template>

<style scoped>
.login-dialog {
  max-width: 380px;
}

.login-form {
  display: grid;
  gap: 0.75rem;
  padding: 1rem 1.5rem;
}

.login-form label {
  font-size: 0.85rem;
  color: var(--muted);
}

.login-form input {
  width: 100%;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--line-strong);
  border-radius: 0.5rem;
  background: var(--panel);
  color: var(--text);
}

.login-form .primary-action {
  justify-self: stretch;
}
</style>
