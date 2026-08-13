import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { loadSkills, type Skill } from "@earendil-works/pi-coding-agent";

import { ApiError } from "../errors.js";
import { WorkspaceService } from "./workspace-service.js";

export class SkillService {
  constructor(private readonly agentDir: string, private readonly workspaces: WorkspaceService) {}

  async list(cwd: string): Promise<Record<string, unknown>> {
    if (!(await this.isWorkspaceRoot(cwd))) {
      throw new ApiError(403, "workspace_not_allowed", "Workspace is not registered");
    }
    return this.serialize(loadSkills({ cwd, agentDir: this.agentDir, skillPaths: [], includeDefaults: true }));
  }

  async toggle(filePath: string, disabled: boolean): Promise<void> {
    const allowed = new Set<string>();
    for (const cwd of await this.workspaces.roots()) {
      for (const skill of loadSkills({ cwd, agentDir: this.agentDir, skillPaths: [], includeDefaults: true }).skills) {
        allowed.add(this.key(skill.filePath));
      }
    }
    const target = resolve(filePath);
    if (!allowed.has(this.key(target))) {
      throw new ApiError(403, "skill_not_allowed", "Skill file is not part of a registered workspace");
    }
    try { if (!(await stat(target)).isFile()) throw new Error("not a file"); }
    catch { throw new ApiError(404, "skill_not_found", "Skill file was not found"); }
    const content = await readFile(target, "utf8");
    const key = "disable-model-invocation";
    const pattern = new RegExp(`^${key}\\s*:.*(?:\\r?\\n|$)`, "m");
    const updated = disabled
      ? (pattern.test(content)
        ? content.replace(pattern, `${key}: true\n`)
        : content.match(/^---\r?\n/) ? content.replace(/^---\r?\n/, `---\n${key}: true\n`) : `---\n${key}: true\n---\n${content}`)
      : content.replace(pattern, "");
    if (updated === content) return;
    const temporary = resolve(dirname(target), `.${basename(target)}.${crypto.randomUUID()}.tmp`);
    await writeFile(temporary, updated, "utf8");
    await rename(temporary, target);
  }

  private async isWorkspaceRoot(cwd: string): Promise<boolean> {
    let candidate: string;
    try { candidate = resolve(cwd); } catch { return false; }
    return (await this.workspaces.roots()).some((root) => this.key(root) === this.key(candidate));
  }

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

  private skill(skill: Skill): Record<string, unknown> {
    return {
      name: skill.name,
      description: skill.description,
      filePath: skill.filePath,
      baseDir: skill.baseDir,
      source: skill.sourceInfo.source,
      sourceInfo: skill.sourceInfo,
      disableModelInvocation: skill.disableModelInvocation,
    };
  }

  private key(path: string): string { return resolve(path).toLocaleLowerCase(); }
}
