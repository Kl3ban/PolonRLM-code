import { z } from 'zod';

/** User defaults also validate per-session overrides. No executable JS or arbitrary launch flags. */
export const browserOptionsSchema = z.object({
  localOrigins: z.array(z.string().max(300).refine(value => {
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname === '/' && !url.search && !url.hash; } catch { return false; }
  }, 'Use an exact loopback HTTP(S) origin with a port, e.g. http://localhost:5173.').transform(value => new URL(value).origin)).max(32).default([]),
  webSockets: z.boolean().default(true),
  serviceWorkers: z.enum(['block', 'allow']).default('block'),
  persistAuth: z.boolean().default(false),
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
// Zod applies nested defaults even inside optional fields. Session patches must
// omit untouched keys instead of resetting them to launch defaults.
export const browserSessionOptionsSchema = z.object({
  viewportWidth: browserOptionsSchema.shape.viewportWidth.removeDefault().optional(),
  viewportHeight: browserOptionsSchema.shape.viewportHeight.removeDefault().optional(),
  colorScheme: browserOptionsSchema.shape.colorScheme.removeDefault().optional(),
  timeoutMs: browserOptionsSchema.shape.timeoutMs.removeDefault().optional(),
  navigationTimeoutMs: browserOptionsSchema.shape.navigationTimeoutMs.removeDefault().optional(),
  snapshotElements: browserOptionsSchema.shape.snapshotElements.removeDefault().optional(),
  maxChars: browserOptionsSchema.shape.maxChars.removeDefault().optional(),
  blockedResources: browserOptionsSchema.shape.blockedResources.removeDefault().optional(),
}).strict();
export const defaultBrowserOptions = (): BrowserOptions => browserOptionsSchema.parse({});
