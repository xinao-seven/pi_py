/**
 * 技能（Skills）服务。
 *
 * 中文说明：技能是 Pi 的 SKILL.md 机制——位于工作区 / .pi 下的 markdown 文件，
 * 通过 YAML frontmatter 描述名称与描述，正文是给模型的操作指引。
 * 本服务提供：列出某工作区可见的技能；切换某个技能文件的
 * disable-model-invocation 标志（关闭后模型不再自动加载该技能）。
 */

import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import { loadSkills, type Skill } from '@earendil-works/pi-coding-agent';

import { ApiError } from '../errors.js';
import { WorkspaceService } from './workspace-service.js';

export class SkillService {
  constructor(
    private readonly agentDir: string,
    private readonly workspaces: WorkspaceService,
  ) {}

  /** 列出工作区可见的所有技能 + 加载诊断信息。 */
  async list(cwd: string): Promise<Record<string, unknown>> {
    // 只允许列出"已登记工作区"的技能，防止探测任意目录。
    if (!(await this.isWorkspaceRoot(cwd))) {
      throw new ApiError(403, 'workspace_not_allowed', 'Workspace is not registered');
    }
    // loadSkills 是 Pi SDK 的技能扫描器：扫工作区/.pi 等位置的 SKILL.md。
    return this.serialize(
      loadSkills({ cwd, agentDir: this.agentDir, skillPaths: [], includeDefaults: true }),
    );
  }

  /**
   * 打开/关闭技能的模型调用能力。
   * @param filePath 技能文件绝对路径
   * @param disabled true = 关闭（写入 disable-model-invocation: true）
   */
  async toggle(filePath: string, disabled: boolean): Promise<void> {
    // 安全校验：技能文件必须属于某个已登记工作区（通过扫描所有工作区得到白名单）。
    const allowed = new Set<string>();
    for (const cwd of await this.workspaces.roots()) {
      for (const skill of loadSkills({
        cwd,
        agentDir: this.agentDir,
        skillPaths: [],
        includeDefaults: true,
      }).skills) {
        allowed.add(this.key(skill.filePath));
      }
    }
    const target = resolve(filePath);
    if (!allowed.has(this.key(target))) {
      throw new ApiError(
        403,
        'skill_not_allowed',
        'Skill file is not part of a registered workspace',
      );
    }
    // 文件必须存在且是文件。
    try {
      if (!(await stat(target)).isFile()) throw new Error('not a file');
    } catch {
      throw new ApiError(404, 'skill_not_found', 'Skill file was not found');
    }

    // 修改 SKILL.md 的 YAML frontmatter：
    // - 关闭：已有该键则覆盖为 true；没有则在 frontmatter 里插入；
    //   完全没有 frontmatter 则补一个 --- ... --- 块；
    // - 打开：删除该键（模型恢复自动加载）。
    const content = await readFile(target, 'utf8');
    const key = 'disable-model-invocation';
    const pattern = new RegExp(`^${key}\\s*:.*(?:\\r?\\n|$)`, 'm');
    const updated = disabled
      ? pattern.test(content)
        ? content.replace(pattern, `${key}: true\n`)
        : content.match(/^---\r?\n/)
          ? content.replace(/^---\r?\n/, `---\n${key}: true\n`)
          : `---\n${key}: true\n---\n${content}`
      : content.replace(pattern, '');
    if (updated === content) return; // 内容没变化（比如本来就没开），无需写盘

    // 原子写：同目录临时文件 + rename，避免写一半崩溃。
    const temporary = resolve(dirname(target), `.${basename(target)}.${crypto.randomUUID()}.tmp`);
    await writeFile(temporary, updated, 'utf8');
    await rename(temporary, target);
  }

  /** cwd 是否正好是一个已登记工作区根目录。 */
  private async isWorkspaceRoot(cwd: string): Promise<boolean> {
    let candidate: string;
    try {
      candidate = resolve(cwd);
    } catch {
      return false;
    }
    return (await this.workspaces.roots()).some((root) => this.key(root) === this.key(candidate));
  }

  /** 把 SDK 的 loadSkills 结果序列化成前端需要的结构（技能 + 诊断）。 */
  private serialize(result: ReturnType<typeof loadSkills>): Record<string, unknown> {
    return {
      skills: result.skills.map((skill) => this.skill(skill)),
      diagnostics: result.diagnostics.map((diagnostic) => ({
        type: diagnostic.type,
        message: diagnostic.message,
        path: diagnostic.path,
      })),
    };
  }

  /** 单个技能 → 前端字段。 */
  private skill(skill: Skill): Record<string, unknown> {
    return {
      name: skill.name,
      description: skill.description,
      filePath: skill.filePath,
      baseDir: skill.baseDir,
      source: skill.sourceInfo.source, // 技能来源（workspace/.pi 等）
      sourceInfo: skill.sourceInfo,
      disableModelInvocation: skill.disableModelInvocation, // 当前是否已关闭模型调用
    };
  }

  /** 路径归一化键（绝对路径 + 小写），用于白名单比较。 */
  private key(path: string): string {
    return resolve(path).toLocaleLowerCase();
  }
}
