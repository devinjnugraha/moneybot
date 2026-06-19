import cron from 'node-cron';
import { fireRecurringPayments } from './recurring-fire.js';
import { sweepDeferredPayments } from './defer-sweep.js';
import { config } from '../config/index.js';
import type { Repos } from '../repositories/interfaces.js';

/** Start both in-process cron jobs (timezone WIB per NFR-10). */
export function startCronJobs(repos: Repos): void {
  // Daily 08:00 WIB — fire recurring payment prompts
  cron.schedule(config.CRON_SCHEDULE, () => {
    fireRecurringPayments(repos).catch((err) =>
      console.error('[cron] recurring-fire error', err),
    );
  }, { timezone: 'Asia/Jakarta' });

  // Every 5 minutes — sweep deferred payments
  cron.schedule('*/5 * * * *', () => {
    sweepDeferredPayments(repos).catch((err) =>
      console.error('[cron] defer-sweep error', err),
    );
  }, { timezone: 'Asia/Jakarta' });

  console.log('[cron] registered daily fire + 5-min defer sweep');
}
