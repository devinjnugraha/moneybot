import { bot } from './bot.js';
import { markdownToTelegramHTML } from './formatter.js';
import type { Repos } from '../repositories/interfaces.js';

export type NudgesIntent =
  | { action: 'status' }
  | { action: 'mute'; resumeAt?: Date } // resumeAt undefined => mute forever
  | { action: 'unmute' }
  | { action: 'unknown'; raw: string };

/** Pure parser for the `/nudges` argument string. */
export function parseNudgesArgs(args: string, now: Date): NudgesIntent {
  const a = args.trim().toLowerCase();
  if (a === '' || a === 'status') return { action: 'status' };
  if (a === 'on' || a === 'unmute') return { action: 'unmute' };
  if (a === 'off') return { action: 'mute' };
  const m = a.match(/^off\s+(\d+)\s*([hd])$/);
  if (m) {
    const n = Number(m[1]);
    const hours = m[2] === 'd' ? n * 24 : n;
    return { action: 'mute', resumeAt: new Date(now.getTime() + hours * 3600_000) };
  }
  return { action: 'unknown', raw: args };
}

function formatStatus(muted: boolean, resumeAt?: string): string {
  if (!muted) return '\u{1F515} Nudge proaktif: aktif. Bot akan kirim ringkasan sesuai jadwal.';
  if (!resumeAt) return '\u{1F515} Nudge proaktif: dimatikan sampai kamu nyalakan lagi dengan /nudges on.';
  return `\u{1F515} Nudge proaktif: dimatikan sampai ${new Date(resumeAt).toLocaleString('id-ID')} (WIB lokal server).`;
}

export interface NudgesResult {
  reply: string;
}

/** Pure dispatch — testable without grammY wiring (mirrors callback-query.ts). */
export async function dispatchNudgesCommand(
  args: string,
  chatId: string,
  repos: Repos,
  now: Date,
): Promise<NudgesResult> {
  const user = await repos.users.findByTelegramChatId(chatId);
  if (!user) return { reply: 'Kamu belum terdaftar. Ketik sesuatu untuk mulai.' };

  const intent = parseNudgesArgs(args, now);
  switch (intent.action) {
    case 'status': {
      const s = await repos.proactiveSettings.get(user.userId);
      return { reply: formatStatus(s.muted, s.resumeAt) };
    }
    case 'mute': {
      await repos.proactiveSettings.setMuted(user.userId, true, intent.resumeAt);
      if (intent.resumeAt) {
        const hours = Math.round((intent.resumeAt.getTime() - now.getTime()) / 3600_000);
        return { reply: `\u{1F515} Oke, nudge proaktif berhenti selama ${hours} jam. Balas /nudges on untuk menyalakan.` };
      }
      return { reply: '\u{1F515} Oke, nudge proaktif berhenti sampai kamu nyalakan lagi dengan /nudges on.' };
    }
    case 'unmute': {
      await repos.proactiveSettings.setMuted(user.userId, false);
      return { reply: '\u{1F514} Nudge proaktif dinyalakan lagi.' };
    }
    case 'unknown':
      return {
        reply:
          'Pakai: /nudges status | /nudges off | /nudges off 8h | /nudges off 2d | /nudges on',
      };
  }
}

/** grammY wiring. Register BEFORE the catch-all message handler so commands are intercepted. */
export function registerNudgesCommand(repos: Repos): void {
  bot.command('nudges', async (ctx) => {
    const chatId = String(ctx.chat.id);
    const args = typeof ctx.match === 'string' ? ctx.match : '';
    const { reply } = await dispatchNudgesCommand(args, chatId, repos, new Date());
    await ctx.reply(markdownToTelegramHTML(reply), { parse_mode: 'HTML' });
  });
}
