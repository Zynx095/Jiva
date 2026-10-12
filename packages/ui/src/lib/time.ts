import { useEffect, useState } from 'react';

type TimeInput = string | number | Date | undefined | null;

const toMs = (t: TimeInput): number => {
  if (t === undefined || t === null) return NaN;
  if (t instanceof Date) return t.getTime();
  return typeof t === 'number' ? t : Date.parse(t);
};

/** Re-renders the caller every `intervalMs` and returns the current time. Use coarse intervals. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** "14:32" in the viewer's locale. */
export function formatClock(t: TimeInput): string {
  const ms = toMs(t);
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** "14:32:08" — only for technical / audit views. */
export function formatClockSeconds(t: TimeInput): string {
  const ms = toMs(t);
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** "just now", "40 s ago", "3 min ago", "2 h ago". */
export function timeAgo(t: TimeInput, now = Date.now()): string {
  const ms = toMs(t);
  if (!Number.isFinite(ms)) return 'never';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/** Milliseconds until `t` (negative when past). */
export function msUntil(t: TimeInput, now = Date.now()): number {
  return toMs(t) - now;
}

/** "in 28 min", "in 45 s", "expired". */
export function timeUntil(t: TimeInput, now = Date.now()): string {
  const ms = msUntil(t, now);
  if (!Number.isFinite(ms)) return '—';
  if (ms <= 0) return 'expired';
  const s = Math.round(ms / 1000);
  if (s < 60) return `in ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m} min`;
  return `in ${Math.round(m / 60)} h`;
}

/** "9:05" countdown for short deadlines. */
export function formatCountdown(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00';
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** "Today", "Yesterday" or "3 Oct". */
export function dayLabel(t: TimeInput, now = Date.now()): string {
  const ms = toMs(t);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const today = new Date(now);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(today) - startOf(d)) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/** Whole minutes from seconds, never below 1 for a non-zero duration. */
export function minutesFromSeconds(seconds: number | undefined): number | undefined {
  if (seconds === undefined || !Number.isFinite(seconds)) return undefined;
  return Math.max(1, Math.ceil(seconds / 60));
}

export function formatKm(meters: number | undefined): string {
  if (meters === undefined || !Number.isFinite(meters)) return '—';
  return `${(meters / 1000).toFixed(meters < 10_000 ? 1 : 0)} km`;
}
