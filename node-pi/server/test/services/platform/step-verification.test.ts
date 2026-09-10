import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { evaluateStepEvidence } from '../../../src/services/platform/step-verification.js';
import type { StepEvidence, StepVerification } from '../../../src/services/platform/task-model.js';

const noFile: (path: string) => boolean = () => false;
const exists =
  (paths: string[]): ((path: string) => boolean) =>
  (path) =>
    paths.includes(path);

describe('evaluateStepEvidence（未声明 verification）', () => {
  it('rejects missing or empty evidence', () => {
    expect(evaluateStepEvidence(undefined, undefined)).toMatchObject({ ok: false });
    expect(
      evaluateStepEvidence(undefined, { toolCallIds: [], filesTouched: [], summary: '   ' }),
    ).toMatchObject({ ok: false });
  });

  it('accepts any non-empty evidence', () => {
    const evidence: StepEvidence = { toolCallIds: [], filesTouched: [], summary: '改完了' };
    expect(evaluateStepEvidence(undefined, evidence)).toMatchObject({ ok: true });
    expect(
      evaluateStepEvidence(undefined, { toolCallIds: [], filesTouched: ['src/a.ts'] }),
    ).toMatchObject({ ok: true });
  });
});

describe('evaluateStepEvidence（kind=file）', () => {
  const verification: StepVerification = { kind: 'file', path: 'dist/index.js' };

  it('fails when the artifact is absent and tells the model what to do', () => {
    const check = evaluateStepEvidence(
      verification,
      { toolCallIds: [], filesTouched: [], summary: '构建完成' },
      { cwd: '/workspace', exists: noFile },
    );
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('产物不存在');
  });

  it('passes when the artifact exists (relative path resolved against cwd)', () => {
    const check = evaluateStepEvidence(
      verification,
      { toolCallIds: [], filesTouched: [], summary: '构建产出 dist' },
      { cwd: '/workspace', exists: exists([resolve('/workspace', 'dist/index.js')]) },
    );
    expect(check).toMatchObject({ ok: true });
    expect(check.detail).toContain('index.js');
  });

  it('rejects a file verification without a path (bad declaration is not silently accepted)', () => {
    expect(
      evaluateStepEvidence({ kind: 'file' }, { toolCallIds: [], filesTouched: ['x'] }),
    ).toMatchObject({ ok: false });
  });
});

describe('evaluateStepEvidence（kind=command）', () => {
  const verification: StepVerification = { kind: 'command', command: 'npm test' };

  it('requires the command to appear in the evidence with the expected exit code', () => {
    const missing = evaluateStepEvidence(verification, {
      toolCallIds: [],
      filesTouched: [],
      commands: [{ command: 'npm run build', exitCode: 0 }],
    });
    expect(missing.ok).toBe(false);
    expect(missing.detail).toContain('没有验证命令');

    const failed = evaluateStepEvidence(verification, {
      toolCallIds: [],
      filesTouched: [],
      commands: [{ command: 'npm test', exitCode: 1 }],
    });
    expect(failed.ok).toBe(false);
    expect(failed.detail).toContain('期望 0');

    const passed = evaluateStepEvidence(verification, {
      toolCallIds: [],
      filesTouched: [],
      commands: [{ command: '  npm   test ', exitCode: 0 }],
    });
    expect(passed).toMatchObject({ ok: true });
  });

  it('honours expectExitCode (some checks expect a non-zero code)', () => {
    const expectOne: StepVerification = {
      kind: 'command',
      command: 'tsc --noEmit',
      expectExitCode: 1,
    };
    expect(
      evaluateStepEvidence(expectOne, {
        toolCallIds: [],
        filesTouched: [],
        commands: [{ command: 'tsc --noEmit', exitCode: 1 }],
      }),
    ).toMatchObject({ ok: true });
    expect(
      evaluateStepEvidence(expectOne, {
        toolCallIds: [],
        filesTouched: [],
        commands: [{ command: 'tsc --noEmit', exitCode: 0 }],
      }),
    ).toMatchObject({ ok: false });
  });

  it('treats a null exit code as not matching', () => {
    expect(
      evaluateStepEvidence(verification, {
        toolCallIds: [],
        filesTouched: [],
        commands: [{ command: 'npm test', exitCode: null }],
      }),
    ).toMatchObject({ ok: false });
  });
});

describe('evaluateStepEvidence（kind=manual 与未知 kind）', () => {
  it('needs a summary for manual verification', () => {
    expect(
      evaluateStepEvidence(
        { kind: 'manual' },
        { toolCallIds: [], filesTouched: [], summary: '人工核对过界面' },
      ),
    ).toMatchObject({ ok: true });
    expect(
      evaluateStepEvidence({ kind: 'manual' }, {
        toolCallIds: [],
        filesTouched: [],
        filesTouchedOnly: true,
      } as StepEvidence),
    ).toMatchObject({ ok: false });
  });

  it('rejects unknown kinds instead of waving them through', () => {
    const check = evaluateStepEvidence({ kind: 'vibes' } as unknown as StepVerification, {
      toolCallIds: [],
      filesTouched: ['x'],
    });
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('未知的 verification.kind');
  });
});
