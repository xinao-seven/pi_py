import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { FileService } from '../../src/services/file-service.js';
import { WorkspaceService } from '../../src/services/workspace-service.js';

describe('FileService', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it('lists and reads registered-workspace files without exposing secrets', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'pi-node-files-'));
    temporaryDirectories.push(parent);
    const workspace = join(parent, 'workspace');
    await mkdir(workspace);
    await writeFile(join(workspace, 'hello.ts'), 'export const answer = 42;\n');
    await writeFile(join(workspace, '.env'), 'TOKEN=secret\n');
    await mkdir(join(workspace, 'node_modules'));

    const workspaces = new WorkspaceService(parent);
    await workspaces.select(workspace);
    const service = new FileService(workspaces);

    await expect(service.list('', workspace)).resolves.toMatchObject({
      entries: [{ name: 'hello.ts', isDir: false }],
    });
    await expect(service.readText('hello.ts', workspace)).resolves.toMatchObject({
      content: 'export const answer = 42;\n',
      language: 'typescript',
    });
    await expect(service.readText('.env', workspace)).rejects.toMatchObject({
      code: 'sensitive_file',
    });
    await expect(service.readText('../outside.txt', workspace)).rejects.toMatchObject({
      code: 'path_outside_workspace',
    });
  });
});
