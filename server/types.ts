export type Team = 'Sales' | 'Marketing' | 'Engineering' | 'QA' | 'Product' | 'Release' | 'Legal' | 'Other';

export const TEAMS: Team[] = ['Sales', 'Marketing', 'Engineering', 'QA', 'Product', 'Release', 'Legal', 'Other'];

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
export type Provider = 'claude' | 'openai' | 'azure';
export interface Settings {
  provider: Provider;
  claudeModel: string;
  /** Empty means the model configured in Codex. */
  openaiModel: string;
  /** Claude model for the Boss only; empty follows `claudeModel`. */
  bossModel?: string;
  /** OpenAI model for the Boss only; empty follows `openaiModel`. */
  bossOpenaiModel?: string;
  /** Stop starting new runs once tracked spend reaches this many dollars. 0 or unset means no cap. */
  budgetUsd?: number;
  /** No new runs start while true; running ones finish. */
  paused?: boolean;
}
export const DEFAULT_SETTINGS: Settings = { provider: 'claude', claudeModel: DEFAULT_MODEL, openaiModel: '' };

export interface Agent {
  id: string;
  name: string;
  title: string;
  team: Team;
  jobDescription: string;
  /** Managers plan and route work to teammates; workers just do tasks. */
  kind: 'worker' | 'manager';
  /** Claude model override for this agent; empty follows the session's Claude model. */
  model: string;
  /** OpenAI model override for this agent; empty follows the session's OpenAI model. */
  openaiModel?: string;
  skills: string[];
  /** May drive the user's Chrome (Claude in Chrome) to test locally running apps. Claude provider only. */
  browser?: boolean;
  hiredAt: string;
}

/** One line of an agent's live work: a tool it called or something it said. */
export interface ActivityItem {
  at: string;
  kind: 'tool' | 'text';
  text: string;
}

export type TaskStatus = 'blocked' | 'queued' | 'running' | 'waiting_input' | 'done' | 'failed' | 'cancelled';

export interface Task {
  id: string;
  agentId: string;
  title: string;
  instructions: string;
  /** Task ids that must be done before this one starts. */
  dependsOn: string[];
  status: TaskStatus;
  sessionId?: string;
  sessionProvider?: Provider;
  result?: string;
  /** Short handoff used when a long task continues in a fresh CLI conversation. */
  checkpoint?: string;
  checkpointCount?: number;
  /** How many of this task's questions the Boss or a manager settled without Akhil (capped, then Akhil is asked). */
  autoAnswers?: number;
  /** Questions this task's agent has asked, to catch repeats. */
  asked?: string[];
  /** The question waiting on a teammate's reply (see answerTo). */
  pendingQuestion?: string;
  /** For a teammate's "answer for X" task: the blocked task its result answers. */
  answerTo?: string;
  /** The manager who planned this task; he reviews the plan when its wave of tasks settles. */
  plannedBy?: string;
  /** Id of the planning task that started this plan (shared by every task and review in it). */
  planId?: string;
  /** A manager's follow-through check, not planned work. */
  review?: boolean;
  error?: string;
  costUsd: number;
  /** Akhil asked for a release: commit, push and deploy are allowed for this task. */
  release?: boolean;
  /** Folder the task runs in; fixed at first start so resumed sessions find their files. */
  workspace?: string;
  startedAt?: string;
  /** Recent live activity (capped). */
  activity?: ActivityItem[];
  createdAt: string;
  updatedAt: string;
}

export interface Question {
  id: string;
  /** Empty for questions the Boss raises himself. */
  taskId: string;
  agentId: string;
  text: string;
  answer?: string;
  status: 'open' | 'answered';
  /** Set when the Boss answered it instead of Akhil. */
  answeredBy?: 'boss' | 'pm';
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  from: 'akhil' | 'boss' | 'system' | 'agent';
  agentId?: string;
  taskId?: string;
  text: string;
  at: string;
}

export interface OfficeState {
  settings: Settings;
  agents: Agent[];
  tasks: Task[];
  questions: Question[];
  chat: ChatMessage[];
  usage: Usage;
  /** Plan session/weekly limits from the latest CLI call. */
  limits?: PlanLimits;
  /** Folder agents work in, chosen by the user. Falls back to the server default. */
  workspace?: string;
  /** Most recently selected workspaces, newest first. */
  recentWorkspaces?: string[];
}

/** Share of a plan window used (0-1) and when it resets (unix seconds), as reported by the CLI. */
export interface LimitWindow {
  utilization: number;
  resetsAt: number;
}

export type PlanLimits = Partial<Record<'five_hour' | 'seven_day', LimitWindow>> & { updatedAt?: string };

export interface Usage {
  calls: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** YYYY-MM-DD -> cost */
  byDay: Record<string, number>;
  runs?: UsageRun[];
}

export interface UsageRun {
  id: string;
  at: string;
  durationMs: number;
  provider: Provider;
  model: string;
  role: 'boss' | 'worker';
  agentId?: string;
  taskId?: string;
  resumed: boolean;
  ok: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd: number;
  /** True only when the CLI explicitly reports a compaction event. */
  compactionObserved?: boolean;
}
