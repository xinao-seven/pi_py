// 访问密码锁状态：探测后端是否启用密码锁，驱动登录弹窗的显示/隐藏。
import { defineStore } from 'pinia';
import { ref } from 'vue';

import { getAuthStatus, login as apiLogin, logout as apiLogout } from '@/lib/api';
import { clearToken } from '@/lib/session';

export type AuthStatus = 'unknown' | 'ok' | 'locked' | 'disabled';

export const useAuthStore = defineStore('auth', () => {
  const status = ref<AuthStatus>('unknown');

  /**
   * 探测后端密码锁状态（App 启动时调用）：
   * - 后端未启用 → disabled（无需登录，正常进入）；
   * - 启用且令牌有效 → ok（保持登录）；
   * - 启用且无/失效令牌 → locked（弹登录框）；
   * - 请求失败（后端未起 / Python 后端无 /api/auth 返回 404）→ disabled，
   *   交给现有 refreshSessions 重试逻辑。
   */
  async function checkStatus(): Promise<void> {
    try {
      const result = await getAuthStatus();
      if (!result.enabled) {
        status.value = 'disabled';
      } else if (result.authenticated) {
        status.value = 'ok';
      } else {
        status.value = 'locked';
      }
    } catch {
      status.value = 'disabled';
    }
  }

  /** 登录：成功即持久化令牌并解锁。失败抛错给登录弹窗显示。 */
  async function login(password: string): Promise<void> {
    await apiLogin(password);
    status.value = 'ok';
  }

  /** 登出：吊销服务端会话并回到锁定状态。 */
  async function logout(): Promise<void> {
    await apiLogout();
    status.value = 'locked';
  }

  /** 收到全局 401 unauthorized 时上锁（令牌失效/被吊销）。 */
  function markLocked(): void {
    clearToken();
    status.value = 'locked';
  }

  return { status, checkStatus, login, logout, markLocked };
});
