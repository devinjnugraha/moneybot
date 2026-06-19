import cron from 'node-cron';
import { fireRecurringPayments } from './recurring-fire.js';
import { sweepDeferredPayments } from './defer-sweep.js';
import { config } from '../config/index.js';
import type { Repos } from '../repositories/interfaces.js';
import { logEvent } from '../utils/logger.js';

/** Start both in-process cron jobs (timezone WIB per NFR-10). */
export function startCronJobs(repos: Repos): void {
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

  logEvent('info', 'cron jobs registered', { schedules: [config.CRON_SCHEDULE, '*/5 * * * *'] });
}
