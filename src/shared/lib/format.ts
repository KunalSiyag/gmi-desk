/** Small formatting helpers shared by the main process and the renderer. */

/** 1_048_576 → "1M", 202_752 → "203K", 950 → "950". */
export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${trim(value / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (abs >= 1_000) return `${trim(value / 1_000)}K`;
  return String(Math.round(value));
}

function trim(n: number): string {
  const rounded = Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 10) / 10;
  return String(rounded).replace(/\.0$/, '');
}

export function formatNumber(value: number | null | undefined, maximumFractionDigits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits }).format(value);
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${u === 0 ? v : v.toFixed(1)} ${units[u]}`;
}

/** "just now", "5m ago", "3h ago", "2d ago", else a short date. */
export function formatRelativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diffSec = Math.round((now.getTime() - t) / 1000);
  if (diffSec < 45) return 'just now';
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86_400) return `${Math.round(diffSec / 3600)}h ago`;
  if (diffSec < 7 * 86_400) return `${Math.round(diffSec / 86_400)}d ago`;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: now.getFullYear() === new Date(t).getFullYear() ? undefined : 'numeric' });
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Unix seconds or milliseconds or ISO → ISO string (null when invalid). */
export function toIsoDate(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === 'string') {
    if (/^\d+$/.test(value)) return toIsoDate(Number(value));
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

/** Truncates to `max` characters with an ellipsis. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
