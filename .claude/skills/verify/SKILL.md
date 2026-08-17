---
name: verify
description: Drives the MoneyBot agent end-to-end (real OpenRouter model + real Neon dev DB) through the production handleMessage() path, without Telegram.
---

# Verifying MoneyBot changes

The user-facing surface is a Telegram LLM agent. For verification you don't need
Telegram: drive `handleMessage()` (`src/agent/orchestrator.ts`) directly — it is
the full production path (enrichment → tools → ReAct loop → session persistence).

## Recipe

Write a throwaway `.verify-<name>.mts` at the repo root (tsx needs the project
dir for ESM), then `npx tsx .verify-<name>.mts` and delete it after:

```ts
process.noDeprecation = true;
import { createOpenAI } from '@ai-sdk/openai';
import { config } from './src/config/index.js';
import { createRepos } from './src/adapters/neon/repos.js';
import { createRunner } from './src/agent/run-agent.js';
import { handleMessage } from './src/agent/orchestrator.js';
import { buildSystemPrompt } from './src/agent/system-prompt.js';
import { todayWIB } from './src/domain/time.js';
import { pool } from './src/adapters/neon/pool.js';

const openrouter = createOpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: config.OPENROUTER_API_KEY });
const run = createRunner(openrouter(process.env.VERIFY_MODEL ?? config.OPENROUTER_MODEL));
const repos = createRepos();
const chatId = `verify-<name>-${Date.now()}`; // unique per run → isolated user/session

const { reply } = await handleMessage({
  text: '...', chatId, repos, run,
  system: buildSystemPrompt(todayWIB()),
  contextWindowTurns: config.CONTEXT_WINDOW_TURNS,
  sessionIdleTimeoutMinutes: config.SESSION_IDLE_TIMEOUT_MINUTES,
});
```

Consecutive `handleMessage` calls with the same `chatId` continue one
conversation (session persisted in DB). Assert outcomes via `repos.*` reads
after each turn, not just the reply text.

## Gotchas

- `.env`'s `OPENROUTER_MODEL` can go stale (free slugs get retired → 404 "This
  model is unavailable for free"). Override per-process:
  `OPENROUTER_MODEL=<paid-slug> npx tsx ...` — don't edit `.env`.
- Log noise: pipe stderr through
  `grep -vE '"level":"(info|error)","message":"(message received|agent run complete|agent run failed)'`.
- Onboarding gate: write tools only register once the user has an account —
  first turn should create one (agent-driven: "Bikin akun cash namanya Cash").
- Bare-brand expenses (e.g. "beli terea 150.000") may make the model ask for a
  category instead of writing; name the `categoryId` when the write itself is
  what you're verifying.
- Verify runs leave rows in the dev DB (unique chatId per run keeps them
  isolated; the DB is truncated by every `npm test` run anyway).
- No Telegram is touched — the only external call is OpenRouter with the
  project's own key (a handful of small model calls).
