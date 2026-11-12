import { z } from 'zod';

export const webSearchOptionsSchema = z.object({
  maxSearches: z.number().int().nonnegative().safe().default(0),
  resultBytes: z.number().int().min(600).max(24000).default(6000),
  maxResults: z.number().int().min(1).max(20).default(8),
  retries: z.number().int().min(0).max(3).default(1),
}).strict();
export type WebSearchOptions = z.infer<typeof webSearchOptionsSchema>;
export const defaultWebSearchOptions = (): WebSearchOptions => webSearchOptionsSchema.parse({});
