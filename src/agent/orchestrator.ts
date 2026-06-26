import type { CoreMessage } from 'ai';
import type { Repos } from '../repositories/interfaces.js';
import type { AgentRunner } from './run-agent.js';
import type { Account } from '../domain/entities.js';
import { buildTools } from './tools.js';
import { enrichSystemPrompt } from './system-prompt.js';
import { isExpired, freshSession, trimTurns, extractLastTransactionId } from './orchestrator-helpers.js';
import { nowWIB, wibYear, wibMonth } from '../domain/time.js';
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
}

export async function handleMessage(args: HandleMessageArgs): Promise<HandleMessageResult> {
	const now = args.now ?? (() => new Date());
	const nowIso = nowWIB(now());

	// 1. Resolve user (onboard if unknown)
	let user = await args.repos.users.findByTelegramChatId(args.chatId);
	if (!user) {
		user = await args.repos.users.create({
			telegramChatId: args.chatId,
			name: '',
		});
	}

	// NFR-07: log incoming message after user resolution
	logEvent('info', 'message received', {
		userId: user.userId,
		chatId: args.chatId,
		textLength: args.text.length,
	});

	// Enrich the system prompt with the user's stable reference data (inject
	// every turn): preferences, account list (id/name/type), and current-month
	// budget codes (id/name/limit). Volatile values (balance, spent) are
	// deliberately NOT injected — the model reads them via tools. The accounts
	// list is fetched once here and reused for the onboarding gate below.
	//
	// All three reads share one try/catch: on any failure we fall back to the
	// base prompt and an empty account list (hasAccount=false → onboarding-only
	// tools this turn), so a transient read error never crashes the request and
	// never lets a write tool fire against an unknown account set.
	let system = args.system;
	let accounts: Account[] = [];
	try {
		const [fetchedAccounts, prefs, budgets] = await Promise.all([
			args.repos.accounts.findAllByUserId(user.userId),
			args.repos.preferences.findAllByUserId(user.userId),
			args.repos.budgets.findByUserAndMonth(user.userId, wibYear(), wibMonth()),
		]);
		accounts = fetchedAccounts;
		system = enrichSystemPrompt(args.system, { preferences: prefs, accounts, budgets });
	} catch (e) {
		logEvent('error', 'prompt enrichment failed', {
			userId: user.userId,
			chatId: args.chatId,
			error: (e as Error).message,
		});
	}

	// 2. Load or reset session
	let session = await args.repos.sessions.get(args.chatId);
	if (!session || isExpired(session, args.sessionIdleTimeoutMinutes, nowIso)) {
		session = freshSession(args.chatId, user.userId, nowIso);
	}

	// 3. Append the user turn, then trim before sending to the model.
	// This prevents oversized histories from being sent to the LLM.
	const untrimmedMessages: CoreMessage[] = [...session.turns, { role: 'user', content: args.text }];

	const messages: CoreMessage[] = trimTurns(untrimmedMessages, args.contextWindowTurns);

	// 4. Build tools (gated by onboarding state). `accounts` was fetched during
	//    enrichment above and reused here (single fetch, no double-read).
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
			userId: user.userId,
			chatId: args.chatId,
			error: (err as Error).message,
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

	// 6. Append response messages + trim again before persistence.
	// The first trim protects the LLM call; this second trim protects stored session size.
	const persistedMessages: CoreMessage[] = trimTurns(
		[...messages, ...result.responseMessages],
		args.contextWindowTurns
	);

	// 7. Persist session
	const lastTxnId = extractLastTransactionId(result.toolResults) ?? session.lastTransactionId;
	await args.repos.sessions.set({
		...session,
		turns: persistedMessages,
		lastTransactionId: lastTxnId,
		lastActivityAt: nowIso,
	});

	return { reply: result.text };
}
