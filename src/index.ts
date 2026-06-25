// Suppress punycode DEP0040 from pg dependency chain (platform-agnostic;
// NODE_OPTIONS=--no-deprecation doesn't work through npm on Windows).
process.noDeprecation = true;

import { createOpenAI } from '@ai-sdk/openai';
import { config } from './config/index.js';
import { migrate } from './adapters/neon/migrate.js';
import { seed } from './adapters/neon/seed.js';
import { pool } from './adapters/neon/pool.js';
import { createRepos } from './adapters/neon/repos.js';
import { createRunner } from './agent/run-agent.js';
import { handleMessage } from './agent/orchestrator.js';
import { buildSystemPrompt } from './agent/system-prompt.js';
import { todayWIB } from './domain/time.js';
import { bot, registerMessageHandler } from './telegram/bot.js';
import { startCronJobs } from './scheduler/cron.js';
import { registerCallbackHandler } from './telegram/callback-query.js';
import { registerNudgesCommand } from './telegram/nudges-command.js';
import { logEvent } from './utils/logger.js';

async function main() {
  await migrate();
  await seed();

  const openrouter = createOpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: config.OPENROUTER_API_KEY,
  });
  const model = openrouter(config.OPENROUTER_MODEL);
  const run = createRunner(model);
  const repos = createRepos();

  registerNudgesCommand(repos);
  registerMessageHandler(async (text, chatId) => {
    const { reply } = await handleMessage({
      text,
      chatId,
      repos,
      run,
      system: buildSystemPrompt(todayWIB()),
      contextWindowTurns: config.CONTEXT_WINDOW_TURNS,
      sessionIdleTimeoutMinutes: config.SESSION_IDLE_TIMEOUT_MINUTES,
    });
    return reply;
  });

  startCronJobs(repos, model);
  registerCallbackHandler(repos);

  // Graceful shutdown on SIGTERM (PaaS hosts: Render/Railway/Fly). grammY
  // handles SIGINT automatically; SIGTERM would otherwise kill the process
  // mid-poll without closing the DB pool. bot.stop() resolves bot.start(),
  // which falls through to the pool.end() below.
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logEvent('info', 'shutting down', { signal });
    void bot.stop();
  };
  process.on('SIGTERM', shutdown);

  logEvent('info', 'starting long-polling');
  await bot.start({
    allowed_updates: ['message', 'callback_query'], // callback_query used in Slice 4
    onStart: () => logEvent('info', 'polling'),
  });

  // Polling stopped (SIGINT auto-stop or SIGTERM above) — close the pool cleanly.
  await pool.end();
  logEvent('info', 'stopped');
  process.exit(0);
}

main().catch(async (err) => {
  logEvent('error', 'fatal', { error: (err as Error).message });
  await pool.end();
  process.exit(1);
});
