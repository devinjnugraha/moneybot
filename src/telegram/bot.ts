import { Bot } from 'grammy';
import { config } from '../config/index.js';
import { logEvent } from '../utils/logger.js';
import { markdownToTelegramHTML } from './formatter.js';

export const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

/** Register the message handler. The `handle` closure returns the reply text. */
export function registerMessageHandler(
  handle: (text: string, chatId: string) => Promise<string>,
): void {
  bot.on('message:text', async (ctx) => {
    await ctx.replyWithChatAction('typing');
    try {
      const reply = await handle(ctx.message.text, String(ctx.chat.id));
      if (reply) await ctx.reply(markdownToTelegramHTML(reply), { parse_mode: 'HTML' });
    } catch (err) {
      logEvent('error', 'message handler failed', { chatId: String(ctx.chat.id), error: (err as Error).message });
      await ctx.reply('Maaf, ada gangguan. Coba lagi ya.', { parse_mode: 'HTML' }); // NFR-09
    }
  });
}
