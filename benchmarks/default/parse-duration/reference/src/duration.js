export function parseDuration(value) {
  if (typeof value !== 'string' || !value) throw new TypeError('invalid duration');
  const match = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?(?:(\d+)ms)?$/.exec(value);
  if (!match || !match.slice(1).some(Boolean)) throw new TypeError('invalid duration');
  const [days, hours, minutes, seconds, millis] = match.slice(1).map(part => part === undefined ? 0 : Number(part));
  return days * 86_400_000 + hours * 3_600_000 + minutes * 60_000 + seconds * 1_000 + millis;
}
