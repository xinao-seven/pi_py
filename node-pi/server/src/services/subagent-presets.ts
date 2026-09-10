/**
 * Subagent 预设发现：`{agentDir}/agents/*.md`（用户级）+ `{cwd}/.pi/agents/*.md`（项目级）。
 *
 * 中文说明：与官方 subagent 扩展**同契约**——frontmatter 提供 `name` / `description` /
 * `tools`（逗号分隔）/ `model`，正文就是该子 agent 的系统提示词。
 * 这样用户已有的 `scout` / `planner` / `reviewer` / `worker` 直接可用，CLI 与本服务共享同一份定义，
 * 不需要在仓库里另立一套 `explore` / `verify` / `general`（两套名字只会让人记不清）。
 *
 * 只读目录、不写任何文件；项目级同名预设覆盖用户级（与官方 `agentScope: "both"` 一致）。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { parseFrontmatter } from '@earendil-works/pi-coding-agent';

/** 一个子 agent 预设。 */
export interface SubagentPreset {
  name: string;
  description: string;
  /** 该子会话可用的工具白名单；缺省 = 全部工具（SDK 语义）。 */
  tools?: string[];
  /** 预设指定的模型（`provider/model` 或裸 id 或 `inherit`）；缺省 = 继承父会话。 */
  model?: string;
  /** 正文：注入子会话的系统提示词。 */
  systemPrompt: string;
  source: 'user' | 'project';
  filePath: string;
}

/** 项目级预设目录名（与 pi 的约定一致）。 */
export const PROJECT_AGENTS_DIR = join('.pi', 'agents');

/** 向上查找项目级 agents 目录的最大层数（防止一路走到盘符根）。 */
const MAX_UPWARD_LEVELS = 6;

/** 只读判定：`tools` 全部落在只读集合内时，子预设是只读的（Plan 模式据此放行）。 */
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set(['read', 'grep', 'find', 'ls']);

/** 从 cwd 向上找到最近的 `.pi/agents` 目录（含 cwd 自身）。 */
export function findProjectAgentsDir(cwd: string): string | undefined {
  let current = cwd;
  for (let level = 0; level <= MAX_UPWARD_LEVELS; level += 1) {
    const candidate = join(current, PROJECT_AGENTS_DIR);
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // 不存在或没权限：继续向上找
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

/** 读取一个目录下的全部预设（跳过没有 name/description 的文件）。 */
export function loadPresetsFromDir(dir: string, source: 'user' | 'project'): SubagentPreset[] {
  if (!existsSync(dir)) return [];
  const presets: SubagentPreset[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.name.endsWith('.md')) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const filePath = join(dir, entry.name);
    let content: string;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch {
      continue; // 单个文件读不了不影响其它预设
    }
    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
    const name = frontmatter.name?.trim();
    const description = frontmatter.description?.trim();
    if (!name || !description) continue;
    const tools = (frontmatter.tools ?? '')
      .split(',')
      .map((tool) => tool.trim())
      .filter(Boolean);
    presets.push({
      name,
      description,
      ...(tools.length > 0 ? { tools } : {}),
      ...(frontmatter.model?.trim() ? { model: frontmatter.model.trim() } : {}),
      systemPrompt: body,
      source,
      filePath,
    });
  }
  return presets;
}

/**
 * 发现全部可用预设（按名字去重，项目级覆盖用户级）。
 * 中文说明：名字排序固定（不是文件系统顺序），这样工具结果里的可选清单是稳定可测的。
 */
export function discoverSubagentPresets(options: {
  agentDir: string;
  cwd: string;
}): SubagentPreset[] {
  const byName = new Map<string, SubagentPreset>();
  for (const preset of loadPresetsFromDir(join(options.agentDir, 'agents'), 'user')) {
    byName.set(preset.name, preset);
  }
  const projectDir = findProjectAgentsDir(options.cwd);
  if (projectDir !== undefined) {
    for (const preset of loadPresetsFromDir(projectDir, 'project')) {
      byName.set(preset.name, preset);
    }
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/** 预设是否只读（Plan 模式下只有只读预设允许被委派）。 */
export function isReadOnlyPreset(preset: SubagentPreset): boolean {
  return (
    preset.tools !== undefined &&
    preset.tools.length > 0 &&
    preset.tools.every((tool) => READ_ONLY_TOOL_NAMES.has(tool))
  );
}
