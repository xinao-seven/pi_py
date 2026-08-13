import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkspaceService } from "../../src/services/workspace-service.js";

describe("WorkspaceService", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
  });

  it("creates and lists a default workspace inside its configured parent", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-node-workspace-"));
    temporaryDirectories.push(parent);
    const service = new WorkspaceService(parent);

    const cwd = await service.createDefault();

    expect(cwd).toContain("pi-cwd-");
    await expect(service.roots()).resolves.toEqual([cwd]);
  });

  it("registers any existing directory explicitly selected by the user", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-node-workspace-"));
    const outside = await mkdtemp(join(tmpdir(), "pi-node-outside-"));
    temporaryDirectories.push(parent, outside);
    const service = new WorkspaceService(parent);

    await expect(service.select(outside)).resolves.toBe(outside);
    await expect(service.roots()).resolves.toEqual([outside]);
  });

  it("restores selected directories after a Node server restart", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-node-workspace-"));
    const outside = await mkdtemp(join(tmpdir(), "pi-node-outside-"));
    temporaryDirectories.push(parent, outside);
    const persistPath = join(parent, "node-server-workspaces.json");

    const first = new WorkspaceService(parent, persistPath);
    await first.select(outside);
    const restarted = new WorkspaceService(parent, persistPath);
    await restarted.initialize();

    await expect(restarted.roots()).resolves.toEqual([outside]);
  });

  it("registers the directory returned by its native picker adapter", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-node-workspace-"));
    const selected = await mkdtemp(join(tmpdir(), "pi-node-picked-workspace-"));
    temporaryDirectories.push(parent, selected);
    const service = new WorkspaceService(parent, undefined, async () => selected);

    await expect(service.pickDirectory()).resolves.toBe(resolve(selected));
  });
});
