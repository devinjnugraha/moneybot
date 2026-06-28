import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import { buildMorningGlanceSystemPrompt } from '../prompt.js';
import { todayWibDisplay } from '../../domain/time.js';
import { dueBillsKeyboard } from '../../telegram/formatter.js';
import { morningGlanceTemplate } from './template.js';
import { logEvent } from '../../utils/logger.js';
import type { Composer, ComposerOutput } from '../types.js';

/** Compose the morning glance: LLM text + a programmatic due-bills keyboard. */
export function createMorningGlanceComposer(model: LanguageModel): Composer {
  return async (payload, ctx) => {
    const bills = (payload.data as { todayDueBills?: { recurringId: string; name: string }[] }).todayDueBills ?? [];
    const replyMarkup = dueBillsKeyboard(bills);

    let text: string;
    try {
      const { text: out } = await generateText({
        model,
        system: buildMorningGlanceSystemPrompt(todayWibDisplay(ctx.now)),
        prompt: `Tulis pesan pagi (morning glance) untuk data berikut:\n\n${JSON.stringify(payload.data, null, 2)}`,
      });
      text = out;
    } catch (err) {
      logEvent('warn', 'morning glance llm failed; falling back to template', { error: (err as Error).message });
      text = morningGlanceTemplate(payload);
    }

    const result: ComposerOutput = { text };
    if (replyMarkup) result.replyMarkup = replyMarkup;
    return result;
  };
}
