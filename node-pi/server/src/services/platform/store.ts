/**
 * 平台存储的装配入口：选后端 + 建库 + 套上写入队列。
 *
 * 中文说明：调用方（app.ts）只拿到一个 `PlatformStore`，不需要知道底下是 SQLite 还是内存。
 * 存储里有两类能力，语义刻意不同：
 * - `traces`：「尽力而为的观测」——写入进队列、可丢可降级，`trace: false` 时退化成空实现；
 * - `tasks`：「业务状态」——同步 CRUD、写入失败必须冒泡成 API 错误，与 trace 开关无关。
 *
 * 三条降级路径（都只记 warn，绝不阻断服务启动）：
 * - `PI_NODE_STORE=memory` → 整体走内存实现，保证测试与无盘环境可用；
 * - sqlite 打开/建表失败（目录不可写、文件被占用等）→ 自动回落到内存实现；
 * - trace 运行时连续 flush 失败 → 由队列自行降级（见 trace-repository.ts）。
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import type { ServiceLogger } from '../service-logger.js';
import { MemoryTraceStorage } from './memory-trace-storage.js';
import { SqliteTraceStorage } from './sqlite-trace-storage.js';
import {
  MemoryTaskRepository,
  SqliteTaskRepository,
  type TaskRepository,
} from './task-repository.js';
import {
  DEFAULT_TRACE_QUEUE,
  NullTraceRepository,
  QueuedTraceRepository,
  type TraceQueueOptions,
  type TraceRepository,
  type TraceStorage,
  type TraceStoreStats,
} from './trace-repository.js';

export interface PlatformStoreOptions {
  mode: 'sqlite' | 'memory';
  /** SQLite 模式的库文件路径。 */
  dbPath?: string;
  /** 是否启用 trace（默认启用）；关闭时 traces 退化成空实现，其余照常。 */
  trace?: boolean;
  flushMs?: number;
  batchSize?: number;
  maxPending?: number;
  logger?: ServiceLogger;
  /** 测试注入：直接给定 trace 后端（跳过选型与建库）。 */
  storage?: TraceStorage;
  /** 测试注入：直接给定任务仓储（默认按模式派生）。 */
  tasks?: TaskRepository;
}

/** 平台存储：trace + 任务（M2 起共用同一个库文件）。 */
export interface PlatformStore {
  readonly mode: 'sqlite' | 'memory';
  readonly traces: TraceRepository;
  readonly tasks: TaskRepository;
  /** 已应用的 schema 版本（内存模式为 0）。 */
  readonly schemaVersion: number;
  flush(): void;
  close(): void;
  stats(): TraceStoreStats;
}

/**
 * trace 关闭且未配置存储时的空存储：不落任何文件。
 * 中文说明：这是 `createApp()` 的默认值——测试环境绝不允许触碰真实 `~/.pi`；
 * 任务在这种模式下是内存实现（进程内有效）。
 */
export function openNullStore(): PlatformStore {
  const traces = new NullTraceRepository();
  const tasks = new MemoryTaskRepository();
  return {
    mode: 'memory',
    traces,
    tasks,
    schemaVersion: 0,
    flush: () => undefined,
    close: () => tasks.close(),
    stats: () => traces.stats(),
  };
}

/** 打开平台存储；SQLite 不可用时自动回落内存实现。 */
export function openPlatformStore(options: PlatformStoreOptions): PlatformStore {
  const queue: TraceQueueOptions = {
    ...DEFAULT_TRACE_QUEUE,
    ...(options.flushMs === undefined ? {} : { flushMs: options.flushMs }),
    ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
    ...(options.maxPending === undefined ? {} : { maxPending: options.maxPending }),
  };
  const backend = options.storage
    ? { storage: options.storage, mode: options.mode, db: undefined, schemaVersion: 0 }
    : openBackend(options);
  return buildStore({
    traceEnabled: options.trace !== false,
    mode: backend.mode,
    storage: backend.storage,
    tasks:
      options.tasks ??
      (backend.db === undefined
        ? new MemoryTaskRepository()
        : new SqliteTaskRepository(backend.db)),
    queue,
    schemaVersion: backend.schemaVersion,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
}

function buildStore(input: {
  traceEnabled: boolean;
  mode: 'sqlite' | 'memory';
  storage: TraceStorage;
  tasks: TaskRepository;
  queue: TraceQueueOptions;
  schemaVersion: number;
  logger?: ServiceLogger;
}): PlatformStore {
  const traces = input.traceEnabled
    ? new QueuedTraceRepository(input.storage, input.mode, input.queue, input.logger)
    : new NullTraceRepository();
  return {
    mode: input.mode,
    traces,
    tasks: input.tasks,
    schemaVersion: input.schemaVersion,
    flush: () => traces.flush(),
    close: () => {
      traces.close();
      // 显式再关一次后端：trace 关闭时 traces 是空实现（不会关连接），
      // 而任务仓储共用同一个连接，必须在这里释放，否则文件句柄会泄漏。
      // 已关闭时重复调用是幂等的（各后端都有 closed 标志）。
      input.storage.close();
      input.tasks.close();
    },
    stats: () => traces.stats(),
  };
}

/** 按配置选择后端；SQLite 打开失败时回落内存并记 warn。 */
function openBackend(options: PlatformStoreOptions): {
  storage: TraceStorage;
  mode: 'sqlite' | 'memory';
  db: DatabaseSync | undefined;
  schemaVersion: number;
} {
  if (options.mode === 'memory' || !options.dbPath) {
    return {
      storage: new MemoryTraceStorage(),
      mode: 'memory',
      db: undefined,
      schemaVersion: 0,
    };
  }
  try {
    mkdirSync(dirname(options.dbPath), { recursive: true });
    const storage = SqliteTraceStorage.open(options.dbPath, options.logger);
    return {
      storage,
      mode: 'sqlite',
      db: storage.database,
      schemaVersion: storage.schemaVersion,
    };
  } catch (error) {
    options.logger?.warn(
      {
        dbPath: options.dbPath,
        error: error instanceof Error ? error.message : String(error),
      },
      'platform store unavailable; falling back to in-memory store',
    );
    return {
      storage: new MemoryTraceStorage(),
      mode: 'memory',
      db: undefined,
      schemaVersion: 0,
    };
  }
}
