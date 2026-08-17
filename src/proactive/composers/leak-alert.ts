import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import { buildLeakAlertSystemPrompt } from '../prompt.js';
import { todayWibDisplay } from '../../domain/time.js';
import { leakAlertBlock } from './template.js';
import { logEvent } from '../../utils/logger.js';
import type { Composer } from '../types.js';

/** Leak alert: deterministic blocks + one LLM prose line (advisory spec §4.1). */
export function createLeakAlertComposer(model: LanguageModel): Composer {
  return async (payload, ctx) => {
    const block = leakAlertBlock(payload);
    try {
      const { text } = await generateText({
        model,
        system: buildLeakAlertSystemPrompt(todayWibDisplay(ctx.now)),
        prompt: JSON.stringify(payload.data),
      });
      return [text.trim(), block].filter(Boolean).join('\n\n');
    } catch (err) {
      logEvent('warn', 'leak alert llm failed; block only', { error: (err as Error).message });
      return block;
    }
  };
}
