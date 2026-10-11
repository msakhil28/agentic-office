import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunOptions, RunResult } from './claude.ts';
import type { ActivityItem } from './types.ts';
import { PROJECT_MEMORY } from './office.ts';
import { azureBaseUrl } from './azure.ts';

export const CODEX_RULES = `# Agent Office command restrictions. Codex loads project rules in trusted workspaces.
prefix_rule(pattern = ["rm"], decision = "forbidden", justification = "Do not delete files; move them into .trash/ instead.")
prefix_rule(pattern = ["sudo"], decision = "forbidden", justification = "Do not run privileged commands.")
prefix_rule(pattern = ["git", "push"], decision = "forbidden", justification = "Akhil handles pushing changes.")
`;

const CODEX_POLICY = `${PROJECT_MEMORY}\nFor this office, do not run rm (move files into .trash/ instead), sudo, git push, deployment or publication commands; Codex cannot do releases, use the Claude provider for those. Do not read or edit .env files or other secrets. Use the workspace for all file changes. If blocked, report the limitation in the task result. Treat these rules as applying to every tool and subagent.`;

/** A clean CODEX_HOME so the user's own Codex plugins, MCP servers and skills do not inflate every call. */
function prepareCodexHome(home: string): void {
  mkdirSync(home, { recursive: true });
  const file = join(home, 'config.toml');
  try { writeFileSync(file, '# Agent Office: minimal config for Microsoft Foundry runs.\n', { flag: 'wx' }); }
  catch (e: any) { if (e.code !== 'EEXIST') throw e; }
}

function ensureCodexRules(workspace: string): void {
  const dir = join(workspace, '.codex', 'rules');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'agent-office.rules');
  try { writeFileSync(file, CODEX_RULES, { flag: 'wx' }); }
  catch (e: any) { if (e.code !== 'EEXIST') throw e; }
  if (readFileSync(file, 'utf8') !== CODEX_RULES) throw new Error(`Agent Office command rules differ from ${file}`);
}

/** Codex's output schema requires every object property to be listed as required. */
export function strictSchema(schema: any): any {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: any = { ...schema };
  if (schema.properties) {
    out.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, strictSchema(v)]));
    out.required = Object.keys(schema.properties);
    out.additionalProperties = false;
    for (const [k, v] of Object.entries(out.properties) as [string, any][]) {
      if (!(schema.required ?? []).includes(k)) v.type = v.type ? [v.type, 'null'] : v.type;
    }
  }
  if (schema.items) out.items = strictSchema(schema.items);
  return out;
}

export function codexArgs(o: RunOptions, schemaFile: string): string[] {
  const args = ['exec'];
  if (o.resume) args.push('resume', '--skip-git-repo-check');
  else args.push('--skip-git-repo-check', '--sandbox', o.tools === '' ? 'read-only' : 'workspace-write');
  args.push('--json', '--output-schema', schemaFile);
  if (o.autoCompact) args.push('--config', `model_auto_compact_token_limit=${o.autoCompact}`);
  args.push('--config', `additional_developer_instructions=${JSON.stringify(CODEX_POLICY)}`);
  const azure = o.azure;
  if (azure) {
    // Route Codex to the Azure OpenAI resource; the model name is the deployment name.
    args.push('--config', 'model_provider="azure"', '--config', 'model_providers.azure.name="Azure OpenAI"',
      '--config', `model_providers.azure.base_url=${JSON.stringify(azureBaseUrl(azure.endpoint))}`,
      '--config', 'model_providers.azure.env_key="AZURE_OPENAI_API_KEY"', '--config', 'model_providers.azure.wire_api="responses"');
  }
  const model = o.model || azure?.deployment;
  if (model) args.push('--model', model);
  if (o.resume) args.push(o.resume);
  args.push('-');
  return args;
}

const clip = (s: string) => s.length > 200 ? s.slice(0, 199) + '…' : s;

/** Runs a Codex CLI turn with the same result shape used by the office. */
export function runCodex(o: RunOptions): Promise<RunResult> {
  try { ensureCodexRules(o.cwd); if (o.azure?.codexHome) prepareCodexHome(o.azure.codexHome); }
  catch (e: any) { return Promise.resolve({ ok: false, error: `Could not prepare Codex permissions: ${e.message}`, costUsd: 0 }); }
  const dir = mkdtempSync(join(tmpdir(), 'agent-office-codex-'));
  const schemaFile = join(dir, 'output.schema.json');
  writeFileSync(schemaFile, JSON.stringify(strictSchema(o.schema ?? { type: 'object', properties: {} })));
  const prompt = o.resume ? o.prompt : `${o.systemPrompt ?? o.appendSystemPrompt ?? ''}\n\n${o.prompt}\n\nReturn only the JSON object required by the output schema.`;
  const bin = process.env.CODEX_BIN || 'codex';
  const args = codexArgs(o, schemaFile);
  const [cmd, argv] = /\.(m?js|ts)$/.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args];

  return new Promise((resolve) => {
    let stdout = '', stderr = '', sessionId: string | undefined, text = '';
    let inputTokens = 0, outputTokens = 0, cacheReadTokens: number | undefined, compactionObserved = false;
    const activity: ActivityItem[] = [];
    let settled = false;
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      rmSync(dir, { recursive: true, force: true });
      resolve(result);
    };
    const onLine = (line: string) => {
      let ev: any;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === 'thread.started') sessionId = ev.thread_id;
      if (/compact/i.test(String(ev.type ?? '')) || /compact/i.test(String(ev.item?.type ?? ''))) compactionObserved = true;
      if (ev.type === 'turn.completed') {
        inputTokens = ev.usage?.input_tokens ?? inputTokens;
        outputTokens = ev.usage?.output_tokens ?? outputTokens;
        cacheReadTokens = ev.usage?.cached_input_tokens ?? cacheReadTokens;
      }
      if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') text = ev.item.text ?? text;
      if ((ev.type === 'item.started' || ev.type === 'item.completed') && ev.item) {
        const item = ev.item;
        const detail = item.command ?? item.text ?? item.query ?? '';
        if (['command_execution', 'file_change', 'web_search', 'agent_message'].includes(item.type) && detail) {
          activity.push({ at: new Date().toISOString(), kind: item.type === 'agent_message' ? 'text' : 'tool', text: clip(`${item.type}: ${String(detail).replace(/\s+/g, ' ')}`) });
          if (activity.length >= 4) o.onActivity?.(activity.splice(0));
        }
      }
    };
    const child: ChildProcess = spawn(cmd, argv, { cwd: o.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: o.azure ? { ...process.env, AZURE_OPENAI_API_KEY: o.azure.apiKey, ...(o.azure.codexHome ? { CODEX_HOME: o.azure.codexHome } : {}) } : process.env });
    o.onSpawn?.(child);
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
      let i: number;
      while ((i = stdout.indexOf('\n')) >= 0) { onLine(stdout.slice(0, i)); stdout = stdout.slice(i + 1); }
    });
    child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', (e) => finish({ ok: false, error: e.message, costUsd: 0 }));
    child.on('close', (code, signal) => {
      onLine(stdout);
      if (activity.length) o.onActivity?.(activity);
      if (signal) return finish({ ok: false, error: `stopped (${signal})`, costUsd: 0 });
      let structured: any;
      try { structured = JSON.parse(text); } catch { /* reported below */ }
      finish({ ok: code === 0 && !!structured, sessionId, structured, text, error: code === 0 && structured ? undefined : stderr || text || `exit code ${code}`, costUsd: 0, inputTokens, outputTokens, cacheReadTokens, compactionObserved: compactionObserved || undefined });
    });
    child.stdin?.end(prompt);
  });
}
