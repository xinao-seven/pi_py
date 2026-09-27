import { describe, expect, it } from 'vitest';

import { toolCallSummary } from '@/lib/tool-summary';

describe('toolCallSummary', () => {
  it('extracts the identity argument for command and file tools', () => {
    expect(toolCallSummary('bash', { command: 'npm test' })).toBe('npm test');
    expect(toolCallSummary('read', { path: 'src/lib/api.ts' })).toBe('src/lib/api.ts');
    expect(toolCallSummary('write', { path: 'a.txt', content: 'x' })).toBe('a.txt');
    expect(toolCallSummary('edit', { path: 'a.txt', oldText: 'x', newText: 'y' })).toBe('a.txt');
    expect(toolCallSummary('ls', { path: 'src' })).toBe('src');
    expect(toolCallSummary('grep', { pattern: 'TODO', path: 'src' })).toBe('TODO');
    expect(toolCallSummary('find', { pattern: '*.ts' })).toBe('*.ts');
  });

  it('collapses whitespace so multi-line commands stay on one line', () => {
    expect(toolCallSummary('bash', { command: 'cat <<EOF\n  hi\nEOF' })).toBe('cat <<EOF hi EOF');
    expect(toolCallSummary('bash', { command: '  git   status  ' })).toBe('git status');
  });

  it('returns an empty string for unknown tools, missing or non-string args', () => {
    // MCP / 未来新增工具：不认识就不猜参数名。
    expect(toolCallSummary('mcp__foo__bar', { query: 'x' })).toBe('');
    expect(toolCallSummary('read', {})).toBe('');
    expect(toolCallSummary('bash', { command: '' })).toBe('');
    expect(toolCallSummary('bash', { command: '   ' })).toBe('');
    expect(toolCallSummary('bash', { command: 42 })).toBe('');
    expect(toolCallSummary('bash', { command: { nested: true } })).toBe('');
    expect(toolCallSummary('bash', undefined)).toBe('');
    expect(toolCallSummary('bash', null)).toBe('');
    expect(toolCallSummary('bash', 'not an object')).toBe('');
    expect(toolCallSummary(undefined, { command: 'ls' })).toBe('');
  });

  it('keeps very long commands intact (CSS does the ellipsis, title needs the full text)', () => {
    const long = 'x'.repeat(5_000);
    expect(toolCallSummary('bash', { command: long })).toHaveLength(5_000);
  });
});
