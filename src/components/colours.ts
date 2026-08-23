import { StatusLabel } from '../types';

export const colours = {
  background: '#FAFAF8',
  surface: '#FFFFFF',
  border: '#EBEBEA',
  textPrimary: '#111110',
  textSecondary: '#6B6B68',
  textMuted: '#9E9E9A',

  // Status colours
  fresh: '#9E9E9A',        // neutral grey
  useSoon: '#C8842A',      // soft amber
  useToday: '#B85C3A',
  pastUseBy: '#C0392B',
  wellPast: '#922B21',

  // UI accents
  primary: '#111110',
  destructive: '#C0392B',
  separator: '#EBEBEA',
} as const;

export function statusColour(label: StatusLabel): string {
  switch (label) {
    case 'Fresh':       return colours.fresh;
    case 'Use soon':    return colours.useSoon;
    case 'Use today':   return colours.useToday;
    case 'Past use by': return colours.pastUseBy;
    case 'Well past':   return colours.wellPast;
    default:            return colours.textMuted;
  }
}
