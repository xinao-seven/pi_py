// M0-⑤: web 会话实际加载了哪些扩展？
// 关键问题：DefaultResourceLoader 会自动发现 ~/.pi/agent/extensions/，
// 因此官方 plan-mode / subagent 扩展会与项目的内联扩展（PlanModeService）同时生效。
// 为安全起见把真实扩展复制到临时 agentDir 再加载，绝不写真实目录。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
// 用**真实实现**的过滤器（构建产物），验证服务端实际行为。
import {
  dropInlineOwnedExtensions,
  INLINE_OWNED_EXTENSION_DIRS,
} from '../dist/services/agent-registry.js';

const realAgentDir = join(homedir(), '.pi', 'agent');
const root = mkdtempSync(join(tmpdir(), 'pi-spike-ext-'));
const agentDir = join(root, 'agent');
const cwd = join(root, 'ws');
mkdirSync(agentDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
writeFileSync(join(agentDir, 'auth.json'), '{}\n');
writeFileSync(join(agentDir, 'models.json'), '{ "providers": {} }\n');

// 复制真实扩展（只读源目录）与 agents/prompts。
// CI 等干净环境没有这些目录，此时只测内联扩展，不算失败。
let hasRealExtensions = false;
for (const sub of ['extensions', 'agents', 'prompts']) {
  const src = join(realAgentDir, sub);
  if (existsSync(src)) {
    cpSync(src, join(agentDir, sub), { recursive: true });
    if (sub === 'extensions') hasRealExtensions = true;
  }
}
if (!hasRealExtensions) {
  console.log(`[注] ${realAgentDir} 不存在或为空：本次只加载内联扩展（CI 环境的正常情况）。\n`);
}

// 模拟项目内联扩展（PlanModeService 的替身：同一批钩子）
const projectInlinePlan = (pi) => {
  pi.on('tool_call', () => undefined);
  pi.on('before_agent_start', () => undefined);
  pi.on('turn_end', () => undefined);
  pi.on('agent_end', () => undefined);
  pi.on('session_start', () => undefined);
};
const projectInlineApproval = (pi) => {
  pi.on('tool_call', () => undefined);
};

console.log(`内联实现接管的扩展目录名: ${INLINE_OWNED_EXTENSION_DIRS.join(', ')}\n`);
const loader = new DefaultResourceLoader({
  cwd,
  agentDir,
  extensionFactories: [projectInlinePlan, projectInlineApproval],
  // 与 src/services/agent-registry.ts 的 loader() 完全一致的过滤逻辑
  extensionsOverride: (base) => dropInlineOwnedExtensions(base).result,
});
await loader.reload();

const result = loader.getExtensions();
console.log(`=== 加载到 ${result.extensions.length} 个扩展 ===\n`);
const rel = (p) => String(p).replace(realAgentDir, '~/.pi/agent').replace(root, '<tmp>');
for (const ext of result.extensions) {
  console.log(`▸ ${rel(ext.path)}`);
  console.log(`    来源: ${JSON.stringify(ext.sourceInfo)}`);
  console.log(`    钩子: ${[...ext.handlers.keys()].sort().join(', ') || '(无)'}`);
  console.log(`    工具: ${[...ext.tools.keys()].join(', ') || '(无)'}`);
  console.log(`    命令: ${[...ext.commands.keys()].join(', ') || '(无)'}`);
  console.log();
}

if (result.errors.length) {
  console.log('=== 加载错误 ===');
  for (const e of result.errors) console.log(`  ${rel(e.path)}: ${e.error}`);
}

// 冲突判定：统计有多少扩展钩了 tool_call
const toolCallHooks = result.extensions.filter((e) => e.handlers.has('tool_call'));
console.log(`=== tool_call 钩子冲突面 ===`);
console.log(`  钩了 tool_call 的扩展数: ${toolCallHooks.length}`);
for (const e of toolCallHooks) console.log(`    - ${rel(e.path)}`);

const planLike = result.extensions.filter(
  (e) => e.handlers.has('agent_end') && e.handlers.has('before_agent_start'),
);
console.log(`\n=== Plan 类扩展（同时钩 agent_end + before_agent_start）===`);
for (const e of planLike) console.log(`    - ${rel(e.path)}`);

console.log(`\n=== 全部注册的工具（名字冲突检查）===`);
for (const e of result.extensions)
  for (const name of e.tools.keys()) console.log(`    ${name}  ← ${rel(e.path)}`);

rmSync(root, { recursive: true, force: true });
