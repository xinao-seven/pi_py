import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  discoverLocalExtensions,
  serverExtensionDirectory,
} from '../../src/services/agent-registry.js';

describe('server extension discovery', () => {
  it('uses the server-local extensions directory after the directory restructure', () => {
    const directory = serverExtensionDirectory(join(process.cwd(), 'src', 'services'));

    expect(directory).toBe(join(process.cwd(), 'extensions'));
  });

  it('discovers the built-in approval extension from the canonical directory', () => {
    const files = discoverLocalExtensions(
      serverExtensionDirectory(join(process.cwd(), 'src', 'services')),
    );

    expect(files.map((file) => basename(file))).toEqual(
      expect.arrayContaining(['tool-approval.ts', 'plan-mode.ts']),
    );
  });
});
