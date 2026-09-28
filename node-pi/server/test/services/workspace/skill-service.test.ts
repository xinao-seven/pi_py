import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ApiError } from '../../../src/errors.js';
import { SkillService } from '../../../src/services/workspace/skill-service.js';
import { WorkspaceService } from '../../../src/services/workspace/workspace-service.js';

/**
 * 技能发现的隔离测试：agentDir 与 `~/.agents`（靠 HOME 重定向）都在临时目录里，
 * 不碰真实的 `~/.pi` 与主目录。
 */
describe('SkillService', () => {
  let home: string;
  let agentDir: string;
  let workspace: string;
  let previousHome: string | undefined;
  let service: SkillService;

  /** 写一个最小可用技能（合法名称 + 描述）。 */
  async function writeSkill(root: string, name: string, description: string): Promise<string> {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'SKILL.md');
    await writeFile(
      file,
      `---\nname: ${name}\ndescription: ${description}\n---\n\n正文。\n`,
      'utf8',
    );
    return file;
  }

  beforeEach(async () => {
    previousHome = process.env.HOME;
    home = await mkdtemp(join(tmpdir(), 'pi-skill-home-'));
    // SDK 的 ~/.agents/skills 走 process.env.HOME || homedir()，重定向即可隔离。
    process.env.HOME = home;
    agentDir = join(home, '.pi', 'agent');
    workspace = await mkdtemp(join(tmpdir(), 'pi-skill-ws-'));
    const workspaces = new WorkspaceService(home, undefined);
    await workspaces.select(workspace);
    service = new SkillService(agentDir, workspaces);
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await Promise.all([home, workspace].map((path) => rm(path, { force: true, recursive: true })));
  });

  it('lists skills from .pi and .agents, both user-level and project-level', async () => {
    await writeSkill(join(agentDir, 'skills'), 'user-pi', '用户 pi 目录');
    await writeSkill(join(home, '.agents', 'skills'), 'user-agents', '用户 agents 目录');
    await writeSkill(join(workspace, '.pi', 'skills'), 'project-pi', '项目 pi 目录');
    await writeSkill(join(workspace, '.agents', 'skills'), 'project-agents', '项目 agents 目录');

    const result = (await service.list(workspace)) as {
      skills: Array<{ name: string; sourceInfo: { scope?: string } }>;
    };

    // 只断言本次造出来的四个：SDK 还会从「工作区祖先目录的 .agents/skills」
    // 里发现技能（临时目录在用户主目录下，所以本机会带出真实的用户技能）。
    const names = result.skills.map((skill) => skill.name);
    expect(names).toEqual(
      expect.arrayContaining(['project-agents', 'project-pi', 'user-agents', 'user-pi']),
    );
    const scopeOf = (name: string) =>
      result.skills.find((skill) => skill.name === name)?.sourceInfo.scope;
    expect(scopeOf('user-agents')).toBe('user');
    expect(scopeOf('project-agents')).toBe('project');
  });

  it('refuses to list skills for a workspace that is not registered', async () => {
    const stranger = await mkdtemp(join(tmpdir(), 'pi-skill-stranger-'));
    try {
      await expect(service.list(stranger)).rejects.toBeInstanceOf(ApiError);
    } finally {
      await rm(stranger, { force: true, recursive: true });
    }
  });

  it('toggles disable-model-invocation on a discovered skill file', async () => {
    const file = await writeSkill(join(home, '.agents', 'skills'), 'agents-skill', '描述');

    const stateOf = async () => {
      const result = (await service.list(workspace)) as {
        skills: Array<{ name: string; disableModelInvocation: boolean }>;
      };
      return result.skills.find((skill) => skill.name === 'agents-skill')?.disableModelInvocation;
    };

    await service.toggle(file, true);
    await expect(stateOf()).resolves.toBe(true);

    await service.toggle(file, false);
    await expect(stateOf()).resolves.toBe(false);
  });

  it('rejects toggling a skill outside every registered workspace', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'pi-skill-outside-'));
    const file = await writeSkill(join(outside, '.agents', 'skills'), 'outside-skill', '外部');
    try {
      await expect(service.toggle(file, true)).rejects.toMatchObject({ code: 'skill_not_allowed' });
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });
});
