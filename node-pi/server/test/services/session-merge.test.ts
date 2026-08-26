import { describe, expect, it } from 'vitest';

import {
  appendMergeSummary,
  createMergeSummary,
  type MergeableSessionManager,
} from '../../src/services/session-merge.js';

function manager(
  entries: Record<string, unknown>[],
): MergeableSessionManager & { appended: unknown[] } {
  const appended: unknown[] = [];
  return {
    appended,
    getEntries: () => entries,
    getSessionName: () => 'Source work',
    appendCustomMessageEntry: (...args) => {
      appended.push(args);
      return 'merge-entry';
    },
  };
}

describe('session merge', () => {
  it('adds a bounded, auditable custom message for source-only content', () => {
    const source = manager([
      { id: 'shared', type: 'message', message: { role: 'user', content: 'shared' } },
      {
        id: 'unique',
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'text', text: 'implement the API' }] },
      },
    ]);
    const target = manager([
      { id: 'shared', type: 'message', message: { role: 'user', content: 'shared' } },
    ]);
    const summary = createMergeSummary(source, target, 'source-session');

    expect(summary).toMatchObject({ sourceUniqueEntryCount: 1, summarizedItemCount: 1 });
    expect(summary?.content).toContain('Assistant: implement the API');
    expect(appendMergeSummary(target, 'source-session', summary!)).toBe('merge-entry');
    expect(target.appended).toHaveLength(1);
  });
});
