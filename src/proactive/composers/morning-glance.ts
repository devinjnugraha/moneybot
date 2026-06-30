import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import { buildMorningGlanceSystemPrompt } from '../prompt.js';
import { todayWibDisplay } from '../../domain/time.js';
import { dueBillsKeyboard } from '../../telegram/formatter.js';
import { morningGlanceTemplate, renderMorningGlanceBlock, MORNING_GLANCE_DUE_CTA } from './template.js';
import { logEvent } from '../../utils/logger.js';
import type { Composer, ComposerOutput } from '../types.js';

/** Compose the morning glance: LLM prose (greeting + yesterday) + deterministic block + CTA. */
export function createMorningGlanceComposer(model: LanguageModel): Composer {
  return async (payload, ctx) => {
    const data = payload.data as {
      yesterday?: { count: number; totalSpend: number } | null;
      todayDueBills?: { recurringId: string; name: string }[];
    };
    const dueBills = data.todayDueBills ?? [];
    const replyMarkup = dueBillsKeyboard(dueBills);

    let prose: string;
    try {
      const { text: out } = await generateText({
        model,
        system: buildMorningGlanceSystemPrompt(todayWibDisplay(ctx.now)),
        // Only yesterday is prose-owned; saldo/budget/tagihan are rendered by the system.
        prompt: `Kemarin (WIB):\n${JSON.stringify(data.yesterday ?? null)}`,
      });
      prose = out.trim();
    } catch (err) {
      logEvent('warn', 'morning glance llm failed; falling back to template', { error: (err as Error).message });
      const fallback: ComposerOutput = { text: morningGlanceTemplate(payload) };
      if (replyMarkup) fallback.replyMarkup = replyMarkup;
      return fallback;
    }

    const block = renderMorningGlanceBlock(payload);
    const parts = [prose, block].filter(Boolean);
    if (dueBills.length > 0) parts.push(MORNING_GLANCE_DUE_CTA);

    const result: ComposerOutput = { text: parts.join('\n\n') };
    if (replyMarkup) result.replyMarkup = replyMarkup;
    return result;
  };
}
