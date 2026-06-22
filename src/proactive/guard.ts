import { todayWIB } from '../domain/time.js';
import type { ProactiveSettings } from '../domain/entities.js';

/** True if the user is muted AND the mute has not auto-expired. */
export function isMuted(settings: ProactiveSettings, now: Date): boolean {
  if (!settings.muted) return false;
  if (!settings.resumeAt) return true; // mute forever
  return Date.parse(settings.resumeAt) > now.getTime();
}

/** Midnight (00:00) of the current WIB day, as a UTC instant. */
export function startOfTodayWIB(now: Date): Date {
  return new Date(`${todayWIB(now)}T00:00:00+07:00`);
}

function wibMinutesOfDay(now: Date): number {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const [hh, mm] = fmt.format(now).split(':').map(Number) as [number, number];
  return hh * 60 + mm;
}

function parseHHMM(s: string): number {
  const [h, m] = s.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

/**
 * True if `now` (interpreted in WIB) falls inside `quietHours` ("HH:MM-HH:MM").
 * A window whose start > end (e.g. 22:00-07:00) is treated as overnight.
 * Both bounds: start inclusive, end exclusive.
 */
export function inQuietHours(now: Date, quietHours: string): boolean {
  const parts = quietHours.split('-');
  if (parts.length !== 2) return false;
  const start = parseHHMM(parts[0]!);
  const end = parseHHMM(parts[1]!);
  if (start === end) return false; // empty window
  const m = wibMinutesOfDay(now);
  if (start < end) return m >= start && m < end;
  return m >= start || m < end; // overnight wrap
}
