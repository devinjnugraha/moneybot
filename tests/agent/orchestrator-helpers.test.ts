import { describe, it, expect } from 'vitest';
import { isExpired, freshSession, trimTurns, extractLastTransactionId } from '../../src/agent/orchestrator-helpers.js';
import type { CoreMessage } from 'ai';

describe('isExpired', () => {
  it('is expired when idle longer than the timeout', () => {
    const last = new Date('2026-06-14T10:00:00Z').toISOString();
    const now = new Date('2026-06-14T10:45:00Z').toISOString();
    expect(isExpired({ lastActivityAt: last }, 30, now)).toBe(true);
  });
  it('is not expired within the timeout', () => {
    const last = new Date('2026-06-14T10:00:00Z').toISOString();
    const now = new Date('2026-06-14T10:29:00Z').toISOString();
    expect(isExpired({ lastActivityAt: last }, 30, now)).toBe(false);
  });
});

describe('freshSession', () => {
  it('starts with empty turns and no lastTransactionId', () => {
    const s = freshSession('chat-1', 'user-1', new Date('2026-06-14T10:00:00Z').toISOString());
    expect(s.chatId).toBe('chat-1');
    expect(s.turns).toEqual([]);
    expect(s.lastTransactionId).toBeUndefined();
  });
});

describe('trimTurns', () => {
  it('drops whole turns from the front, never splitting a tool-call from its result', () => {
    // 3 turns: each = user + assistant(tool_call) + tool_result + assistant(final)
    const mk = (n: number): CoreMessage[] => [
      { role: 'user', content: `u${n}` },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: `tc${n}`, toolName: 'x', args: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: `tc${n}`, toolName: 'x', result: {} }] },
      { role: 'assistant', content: `a${n}` },
    ];
    const messages: CoreMessage[] = [...mk(1), ...mk(2), ...mk(3)];
    const trimmed = trimTurns(messages, 2);
    // oldest turn (1) dropped entirely; remaining start with u2
    expect((trimmed[0] as { content: string }).content).toBe('u2');
    expect(trimmed).toHaveLength(8); // 2 turns * 4 messages
  });
});

describe('extractLastTransactionId', () => {
  it('returns the latest transactionId across tool results', () => {
    const results = [
      { toolName: 'create_account', result: { status: 'ok', data: { accountId: 'acc-1' } } },
      { toolName: 'create_expense', result: { status: 'ok', data: { transaction: { transactionId: 'txn-1' } } } },
      { toolName: 'create_expense', result: { status: 'ok', data: { transaction: { transactionId: 'txn-2' } } } },
    ];
    expect(extractLastTransactionId(results)).toBe('txn-2');
  });
  it('returns undefined when no write tool produced a transaction', () => {
    const results = [{ toolName: 'get_accounts', result: [] }];
    expect(extractLastTransactionId(results)).toBeUndefined();
  });
});
