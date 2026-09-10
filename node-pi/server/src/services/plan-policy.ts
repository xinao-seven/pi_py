/**
 * 规划期权限策略（M4）：用**能力分类**替代「正则白名单 + 快照恢复」。
 *
 * 中文说明（这是 P6 的根治）：
 * 旧实现用一条正则白名单放行只读命令，结果把最常用的验证命令全拦了——
 * `tsc --noEmit`、`pnpm test`、`npm run build`、`node -e` 都被判为「不安全」。
 * 规划期跑不了验证，计划质量自然差，这是「Plan 用起来不符合逻辑」最直接的体感来源。
 *
 * 现在的做法是**分类**而不是「黑名单比对」：
 * 1. 先跑审批规则（`classifyBashCommand`）——危险/敏感命令（递归删除、改依赖、联网、
 *    重定向写文件、远端 Git 操作…）一律不放行，这样同一套判定同时服务审批与 Plan，
 *    不会出现「审批说危险、Plan 说安全」这种自相矛盾；
 * 2. 把整条命令按 `;` `&&` `||` `|` 拆成段，**每一段都必须放行**（避免
 *    `npm test && rm -rf src` 这种一段合法、一段破坏的漏网）；
 * 3. 每段取实际执行的程序名，按能力归类：只读 / 验证 / 写 / 未知。
 *    **未归类 = 未知 = 不放行**（宁可让模型改用 `read`，也不要放行任意程序）。
 *
 * 三个能力类别对应三种处理：
 * - `read`：只读，规划期永远放行；
 * - `verify`：构建/测试/类型检查等验证命令——它们会写构建产物，但这是「验证」必需的成本，
 *   由 `policy.bash` 决定是否放行；`policy.bash='none'` 时连它们也不放行；
 * - `write` / `unknown`：不放行（写操作要么等确认后执行，要么改用只读方式调研）。
 */

import { basename } from 'node:path';

import { classifyBashCommand } from './tool-approval.js';

export interface PlanPolicy {
  /** 规划期允许的只读工具（默认 read/grep/find/ls）。 */
  readOnlyTools: string[];
  /** bash 策略：`none` 完全禁止；`verify` 允许只读与验证类命令；`all` 全放行（不推荐）。 */
  bash: 'none' | 'verify' | 'all';
  /** 额外视为「验证命令」的程序名（工作区/预设可扩展，例如自研的检查脚本）。 */
  verifyCommands: string[];
  /** 是否允许 MCP 只读工具（默认禁止：无法证明 MCP 工具只读）。 */
  allowMcp: boolean;
  /**
   * 规划期是否允许把**只读子任务**委派出去（M5，默认允许）。
   * 中文说明：委派本身很契合规划期（大范围搜代码又不污染主上下文），
   * 但子会话是不受本策略约束的独立会话，所以这里只开一道缝：
   * 预设必须**结构上只读**（工具集全在 `readOnlyTools` 里，不能有 bash）。
   * 想让某个带 bash 的预设也能在规划期用，就把它自己改为不带 bash，
   * 而不是把策略放宽成「信任预设」。
   */
  allowSubagentDelegation: boolean;
}

export type BashCapability = 'read' | 'verify' | 'write' | 'unknown';

export interface BashVerdict {
  allowed: boolean;
  capability: BashCapability;
  /** 不放行时给出人类/模型可读的原因（模型据此改用只读方式，而不是反复重试）。 */
  reason: string;
}

/** 默认策略：只读调研 + 验证类命令放行，写操作与 MCP 一律不放行。 */
export const DEFAULT_PLAN_POLICY: PlanPolicy = {
  readOnlyTools: ['read', 'grep', 'find', 'ls'],
  bash: 'verify',
  verifyCommands: [],
  allowMcp: false,
  allowSubagentDelegation: true,
};

/** 纯只读命令（首程序名）。 */
const READ_COMMANDS = new Set([
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'grep',
  'rg',
  'ag',
  'find',
  'fd',
  'ls',
  'dir',
  'pwd',
  'echo',
  'printf',
  'wc',
  'sort',
  'uniq',
  'cut',
  'tr',
  'diff',
  'file',
  'stat',
  'du',
  'df',
  'tree',
  'which',
  'where',
  'type',
  'env',
  'printenv',
  'uname',
  'whoami',
  'id',
  'date',
  'uptime',
  'ps',
  'jq',
  'true',
  'false',
  'test',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'sha256sum',
  'md5sum',
  'column',
  'seq',
  'sleep',
]);

/** 构建/测试/类型检查类命令：会写构建产物，但属于「验证」必需。 */
const VERIFY_COMMANDS = new Set([
  'tsc',
  'vitest',
  'jest',
  'mocha',
  'ava',
  'pytest',
  'eslint',
  'prettier',
  'biome',
  'ruff',
  'mypy',
  'pyright',
  'vue-tsc',
  'svelte-check',
  'cargo',
  'go',
  'dotnet',
  'gradle',
  'gradlew',
  'mvn',
  'mvnw',
  'make',
  'cmake',
  'ninja',
]);

/** 明确的写操作命令（给出 `write` 能力，而不是含糊的 unknown）。 */
const WRITE_COMMANDS = new Set([
  'rm',
  'rmdir',
  'rd',
  'del',
  'remove-item',
  'mv',
  'move',
  'ren',
  'rename',
  'cp',
  'copy',
  'xcopy',
  'robocopy',
  'mkdir',
  'md',
  'new-item',
  'touch',
  'tee',
  'out-file',
  'set-content',
  'add-content',
  'dd',
  'shred',
  'truncate',
  'chmod',
  'chown',
  'attrib',
  'ln',
  'mklink',
  'install',
  'sudo',
  'su',
  'runas',
  'kill',
  'pkill',
  'taskkill',
  'reboot',
  'shutdown',
  'systemctl',
  'service',
  'sc',
  'format',
  'mkfs',
  'reg',
  'docker',
  'kubectl',
  'helm',
  'powershell',
  'pwsh',
  'cmd',
  'bash',
  'sh',
  'zsh',
]);

/** `git` 的只读子命令（其余子命令按写处理）。 */
const GIT_READ_SUBCOMMANDS = new Set([
  'status',
  'log',
  'diff',
  'show',
  'branch',
  'remote',
  'rev-parse',
  'describe',
  'blame',
  'ls-files',
  'ls-tree',
  'shortlog',
  'tag',
  'whatchanged',
  'config',
  'worktree',
  'grep',
  'cat-file',
]);

/** 包管理器的只读子命令。 */
const PACKAGE_READ_SUBCOMMANDS = new Set([
  'list',
  'ls',
  'view',
  'info',
  'search',
  'outdated',
  'audit',
  'why',
  'explain',
  'licenses',
  'config',
]);

/** `npx <tool>` 允许的工具（避免「npx 任意包」等于执行未知代码）。 */
const NPX_ALLOWED_TOOLS = new Set([
  'tsc',
  'vitest',
  'jest',
  'eslint',
  'prettier',
  'vue-tsc',
  'svelte-check',
  'biome',
  'mypy',
  'ruff',
]);

/** 命令包装器：剥掉后可继续看真正的程序名。 */
const WRAPPERS = new Set(['time', 'nohup', 'stdbuf', 'command', 'exec']);

/** 会写文件的脚本片段（`node -e` / `python -c` 的保守判定）。 */
const SCRIPT_WRITE_PATTERNS: readonly RegExp[] = [
  /\bwriteFile(Sync)?\b/,
  /\bappendFile(Sync)?\b/,
  /\bmkdir(Sync)?\b/,
  /\bunlink(Sync)?\b/,
  /\brm(Sync)?\b/,
  /\brename(Sync)?\b/,
  /\bcopyFile(Sync)?\b/,
  /\bcreateWriteStream\b/,
  /\btruncate(Sync)?\b/,
  /\bchmod(Sync)?\b/,
  /\bchild_process\b/,
  /\bexec(Sync)?\(/,
  /\bspawn(Sync)?\(/,
  /\bos\.(remove|rmdir|unlink|system|popen|rename|mkdir)\b/,
  /\bshutil\./,
  /\bpathlib\b/,
  /\bopen\([^)]*['"][waxr]\+?['"]/,
  /\bsubprocess\b/,
];

/** 拆段：按 shell 连接符切分（引号内的不切，简单扫描即可）。 */
export function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote !== undefined) {
      current += char;
      if (char === quote && command[index - 1] !== '\\') quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    const two = command.slice(index, index + 2);
    if (two === '&&' || two === '||') {
      segments.push(current);
      current = '';
      index += 1;
      continue;
    }
    if (char === ';' || char === '|' || char === '\n') {
      segments.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}

/** 取一段命令里实际执行的程序名（剥掉环境变量赋值与包装器）。 */
function programOf(segment: string): { name: string; args: string[] } {
  const tokens = segment.split(/\s+/).filter((token) => token.length > 0);
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index += 1;
  while (index < tokens.length && WRAPPERS.has(basename(tokens[index]).toLowerCase())) index += 1;
  const raw = tokens[index] ?? '';
  const name = basename(raw)
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|ps1)$/, '');
  return { name, args: tokens.slice(index + 1) };
}

/** 单个命令段的能力分类。 */
function classifySegment(segment: string, policy: PlanPolicy): BashCapability {
  const { name, args } = programOf(segment);
  if (name.length === 0) return 'unknown';
  if (WRITE_COMMANDS.has(name)) return 'write';
  if (name === 'sed' || name === 'perl') {
    // `sed -i` / `perl -i` 是就地写文件；不带的才当只读。
    return args.some((arg) => /^-i|--in-place/.test(arg)) ? 'write' : 'read';
  }
  if (name === 'git') {
    const sub = args.find((arg) => !arg.startsWith('-')) ?? '';
    return GIT_READ_SUBCOMMANDS.has(sub) ? 'read' : 'write';
  }
  if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') {
    const sub = args.find((arg) => !arg.startsWith('-')) ?? '';
    if (sub === 'run' || sub === 'test' || sub === 'exec') return 'verify';
    if (PACKAGE_READ_SUBCOMMANDS.has(sub) || sub === '--version' || sub === '-v') return 'read';
    if (args.some((arg) => arg === '--version' || arg === '-v')) return 'read';
    return sub.length === 0 ? 'read' : 'write';
  }
  if (name === 'npx') {
    const tool = args.find((arg) => !arg.startsWith('-')) ?? '';
    return NPX_ALLOWED_TOOLS.has(basename(tool).toLowerCase()) ? 'verify' : 'unknown';
  }
  if (name === 'node' || name === 'python' || name === 'python3') {
    if (args.some((arg) => arg === '--version' || arg === '-V')) return 'read';
    const inline = args.findIndex((arg) => arg === '-e' || arg === '-c' || arg === '--eval');
    if (inline < 0) return 'unknown'; // 跑脚本文件：内容不可知
    const snippet = args.slice(inline + 1).join(' ');
    return SCRIPT_WRITE_PATTERNS.some((pattern) => pattern.test(snippet)) ? 'write' : 'verify';
  }
  if (VERIFY_COMMANDS.has(name)) return 'verify';
  if (policy.verifyCommands.includes(name)) return 'verify';
  if (READ_COMMANDS.has(name)) return 'read';
  return 'unknown';
}

const CAPABILITY_LABEL: Record<BashCapability, string> = {
  read: '只读命令',
  verify: '验证类命令',
  write: '写操作',
  unknown: '无法判定能力的命令',
};

/**
 * 判定一条 bash 命令在规划期是否放行。
 * 顺序即优先级：审批规则（危险） → bash 策略（none 全禁） → 逐段分类。
 */
export function evaluatePlanBash(
  command: unknown,
  policy: PlanPolicy = DEFAULT_PLAN_POLICY,
): BashVerdict {
  if (typeof command !== 'string' || command.trim().length === 0) {
    return { allowed: false, capability: 'unknown', reason: '命令为空' };
  }
  const approval = classifyBashCommand({ command });
  if (approval !== undefined) {
    return {
      allowed: false,
      capability: 'write',
      reason: `命中审批规则 ${approval.rule}（${approval.reason}），规划期不放行`,
    };
  }
  if (policy.bash === 'none') {
    return {
      allowed: false,
      capability: 'read',
      reason: '当前策略禁止规划期执行任何 bash 命令（bash: none）',
    };
  }
  if (policy.bash === 'all') {
    return { allowed: true, capability: 'verify', reason: '当前策略放行所有 bash 命令' };
  }
  let sawVerify = false;
  for (const segment of splitCommandSegments(command)) {
    const capability = classifySegment(segment, policy);
    if (capability === 'read') continue;
    if (capability === 'verify') {
      sawVerify = true;
      continue;
    }
    return {
      allowed: false,
      capability,
      reason: `「${segment}」被判定为${CAPABILITY_LABEL[capability]}，规划期只允许只读与验证类命令`,
    };
  }
  // 能力取「最宽的那一段」：全只读就是只读，含验证类就是验证类。
  return sawVerify
    ? { allowed: true, capability: 'verify', reason: '只读/验证类命令，规划期放行' }
    : { allowed: true, capability: 'read', reason: '只读命令，规划期放行' };
}
