import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RunOptions, RunResult } from './claude.ts';
import type { ActivityItem } from './types.ts';
import { PROJECT_MEMORY } from './office.ts';

export const GEMINI_POLICY = `${PROJECT_MEMORY}\nFor this office, do not run rm (move files into .trash/ instead), sudo, git push, deployment or publication commands; Gemini cannot do releases, use the Claude provider for those. Do not read or edit .env files or other secrets. Use the workspace for all file changes. If blocked, report the limitation in the task result. Treat these rules as applying to every tool and subagent.`;

/** The Antigravity CLI (`agy`). The old Gemini CLI is retired and is not supported. Override the path with AGY_BIN. */
export function resolveAgyBin(): string {
  if (process.env.AGY_BIN) return process.env.AGY_BIN;
  const installed = join(homedir(), '.gemini', 'bin', 'agy');
  return existsSync(installed) ? installed : 'agy';
}

/** `agy models` ids carry a level suffix; a bare family name gets the medium level. */
export function normalizeAgyModel(model: string): string {
  if (!model) return '';
  const trimmed = model.trim();
  const m = trimmed.match(/^gemini-(4-argon|3\.8-flash)(?:-(low|medium|high))?$/);
  if (m) return `gemini-${m[1]}-${m[2] ?? 'medium'}`;
  if (/pro/i.test(trimmed)) return 'gemini-4-argon-medium';
  if (/flash/i.test(trimmed)) return 'gemini-3.8-flash-medium';
  return trimmed;
}

export function agyArgs(o: RunOptions): string[] {
  // Boss and triage calls have no tools (tools === ''): plan mode is read-only and nothing is auto-approved.
  // Workers run unattended, so they auto-approve, but only inside agy's terminal sandbox.
  const args: string[] = o.tools === '' ? ['--mode', 'plan', '--output-format', 'stream-json'] : ['--sandbox', '--dangerously-skip-permissions', '--output-format', 'stream-json'];
  const model = normalizeAgyModel(o.model);
  if (model) args.push('--model', model);
  if (o.resume) args.push('--conversation', o.resume);
  if (o.schema) args.push('--json-schema', JSON.stringify(o.schema));
  return args;
}

export function extractJson(text: string): any {
  if (!text) return undefined;
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {}
  const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (match) {
    try {
      return JSON.parse(match[1].trim());
    } catch {}
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {}
  }
  return undefined;
}

/** Runs one Antigravity CLI turn with the same result shape used by the office. */
export function runGemini(o: RunOptions): Promise<RunResult> {
  const schemaInstruction = o.schema
    ? `\n\nYou MUST return a JSON object matching this schema:\n${JSON.stringify(o.schema, null, 2)}\nReturn only the JSON object, with no extra commentary or markdown formatting.`
    : '';
  const prompt = o.resume
    ? `${o.prompt}${schemaInstruction}`
    : `${o.systemPrompt ?? o.appendSystemPrompt ?? ''}\n\n${GEMINI_POLICY}\n\n${o.prompt}${schemaInstruction}`;

  const bin = resolveAgyBin();
  const args = [...agyArgs(o), `--print=${prompt}`];
  const [cmd, argv] = /\.(m?js|ts)$/.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args];

  const clip = (x: string) => (x.length > 200 ? x.slice(0, 199) + '…' : x);
  return new Promise((resolve) => {
    let buf = '', stderr = '', sessionId: string | undefined, final: any;
    const activity: ActivityItem[] = [];
    let settled = false;
    const finish = (result: RunResult) => { if (!settled) { settled = true; resolve(result); } };
    // agy --output-format stream-json: one JSON event per line. Tool steps become the activity feed; the last "result" event has the answer.
    const onLine = (line: string) => {
      let ev: any;
      try { ev = JSON.parse(line); } catch { return; }
      sessionId = ev.conversation_id ?? ev.step_update?.conversation_id ?? ev.result?.conversation_id ?? sessionId;
      if (ev.event === 'result') final = ev.result;
      const st = ev.step_update;
      if (st?.step_type === 'tool' && st.state === 'ACTIVE') {
        const p = st.tool_info?.parameters ?? {};
        const detail = String(p.CommandLine ?? p.Path ?? p.AbsolutePath ?? p.Query ?? p.Url ?? Object.values(p)[0] ?? '');
        activity.push({ at: new Date().toISOString(), kind: 'tool', text: clip(`${st.tool_name}${detail ? ': ' + detail.replace(/\s+/g, ' ') : ''}`) });
        o.onActivity?.(activity.splice(0));
      }
    };
    const child: ChildProcess = spawn(cmd, argv, { cwd: o.cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    o.onSpawn?.(child);
    child.stdout?.on('data', (chunk) => {
      buf += String(chunk);
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', (e: any) => finish({ ok: false, error: e.code === 'ENOENT' ? `Antigravity CLI not found ("${bin}"). Install agy, or set AGY_BIN to its path.` : e.message, costUsd: 0 }));
    child.on('close', (code, signal) => {
      if (buf.trim()) onLine(buf);
      if (signal) return finish({ ok: false, error: `stopped (${signal})`, costUsd: 0 });
      const text: string = typeof final?.response === 'string' ? final.response.trim() : '';
      const structured = final?.structured_output ?? extractJson(text);
      const usage = final?.usage ?? {};
      const ok = code === 0 && final?.status !== 'ERROR' && !!final && (o.schema ? !!structured : true);
      finish({
        ok,
        sessionId: final?.conversation_id ?? sessionId,
        structured,
        text,
        error: ok ? undefined : stderr || text || (final?.error ? String(final.error) : `exit code ${code}`),
        costUsd: 0,
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheReadTokens: usage.cache_read_tokens,
      });
    });
  });
}
