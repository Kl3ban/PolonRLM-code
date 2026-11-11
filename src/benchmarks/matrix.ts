import type { BenchmarkProfileName } from './profiles.js';

export interface BenchmarkMatrixRun {
  provider?: string;
  model: string;
  profile: BenchmarkProfileName;
}

export interface BenchmarkMatrixResult {
  reportPath: string;
  status: string;
}

function splitList(value: string, name: string): string[] {
  const items = value.split(',').map(item => item.trim());
  if (items.some(item => !item)) throw new Error(`${name} must be a comma-separated list without empty values.`);
  if (new Set(items).size !== items.length) throw new Error(`${name} must not contain duplicates.`);
  return items;
}

export function createBenchmarkMatrix(modelsValue: string, profilesValue = 'single'): BenchmarkMatrixRun[] {
  const models = splitList(modelsValue, '--models');
  if (models.some(model => model.length > 200)) throw new Error('Model IDs in --models must be at most 200 characters.');
  const profiles = splitList(profilesValue, '--profiles');
  if (profiles.some(profile => !['single', 'adaptive', 'fixed'].includes(profile))) {
    throw new Error('--profiles accepts single, adaptive, and fixed.');
  }
  const runs = models.flatMap(model => profiles.map(profile => ({ model, profile: profile as BenchmarkProfileName })));
  if (runs.length < 2) throw new Error('A benchmark matrix needs at least two runs. Add another model or profile.');
  return runs;
}

export function createProviderBenchmarkMatrix(targetsValue: string, profilesValue = 'single'): BenchmarkMatrixRun[] {
  const targets = splitList(targetsValue, '--targets').map(target => {
    const separator = target.indexOf('=');
    if (separator <= 0 || separator === target.length - 1) {
      throw new Error('--targets entries must use provider=model syntax.');
    }
    const provider = target.slice(0, separator).trim();
    const model = target.slice(separator + 1).trim();
    if (!provider) throw new Error('--targets entries must include a provider before =.');
    if (!model || model.length > 200) throw new Error('Model IDs in --targets must be 1 to 200 characters.');
    return { provider, model };
  });
  const identities = targets.map(target => `${target.provider}\0${target.model}`);
  if (new Set(identities).size !== identities.length) throw new Error('--targets must not repeat a provider/model pair.');
  const profiles = splitList(profilesValue, '--profiles');
  if (profiles.some(profile => !['single', 'adaptive', 'fixed'].includes(profile))) {
    throw new Error('--profiles accepts single, adaptive, and fixed.');
  }
  const runs = targets.flatMap(target => profiles.map(profile => ({ ...target, profile: profile as BenchmarkProfileName })));
  if (runs.length < 2) throw new Error('A benchmark matrix needs at least two runs. Add another model, provider, or profile.');
  return runs;
}

export async function executeBenchmarkMatrix<T extends BenchmarkMatrixResult>(
  runs: BenchmarkMatrixRun[],
  runOne: (run: BenchmarkMatrixRun, index: number, total: number) => Promise<T>,
): Promise<{ completed: Array<{ run: BenchmarkMatrixRun; result: T }>; failure?: unknown }> {
  const completed: Array<{ run: BenchmarkMatrixRun; result: T }> = [];
  for (const [index, run] of runs.entries()) {
    try {
      const result = await runOne(run, index, runs.length);
      completed.push({ run, result });
      if (result.status !== 'complete') break;
    } catch (failure) {
      return { completed, failure };
    }
  }
  return { completed };
}
