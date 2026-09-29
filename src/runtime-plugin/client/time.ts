/**
 * Times as the panel shows them. Pure, so the model functions and their tests need no React Native.
 */

const two = (value: number): string => String(value).padStart(2, '0');

/** "just now", "5 min ago", "2 h ago", "3 d ago". */
export function ago(iso: string | undefined, now = Date.now()): string {
  if (iso === undefined) return '';
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (Number.isNaN(minutes)) return '';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${String(hours)} h ago` : `${String(Math.round(hours / 24))} d ago`;
}

/** A moment as local `YYYY-MM-DD HH:MM`, for text that must not change as time passes. */
export function clockTime(iso: string): string {
  const at = new Date(iso);
  return `${String(at.getFullYear())}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
}

/** A moment's local time of day, `14:05`. */
export function hourMinute(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '' : `${two(at.getHours())}:${two(at.getMinutes())}`;
}

const midnight = (at: Date): number => new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();

/** The local day a moment falls on, as a list groups it: `Today`, `Yesterday`, `Mon 27 Sep`, `27 Sep 2025`. */
export function dayLabel(iso: string, now = Date.now()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'Earlier';
  const days = Math.round((midnight(new Date(now)) - midnight(at)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const month = at.toLocaleString('en-US', { month: 'short' });
  if (days > 1 && days < 7) return `${at.toLocaleString('en-US', { weekday: 'short' })} ${String(at.getDate())} ${month}`;
  return at.getFullYear() === new Date(now).getFullYear() ? `${String(at.getDate())} ${month}` : `${String(at.getDate())} ${month} ${String(at.getFullYear())}`;
}

/** A moment as a row states it: its time today, else its day and time. */
export function whenLabel(iso: string, now = Date.now()): string {
  const day = dayLabel(iso, now);
  return day === 'Today' ? hourMinute(iso) : `${day} ${hourMinute(iso)}`;
}

/** How long something took: `40 s`, `42 min`, `3 h 5 min`, `2 d 4 h`. */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${String(seconds)} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(minutes % 60)} min`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${String(days)} d` : `${String(days)} d ${String(hours % 24)} h`;
}
