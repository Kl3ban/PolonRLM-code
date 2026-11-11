import { readFile } from 'node:fs/promises';

export interface BenchmarkReportCase {
  status: 'passed' | 'failed' | 'error';
  durationMs: number;
  toolCalls: number;
  toolErrors: number;
  usage: { input: number; output: number; cached: number; cost: number; costKnown: boolean };
}

export interface BenchmarkReportInput {
  version: 1 | 2;
  status: 'running' | 'complete' | 'stopped' | 'error' | 'cleanup-error';
  startedAt: string;
  provider: string;
  model: string;
  taskPack: string;
  profile?: 'single' | 'adaptive' | 'fixed';
  cases: BenchmarkReportCase[];
}

export interface BenchmarkRunSummary {
  startedAt: string;
  provider: string;
  model: string;
  taskPack: string;
  profile: 'single' | 'adaptive' | 'fixed';
  status: BenchmarkReportInput['status'];
  passed: number;
  failed: number;
  errors: number;
  cases: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  toolErrors: number;
  cost: number;
  costKnown: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseBenchmarkReport(value: unknown, source = 'report'): BenchmarkReportInput {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2) ||
    !['running', 'complete', 'stopped', 'error', 'cleanup-error'].includes(String(value.status)) ||
    typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt)) ||
    typeof value.provider !== 'string' || !value.provider.trim() ||
    typeof value.model !== 'string' || !value.model.trim() ||
    typeof value.taskPack !== 'string' || !value.taskPack.trim() || !Array.isArray(value.cases)) {
    throw new Error(`${source} is not a supported PolonRLM benchmark report.`);
  }
  const profile = value.profile === undefined && value.version === 1 ? 'single' : value.profile;
  if (!['single', 'adaptive', 'fixed'].includes(String(profile))) throw new Error(`${source} has an unknown benchmark profile.`);
  for (const [index, item] of value.cases.entries()) {
    if (!isRecord(item) || !['passed', 'failed', 'error'].includes(String(item.status)) ||
      !Number.isFinite(item.durationMs) || (item.durationMs as number) < 0 ||
      !Number.isFinite(item.toolCalls) || !Number.isFinite(item.toolErrors) || !isRecord(item.usage) ||
      !Number.isFinite(item.usage.input) || !Number.isFinite(item.usage.output) ||
      !Number.isFinite(item.usage.cached) || !Number.isFinite(item.usage.cost) || typeof item.usage.costKnown !== 'boolean') {
      throw new Error(`${source} case ${index + 1} is malformed.`);
    }
  }
  return { version: value.version, status: value.status as BenchmarkReportInput['status'], startedAt: value.startedAt,
    provider: value.provider, model: value.model, taskPack: value.taskPack, profile: profile as BenchmarkRunSummary['profile'],
    cases: value.cases as BenchmarkReportCase[] };
}

export async function loadBenchmarkReports(files: string[]): Promise<BenchmarkReportInput[]> {
  if (files.length < 2) throw new Error('Provide at least two report paths to compare.');
  return Promise.all(files.map(async file => {
    let raw: unknown;
    try { raw = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { throw new Error(`Could not read benchmark report ${file}: ${error instanceof Error ? error.message : String(error)}`); }
    return parseBenchmarkReport(raw, file);
  }));
}

export function summarizeBenchmarkReports(reports: BenchmarkReportInput[]): BenchmarkRunSummary[] {
  return reports.map(report => {
    const cases = report.cases;
    return {
      startedAt: report.startedAt, provider: report.provider, model: report.model, taskPack: report.taskPack,
      profile: report.profile ?? 'single', status: report.status,
      passed: cases.filter(item => item.status === 'passed').length,
      failed: cases.filter(item => item.status === 'failed').length,
      errors: cases.filter(item => item.status === 'error').length,
      cases: cases.length,
      durationMs: cases.reduce((total, item) => total + item.durationMs, 0),
      inputTokens: cases.reduce((total, item) => total + item.usage.input, 0),
      outputTokens: cases.reduce((total, item) => total + item.usage.output, 0),
      toolCalls: cases.reduce((total, item) => total + item.toolCalls, 0),
      toolErrors: cases.reduce((total, item) => total + item.toolErrors, 0),
      cost: cases.reduce((total, item) => total + item.usage.cost, 0),
      costKnown: cases.length > 0 && cases.every(item => item.usage.costKnown),
    };
  });
}

function duration(ms: number): string { return `${(ms / 1000).toFixed(1)}s`; }
function rate(passed: number, cases: number): string { return cases ? `${Math.round(passed / cases * 100)}%` : 'n/a'; }

export function formatBenchmarkComparison(reports: BenchmarkReportInput[]): string {
  const rows = summarizeBenchmarkReports(reports);
  const headers = ['Started', 'Model', 'Profile', 'Pack', 'Status', 'Pass', 'Rate', 'Time', 'Tokens in/out', 'Cost', 'Tools err'];
  const values = rows.map(row => [row.startedAt.replace('T', ' ').replace(/\.\d{3}Z$/, 'Z'), `${row.provider}/${row.model}`, row.profile, row.taskPack,
    row.status, `${row.passed}/${row.cases} (${row.failed} fail, ${row.errors} error)`, rate(row.passed, row.cases), duration(row.durationMs),
    `${row.inputTokens}/${row.outputTokens}`, row.costKnown ? `$${row.cost.toFixed(5)}` : 'unknown', `${row.toolErrors}/${row.toolCalls}`]);
  const widths = headers.map((header, column) => Math.max(header.length, ...values.map(row => row[column]!.length)));
  const render = (row: string[]) => `| ${row.map((value, column) => value.padEnd(widths[column]!)).join(' | ')} |`;
  return [render(headers), `|-:${widths.map(width => '-'.repeat(width + 1)).join('-|-:')}-|`, ...values.map(render)].join('\n');
}
