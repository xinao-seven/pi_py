/**
 * Node 后端的工作区（Workspace）登记服务。
 *
 * 中文说明：用户可以把任意已有的本地目录登记为工作区（用于约束 Agent 的
 * 工作范围与文件浏览权限）。登记结果持久化到一个 JSON 文件（默认是
 * ~/.pi/agent/node-server-workspaces.json，路径由 app.ts 传入）；
 * 未选择工作区时，会在配置的父目录下按日期创建默认工作区（pi-cwd-YYYYMMDD）。
 *
 * 设计要点：
 * - selected：内存中的已登记目录集合（Set，去重）；
 * - 启动时 initialize() 从 JSON 恢复；保存时原子写（临时文件 + rename）；
 * - 持久化失败只静默忽略，绝不影响用户当前会话的操作。
 */

import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { ApiError } from "../errors.js";
import { chooseDirectory } from "./directory-picker.js";

export class WorkspaceService {
  /** 已登记的绝对路径集合。 */
  private readonly selected = new Set<string>();
  /** 默认工作区父目录（resolve 成绝对路径）。 */
  readonly parent: string;

  /**
   * @param parent 默认工作区父目录（默认用户主目录）
   * @param persistPath 持久化文件路径；不传则不做持久化（测试用）
   * @param directoryPicker 目录选择函数（可注入 mock，测试时避免真的弹窗）
   */
  constructor(
    parent = homedir(),
    private readonly persistPath?: string,
    private readonly directoryPicker: () => Promise<string | undefined> = chooseDirectory,
  ) {
    this.parent = resolve(parent);
  }

  /** 初始化（onReady 钩子调用）：从持久化文件恢复已登记的工作区。 */
  async initialize(): Promise<void> {
    if (!this.persistPath) return;
    try {
      const value: unknown = JSON.parse(await readFile(this.persistPath, "utf8"));
      const workspaces = value && typeof value === "object" ? (value as { workspaces?: unknown }).workspaces : undefined;
      if (!Array.isArray(workspaces)) return;
      for (const path of workspaces) {
        if (typeof path !== "string") continue;
        try {
          // realpath 解析真实路径，且只登记仍然存在的目录（失效项静默跳过）。
          const resolved = await realpath(path);
          if ((await stat(resolved)).isDirectory()) this.selected.add(resolved);
        } catch { /* stale entries are ignored */ }
      }
    } catch { /* persistence is optional */ }
  }

  /** 列出所有已登记且仍然存在的目录（升序排序）。 */
  async roots(): Promise<string[]> {
    const roots = await Promise.all([...this.selected].map(async (path) => {
      try {
        return (await stat(path)).isDirectory() ? path : undefined;
      } catch {
        return undefined; // 目录已被删除 → 从结果中剔除
      }
    }));
    return roots.filter((path): path is string => path !== undefined).sort();
  }

  /** 登记一个已存在的目录为工作区；路径非法则 400。 */
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

  /** 弹系统目录选择器；用户取消（返回 undefined）时原样返回。 */
  async pickDirectory(): Promise<string | undefined> {
    const selected = await this.directoryPicker();
    return selected === undefined ? undefined : this.select(selected);
  }

  /** 在父目录下按日期创建默认工作区（如 pi-cwd-20250701）并自动登记。 */
  async createDefault(): Promise<string> {
    const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const workspace = join(this.parent, `pi-cwd-${stamp}`);
    await mkdir(workspace, { recursive: true });
    this.selected.add(await realpath(workspace));
    await this.save();
    return workspace;
  }

  /** 持久化当前登记集合（原子写；失败静默，不影响使用）。 */
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
