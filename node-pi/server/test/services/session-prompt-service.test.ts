import { describe, expect, it } from 'vitest';

import {
  buildPromptSnapshot,
  classifyToolSource,
  MAX_SYSTEM_PROMPT_CHARS,
  toolParamsOf,
  type PiPromptResourceLoader,
  type PiRegisteredTool,
  type PromptSnapshotContext,
  type PromptSourceSession,
} from '../../src/services/session-prompt-service.js';

const CONTEXT: PromptSnapshotContext = {
  sessionId: 'session-1',
  cwd: '/workspace',
  provider: 'deepseek',
  model: 'deepseek-chat',
  thinkingLevel: 'medium',
  now: () => new Date(Date.UTC(2026, 8, 27, 10, 0, 0)),
};

/** 一份「什么都有」的假会话（形状对齐 SDK：systemPrompt/resourceLoader 是属性）。 */
function fullSession(overrides: Partial<PromptSourceSession> = {}): PromptSourceSession {
  const tools: PiRegisteredTool[] = [
    {
      name: 'read',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      sourceInfo: { path: '<builtin:read>', source: 'builtin' },
    },
    {
      name: 'bash',
      description: 'Run a command',
      parameters: { type: 'object', properties: { command: {}, timeout: {} } },
      promptGuidelines: ['Prefer short commands'],
      sourceInfo: { path: '<builtin:bash>', source: 'builtin' },
    },
    {
      name: 'submit_plan',
      description: '提交计划',
      sourceInfo: { path: '<inline>', source: 'inline' },
    },
    {
      name: 'mcp__github__create_issue',
      description: 'Create an issue',
      sourceInfo: { path: '<inline>', source: 'inline' },
    },
  ];
  const resourceLoader: PiPromptResourceLoader = {
    getSkills: () => ({
      skills: [
        {
          name: 'tavily-search',
          description: 'Web search',
          filePath: '/home/u/.pi/agent/skills/tavily-search/SKILL.md',
        },
        {
          name: 'hidden',
          description: 'Explicit only',
          filePath: '/home/u/.pi/agent/skills/hidden/SKILL.md',
          disableModelInvocation: true,
        },
      ],
      diagnostics: [{ message: 'SKILL.md 缺少 description', path: '/x/SKILL.md' }],
    }),
    getPrompts: () => ({
      prompts: [
        {
          name: 'review',
          description: 'Review a diff',
          argumentHint: '<pr>',
          filePath: '/home/u/.pi/agent/prompts/review.md',
        },
      ],
    }),
    getAgentsFiles: () => ({
      agentsFiles: [{ path: '/workspace/CLAUDE.md', content: 'x'.repeat(120) }],
    }),
    getAppendSystemPrompt: () => ['extra one', 'extra two'],
    getSystemPromptSource: () => ({ path: '/home/u/.pi/agent/prompts/system.md' }),
  };
  return {
    systemPrompt: 'You are pi.',
    getAllTools: () => tools,
    getActiveToolNames: () => ['read', 'bash'],
    resourceLoader,
    ...overrides,
  };
}

describe('classifyToolSource', () => {
  it('maps the SDK source markers and lets the mcp prefix win', () => {
    expect(classifyToolSource('read', { source: 'builtin' })).toBe('builtin');
    expect(classifyToolSource('custom', { source: 'sdk' })).toBe('sdk');
    expect(classifyToolSource('submit_plan', { source: 'inline', path: '<inline>' })).toBe(
      'inline',
    );
    expect(classifyToolSource('demo', { source: 'local', path: '/x/ext.js' })).toBe('extension');
    expect(classifyToolSource('demo', { source: 'my-package', path: '/x/y' })).toBe('package');
    expect(classifyToolSource('demo', undefined)).toBe('other');
    // MCP 前缀优先：即使 sourceInfo 说是内联扩展（我们的 MCP 工具就是内联注册的）。
    expect(classifyToolSource('mcp__github__x', { source: 'inline', path: '<inline>' })).toBe(
      'mcp',
    );
  });
});

describe('toolParamsOf', () => {
  it('lists parameter names and marks the required ones', () => {
    expect(
      toolParamsOf({
        type: 'object',
        properties: { command: {}, timeout: {} },
        required: ['command'],
      }),
    ).toEqual([
      { name: 'command', required: true },
      { name: 'timeout', required: false },
    ]);
  });

  it('returns an empty list for schemas it cannot read', () => {
    expect(toolParamsOf(undefined)).toEqual([]);
    expect(toolParamsOf('nope')).toEqual([]);
    expect(toolParamsOf({ type: 'object' })).toEqual([]);
    expect(toolParamsOf({ type: 'object', properties: [] })).toEqual([]);
  });
});

describe('buildPromptSnapshot', () => {
  it('assembles the system prompt, tools, skills, templates and context files', () => {
    const snapshot = buildPromptSnapshot(fullSession(), CONTEXT);

    expect(snapshot).toMatchObject({
      sessionId: 'session-1',
      cwd: '/workspace',
      capturedAt: '2026-09-27T10:00:00.000Z',
      model: { provider: 'deepseek', modelId: 'deepseek-chat' },
      thinkingLevel: 'medium',
      systemPrompt: {
        text: 'You are pi.',
        source: '/home/u/.pi/agent/prompts/system.md',
        appendedPrompts: 2,
      },
      overview: {
        systemPromptChars: 11,
        systemPromptTruncated: false,
        toolsRegistered: 4,
        toolsActive: 2,
        mcpTools: 1,
        skills: 2,
        promptTemplates: 1,
        contextFiles: 1,
      },
    });

    // 激活的工具排在前面；未激活的注册工具也列出来（但标 active:false）。
    expect(snapshot.tools.map((tool) => [tool.name, tool.active, tool.source])).toEqual([
      ['bash', true, 'builtin'],
      ['read', true, 'builtin'],
      ['mcp__github__create_issue', false, 'mcp'],
      ['submit_plan', false, 'inline'],
    ]);
    const read = snapshot.tools.find((tool) => tool.name === 'read');
    expect(read?.params).toEqual([{ name: 'path', required: true }]);
    expect(snapshot.tools.find((tool) => tool.name === 'bash')?.promptGuidelines).toEqual([
      'Prefer short commands',
    ]);

    // MCP 归属：没有注入解析器时按 mcp__<server>__<tool> 拆名字。
    expect(snapshot.tools.find((tool) => tool.name.startsWith('mcp__'))?.mcp).toEqual({
      server: 'github',
      tool: 'create_issue',
    });

    expect(snapshot.skills).toEqual([
      {
        name: 'tavily-search',
        description: 'Web search',
        location: '/home/u/.pi/agent/skills/tavily-search/SKILL.md',
        disableModelInvocation: false,
      },
      {
        name: 'hidden',
        description: 'Explicit only',
        location: '/home/u/.pi/agent/skills/hidden/SKILL.md',
        disableModelInvocation: true,
      },
    ]);
    expect(snapshot.promptTemplates).toEqual([
      {
        name: 'review',
        description: 'Review a diff',
        argumentHint: '<pr>',
        path: '/home/u/.pi/agent/prompts/review.md',
      },
    ]);
    expect(snapshot.contextFiles).toEqual([{ path: '/workspace/CLAUDE.md', chars: 120 }]);
    // 资源诊断（坏掉的 SKILL.md 等）要露出来，否则「skill 没生效」查不出来。
    expect(snapshot.diagnostics).toEqual(['SKILL.md 缺少 description（/x/SKILL.md）']);
  });

  it('prefers the injected MCP resolver (name collisions are resolved by toolIndex)', () => {
    const snapshot = buildPromptSnapshot(fullSession(), {
      ...CONTEXT,
      resolveMcpTool: () => ({ server: 'github-enterprise', tool: 'issues.create' }),
    });

    expect(snapshot.tools.find((tool) => tool.name.startsWith('mcp__'))?.mcp).toEqual({
      server: 'github-enterprise',
      tool: 'issues.create',
    });
  });

  it('degrades to an empty snapshot when the session exposes nothing', () => {
    const snapshot = buildPromptSnapshot({}, CONTEXT);

    expect(snapshot.systemPrompt).toEqual({ text: '', appendedPrompts: 0 });
    expect(snapshot.tools).toEqual([]);
    expect(snapshot.skills).toEqual([]);
    expect(snapshot.promptTemplates).toEqual([]);
    expect(snapshot.contextFiles).toEqual([]);
    expect(snapshot.overview).toMatchObject({
      systemPromptChars: 0,
      toolsRegistered: 0,
      toolsActive: 0,
      mcpTools: 0,
    });
    // 没有模型信息时给 null，前端不必处理 undefined。
    expect(buildPromptSnapshot({}, { sessionId: 's', cwd: '/w' }).model).toBeNull();
  });

  it('never throws when a source itself throws', () => {
    const broken: PromptSourceSession = {
      systemPrompt: 'ok',
      getAllTools: () => {
        throw new Error('tool registry exploded');
      },
      getActiveToolNames: () => {
        throw new Error('no tools');
      },
      resourceLoader: {
        getSkills: () => {
          throw new Error('bad skill file');
        },
        getPrompts: () => {
          throw new Error('bad template');
        },
        getAgentsFiles: () => {
          throw new Error('bad context file');
        },
      },
    };

    const snapshot = buildPromptSnapshot(broken, CONTEXT);
    expect(snapshot.systemPrompt.text).toBe('ok');
    expect(snapshot.tools).toEqual([]);
    expect(snapshot.skills).toEqual([]);
    expect(snapshot.overview.toolsActive).toBe(0);
  });

  it('truncates long text but keeps the counters honest', () => {
    const longDescription = 'd'.repeat(1_000);
    const manyTools: PiRegisteredTool[] = Array.from({ length: 260 }, (_item, index) => ({
      name: `tool-${index}`,
      description: longDescription,
      promptGuidelines: Array.from({ length: 12 }, (_g, g) => `guideline ${g}`),
      sourceInfo: { source: 'builtin' },
    }));
    const snapshot = buildPromptSnapshot(
      fullSession({
        systemPrompt: 's'.repeat(MAX_SYSTEM_PROMPT_CHARS + 10),
        getAllTools: () => manyTools,
      }),
      CONTEXT,
    );

    // 计数用完整列表，只有输出截断：否则工具一多，面板上的数字会静默变少。
    expect(snapshot.overview.toolsRegistered).toBe(260);
    expect(snapshot.tools).toHaveLength(200);
    expect(snapshot.tools[0].description).toHaveLength(601); // 600 + 省略号
    expect(snapshot.tools[0].promptGuidelines).toHaveLength(10);
    expect(snapshot.overview.systemPromptChars).toBe(MAX_SYSTEM_PROMPT_CHARS + 10);
    expect(snapshot.overview.systemPromptTruncated).toBe(true);
    expect(snapshot.systemPrompt.text).toHaveLength(MAX_SYSTEM_PROMPT_CHARS + 1);
  });

  it('drops tools and skills without a usable name instead of listing blanks', () => {
    const snapshot = buildPromptSnapshot(
      fullSession({
        getAllTools: () => [{ description: 'no name' }, { name: 'ok' }],
        resourceLoader: {
          getSkills: () => ({ skills: [{ description: 'no name' }, { name: 'ok' }] }),
        },
      }),
      CONTEXT,
    );

    expect(snapshot.tools.map((tool) => tool.name)).toEqual(['ok']);
    expect(snapshot.skills.map((skill) => skill.name)).toEqual(['ok']);
  });
});
