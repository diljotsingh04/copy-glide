// Recognises what a clip is so the UI can show it nicely (link preview, colour swatch, code font…).
export type ClipKind = 'link' | 'email' | 'color' | 'code' | 'number' | 'phone' | 'text';

export interface ClipInfo {
  kind: ClipKind;
  label: string;
  href?: string;
  color?: string;
  host?: string;
}

const URL_RE = /^(https?:\/\/|www\.)\S+$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const COLOR_RE = /^(#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgb|rgba|hsl|hsla|oklch)\([^)]*\))$/i;
const NUMBER_RE = /^\d{4,10}$/;
const PHONE_RE = /^\+?[\d\s\-().]{7,20}$/;
const CODE_RE = /(^|\n)\s*(import |export |const |let |var |function |def |class |return |#include|SELECT |<\/?[a-z][\w-]*[\s>])|[{};]\s*$|=>|\$\{/im;

export function describeClip(text: string): ClipInfo {
  const t = text.trim();
  const oneLine = !t.includes('\n');
  if (oneLine && URL_RE.test(t)) {
    const href = t.startsWith('www.') ? `https://${t}` : t;
    let host = t;
    try {
      host = new URL(href).host.replace(/^www\./, '');
    } catch {
      /* keep raw */
    }
    return { kind: 'link', label: 'Link', href, host };
  }
  if (oneLine && EMAIL_RE.test(t)) return { kind: 'email', label: 'Email', href: `mailto:${t}` };
  if (oneLine && COLOR_RE.test(t)) return { kind: 'color', label: 'Color', color: t };
  if (oneLine && NUMBER_RE.test(t)) return { kind: 'number', label: t.length <= 8 ? 'One-time code' : 'Number' };
  if (oneLine && PHONE_RE.test(t) && (t.match(/\d/g)?.length ?? 0) >= 7) return { kind: 'phone', label: 'Phone', href: `tel:${t.replace(/[^\d+]/g, '')}` };
  if (CODE_RE.test(t) && (t.includes('\n') || /[{};]/.test(t))) return { kind: 'code', label: 'Snippet' };
  const words = t.split(/\s+/).filter(Boolean).length;
  return { kind: 'text', label: words === 1 ? '1 word' : `${words} words` };
}

export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.round((now - ts) / 1000);
  if (s < 10) return 'Just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(d)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
