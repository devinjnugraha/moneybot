import type { CoreMessage } from 'ai';
import type { SessionContext } from '../domain/entities.js';

export function isExpired(
  session: { lastActivityAt: string },
  timeoutMinutes: number,
  nowIso: string = new Date().toISOString(),
): boolean {
  const last = Date.parse(session.lastActivityAt);
  const now = Date.parse(nowIso);
  return now - last > timeoutMinutes * 60_000;
}

export function freshSession(chatId: string, userId: string, nowIso: string): SessionContext {
  return {
    chatId,
    userId,
    turns: [],
    lastTransactionId: undefined,
    lastActivityAt: nowIso,
  };
}

/**
 * Trim to the last `maxTurns` turns. A turn = one user message + every following
 * message up to (not including) the next user message. Trimming removes whole
 * turns from the front so a tool-call is never split from its tool-result.
 */
export function trimTurns(messages: CoreMessage[], maxTurns: number): CoreMessage[] {
  // Indices where each turn starts (each user message begins a new turn)
  const turnStarts: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === 'user') turnStarts.push(i);
  });
  if (turnStarts.length <= maxTurns) return messages;
  const keepFrom = turnStarts[turnStarts.length - maxTurns]!;
  return messages.slice(keepFrom);
}

/**
 * Extract the most recent transactionId from write-tool results. Tools return
 * WriteResult objects; only `status: 'ok'` with a `transaction.transactionId`
 * counts.
 */
export function extractLastTransactionId(
  toolResults: Array<{ toolName: string; result: unknown }>,
): string | undefined {
  let last: string | undefined;
  for (const { result } of toolResults) {
    const r = result as { status?: string; data?: { transaction?: { transactionId?: string } } };
    if (r && r.status === 'ok' && r.data?.transaction?.transactionId) {
      last = r.data.transaction.transactionId;
    }
  }
  return last;
}
