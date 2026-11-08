export const VERSION = '0.5.0';
export const THEMES = {
  dark: { canvas: undefined, panel: '#161616', selected: '#292929', text: '#c0bdb5', muted: '#8d8c87', faint: '#696964', accent: '#cac7bf', border: '#343432', warm: '#aaa69b', error: '#bca3a3' },
  light: { canvas: '#f5f5f5', panel: '#e9e9ed', selected: '#d6deef', text: '#272730', muted: '#646470', faint: '#898996', accent: '#3556bc', border: '#c9c9d2', warm: '#92601b', error: '#b52b35' },
} as const;
export const MODE_LABELS = { BUILD: 'Build', PLAN: 'Plan', REVIEW: 'Review' } as const;
// Lowered polo by one half-cell; nRLM retain their existing positions.
export const WORDMARK = [
  "                  █▀█ █   █▄ ▄█",
  "▄▄▄ ▄▄▄ █ ▄▄▄ █▀▄ █▀▄ █   █ ▀ █",
  "█▄█ █▄█ █ █▄█ █ █ █ █ █▄▄ █   █",
  "▀"
] as const;
export function contentWidth(columns: number): number { return Math.max(10, Math.min(76, columns - (columns >= 80 ? 12 : 4))); }

