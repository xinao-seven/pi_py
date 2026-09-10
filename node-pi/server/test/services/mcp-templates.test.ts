import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';

import {
  assertTemplateTable,
  fixtureServerPath,
  listTemplates,
  MCP_TEMPLATES,
  MCP_TEMPLATE_GROUPS,
  resolveTemplate,
} from '../../src/services/mcp/mcp-templates.js';

describe('MCP 模板库：形状自检', () => {
  it('passes the built-in table validation', () => {
    expect(() => assertTemplateTable()).not.toThrow();
  });

  it('catches duplicate ids / names', () => {
    expect(() =>
      assertTemplateTable([
        { ...MCP_TEMPLATES[0] },
        { ...MCP_TEMPLATES[1], id: MCP_TEMPLATES[0].id },
      ]),
    ).toThrow(/duplicate template id/);
    expect(() =>
      assertTemplateTable([
        { ...MCP_TEMPLATES[0] },
        { ...MCP_TEMPLATES[1], name: MCP_TEMPLATES[0].name },
      ]),
    ).toThrow(/duplicate template name/);
  });

  it('catches a stdio template without a command and an http template without a url', () => {
    expect(() => assertTemplateTable([{ ...MCP_TEMPLATES[0], command: undefined }])).toThrow(
      /needs a command/,
    );
    expect(() =>
      assertTemplateTable([
        {
          ...MCP_TEMPLATES[0],
          transport: 'streamable-http',
          command: undefined,
          url: undefined,
          args: undefined,
        },
      ]),
    ).toThrow(/needs a url/);
  });

  it('refuses plaintext credentials in env / headers / args', () => {
    expect(() =>
      assertTemplateTable([{ ...MCP_TEMPLATES[0], env: { API_KEY: 'sk-live-123' } }]),
    ).toThrow(/must reference an env var/);
    expect(() =>
      assertTemplateTable([
        {
          ...MCP_TEMPLATES[0],
          headers: { Authorization: 'Bearer abc' },
        },
      ]),
    ).toThrow(/must reference an env var/);
    expect(() =>
      assertTemplateTable([
        { ...MCP_TEMPLATES[0], args: ['-y', 'pkg', '--access-token=sk-live-123'] },
      ]),
    ).toThrow(/plaintext credential in args/);
  });

  it('every group is used and every template is complete', () => {
    const used = new Set(MCP_TEMPLATES.map((template) => template.group));
    for (const group of used) expect(MCP_TEMPLATE_GROUPS).toContain(group);
    for (const template of MCP_TEMPLATES) {
      expect(template.description.length, template.id).toBeGreaterThan(15);
      expect(template.homepage, template.id).toMatch(/^https:\/\//);
    }
  });
});

describe('MCP 模板库：列表视图', () => {
  it('marks credential requirements and direct-add eligibility', () => {
    const views = listTemplates();
    const byId = Object.fromEntries(views.map((view) => [view.id, view]));

    // 无需凭据 + 无必填输入 → 可一键添加
    expect(byId.memory).toMatchObject({ requiresCredentials: false, canAddDirectly: true });
    expect(byId['sequential-thinking'].canAddDirectly).toBe(true);
    expect(byId.context7).toMatchObject({ requiresCredentials: false, canAddDirectly: true });

    // 需要凭据 → 只能填入表单
    expect(byId.tavily).toMatchObject({ requiresCredentials: true, canAddDirectly: false });
    expect(byId.mongodb).toMatchObject({ requiresCredentials: true, canAddDirectly: false });

    // 缺必填输入（filesystem 的根目录、uvx 系的项目路径）→ 也只能填入表单
    expect(byId.filesystem).toMatchObject({ requiresCredentials: false, canAddDirectly: false });
    expect(byId.filesystem.needsInput).toBeTruthy();
    expect(byId.serena.canAddDirectly).toBe(false);
  });

  it('keeps credentials as env references (never plaintext) in the view', () => {
    for (const view of listTemplates()) {
      for (const value of [
        ...Object.values(view.env ?? {}),
        ...Object.values(view.headers ?? {}),
      ]) {
        expect(value).toMatch(/^\$[A-Z][A-Z0-9_]*$/);
      }
    }
  });

  it('recommends approval for anything that can write outside the workspace', () => {
    for (const template of MCP_TEMPLATES) {
      if (template.access !== 'external-write') continue;
      expect(template.suggestApproval, `${template.id} 应建议审批`).toBe(true);
    }
  });

  it('marks Python templates as needing extra dependencies', () => {
    for (const template of MCP_TEMPLATES.filter((item) => item.command === 'uvx')) {
      expect(template.needsInput, template.id).toMatch(/uv/);
    }
  });
});

describe('MCP 模板库：自带 fixture 模板', () => {
  it('resolves the repo fixture path to a real file', () => {
    const template = resolveTemplate(MCP_TEMPLATES.find((item) => item.id === 'debug-echo')!);
    const path = template.args?.at(-1) ?? '';
    expect(path).not.toContain('@fixture:');
    expect(existsSync(path)).toBe(true);
    expect(path.endsWith('mcp-test-server.mjs')).toBe(true);
    expect(fixtureServerPath()).toBe(path);
  });

  it('leaves ordinary templates untouched', () => {
    const memory = MCP_TEMPLATES.find((item) => item.id === 'memory')!;
    expect(resolveTemplate(memory)).toEqual(memory);
  });
});
