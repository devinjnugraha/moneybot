import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import { buildHealthDigestSystemPrompt } from '../prompt.js';
import { todayWibDisplay } from '../../domain/time.js';
import { healthDigestBlock } from './template.js';
import { logEvent } from '../../utils/logger.js';
import type { Composer } from '../types.js';

/** Monthly health digest: deterministic blocks + LLM delta prose (advisory spec §4.2). */
export function createHealthDigestComposer(model: LanguageModel): Composer {
  return async (payload, ctx) => {
    const block = healthDigestBlock(payload);
    try {
      const { text } = await generateText({
        model,
        system: buildHealthDigestSystemPrompt(todayWibDisplay(ctx.now)),
        prompt: JSON.stringify(payload.data),
      });
      return [text.trim(), block].filter(Boolean).join('\n\n');
    } catch (err) {
      logEvent('warn', 'health digest llm failed; block only', { error: (err as Error).message });
      return block;
    }
  };
}
