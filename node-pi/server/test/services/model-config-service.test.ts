import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ModelConfigService } from '../../src/services/model-config-service.js';

describe('ModelConfigService', () => {
  const temporaryDirectories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it('writes only environment-variable API key references', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'pi-node-models-'));
    temporaryDirectories.push(agentDir);
    const service = new ModelConfigService(agentDir);
    await service.write({
      providers: {
        local: {
          api: 'openai-completions',
          apiKey: '$LOCAL_API_KEY',
          models: [{ id: 'local-model', contextWindow: 4096 }],
        },
      },
    });
    await expect(service.read()).resolves.toEqual({
      providers: {
        local: {
          api: 'openai-completions',
          apiKey: '$LOCAL_API_KEY',
          models: [{ id: 'local-model', contextWindow: 4096 }],
        },
      },
    });
    await expect(
      service.write({ providers: { local: { apiKey: 'secret' } } }),
    ).rejects.toMatchObject({ code: 'invalid_models_config' });
  });
});
