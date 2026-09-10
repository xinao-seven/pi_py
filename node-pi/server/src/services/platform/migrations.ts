/**
 * 平台库（platform.db）的建表与版本迁移。
 *
 * 中文说明：迁移用 SQLite 内置的 `PRAGMA user_version` 做版本号，不需要额外的
 * 迁移记录表；每个版本是一组幂等 DDL 语句，按顺序补齐到目标版本。
 *
 * 设计要点（都直接来自 M0 的实测结论）：
 * - `steps.blocked_by` 必须存在：SDK 对「策略拦截」与「工具真实失败」都只发
 *   `tool_execution_end(isError=true)`，缺这一列会把被正确拦下的调用统计成失败；
 * - `steps.day` / `runs.day`：预聚合按 UTC 日期分桶，读路径不再对原始表做全表扫描；
 * - `runs.parent_run_id`：M5 subagent 需要，建表时就加上，避免后续再迁移；
 * - 预聚合表（run_rollups / tool_rollups / approval_rollups）在**写入时**增量维护，
 *   因此聚合的时间分辨率为「天 + cwd」，明细被清理（prune）后仍保留长期聚合历史；
 *   只有分位数样本走明细表（范围内最近 N 条，见 trace-repository.ts）。
 */

import type { DatabaseSync } from 'node:sqlite';

import type { ServiceLogger } from '../service-logger.js';

/** 一个迁移版本：version 单调递增，statements 按顺序执行。 */
export interface Migration {
  version: number;
  statements: readonly string[];
}

/** 当前目标版本（新增迁移时同步递增）。 */
export const TARGET_SCHEMA_VERSION = 2;

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        parent_run_id TEXT,
        task_id TEXT,
        cwd TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        thinking_level TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        status TEXT NOT NULL,
        stop_reason TEXT,
        error_type TEXT,
        error_message TEXT,
        turns INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        ttft_ms INTEGER,
        duration_ms INTEGER,
        meta TEXT,
        day TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id, started_at)`,
      `CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at)`,
      `CREATE INDEX IF NOT EXISTS idx_runs_cwd ON runs(cwd, started_at)`,
      `CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status, started_at)`,
      `CREATE TABLE IF NOT EXISTS steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        kind TEXT NOT NULL,
        tool_name TEXT,
        tool_call_id TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        duration_ms INTEGER,
        is_error INTEGER NOT NULL DEFAULT 0,
        blocked_by TEXT,
        error_type TEXT,
        error_message TEXT,
        args_digest TEXT,
        args_bytes INTEGER,
        result_digest TEXT,
        result_bytes INTEGER,
        approval_rule TEXT,
        approval_risk TEXT,
        approval_decision TEXT,
        approval_wait_ms INTEGER,
        decided_by TEXT,
        meta TEXT,
        day TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_steps_run ON steps(run_id)`,
      `CREATE INDEX IF NOT EXISTS idx_steps_kind_time ON steps(kind, started_at)`,
      `CREATE INDEX IF NOT EXISTS idx_steps_tool ON steps(tool_name, started_at)`,
      `CREATE TABLE IF NOT EXISTS run_rollups (
        day TEXT NOT NULL,
        cwd TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        runs INTEGER NOT NULL DEFAULT 0,
        turns INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        errors INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, cwd, provider, model)
      )`,
      `CREATE TABLE IF NOT EXISTS tool_rollups (
        day TEXT NOT NULL,
        cwd TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        calls INTEGER NOT NULL DEFAULT 0,
        errors INTEGER NOT NULL DEFAULT 0,
        blocked INTEGER NOT NULL DEFAULT 0,
        duration_ms_sum INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, cwd, tool_name)
      )`,
      `CREATE TABLE IF NOT EXISTS approval_rollups (
        day TEXT NOT NULL,
        cwd TEXT NOT NULL,
        rule TEXT NOT NULL,
        risk TEXT NOT NULL,
        approved INTEGER NOT NULL DEFAULT 0,
        denied INTEGER NOT NULL DEFAULT 0,
        timed_out INTEGER NOT NULL DEFAULT 0,
        wait_ms_sum INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, cwd, rule, risk)
      )`,
    ],
  },
  {
    // M1 开发期间的过渡 schema 修复：聚合表由 day_rollups 改为 run_rollups
    // （原设计下 totals 只能从 runs 明细算，一旦 prune 清理明细，totals 与 byTool 口径
    // 就互相矛盾）。对新建库这条是幂等的；对已经跑过旧版代码的库（user_version 已是 1）
    // 它会补齐缺失的 run_rollups 并清掉遗留的 day_rollups。
    // 教训：已发布的 DDL 不应直接改写，而应追加新版本迁移——这条就是为此存在的。
    version: 2,
    statements: [
      `CREATE TABLE IF NOT EXISTS run_rollups (
        day TEXT NOT NULL,
        cwd TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        runs INTEGER NOT NULL DEFAULT 0,
        turns INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        errors INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, cwd, provider, model)
      )`,
      `DROP TABLE IF EXISTS day_rollups`,
    ],
  },
];

/** 读取当前库的 schema 版本。 */
export function currentSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

/**
 * 把库补齐到目标版本；返回实际应用的迁移数量（0 表示已是最新）。
 * 中文说明：整个过程包在一个事务里，中途失败会整体回滚，不会留下半成品 schema。
 */
export function applyMigrations(
  db: DatabaseSync,
  migrations: readonly Migration[] = MIGRATIONS,
  logger?: ServiceLogger,
): number {
  const from = currentSchemaVersion(db);
  const pending = migrations
    .filter((item) => item.version > from)
    .sort((a, b) => a.version - b.version);
  if (pending.length === 0) return 0;
  db.exec('BEGIN');
  try {
    for (const migration of pending) {
      for (const statement of migration.statements) db.exec(statement);
      // PRAGMA 不接受参数绑定，版本号来自代码常量（非外部输入）。
      db.exec(`PRAGMA user_version = ${migration.version}`);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  const to = currentSchemaVersion(db);
  logger?.info({ from, to, applied: pending.length }, 'platform schema migrated');
  return pending.length;
}
