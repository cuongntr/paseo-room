/**
 * Times as the panel shows them. Pure, so the model functions and their tests need no React Native.
 */

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
  const two = (value: number): string => String(value).padStart(2, '0');
  return `${String(at.getFullYear())}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
}
