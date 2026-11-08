export const CORTEX = [
  { name: 'Fast', steps: 8, agents: 0, guidance: 'Take the shortest correct path. Do not delegate.' },
  { name: 'Standard', steps: 24, agents: 2, guidance: 'Use a short plan only for complex tasks. Check the changed behavior.' },
  { name: 'Advanced', steps: 36, agents: 3, guidance: 'Plan, execute, and verify complex tasks. Delegate only independent work.' },
  { name: 'Deep', steps: 48, agents: 3, guidance: 'For difficult bugs, gather evidence and test a hypothesis. Do not repeat successful checks.' },
  { name: 'Expert', steps: 64, agents: 4, guidance: 'For important changes, use an independent reviewer if the budget allows.' },
  { name: 'Maximum', steps: 80, agents: 6, guidance: 'Compare alternatives only when the outcome is uncertain. Avoid extra calls without a clear benefit.' }
] as const;
