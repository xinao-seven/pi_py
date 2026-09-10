/**
 * 任务执行租约（M3）：防双跑 + 心跳续期。
 *
 * 中文说明：断点续跑最先要解决的不是「怎么继续」，而是「谁在跑」。租约提供两件事：
 * 1. **防双跑**：同一任务同时只能被一个 owner 持有，第二个 acquire 直接失败（任务只读）；
 * 2. **中断判定**：租约过期且任务仍在推进 → 疑似中断，进入恢复清单。
 *
 * `owner` 由 `pid + 每次进程启动生成的 bootId` 组成：重启后 owner 必然不同，
 * 因此不需要额外的「上次是谁在跑」的记录——旧租约一定是过期的。
 *
 * TTL 与续期间隔的关系：TTL 30s、每 10s 续一次，容忍单次续期失败或事件循环卡顿。
 * 崩溃后最多 30s 就能被判定为中断（恢复清单是启动时扫的，所以通常更久也不影响）。
 */

import { randomUUID } from 'node:crypto';

import type { TaskExecution, TaskLease } from './platform/task-model.js';

/** 租约有效期（毫秒）。 */
export const DEFAULT_LEASE_TTL_MS = 30_000;
/** 续期间隔（毫秒）：TTL 的 1/3。 */
export const DEFAULT_RENEW_INTERVAL_MS = 10_000;

/**
 * 生成本进程的租约 owner：`${pid}-${bootId}`。
 * 中文说明：bootId 每次调用都会生成——调用方（服务启动时）只应调用一次并存下来，
 * 否则同一进程里的两次调用会被当成两个不同的持有者。
 */
export function createLeaseOwner(pid: number = process.pid): string {
  return `${pid}-${randomUUID()}`;
}

/** 租约快照（供恢复清单/日志展示）。 */
export interface LeaseView {
  active: boolean;
  owner?: string;
  expiresAt?: string;
  /** 是否被**其它** owner 持有且仍活跃（→ 该任务目前只读）。 */
  heldByOther: boolean;
}

/** 读取任务的租约状态。 */
export function leaseView(execution: TaskExecution, owner: string, nowMs: number): LeaseView {
  const lease = execution.lease;
  if (lease === undefined) return { active: false, heldByOther: false };
  const expiresMs = Date.parse(lease.expiresAt);
  const active = Number.isFinite(expiresMs) && expiresMs > nowMs;
  return {
    active,
    owner: lease.owner,
    expiresAt: lease.expiresAt,
    heldByOther: active && lease.owner !== owner,
  };
}

/** 计算新的租约（acquire / renew 共用）。 */
export function leaseUntil(owner: string, nowMs: number, ttlMs: number): TaskLease {
  return { owner, expiresAt: new Date(nowMs + ttlMs).toISOString() };
}

/**
 * 保活句柄：为一个任务定期续租，dispose() 时停止。
 *
 * 中文说明：续期失败（例如任务被删、或另一个进程抢走了租约）会回调 `onLost`，
 * 由调用方决定是中止执行还是只记日志——租约模块不自己决定要不要停掉 agent。
 */
export class TaskLeaseKeeper {
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private readonly handlers: {
      renew: () => void;
      onLost?: (error: unknown) => void;
      intervalMs?: number;
    },
  ) {}

  /** 开始续期（幂等）。 */
  start(): void {
    if (this.timer !== undefined || this.stopped) return;
    const interval = this.handlers.intervalMs ?? DEFAULT_RENEW_INTERVAL_MS;
    this.timer = setInterval(() => {
      if (this.stopped) return;
      try {
        this.handlers.renew();
      } catch (error) {
        this.handlers.onLost?.(error);
      }
    }, interval);
    // 续期定时器不应该阻止进程退出。
    this.timer.unref?.();
  }

  /** 停止续期（不自动释放租约，释放由调用方显式做）。 */
  dispose(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}
