import { spawn, type ChildProcess } from 'node:child_process';
import type { ActivityItem, PlanLimits } from './types.ts';
import type { AzureConfig } from './azure.ts';

export interface RunOptions {
  prompt: string;
  model: string;
  cwd: string;
  /** Replaces the default system prompt (used for the Boss). */
  systemPrompt?: string;
  /** Appended to the default Claude Code system prompt (used for workers). */
  appendSystemPrompt?: string;
  /** Tool list; "" disables all tools. Omit for the default set. */
  tools?: string;
  /** Tools pre-approved so headless runs never stall on a permission prompt. */
  allowedTools?: string[];
  /** Tools blocked outright, even in permissive modes. */
  disallowedTools?: string[];
  schema?: object;
  resume?: string;
  permissionMode?: string;
  /** Context size (tokens) at which the CLI auto-compacts the conversation. */
  autoCompact?: number;
  /** Turns off skills (and their listing in every prompt). */
  disableSlashCommands?: boolean;
  /** Lets the run use the Claude in Chrome extension (the user's own Chrome). */
  chrome?: boolean;
  /** Which settings layers the CLI loads (default "project": skips user-level plugins, hooks and memory). */
  settingSources?: string;
  /** Microsoft Foundry (Azure OpenAI) connection; set only when that provider is selected. Codex runs only. */
  azure?: AzureConfig;
  onSpawn?: (child: ChildProcess) => void;
  /** Called with what the agent does as it works (tool calls, messages). */
  onActivity?: (items: ActivityItem[]) => void;
}

export interface RunResult {
  ok: boolean;
  sessionId?: string;
  structured?: any;
  text?: string;
  error?: string;
  costUsd: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  compactionObserved?: boolean;
  /** Plan limits reported during this call, if any. */
  limits?: PlanLimits;
}

export type ClaudeRunner = (opts: RunOptions) => Promise<RunResult>;

export function buildArgs(o: RunOptions): string[] {
  const args = ['-p', '--model', o.model, '--output-format', 'stream-json', '--verbose'];
  // Cost control: no MCP servers (their tool definitions alone were ~73k tokens per call), only the layers asked for.
  args.push('--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', o.settingSources ?? 'project', '--exclude-dynamic-system-prompt-sections');
  if (o.chrome) args.push('--chrome');
  if (o.disableSlashCommands) args.push('--disable-slash-commands');
  if (o.systemPrompt !== undefined) args.push('--system-prompt', o.systemPrompt);
  if (o.appendSystemPrompt) args.push('--append-system-prompt', o.appendSystemPrompt);
  if (o.tools !== undefined) args.push('--tools', o.tools);
  if (o.allowedTools?.length) args.push('--allowedTools', o.allowedTools.join(','));
  if (o.disallowedTools?.length) args.push('--disallowedTools', o.disallowedTools.join(','));
  if (o.schema) args.push('--json-schema', JSON.stringify(o.schema));
  if (o.resume) args.push('--resume', o.resume);
  if (o.autoCompact) args.push('--autocompact', String(o.autoCompact));
  if (o.permissionMode) args.push('--permission-mode', o.permissionMode);
  return args;
}

/** Runs one `claude -p` turn. The prompt goes over stdin so it can never be parsed as a flag. */
export const runClaude: ClaudeRunner = (o) => {
  const bin = process.env.CLAUDE_BIN || 'claude';
  const args = buildArgs(o);
  // Allow a JS/TS script as a stand-in CLI (used by tests).
  const [cmd, argv] = /\.(m?js|ts)$/.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args];

  return new Promise((resolve) => {
    let buf = '';
    let stderr = '';
    let last: any = null; // the final {"type":"result"} line
    let limits: PlanLimits | undefined;
    let compactionObserved = false;
    let other = '';
    // Only the result line and the rate-limit events matter; the rest of the stream is dropped as it arrives.
    const onLine = (line: string) => {
      if (!line.trim()) return;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        other = (other + line + '\n').slice(-2000);
        return;
      }
      if (ev.type === 'result') last = ev;
      else if (ev.type === 'system' && /compact/i.test(String(ev.subtype ?? ''))) compactionObserved = true;
      else if (ev.type === 'assistant' && o.onActivity) {
        const items = describeEvent(ev);
        if (items.length) o.onActivity(items);
      }
      else if (ev.type === 'rate_limit_event') limits = mergeLimits(limits, ev.rate_limit_info);
    };
    const child = spawn(cmd, argv, { cwd: o.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ENABLE_PROMPT_CACHING_1H: process.env.ENABLE_PROMPT_CACHING_1H ?? '1' } });
    o.onSpawn?.(child);
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => resolve({ ok: false, error: err.message, costUsd: 0 }));
    child.on('close', (code, signal) => {
      onLine(buf);
      if (signal) return resolve({ ok: false, error: `stopped (${signal})`, costUsd: 0 });
      const out = last;
      if (!out) return resolve({ ok: false, error: (stderr || other).slice(-2000) || `exit code ${code}`, costUsd: 0, limits });
      resolve({
        ok: !out.is_error && code === 0,
        sessionId: out.session_id,
        structured: out.structured_output,
        text: out.result,
        error: out.is_error ? String(out.result ?? 'error') : code ? stderr.slice(-2000) : undefined,
        costUsd: Number(out.total_cost_usd) || 0,
        inputTokens: (out.usage?.input_tokens ?? 0) + (out.usage?.cache_creation_input_tokens ?? 0) + (out.usage?.cache_read_input_tokens ?? 0),
        outputTokens: out.usage?.output_tokens ?? 0,
        cacheReadTokens: out.usage?.cache_read_input_tokens,
        cacheCreationTokens: out.usage?.cache_creation_input_tokens,
        compactionObserved: compactionObserved || undefined,
        limits,
      });
    });
    child.stdin.end(o.prompt);
  });
};

/** Folds one rate_limit_event's windows into `into`. */
export function mergeLimits(into: PlanLimits | undefined, info: any): PlanLimits | undefined {
  const w = info?.unifiedWindows;
  if (!w || typeof w !== 'object') return into;
  const out: PlanLimits = { ...into };
  for (const k of ['five_hour', 'seven_day'] as const) {
    const v = w[k];
    if (v && typeof v.utilization === 'number' && typeof v.resetsAt === 'number') out[k] = { utilization: v.utilization, resetsAt: v.resetsAt };
  }
  return out;
}

const clip = (t: string, n = 140) => (t.length > n ? t.slice(0, n - 1) + '…' : t);

/** Short human description of a tool call, e.g. "Read src/app.ts". */
export function describeTool(name: string, input: any): string {
  const i = input ?? {};
  const arg = i.file_path ?? i.path ?? i.command ?? i.pattern ?? i.url ?? i.query ?? i.description ?? i.skill ?? '';
  return clip(`${name}${arg ? ' ' + String(arg).replace(/\s+/g, ' ') : ''}`);
}

/** Turns one stream-json "assistant" event into activity lines (thinking blocks are skipped). */
export function describeEvent(ev: any): ActivityItem[] {
  const at = new Date().toISOString();
  const out: ActivityItem[] = [];
  for (const b of ev?.message?.content ?? []) {
    if (b.type === 'tool_use') out.push({ at, kind: 'tool', text: describeTool(b.name, b.input) });
    else if (b.type === 'text' && String(b.text ?? '').trim()) out.push({ at, kind: 'text', text: clip(String(b.text).trim().replace(/\s+/g, ' '), 200) });
  }
  return out;
}
