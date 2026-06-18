import type { CoreMessage } from 'ai';
import type { Slice1Repos } from '../repositories/interfaces.js';
import type { AgentRunner } from './run-agent.js';
import { buildTools } from './tools.js';
import { isExpired, freshSession, trimTurns, extractLastTransactionId } from './orchestrator-helpers.js';
import { nowWIB } from '../domain/time.js';

export interface HandleMessageArgs {
  text: string;
  chatId: string;
  repos: Slice1Repos;
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
    user = await args.repos.users.create({ telegramChatId: args.chatId, name: 'Teman' });
    onboarded = true;
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
  const tools = buildTools({ userId: user.userId, repos: args.repos, hasAccount });

  // 5. Run the agent (seam — real model in prod via createRunner; fake in tests)
  const result = await args.run({
    system: args.system,
    messages,
    tools,
    maxSteps: 10,
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
