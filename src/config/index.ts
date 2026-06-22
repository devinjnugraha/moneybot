import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_MODEL: z.string().default('anthropic/claude-3-haiku'),
  CONTEXT_WINDOW_TURNS: z.coerce.number().int().positive().default(20),
  SESSION_IDLE_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(30),
  CRON_SCHEDULE: z.string().default('0 8 * * *'),
  PROACTIVE_ENABLED: z.string().default('true').transform((v) => v === 'true'),
  PROACTIVE_SUMMARY_CRON: z.string().default('0 21 * * *'),
  PROACTIVE_MAX_PER_DAY: z.coerce.number().int().positive().default(5),
  PROACTIVE_QUIET_HOURS: z.string().default('22:00-07:00'),
});

export type AppConfig = z.infer<typeof schema>;

export const config: AppConfig = schema.parse(process.env);
