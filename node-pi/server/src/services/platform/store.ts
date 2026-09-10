/**
 * 平台存储的装配入口：选后端 + 建库 + 套上写入队列。
 *
 * 中文说明：调用方（app.ts）只拿到一个 `PlatformStore`（trace 的写入与读取都通过它），
 * 不需要知道底下是 SQLite 还是内存。
 *
 * 两条降级路径（都只记 warn，绝不阻断服务启动）：
 * - `PI_NODE_STORE=memory` → 整体走内存实现，保证测试与无盘环境可用；
 * - sqlite 打开/建表失败（目录不可写、文件被占用等）→ 自动回落到内存实现。
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { ServiceLogger } from '../service-logger.js';
import { MemoryTraceStorage } from './memory-trace-storage.js';
import { SqliteTraceStorage } from './sqlite-trace-storage.js';
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
  flushMs?: number;
  batchSize?: number;
  maxPending?: number;
  logger?: ServiceLogger;
  /** 测试注入：直接给定存储后端（跳过选型与建库）。 */
  storage?: TraceStorage;
}

/** 平台存储：M1 只有 trace（M2 会挂上 tasks，共用同一个库文件）。 */
export interface PlatformStore {
  readonly mode: 'sqlite' | 'memory';
  readonly traces: TraceRepository;
  /** 已应用的 schema 版本（内存模式为 0）。 */
  readonly schemaVersion: number;
  flush(): void;
  close(): void;
  stats(): TraceStoreStats;
}

/** trace 关闭（PI_NODE_TRACE=0）时的空存储：与今天的零埋点行为完全一致。 */
export function openNullStore(): PlatformStore {
  const traces = new NullTraceRepository();
  return {
    mode: 'memory',
    traces,
    schemaVersion: 0,
    flush: () => undefined,
    close: () => undefined,
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
    ? { storage: options.storage, mode: options.mode }
    : openBackend(options);
  const traces = new QueuedTraceRepository(backend.storage, backend.mode, queue, options.logger);
  return {
    mode: backend.mode,
    traces,
    schemaVersion:
      backend.storage instanceof SqliteTraceStorage ? backend.storage.schemaVersion : 0,
    flush: () => traces.flush(),
    close: () => traces.close(),
    stats: () => traces.stats(),
  };
}

/** 按配置选择后端；SQLite 打开失败时回落内存并记 warn。 */
function openBackend(options: PlatformStoreOptions): {
  storage: TraceStorage;
  mode: 'sqlite' | 'memory';
} {
  if (options.mode === 'memory' || !options.dbPath) {
    return { storage: new MemoryTraceStorage(), mode: 'memory' };
  }
  try {
    mkdirSync(dirname(options.dbPath), { recursive: true });
    return { storage: SqliteTraceStorage.open(options.dbPath, options.logger), mode: 'sqlite' };
  } catch (error) {
    options.logger?.warn(
      {
        dbPath: options.dbPath,
        error: error instanceof Error ? error.message : String(error),
      },
      'platform store unavailable; falling back to in-memory trace store',
    );
    return { storage: new MemoryTraceStorage(), mode: 'memory' };
  }
}
