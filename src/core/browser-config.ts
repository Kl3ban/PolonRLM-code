import { z } from 'zod';

/** User defaults also validate per-session overrides. No executable JS or arbitrary launch flags. */
export const browserOptionsSchema = z.object({
  viewportWidth: z.number().int().min(320).max(3840).default(1365),
  viewportHeight: z.number().int().min(240).max(2160).default(900),
  locale: z.string().min(2).max(40).refine(value => { try { return Intl.getCanonicalLocales(value).length === 1; } catch { return false; } }, 'Use a valid locale, e.g. en-US.').default('en-US'),
  timezoneId: z.string().min(1).max(80).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }, 'Use an IANA time zone, e.g. Europe/Warsaw.').default('UTC'),
  colorScheme: z.enum(['light', 'dark', 'no-preference']).default('light'),
  timeoutMs: z.number().int().min(100).max(60000).default(10000),
  navigationTimeoutMs: z.number().int().min(100).max(90000).default(20000),
  snapshotElements: z.number().int().min(1).max(200).default(40),
  maxChars: z.number().int().min(1000).max(30000).default(6000),
  blockedResources: z.array(z.enum(['image', 'media', 'font'])).max(3).refine(items => new Set(items).size === items.length, 'Resource types must be unique.').default([]),
}).strict();

export type BrowserOptions = z.infer<typeof browserOptionsSchema>;
export const browserSessionOptionsSchema = browserOptionsSchema.pick({ viewportWidth: true, viewportHeight: true, colorScheme: true, timeoutMs: true, navigationTimeoutMs: true, snapshotElements: true, maxChars: true, blockedResources: true }).partial();
export const defaultBrowserOptions = (): BrowserOptions => browserOptionsSchema.parse({});
