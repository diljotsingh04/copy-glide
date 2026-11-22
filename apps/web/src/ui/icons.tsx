import { Code, Globe, Hash, Laptop, Link2, Mail, Monitor, Palette, Phone, Smartphone, Terminal, Type, type LucideIcon } from 'lucide-react';
import type { ClipKind } from '../clipKind';

const PLATFORM: Record<string, { icon: LucideIcon; label: string }> = {
  windows: { icon: Monitor, label: 'Windows' },
  macos: { icon: Laptop, label: 'macOS' },
  linux: { icon: Terminal, label: 'Linux' },
  android: { icon: Smartphone, label: 'Android' },
  ios: { icon: Smartphone, label: 'iPhone' },
  web: { icon: Globe, label: 'Web' },
};

export const platformInfo = (p: string) => PLATFORM[p] ?? { icon: Monitor, label: p };

export const KIND_ICON: Record<ClipKind, LucideIcon> = {
  link: Link2,
  email: Mail,
  color: Palette,
  code: Code,
  number: Hash,
  phone: Phone,
  text: Type,
};
