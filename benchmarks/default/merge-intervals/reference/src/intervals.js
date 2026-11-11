export function mergeIntervals(intervals) {
  if (!Array.isArray(intervals)) throw new TypeError('intervals must be an array');
  const rows = intervals.map(row => {
    if (!Array.isArray(row) || row.length !== 2) throw new TypeError('interval must have two values');
    const [start, end] = row;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw new TypeError('invalid interval');
    return [start, end];
  }).sort((left, right) => left[0] - right[0]);
  const output = [];
  for (const [start, end] of rows) {
    const last = output.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else output.push([start, end]);
  }
  return output;
}
