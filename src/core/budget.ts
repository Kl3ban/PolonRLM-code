/** Zero is the persisted, JSON-safe representation of an unlimited token budget. */
export function parseTokenBudget(value: unknown): number {
  if (typeof value === 'string' && !value.trim()) throw new Error('Enter infinity, 0, or a token count.');
  if (value === null || value === Infinity || (typeof value === 'string' && /^(?:infinity|inf|unlimited|unlimited|∞)$/i.test(value.trim()))) return 0;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || (number > 0 && number < 1000)) throw new Error('Token limit: infinity / 0, or an integer of at least 1,000.');
  return number;
}
export const tokenBudgetMaximum = (value: number): number => value === 0 ? Infinity : value;
export const formatTokenBudget = (value: number): string => value === 0 ? '∞' : value.toLocaleString('en-US');

