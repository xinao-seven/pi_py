/**
 * MCP server 模板库（M4.2）：一份「推荐清单」，把「知道包名和参数」这件事从用户手里接过来。
 *
 * 中文说明：MCP 的协议层早就支持任意 server（stdio 子进程 + streamable-http 静态头），
 * 真正缺的是**目录**——用户得自己知道包名、参数、需要哪个环境变量。这个模块就是那份目录：
 * 前端「模板库」面板据此渲染卡片，一键填入配置（无凭据的可以直接添加）。
 *
 * 三条硬约束（写模板时必须遵守，测试会校验）：
 * 1. **不落明文密钥**：需要凭据的模板一律用 `$ENV` 引用（env 值、headers 值，以及
 *    `args` 里的 `--token=$ENV`——`mcp-client-manager` 会对参数做同样的插值）。
 * 2. **不假装能用**：`needsInput` 表示「光有模板还启动不了」（例如 filesystem 必须给根目录），
 *    这类模板在前端只能「填入表单」，不能一键添加。
 * 3. **如实标注能力**：`access` 说明它可能造成什么影响，`suggestApproval` 给出是否建议
 *    打开「工具调用需人工审批」（沿用既有的 `approval: "required"`）。
 *
 * 兼容性提醒（写在 `notes` 里，让用户少踩坑）：
 * - 本仓库只支持**静态请求头**鉴权，不支持 OAuth 交互授权 → 只收录接受 PAT / API Key 的实现；
 * - Windows 上 `command: "npx"` 可以直接用（SDK 内部走 cross-spawn，会自动解析 `npx.cmd`），
 *   不要写成 `npx.cmd`（Node 的安全检查会拒绝 `.cmd`）；
 * - Python 系（`uvx`）需要先装 `uv`；
 * - 每个 server 的工具都会进系统提示词，建议每个工作区常驻 2–4 个。
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { McpTransport } from './mcp-config.js';

/** 模板分组（前端按组渲染标题）。 */
export const MCP_TEMPLATE_GROUPS = [
  'core', // 通用能力：记忆、结构化思考
  'research', // 联网检索与文档
  'browser', // 浏览器自动化
  'code', // 代码/仓库
  'data', // 数据库
  'team', // 协作与线上排障
  'debug', // 调试用
] as const;
export type McpTemplateGroup = (typeof MCP_TEMPLATE_GROUPS)[number];

/** 模板可能造成的影响（用来给用户一个直白的风险提示）。 */
export type McpTemplateAccess =
  | 'read-only' // 只读/无副作用（可能联网）
  | 'local-write' // 只写本地文件/浏览器
  | 'external-write'; // 会改外部系统（数据库、仓库、SaaS）

export interface McpTemplate {
  /** 稳定 id（前端 key）。 */
  id: string;
  /** 默认 server 名（决定工具前缀 `mcp__<name>__<tool>`）。 */
  name: string;
  title: string;
  group: McpTemplateGroup;
  /** 一句话说明「它是干什么的 + 在本项目里有什么用」。 */
  description: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  /** 需要的环境变量（值用 `$VAR` 引用，绝不写明文）。 */
  env?: Record<string, string>;
  /** 请求头（远程 server 用，值同样用 `$VAR`）。 */
  headers?: Record<string, string>;
  /** 可选环境变量（不设也能工作）。 */
  optionalEnv?: Record<string, string>;
  /** 光有模板还缺什么才能启动（缺了就不能一键添加）。 */
  needsInput?: string;
  access: McpTemplateAccess;
  /** 建议打开「工具调用需人工审批」。 */
  suggestApproval: boolean;
  /** 工具数量级（帮助用户判断上下文成本）。 */
  toolCountHint: string;
  /** 注意事项（首次下载、额外依赖、与本项目能力重复等）。 */
  notes?: string[];
  /** 包主页（npm/PyPI），便于用户自己看文档。 */
  homepage: string;
}

const SERVERS_REPO = 'https://github.com/modelcontextprotocol/servers';
const NPM = (name: string) => `https://www.npmjs.com/package/${name}`;
const PYPI = (name: string) => `https://pypi.org/project/${name}/`;

/** 模板库：按「对这个项目的价值」从高到低排列。 */
export const MCP_TEMPLATES: readonly McpTemplate[] = [
  // ---- 通用能力 -----------------------------------------------------------
  {
    id: 'memory',
    name: 'memory',
    title: '本地知识图谱（Memory）',
    group: 'core',
    description:
      '跨会话记住项目约定、模块关系与踩坑结论（实体/关系/观察三种原语）。纯本地文件，不联网。',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    access: 'local-write',
    suggestApproval: false,
    toolCountHint: '~9',
    notes: [
      '知识图谱默认落在包缓存目录；想固定在项目里，可加环境变量 MEMORY_FILE_PATH 指向某个 json 文件。',
      '写入是本地文件，不影响工作区代码，因此默认不要求人工审批。',
    ],
    homepage: SERVERS_REPO,
  },
  {
    id: 'sequential-thinking',
    name: 'sequential-thinking',
    title: '结构化思考（Sequential Thinking）',
    group: 'core',
    description: '把复杂问题拆成可修订的思考步骤，规划类任务更稳；与 Plan 模式互补。',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    access: 'read-only',
    suggestApproval: false,
    toolCountHint: '1',
    homepage: NPM('@modelcontextprotocol/server-sequential-thinking'),
  },
  // ---- 联网检索与文档 -----------------------------------------------------
  {
    id: 'context7',
    name: 'context7',
    title: '库文档查询（Context7）',
    group: 'research',
    description:
      '按库名查最新官方文档/示例，解决「模型不知道新版本 API」；无需 key 即可用（有 key 限额更高）。',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
    optionalEnv: { CONTEXT7_API_KEY: '$CONTEXT7_API_KEY' },
    access: 'read-only',
    suggestApproval: false,
    toolCountHint: '~2',
    homepage: 'https://github.com/upstash/context7',
  },
  {
    id: 'tavily',
    name: 'tavily',
    title: '联网搜索与抓取（Tavily）',
    group: 'research',
    description: '搜索、抓正文、爬站点的三件套，比内置抓取更适合调研与查报错。',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'tavily-mcp'],
    env: { TAVILY_API_KEY: '$TAVILY_API_KEY' },
    access: 'read-only',
    suggestApproval: false,
    toolCountHint: '~3',
    notes: ['需要环境变量 TAVILY_API_KEY（在 Tavily 控制台创建）。'],
    homepage: 'https://github.com/tavily-ai/tavily-mcp',
  },
  {
    id: 'brave-search',
    name: 'brave-search',
    title: '网页搜索（Brave）',
    group: 'research',
    description: '免登录的搜索 API 封装；不想用 Tavily 时的替代。',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    env: { BRAVE_API_KEY: '$BRAVE_API_KEY' },
    access: 'read-only',
    suggestApproval: false,
    toolCountHint: '~4',
    homepage: NPM('@modelcontextprotocol/server-brave-search'),
  },
  // ---- 浏览器 -------------------------------------------------------------
  {
    id: 'playwright',
    name: 'playwright',
    title: '浏览器自动化（Playwright）',
    group: 'browser',
    description:
      '真浏览器打开页面、点击、截图、读 console/network：前端改动自查、按场景做回归最有用。',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp'],
    access: 'local-write',
    suggestApproval: false,
    toolCountHint: '~20',
    notes: [
      '首次运行会下载 Chromium（需要网络）。',
      '默认显示可视化窗口；想无头运行可在参数后加 --headless。',
      '会真的点击/填写页面，建议只指向本地或测试环境。',
      '工具较多（约 20 个），常驻时会占用一部分系统提示词。',
    ],
    homepage: 'https://github.com/microsoft/playwright-mcp',
  },
  // ---- 代码/仓库 ----------------------------------------------------------
  {
    id: 'filesystem',
    name: 'filesystem',
    title: '受限目录文件读写（Filesystem）',
    group: 'code',
    description: '在指定根目录内读写文件，适合让模型访问工作区之外的项目。',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    needsInput: '必须追加「允许访问的根目录」到参数末尾（建议只给一个项目目录）',
    access: 'local-write',
    suggestApproval: true,
    toolCountHint: '~12',
    notes: [
      '本项目自带工作区文件面板与路径边界校验，这个 server 主要用在「要访问其它目录」的场景，避免重复配置。',
      '能写文件 → 建议打开人工审批。',
    ],
    homepage: SERVERS_REPO,
  },
  {
    id: 'github',
    name: 'github',
    title: 'GitHub 仓库/PR（PAT）',
    group: 'code',
    description: '读 PR/Issue/提交、按需创建分支与评论；用个人访问令牌（PAT）鉴权。',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: '$GITHUB_PERSONAL_ACCESS_TOKEN' },
    access: 'external-write',
    suggestApproval: true,
    toolCountHint: '~26',
    notes: [
      '只用只读权限的 token（Fine-grained PAT 勾选只读）能显著降低风险。',
      '官方托管的 OAuth 版本本仓库暂不支持（只支持静态 token），因此这里用 PAT 版。',
      '工具较多，建议按需开启。',
    ],
    homepage: 'https://github.com/github/github-mcp-server',
  },
  {
    id: 'git',
    name: 'git',
    title: 'Git 历史考古（Python）',
    group: 'code',
    description: 'git log/diff/blame/show 的结构化查询，用来回答「这行为什么这样写」。',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-git', '--repository'],
    needsInput: '需要安装 uv（或 pip 安装 mcp-server-git 后改用可执行文件名），并追加仓库路径',
    access: 'read-only',
    suggestApproval: false,
    toolCountHint: '~13',
    notes: [
      '需要额外依赖：uv（Windows 可 winget install astral-sh.uv）或 pip install mcp-server-git。',
      '本项目已能在 bash 里跑 git，这个 server 的价值在于结构化查询，避免每次拼命令。',
    ],
    homepage: PYPI('mcp-server-git'),
  },
  {
    id: 'serena',
    name: 'serena',
    title: '语义代码检索（Serena · Python）',
    group: 'code',
    description: '基于 LSP 的符号级查找/引用/重构，大仓库理解最强的一项。',
    transport: 'stdio',
    command: 'uvx',
    args: ['--from', 'git+https://github.com/oraios/serena', 'serena', 'start-mcp-server'],
    needsInput: '需要安装 uv；建议再加 --project <项目路径> 限定索引范围',
    access: 'local-write',
    suggestApproval: false,
    toolCountHint: '~20',
    notes: [
      '需要额外依赖：uv；首次索引会消耗时间与内存。',
      '工具较多且常驻索引，建议只在需要深挖大仓库时开启。',
    ],
    homepage: 'https://github.com/oraios/serena',
  },
  {
    id: 'fetch',
    name: 'fetch',
    title: '网页抓取（Python）',
    group: 'research',
    description: '把网页转成 markdown 给模型读（含 robots.txt 处理）。',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    needsInput: '需要安装 uv（或 pip install mcp-server-fetch）',
    access: 'read-only',
    suggestApproval: false,
    toolCountHint: '1',
    homepage: PYPI('mcp-server-fetch'),
  },
  // ---- 数据库 -------------------------------------------------------------
  {
    id: 'mongodb',
    name: 'mongodb',
    title: 'MongoDB',
    group: 'data',
    description: '查询/聚合/索引分析；建议配只读账号，写操作打开人工审批。',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'mongodb-mcp-server'],
    env: { MDB_MCP_CONNECTION_STRING: '$MDB_MCP_CONNECTION_STRING' },
    access: 'external-write',
    suggestApproval: true,
    toolCountHint: '~20',
    notes: [
      '连接串放环境变量 MDB_MCP_CONNECTION_STRING（不要写进配置文件）。',
      'server 自身也支持 MDB_MCP_DISABLED_TOOLS / MDB_MCP_CONFIRMATION_REQUIRED_TOOLS 等开关。',
    ],
    homepage: 'https://github.com/mongodb-js/mongodb-mcp-server',
  },
  {
    id: 'postgres',
    name: 'postgres',
    title: 'PostgreSQL（只读查询）',
    group: 'data',
    description: '跑只读 SQL、看表结构与执行计划；请用只读账号的连接串。',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres', '$DATABASE_URL'],
    env: { DATABASE_URL: '$DATABASE_URL' },
    access: 'external-write',
    suggestApproval: true,
    toolCountHint: '1',
    notes: [
      '连接串通过参数传入（本仓库支持参数里的 $ENV 插值，因此不会落明文）。',
      '建议用只读账号，从源头避免误写。',
    ],
    homepage: NPM('@modelcontextprotocol/server-postgres'),
  },
  {
    id: 'sqlite',
    name: 'sqlite',
    title: 'SQLite（Python）',
    group: 'data',
    description: '对本地 .db 文件做只读查询与 schema 分析（例如本项目的 platform.db）。',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-sqlite', '--db-path'],
    needsInput: '需要安装 uv，并追加 .db 文件路径（例如本项目的 platform.db）',
    access: 'read-only',
    suggestApproval: false,
    toolCountHint: '~6',
    notes: ['排查 M1 trace / M2 任务数据时很好用（只读打开，不会占写锁）。'],
    homepage: PYPI('mcp-server-sqlite'),
  },
  // ---- 协作与线上排障 -----------------------------------------------------
  {
    id: 'sentry',
    name: 'sentry',
    title: 'Sentry 线上错误',
    group: 'team',
    description: '按项目/issue 查线上报错与堆栈，配合 trace 定位回归。',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@sentry/mcp-server', '--access-token=$SENTRY_ACCESS_TOKEN'],
    env: { SENTRY_ACCESS_TOKEN: '$SENTRY_ACCESS_TOKEN' },
    access: 'external-write',
    suggestApproval: true,
    toolCountHint: '~15',
    notes: [
      'token 通过参数传入（参数支持 $ENV 插值，不会落明文）；自建实例再加 --host <host>。',
      '若不配 token 会走设备码 OAuth 登录流程，本仓库无交互终端，因此建议直接用 token。',
      '默认工具集包含修改 issue 的能力，建议保留人工审批。',
    ],
    homepage: 'https://github.com/getsentry/sentry-mcp',
  },
  {
    id: 'slack',
    name: 'slack',
    title: 'Slack 频道',
    group: 'team',
    description: '读频道/线程上下文、发消息与回复（用 bot token）。',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    env: {
      SLACK_BOT_TOKEN: '$SLACK_BOT_TOKEN',
      SLACK_TEAM_ID: '$SLACK_TEAM_ID',
    },
    access: 'external-write',
    suggestApproval: true,
    toolCountHint: '~8',
    notes: ['需要 Slack App 的 bot token 与 team id；发消息属于外部副作用，建议保留审批。'],
    homepage: NPM('@modelcontextprotocol/server-slack'),
  },
  {
    id: 'figma',
    name: 'figma',
    title: 'Figma 设计稿',
    group: 'team',
    description: '读设计稿的布局/样式/文案，按设计还原前端；需要 Figma API key。',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'figma-developer-mcp', '--stdio'],
    env: { FIGMA_API_KEY: '$FIGMA_API_KEY' },
    access: 'read-only',
    suggestApproval: false,
    toolCountHint: '~2',
    notes: ['设计稿需要一个可分享的 file key（在 Figma 链接里）。'],
    homepage: 'https://github.com/GLips/Figma-Context-MCP',
  },
  // ---- 调试 ---------------------------------------------------------------
  {
    id: 'debug-echo',
    name: 'debug-echo',
    title: '链路自检（本仓库自带 fixture）',
    group: 'debug',
    description:
      '暴露 echo / add / fail 三个工具的本地测试 server，用来验证「配置 → 连接 → 工具出现」整条链路。',
    transport: 'stdio',
    command: 'node',
    args: ['@fixture:mcp-test-server'],
    access: 'read-only',
    suggestApproval: false,
    toolCountHint: '3',
    notes: ['排错第一步：先确认这个能连上（能列出 3 个工具），再去排查目标 server。'],
    homepage: SERVERS_REPO,
  },
];

/** 本仓库自带 fixture server 的绝对路径（模板 `@fixture:mcp-test-server` 占位符用）。 */
export function fixtureServerPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/services/mcp → ../../.. = 包根目录（node-pi/server）
  return join(here, '..', '..', '..', 'test', 'fixtures', 'mcp-test-server.mjs');
}

/** 展开模板里的动态占位符（目前只有仓库自带 fixture 的路径）。 */
export function resolveTemplate(template: McpTemplate): McpTemplate {
  if (template.args?.includes('@fixture:mcp-test-server')) {
    return {
      ...template,
      args: template.args.map((arg) =>
        arg === '@fixture:mcp-test-server' ? fixtureServerPath() : arg,
      ),
    };
  }
  return template;
}

/** 列表（供 REST 返回）：附带「是否需要凭据 / 是否可一键添加」这类派生信息。 */
export interface McpTemplateView extends McpTemplate {
  /** 需要用户先准备凭据（环境变量）。 */
  requiresCredentials: boolean;
  /** 可以直接一键添加（无凭据、也不缺必填输入）。 */
  canAddDirectly: boolean;
}

export function listTemplates(): McpTemplateView[] {
  return MCP_TEMPLATES.map(resolveTemplate).map((template) => {
    const requiresCredentials = Object.keys(template.env ?? {}).length > 0;
    return {
      ...template,
      requiresCredentials,
      canAddDirectly: !requiresCredentials && template.needsInput === undefined,
    };
  });
}

/**
 * 模板自检（测试用，也在 `listTemplates()` 之外的启动自检里可选调用）。
 * 中文说明：模板库是手写的常量表，最容易犯的三类错——id/name 重复、
 * stdio 缺 command / http 缺 url、以及**把凭据写成明文**——在这里一次性挡住。
 */
export function assertTemplateTable(templates: readonly McpTemplate[] = MCP_TEMPLATES): void {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const template of templates) {
    if (ids.has(template.id)) throw new Error(`duplicate template id: ${template.id}`);
    ids.add(template.id);
    if (names.has(template.name)) throw new Error(`duplicate template name: ${template.name}`);
    names.add(template.name);
    if (!MCP_TEMPLATE_GROUPS.includes(template.group))
      throw new Error(`unknown group for ${template.id}: ${template.group}`);
    if (template.transport === 'stdio') {
      if (!template.command) throw new Error(`stdio template ${template.id} needs a command`);
    } else if (!template.url) {
      throw new Error(`http template ${template.id} needs a url`);
    }
    if (/https?:\/\//.test(template.command ?? ''))
      throw new Error(`template ${template.id} looks like a url in command`);
    // 凭据必须是 $ENV 引用：env/headers 的值、以及 args 里 --flag=$VAR 形式。
    for (const [key, value] of [
      ...Object.entries(template.env ?? {}),
      ...Object.entries(template.headers ?? {}),
    ]) {
      if (!/^\$[A-Z][A-Z0-9_]*$/.test(value))
        throw new Error(`${template.id}.${key} must reference an env var, got: ${value}`);
    }
    for (const arg of template.args ?? []) {
      const flag = /^--[a-z-]+=(.*)$/.exec(arg);
      if (flag === null) continue;
      const value = flag[1];
      if (!value.startsWith('$') && /(token|key|secret|password)/i.test(arg))
        throw new Error(`${template.id} has a plaintext credential in args: ${arg}`);
    }
    if (!template.homepage.startsWith('https://'))
      throw new Error(`template ${template.id} needs an https homepage`);
    if (template.toolCountHint.trim() === '')
      throw new Error(`template ${template.id} needs a toolCountHint`);
  }
}
