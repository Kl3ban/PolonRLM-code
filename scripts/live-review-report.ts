export interface LiveReviewCase {
  name: string;
  missing: string[];
  errors: Array<{ name: string; error: string }>;
  fatal?: string;
  providerFailure?: boolean;
  unsubstantiatedClaim?: boolean;
  answer?: string;
}

const PROVIDER_FAILURE = /timeout|timed out|aborted|fetch failed|ECONN|ENOTFOUND|forbidden|high demand|temporarily busy|provider.{0,40}unavailable|rate.?limit|too many requests|\b429\b|quota|overloaded|overload|over capacity|capacity exceeded|service unavailable|bad gateway|gateway timeout|HTTP\s+[45]\d\d/i;

export function isProviderFailure(message: string | undefined): boolean {
  return message !== undefined && PROVIDER_FAILURE.test(message);
}

export function liveReviewFindings(entry: LiveReviewCase, expectedErrors: ReadonlySet<string>) {
  return [
    ...(!entry.providerFailure ? entry.missing.map(name => ({ severity: 'medium' as const, area: entry.name, status: 'required tool not called', evidence: name })) : []),
    ...entry.errors.filter(error => !expectedErrors.has(error.name)).map(error => {
      const invalidModelArguments = /^Invalid arguments for tool\b/i.test(error.error);
      return { severity: invalidModelArguments ? 'low' as const : 'medium' as const, area: `${entry.name}/${error.name}`,
        status: invalidModelArguments ? 'model returned invalid tool arguments; call was blocked' : 'tool returned an error', evidence: error.error };
    }),
    ...(entry.fatal ? [{ severity: 'high' as const, area: entry.name, status: entry.providerFailure ? 'provider unavailable before tool review completed' : 'case failed', evidence: entry.fatal }] : []),
    ...(!entry.providerFailure && entry.unsubstantiatedClaim ? [{ severity: 'medium' as const, area: entry.name, status: 'action claim without a tool call', evidence: entry.answer ?? '' }] : []),
  ];
}
