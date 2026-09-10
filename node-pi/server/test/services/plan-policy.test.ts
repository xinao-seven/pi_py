import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PLAN_POLICY,
  evaluatePlanBash,
  splitCommandSegments,
} from '../../src/services/plan-policy.js';

/** 只看放行与否，便于用表格写用例。 */
function allowed(command: string, policy = DEFAULT_PLAN_POLICY): boolean {
  return evaluatePlanBash(command, policy).allowed;
}

describe('规划期放行验证类命令（P6 的修复点）', () => {
  it('allows the verification commands that used to be blocked', () => {
    // 这三条正是旧 isSafePlanCommand() 白名单拦掉、导致规划质量差的命令。
    expect(allowed('pnpm test')).toBe(true);
    expect(allowed('tsc --noEmit')).toBe(true);
    expect(allowed('npm run build')).toBe(true);
    expect(allowed('npm test -- --run')).toBe(true);
    expect(allowed('npx vitest run src/foo.test.ts')).toBe(true);
    expect(allowed('pytest -q')).toBe(true);
    expect(allowed('cargo check')).toBe(true);
    expect(allowed('go build ./...')).toBe(true);
    expect(allowed('node -e "console.log(require(\'./package.json\').version)"')).toBe(true);
    expect(allowed('python -c "print(1+1)"')).toBe(true);
  });

  it('allows read-only commands', () => {
    for (const command of [
      'rg -n "plan" src',
      'cat package.json',
      'git status --short',
      'git log --oneline -5',
      'git diff HEAD~1',
      'npm ls --depth=0',
      'wc -l src/*.ts',
      'find . -name "*.test.ts"',
      'node --version',
      'sed -n "1,20p" file.ts',
    ]) {
      expect(allowed(command), command).toBe(true);
    }
  });

  it('classifies read vs verify capability', () => {
    expect(evaluatePlanBash('cat package.json').capability).toBe('read');
    expect(evaluatePlanBash('pnpm test').capability).toBe('verify');
  });
});

describe('规划期仍然拦下写操作', () => {
  it('blocks file mutations', () => {
    for (const command of [
      'rm -rf src',
      'mv a.ts b.ts',
      'cp a.ts b.ts',
      'mkdir new-dir',
      'touch new.ts',
      'sed -i "s/a/b/" file.ts',
      'echo hi > out.txt',
      'cat a > b',
      'tee out.txt',
      'git add -A',
      'git commit -m x',
      'git push',
      'npm install lodash',
      'pnpm add -D vitest',
      'powershell -Command "Remove-Item -Recurse x"',
    ]) {
      const verdict = evaluatePlanBash(command);
      expect(verdict.allowed, command).toBe(false);
      expect(['write', 'unknown']).toContain(verdict.capability);
    }
  });

  it('blocks network and unknown programs', () => {
    expect(allowed('curl https://example.com')).toBe(false);
    expect(allowed('wget http://example.com')).toBe(false);
    expect(allowed('some-random-binary --do-things')).toBe(false);
    expect(allowed('npx some-unknown-package')).toBe(false);
    expect(allowed('node scripts/deploy.js')).toBe(false);
    expect(evaluatePlanBash('some-random-binary').capability).toBe('unknown');
  });

  it('blocks inline scripts that write files', () => {
    expect(allowed("node -e \"require('fs').writeFileSync('a','b')\"")).toBe(false);
    expect(allowed("python -c \"open('x','w').write('hi')\"")).toBe(false);
    expect(allowed("node -e \"require('child_process').execSync('rm -rf /')\"")).toBe(false);
  });
});

describe('逐段判定（不给「前半合法后半破坏」留口子）', () => {
  it('rejects a command whose later segment writes', () => {
    expect(allowed('npm test && rm -rf src')).toBe(false);
    expect(allowed('cat a || mv a b')).toBe(false);
    expect(allowed('cat a | tee b')).toBe(false);
    expect(allowed('git status; git push')).toBe(false);
  });

  it('allows a chain of read-only segments', () => {
    expect(allowed('git status && git diff | head -50')).toBe(true);
    expect(allowed('cat a | grep b | wc -l')).toBe(true);
  });

  it('splitCommandSegments keeps quoted separators inside one segment', () => {
    expect(splitCommandSegments('echo "a && b" && ls')).toEqual(['echo "a && b"', 'ls']);
    expect(splitCommandSegments('  ')).toEqual([]);
  });

  it('explains why a command was rejected (rule name or the offending segment)', () => {
    // 危险规则优先于逐段判定，因此这里可能是规则名，也可能是段本身——两者都算说清楚原因。
    const destructive = evaluatePlanBash('npm test && rm -rf src');
    expect(destructive.allowed).toBe(false);
    expect(destructive.reason).toMatch(/recursive-delete|rm -rf src/);

    const plainWrite = evaluatePlanBash('npm test && mkdir build');
    expect(plainWrite.allowed).toBe(false);
    expect(plainWrite.reason).toContain('mkdir build');
    expect(plainWrite.reason).toContain('写操作');
  });
});

describe('策略开关', () => {
  it('bash=none blocks everything', () => {
    const policy = { ...DEFAULT_PLAN_POLICY, bash: 'none' as const };
    expect(allowed('cat package.json', policy)).toBe(false);
    expect(allowed('pnpm test', policy)).toBe(false);
    expect(evaluatePlanBash('cat x', policy).reason).toContain('bash: none');
  });

  it('bash=all allows everything that is not a dangerous rule', () => {
    const policy = { ...DEFAULT_PLAN_POLICY, bash: 'all' as const };
    expect(allowed('mkdir build', policy)).toBe(true);
    expect(allowed('cp a.ts b.ts', policy)).toBe(true);
    // 危险/敏感审批规则仍然优先：命中规则的一律拦（bash=all 也不例外）。
    expect(allowed('rm -rf src', policy)).toBe(false);
    expect(allowed('shutdown -h now', policy)).toBe(false);
    expect(allowed('npm install lodash', policy)).toBe(false);
  });

  it('verifyCommands extends the verify set', () => {
    const policy = { ...DEFAULT_PLAN_POLICY, verifyCommands: ['my-check'] };
    expect(allowed('my-check --strict', policy)).toBe(true);
    expect(allowed('my-check --strict')).toBe(false);
  });

  it('rejects empty input', () => {
    expect(evaluatePlanBash(undefined)).toMatchObject({ allowed: false });
    expect(evaluatePlanBash('   ')).toMatchObject({ allowed: false });
  });
});
