import cron from 'node-cron';
import type { LanguageModel } from 'ai';
import { fireRecurringPayments } from './recurring-fire.js';
import { sweepDeferredPayments } from './defer-sweep.js';
import { runProactivePass } from '../proactive/dispatcher.js';
import { createComposer } from '../proactive/composers/resolve.js';
import { detectScheduledSummary } from '../proactive/triggers/scheduled-summary.js';
import { createBudgetThresholdDetector } from '../proactive/triggers/budget-threshold.js';
import { createLoggingGapDetector } from '../proactive/triggers/logging-gap.js';
import { markdownToTelegramHTML } from '../telegram/formatter.js';
import { bot } from '../telegram/bot.js';
import { config } from '../config/index.js';
import type { Repos } from '../repositories/interfaces.js';
import { logEvent } from '../utils/logger.js';

/** Start all in-process cron jobs (timezone WIB per NFR-10). */
export function startCronJobs(repos: Repos, model: LanguageModel): void {
  // Daily 08:00 WIB — fire recurring payment prompts
  cron.schedule(config.CRON_SCHEDULE, () => {
    fireRecurringPayments(repos).catch((err) =>
      logEvent('error', 'recurring-fire error', { error: (err as Error).message }),
    );
  }, { timezone: 'Asia/Jakarta' });

  // Every 5 minutes — sweep deferred payments
  cron.schedule('*/5 * * * *', () => {
    sweepDeferredPayments(repos).catch((err) =>
      logEvent('error', 'defer-sweep error', { error: (err as Error).message }),
    );
  }, { timezone: 'Asia/Jakarta' });

  // Proactive outreach — daily spending summary (LLM-composed).
  const composer = createComposer(model);
  const policy = {
    enabled: config.PROACTIVE_ENABLED,
    maxPerDay: config.PROACTIVE_MAX_PER_DAY,
    quietHours: config.PROACTIVE_QUIET_HOURS,
    contextWindowTurns: config.CONTEXT_WINDOW_TURNS,
  };
  const send = async (chatId: string, text: string): Promise<void> => {
    await bot.api.sendMessage(chatId, markdownToTelegramHTML(text), { parse_mode: 'HTML' });
  };

  cron.schedule(config.PROACTIVE_SUMMARY_CRON, () => {
    runProactivePass({ detector: detectScheduledSummary, composer, repos, policy, now: new Date(), send })
      .catch((err) => logEvent('error', 'proactive summary error', { error: (err as Error).message }));
  }, { timezone: 'Asia/Jakarta' });

  // Proactive outreach — event-driven sweep (design §14): budget thresholds +
  // logging-gap check run together every sweep.
  cron.schedule(config.PROACTIVE_SWEEP_CRON, () => {
    Promise.all([
      runProactivePass({
        detector: createBudgetThresholdDetector(config.PROACTIVE_BUDGET_THRESHOLDS),
        composer, repos, policy, now: new Date(), send,
      }),
      runProactivePass({
        detector: createLoggingGapDetector(config.PROACTIVE_GAP_DAYS),
        composer, repos, policy, now: new Date(), send,
      }),
    ]).catch((err) => logEvent('error', 'proactive sweep error', { error: (err as Error).message }));
  }, { timezone: 'Asia/Jakarta' });

  logEvent('info', 'cron jobs registered', {
    schedules: [config.CRON_SCHEDULE, '*/5 * * * *', config.PROACTIVE_SUMMARY_CRON, config.PROACTIVE_SWEEP_CRON],
  });
}
