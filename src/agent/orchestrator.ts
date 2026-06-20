import type { CoreMessage } from 'ai';
import type { Repos } from '../repositories/interfaces.js';
import type { AgentRunner } from './run-agent.js';
import { buildTools } from './tools.js';
import { isExpired, freshSession, trimTurns, extractLastTransactionId } from './orchestrator-helpers.js';
import { nowWIB } from '../domain/time.js';
import { logEvent } from '../utils/logger.js';

export interface HandleMessageArgs {
  text: string;
  chatId: string;
  repos: Repos;
  /** Injectable runner: production uses createRunner(model); tests pass a fake. */
  run: AgentRunner;
  system: string;
  contextWindowTurns: number;
  sessionIdleTimeoutMinutes: number;
  /** Stable clock injection for deterministic expiry checks. */
  now?: () => Date;
}

export interface HandleMessageResult {
  reply: string;
  onboarded: boolean;
}

export async function handleMessage(args: HandleMessageArgs): Promise<HandleMessageResult> {
  const now = args.now ?? (() => new Date());
  const nowIso = nowWIB(now());

  // 1. Resolve user (onboard if unknown)
  let user = await args.repos.users.findByTelegramChatId(args.chatId);
  let onboarded = false;
  if (!user) {
    user = await args.repos.users.create({ telegramChatId: args.chatId, name: '' });
    onboarded = true;
  }

  // NFR-07: log incoming message after user resolution
  logEvent('info', 'message received', {
    userId: user.userId, chatId: args.chatId, onboarded, textLength: args.text.length,
  });

  // Enrich the system prompt with the user's saved preferences (inject every
  // turn). Preferences are optional enrichment — degrade gracefully if the
  // read fails: log and proceed with the base prompt.
  let system = args.system;
  try {
    const prefs = await args.repos.preferences.findAllByUserId(user.userId);
    if (prefs.length) {
      system = args.system +
        '\n\nPREFERENSI USER (sudah diketahui — jangan tanya ulang):\n' +
        prefs.map((p) => `- ${p.key}: ${p.value}`).join('\n');
    }
  } catch (e) {
    logEvent('error', 'preferences load failed', { userId: user.userId, chatId: args.chatId, error: (e as Error).message });
  }

  // 2. Load or reset session
  let session = await args.repos.sessions.get(args.chatId);
  if (!session || isExpired(session, args.sessionIdleTimeoutMinutes, nowIso)) {
    session = freshSession(args.chatId, user.userId, nowIso);
  }

  // 3. Append the user turn
  const messages: CoreMessage[] = [...session.turns, { role: 'user', content: args.text }];

  // 4. Build tools (gated by onboarding state)
  const accounts = await args.repos.accounts.findAllByUserId(user.userId);
  const hasAccount = accounts.length > 0;
  const tools = buildTools({
    userId: user.userId,
    repos: args.repos,
    hasAccount,
    lastTransactionId: session.lastTransactionId,
  });

  // 5. Run the agent (seam — real model in prod via createRunner; fake in tests)
  let result;
  try {
    result = await args.run({
      system,
      messages,
      tools,
      maxSteps: 10,
    });
  } catch (err) {
    logEvent('error', 'agent run failed', {
      userId: user.userId, chatId: args.chatId, error: (err as Error).message,
    });
    throw err;
  }

  // NFR-07: log agent completion summary
  logEvent('info', 'agent run complete', {
    userId: user.userId,
    chatId: args.chatId,
    stepCount: result.toolResults.length,
    toolNames: result.toolResults.map((t) => t.toolName),
    replyLength: result.text.length,
  });

  // 6. Append response messages + trim
  messages.push(...result.responseMessages);
  const trimmed = trimTurns(messages, args.contextWindowTurns);

  // 7. Persist session
  const lastTxnId = extractLastTransactionId(result.toolResults) ?? session.lastTransactionId;
  await args.repos.sessions.set({
    ...session,
    turns: trimmed,
    lastTransactionId: lastTxnId,
    lastActivityAt: nowIso,
  });

  return { reply: result.text, onboarded };
}
