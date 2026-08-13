/** Workspace registration for the Node backend.
 *
 * 中文说明：用户可将任意已有本地目录登记为工作区；默认工作区仍在配置的父目录中按日期创建。
 */

import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { ApiError } from "../errors.js";
import { chooseDirectory } from "./directory-picker.js";

export class WorkspaceService {
  private readonly selected = new Set<string>();
  readonly parent: string;

  constructor(
    parent = homedir(),
    private readonly persistPath?: string,
    private readonly directoryPicker: () => Promise<string | undefined> = chooseDirectory,
  ) {
    this.parent = resolve(parent);
  }

  async initialize(): Promise<void> {
    if (!this.persistPath) return;
    try {
      const value: unknown = JSON.parse(await readFile(this.persistPath, "utf8"));
      const workspaces = value && typeof value === "object" ? (value as { workspaces?: unknown }).workspaces : undefined;
      if (!Array.isArray(workspaces)) return;
      for (const path of workspaces) {
        if (typeof path !== "string") continue;
        try {
          const resolved = await realpath(path);
          if ((await stat(resolved)).isDirectory()) this.selected.add(resolved);
        } catch { /* stale entries are ignored */ }
      }
    } catch { /* persistence is optional */ }
  }

  async roots(): Promise<string[]> {
    const roots = await Promise.all([...this.selected].map(async (path) => {
      try {
        return (await stat(path)).isDirectory() ? path : undefined;
      } catch {
        return undefined;
      }
    }));
    return roots.filter((path): path is string => path !== undefined).sort();
  }

  async select(path: string): Promise<string> {
    let candidate: string;
    try {
      candidate = await realpath(path);
      if (!(await stat(candidate)).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new ApiError(400, "invalid_workspace", `Workspace does not exist: ${path}`);
    }
    this.selected.add(candidate);
    await this.save();
    return candidate;
  }

  async pickDirectory(): Promise<string | undefined> {
    const selected = await this.directoryPicker();
    return selected === undefined ? undefined : this.select(selected);
  }

  async createDefault(): Promise<string> {
    const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const workspace = join(this.parent, `pi-cwd-${stamp}`);
    await mkdir(workspace, { recursive: true });
    this.selected.add(await realpath(workspace));
    await this.save();
    return workspace;
  }

  private async save(): Promise<void> {
    if (!this.persistPath) return;
    try {
      await mkdir(dirname(this.persistPath), { recursive: true });
      const temporary = `${this.persistPath}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ workspaces: [...this.selected].sort() }, null, 2)}\n`, "utf8");
      await rename(temporary, this.persistPath);
    } catch { /* failing to persist must not block workspace selection */ }
  }
}
