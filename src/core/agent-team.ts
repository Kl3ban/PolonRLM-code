import type { AgentInfo } from './types.js';
import { safeText } from './secrets.js';

export interface AgentTeamMessage { from: string; role: string; content: string; source?: 'user' }

const MAX_TEAM_MESSAGES = 24;
const MAX_MESSAGES_PER_AGENT = 4;
const MAX_USER_STEERS_PER_AGENT = 4;
const MAX_MESSAGE_LENGTH = 700;
const MAX_MESSAGES_PER_TURN = 6;
const isWorking = (status: string): boolean => status === 'running' || status === 'working';

/** Ephemeral, bounded direct messages between agents in one delegation batch. */
export class AgentTeam {
  private readonly members = new Map<string, AgentInfo>();
  private readonly inboxes = new Map<string, AgentTeamMessage[]>();
  private readonly sent = new Map<string, number>();
  private readonly steered = new Map<string, number>();
  private total = 0;

  constructor(members: readonly AgentInfo[]) {
    for (const member of members) {
      if (this.members.has(member.id)) throw new Error('Duplicate subagent ID.');
      this.members.set(member.id, member);
      this.inboxes.set(member.id, []);
    }
  }

  peers(id: string): AgentInfo[] {
    if (!this.members.has(id)) throw new Error('Subagent does not belong to this team.');
    return [...this.members.values()].filter(member => member.id !== id);
  }

  send(from: string, to: string, message: string): string {
    const sender = this.members.get(from);
    const recipient = this.members.get(to);
    if (!sender || !isWorking(sender.status)) throw new Error('Sender is no longer an active team member.');
    if (!recipient) throw new Error('Recipient does not belong to this team.');
    if (from === to) throw new Error('A message must be sent to another agent.');

    const content = safeText(message).trim();
    if (!content) throw new Error('Message is empty after sanitization.');
    if (content.length > MAX_MESSAGE_LENGTH) throw new Error(`Message can contain at most ${MAX_MESSAGE_LENGTH} characters.`);
    if (this.total >= MAX_TEAM_MESSAGES) throw new Error('The team reached its message limit. Include your findings in the task result.');
    const senderCount = this.sent.get(from) ?? 0;
    if (senderCount >= MAX_MESSAGES_PER_AGENT) throw new Error(`An agent can send at most ${MAX_MESSAGES_PER_AGENT} messages during this task.`);

    this.inboxes.get(to)!.push({ from, role: sender.role, content });
    this.sent.set(from, senderCount + 1);
    this.total++;
    return isWorking(recipient.status)
      ? `Message queued for ${recipient.role} (${recipient.id}); they will see it on their next step if they are still working.`
      : `Recipient ${recipient.role} (${recipient.id}) has finished; the message is included with the results for the coordinator.`;
  }

  steer(to: string, message: string): string {
    const recipient = this.members.get(to);
    if (!recipient || !isWorking(recipient.status)) throw new Error('Subagent is no longer active.');
    const content = safeText(message).trim();
    if (!content) throw new Error('Message is empty after sanitization.');
    if (content.length > MAX_MESSAGE_LENGTH) throw new Error(`Message can contain at most ${MAX_MESSAGE_LENGTH} characters.`);
    if (this.total >= MAX_TEAM_MESSAGES) throw new Error('The team reached its message limit.');
    const count = this.steered.get(to) ?? 0;
    if (count >= MAX_USER_STEERS_PER_AGENT) throw new Error(`Steering limit reached for this agent (${MAX_USER_STEERS_PER_AGENT}) has been reached.`);
    this.inboxes.get(to)!.push({ from: 'user', role: 'user', content, source: 'user' });
    this.steered.set(to, count + 1);
    this.total++;
    return `Steering message queued for ${recipient.role} (${recipient.id}); the agent will see it on the next step if still working.`;
  }

  take(id: string): AgentTeamMessage[] {
    const inbox = this.inboxes.get(id);
    if (!inbox) throw new Error('Subagent does not belong to this team.');
    return inbox.splice(0, MAX_MESSAGES_PER_TURN);
  }

  pending(id: string): AgentTeamMessage[] {
    const inbox = this.inboxes.get(id);
    if (!inbox) throw new Error('Subagent does not belong to this team.');
    return [...inbox];
  }
}
