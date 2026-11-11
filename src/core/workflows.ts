import { z } from 'zod';

export interface WorkflowState {
  goal?: { objective: string; status: 'active' | 'paused' | 'complete' | 'limit'; tokenBudget: number; usedTokens: number; evidence?: string };
  grill?: { task: string; summary?: string; active: boolean };
  plan?: { step: string; status: 'pending' | 'in_progress' | 'done' }[];
  verificationRepro?: { command: string; baselineExitCode: number; baselineOutput: string; createdAt: number };
}
export const questionSchema = z.object({
  question: z.string().min(1).max(1500),
  options: z.array(z.object({ label: z.string().min(1).max(160), description: z.string().max(500) })).min(2).max(5),
  recommended: z.number().int().min(0).max(4),
}).refine(value => value.recommended < value.options.length, 'recommended must identify an option');
export type AgentQuestion = z.infer<typeof questionSchema>;
export function workflowInstructions(state: WorkflowState): string {
  const activeStep = state.plan?.find(step => step.status === 'in_progress')?.step;
  const plan = state.goal?.status === 'active' && state.plan?.length ? `TASK PLAN PROGRESS: ${state.plan.filter(step => step.status === 'done').length}/${state.plan.length} steps marked done${activeStep ? `; active step: ${activeStep.slice(0, 120)}` : ''}. Use plan_status to inspect or plan_update to revise. Plan status is bookkeeping, not proof of completion.` : '';
  return [state.goal ? `GOAL: ${JSON.stringify(state.goal)}. tokenBudget=0 means unlimited. Work until achieved, paused, or budget exhausted. Use get_goal and update_goal. Mark complete only with concrete evidence that all requirements are met. Do not create goals unless the user requests one.` : '', plan,
    state.grill?.active ? `GRILL_ME: Interview the user about ${JSON.stringify(state.grill.task)}. Resolve dependent design decisions one at a time. Inspect the codebase for facts instead of asking about them. Use ask_question for exactly one question at a time with 2-5 choices and a recommended answer. Explore constraints, behavior, edge cases and acceptance criteria. Only read tools are allowed during the interview. When understanding is complete, summarize decisions, ask the user through ask_question whether to implement, and call finish_interview only if they agree. Then implement the agreed plan.` : ''].filter(Boolean).join('\n');
}
