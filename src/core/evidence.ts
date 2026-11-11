export interface EvidenceTimelineEntry {
  id: string;
  createdAt: number;
  kind: 'tool' | 'model' | 'verification';
  actor: string;
  status: string;
  summary: string;
  durationMs?: number;
}

export function formatEvidenceTimeline(entries: EvidenceTimelineEntry[]): string {
  if (!entries.length) return 'No evidence has been recorded for this chat yet.';
  const lines = [`EVIDENCE TIMELINE · ${entries.length} recent events`];
  for (const entry of entries) {
    const time = new Date(entry.createdAt).toLocaleTimeString('en-US');
    const duration = entry.durationMs === undefined ? '' : ` · ${(entry.durationMs / 1000).toFixed(1)}s`;
    lines.push(`${time} · ${entry.kind.toUpperCase()} ${entry.status.toUpperCase()} · ${entry.actor} · ${entry.summary}${duration}`);
  }
  const latestVerification = entries.find(entry => entry.kind === 'verification');
  lines.push(latestVerification
    ? `Latest /verify evidence: ${latestVerification.status.toUpperCase()} · ${latestVerification.summary}.`
    : 'No /verify report is recorded in this chat. Tool activity alone does not confirm the final result.');
  lines.push('Full tool results remain in the conversation.');
  return lines.join('\n');
}
