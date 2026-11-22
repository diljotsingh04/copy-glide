import { useEffect, useState } from 'react';
import { native } from './native';

export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'copyglide.theme';
const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(pref: ThemePref = getThemePref()): void {
  const dark = pref === 'dark' || (pref === 'system' && !!media?.matches);
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  root.style.colorScheme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0B0C14' : '#F6F6F9');
  void native?.setTheme(dark);
}

export function useTheme(): [ThemePref, (p: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(getThemePref);
  useEffect(() => {
    applyTheme(pref);
    if (pref !== 'system' || !media) return;
    const onChange = () => applyTheme('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [pref]);
  return [
    pref,
    (p) => {
      try {
        localStorage.setItem(KEY, p);
      } catch {
        /* storage unavailable */
      }
      setPref(p);
    },
  ];
}

/** Keep following the OS theme even before any component mounts. */
export function initTheme(): void {
  applyTheme();
  const root = document.documentElement;
  root.classList.add(native ? 'is-desktop' : 'is-web', `os-${native?.platform ?? 'web'}`);
  media?.addEventListener('change', () => {
    if (getThemePref() === 'system') applyTheme('system');
  });
  if (window.matchMedia('(pointer: coarse)').matches) root.classList.add('is-touch');
}
