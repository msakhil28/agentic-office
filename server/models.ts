import { spawn } from 'node:child_process';

export type ModelChoice = { id: string; name: string };
export type ModelCatalog = { models: ModelChoice[]; source: string; note?: string };

const aliases: ModelChoice[] = [
  { id: 'sonnet', name: 'Sonnet (latest)' },
  { id: 'opus', name: 'Opus (latest)' },
  { id: 'haiku', name: 'Haiku (latest)' },
];

function unique(models: ModelChoice[]): ModelChoice[] {
  const seen = new Set<string>();
  return models.filter((m) => m.id && !seen.has(m.id) && (seen.add(m.id), true));
}

/** The Anthropic Models API requires an API key; Claude Code OAuth is separate. */
export async function claudeModels(): Promise<ModelCatalog> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { models: aliases, source: 'Claude CLI aliases', note: 'Set ANTHROPIC_API_KEY to load the full Anthropic API model catalog. Claude CLI aliases always point to its latest models.' };
  try {
    const models: ModelChoice[] = [];
    let after = '';
    do {
      const url = new URL('https://api.anthropic.com/v1/models');
      url.searchParams.set('limit', '1000');
      if (after) url.searchParams.set('after_id', after);
      const res = await fetch(url, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`Anthropic Models API returned ${res.status}`);
      const page = await res.json() as any;
      if (!Array.isArray(page.data)) throw new Error('Invalid Anthropic model response');
      models.push(...page.data.filter((m: any) => typeof m.id === 'string').map((m: any) => ({ id: m.id, name: m.display_name || m.id })));
      const next = page.has_more && typeof page.last_id === 'string' ? page.last_id : '';
      if (next === after) break;
      after = next;
    } while (after);
    return { models: unique([...aliases, ...models]), source: 'Anthropic Models API' };
  } catch (e: any) {
    return { models: aliases, source: 'Claude CLI aliases', note: `Could not load the Anthropic catalog: ${e.message}` };
  }
}

/** Query the same local Codex sign-in used to run OpenAI agents. */
export function openaiModels(): Promise<ModelCatalog> {
  return new Promise((resolve) => {
    const bin = process.env.CODEX_BIN || 'codex';
    const child = spawn(bin, ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    const models: ModelChoice[] = [];
    let buffer = '', done = false;
    const finish = (note?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve({ models: unique(models), source: 'Codex app server', ...(note ? { note } : {}) });
    };
    const send = (id: number, method: string, params: object) => child.stdin?.write(JSON.stringify({ id, method, params }) + '\n');
    const timer = setTimeout(() => finish('Codex model listing timed out.'), 12000);
    child.on('error', (e) => finish(`Could not start Codex: ${e.message}`));
    child.on('close', () => finish(models.length ? undefined : 'Codex model listing is unavailable. Check that the Codex CLI is signed in.'));
    child.stdout?.on('data', (chunk) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message: any;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error) return finish('Codex app server initialization failed.');
          child.stdin?.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
          send(2, 'model/list', {});
        } else if (message.id >= 2) {
          if (message.error) return finish('Codex model listing failed.');
          const page = message.result;
          if (!Array.isArray(page?.data)) return finish('Invalid Codex model response.');
          models.push(...page.data.filter((m: any) => !m.hidden && typeof m.model === 'string').map((m: any) => ({ id: m.model, name: m.displayName || m.model })));
          if (page.nextCursor) send(message.id + 1, 'model/list', { cursor: page.nextCursor });
          else finish();
        }
      }
    });
    send(1, 'initialize', { clientInfo: { name: 'agent_office', title: 'Agent Office', version: '0.1.0' }, capabilities: {} });
  });
}

let cached: { at: number; value: Promise<{ claude: ModelCatalog; openai: ModelCatalog }> } | undefined;
export function listModels(refresh = false) {
  if (!refresh && cached && Date.now() - cached.at < 5 * 60_000) return cached.value;
  const value = Promise.all([claudeModels(), openaiModels()]).then(([claude, openai]) => ({ claude, openai }));
  cached = { at: Date.now(), value };
  return value;
}
