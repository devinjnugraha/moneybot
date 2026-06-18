import { Bot } from 'grammy';
import { config } from '../config/index.js';

export const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

/** Register the message handler. The `handle` closure returns the reply text. */
export function registerMessageHandler(
  handle: (text: string, chatId: string) => Promise<string>,
): void {
  bot.on('message:text', async (ctx) => {
    await ctx.replyWithChatAction('typing');
    try {
      const reply = await handle(ctx.message.text, String(ctx.chat.id));
      if (reply) await ctx.reply(reply);
    } catch (err) {
      console.error('[bot] message handler failed', err);
      await ctx.reply('Maaf, ada gangguan. Coba lagi ya.'); // NFR-09
    }
  });
}
