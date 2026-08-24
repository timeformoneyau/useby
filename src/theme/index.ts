/**
 * Design tokens — "Warm Home Utility", from the Claude Design v3 artboard.
 *
 * The artboard specifies colour in `oklch()`, which React Native's StyleSheet
 * cannot parse. Every value below is that same colour converted to sRGB hex,
 * with the original oklch triple kept alongside it so a token can be checked
 * against the design file without re-deriving anything. Conversion is exact to
 * the nearest 8-bit channel; the device renders sRGB regardless.
 *
 * The palette carries a deliberate rule from the design: sage is the brand and
 * marks everything UseBy *does* (scan, save, focus), so the accent never reads
 * as a status. Terracotta means one thing only — today or already past.
 * Anything with a day or more left is plain ink with a soft sage trim. There is
 * no third or fourth urgency colour, so nothing competes.
 */

export const colours = {
  // Sage — actions, brand, focus. Never a status.
  sage: '#1C655B',          // oklch(0.46 0.072 182)
  sagePressed: '#00544B',   // oklch(0.40 0.072 182)
  sageTint: '#C6E6E0',      // oklch(0.90 0.035 182)
  sageTintBorder: '#AFD4CC', // oklch(0.84 0.04 182)

  // Surfaces
  background: '#F5EFE4',    // oklch(0.955 0.016 84) — oat
  card: '#FEFCF5',          // oklch(0.99 0.009 90)
  cardBorder: '#E7E0D6',    // oklch(0.91 0.016 82)
  panelBorder: '#E3DDD2',   // oklch(0.90 0.016 82)
  divider: '#EFEBE2',       // oklch(0.94 0.012 84)
  inputBorder: '#D9D3C9',   // oklch(0.87 0.016 82)

  // Text
  ink: '#2E241B',           // oklch(0.27 0.022 62)
  textSecondary: '#71675B', // oklch(0.52 0.022 72)
  textSub: '#776D61',       // oklch(0.54 0.022 74)
  textMuted: '#938B7F',     // oklch(0.64 0.02 78)
  placeholder: '#A49E94',   // oklch(0.70 0.016 80)
  label: '#5B5146',         // oklch(0.44 0.022 70)
  secondaryAction: '#5D5040', // oklch(0.44 0.03 74)
  onSage: '#FBF8F1',        // oklch(0.98 0.01 90)

  // Urgency — terracotta is today and past, and nothing else.
  terracotta: '#983E1B',    // oklch(0.48 0.13 40)
  barHot: '#B85C37',        // oklch(0.58 0.13 42)
  barSoon: '#7AB1A7',       // oklch(0.72 0.06 182)  — 1–3 days
  barLater: '#CADCD8',      // oklch(0.88 0.02 182)  — more than 3 days

  // Clay — "worth checking". Attention, not alarm; never used for urgency.
  clay: '#91642F',          // oklch(0.54 0.09 68)
  clayText: '#73480D',      // oklch(0.44 0.09 68)
  clayBorder: '#BD8E59',    // oklch(0.68 0.09 68)
  clayFieldBg: '#FFF6E1',   // oklch(0.975 0.03 84)

  // Camera
  cameraBg: '#261D17',      // oklch(0.24 0.018 62)
  cameraPanel: '#342C26',   // oklch(0.30 0.016 62)
  cameraBracket: '#71B3A8', // oklch(0.72 0.07 182)
  cameraText: '#E8E4DC',    // oklch(0.92 0.012 88)
  cameraDim: '#CFC8BE',     // oklch(0.80 0.012 88)

  destructive: '#9C433F',   // oklch(0.50 0.12 25)
} as const;

/**
 * Type. Hanken Grotesk does the work; the serif appears only where the app
 * speaks to you rather than reports — empty states and review titles.
 */
export const fonts = {
  regular: 'HankenGrotesk_400Regular',
  medium: 'HankenGrotesk_500Medium',
  semibold: 'HankenGrotesk_600SemiBold',
  bold: 'HankenGrotesk_700Bold',
  serif: 'InstrumentSerif_400Regular',
} as const;

/** 4 · 8 · 12 · 16 · 22, as laid out on the artboard's spacing scale. */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 22 } as const;

/** Soft but never pill-shaped: radii stay under half the height so cards read as cards. */
export const radius = {
  chip: 12,
  segment: 13,
  group: 14,
  row: 16,
  button: 18,
  panel: 22,
} as const;

/** Everything tappable clears 48dp — forgiving for one-handed use mid-unpack. */
export const hit = { minTarget: 48, row: 56, primaryButton: 58 } as const;
