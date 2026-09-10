// M0-①  node:sqlite DatabaseSync 写入延迟实测（单线程事件循环阻塞风险评估）
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'pi-spike-sqlite-'));
const db = new DatabaseSync(join(dir, 'spike.db'));
db.exec('PRAGMA journal_mode=WAL');
db.exec(`CREATE TABLE steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL, turn_index INTEGER NOT NULL, kind TEXT NOT NULL,
  tool_name TEXT, started_at INTEGER NOT NULL, duration_ms INTEGER,
  is_error INTEGER DEFAULT 0, args_digest TEXT, result_digest TEXT
)`);

const insert = db.prepare(
  'INSERT INTO steps (run_id, turn_index, kind, tool_name, started_at, duration_ms, is_error, args_digest, result_digest) VALUES (?,?,?,?,?,?,?,?,?)',
);

function pct(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}
function measure(label, batchSize, iterations) {
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    // 模拟批量 flush：一个事务里写 batchSize 行
    db.exec('BEGIN');
    for (let j = 0; j < batchSize; j++) {
      insert.run(
        `run-${i}`,
        j,
        'tool_call',
        'bash',
        Date.now(),
        12,
        0,
        'abc123def456',
        'fed654cba321',
      );
    }
    db.exec('COMMIT');
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  console.log(
    `${label.padEnd(22)} n=${iterations} batch=${String(batchSize).padStart(3)}  ` +
      `p50=${pct(samples, 0.5).toFixed(2)}ms  p95=${pct(samples, 0.95).toFixed(2)}ms  ` +
      `p99=${pct(samples, 0.99).toFixed(2)}ms  max=${samples.at(-1).toFixed(2)}ms`,
  );
  return pct(samples, 0.95);
}

console.log('--- node:sqlite WAL 写入延迟（含事务边界）---');
const single = measure('单行一次事务', 1, 2000);
const b20 = measure('批量 20 行', 20, 500);
const b200 = measure('批量 200 行', 200, 300);

// 聚合查询延迟（Dashboard 场景）：插入 20 万行后跑一次 p95 聚合
const bulk = db.prepare(
  'INSERT INTO steps (run_id, turn_index, kind, tool_name, started_at, duration_ms, is_error, args_digest, result_digest) VALUES (?,?,?,?,?,?,?,?,?)',
);
db.exec('BEGIN');
for (let i = 0; i < 200_000; i++) {
  bulk.run(
    `run-${i % 5000}`,
    i % 20,
    'tool_call',
    ['bash', 'read', 'edit', 'grep'][i % 4],
    Date.now() - (i % 100000),
    (i % 900) + 3,
    i % 37 === 0 ? 1 : 0,
    'd1',
    'd2',
  );
}
db.exec('COMMIT');
const t0 = performance.now();
const agg = db
  .prepare(
    `SELECT tool_name, COUNT(*) c, SUM(is_error) e, AVG(duration_ms) a
  FROM steps WHERE kind='tool_call' AND started_at > ? GROUP BY tool_name`,
  )
  .all(Date.now() - 90000);
const aggMs = performance.now() - t0;
console.log(`\n聚合查询（20 万行全表 GROUP BY）: ${aggMs.toFixed(2)}ms  行数=${agg.length}`);
const t1 = performance.now();
db.exec('CREATE INDEX IF NOT EXISTS idx_steps_tool ON steps(tool_name, started_at)');
console.log(`建索引耗时: ${(performance.now() - t1).toFixed(2)}ms`);
const t2 = performance.now();
db.prepare(
  `SELECT tool_name, COUNT(*) c FROM steps WHERE tool_name=? AND started_at > ? GROUP BY tool_name`,
).all('bash', Date.now() - 90000);
console.log(`带索引的点查聚合: ${(performance.now() - t2).toFixed(2)}ms`);

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n结论: 单行 p95=${single.toFixed(2)}ms / 批量200 p95=${b200.toFixed(2)}ms`);
