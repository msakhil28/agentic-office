import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AzureStore, azureBaseUrl } from '../server/azure.ts';
import { codexArgs, runCodex, strictSchema } from '../server/codex.ts';

test('Codex schema makes optional fields nullable and supports fresh and resumed turns', () => {
  const schema = strictSchema({ type: 'object', properties: { status: { type: 'string' }, question: { type: 'string' } }, required: ['status'] });
  assert.deepEqual(schema.required, ['status', 'question']);
  assert.deepEqual(schema.properties.question.type, ['string', 'null']);
  assert.equal(schema.additionalProperties, false);
  const o = { prompt: 'x', model: '', cwd: '.', schema };
  assert.ok(codexArgs(o, '/tmp/schema').includes('workspace-write'));
  assert.ok(codexArgs({ ...o, resume: 'abc' }, '/tmp/schema').includes('resume'));
  assert.ok(codexArgs({ ...o, autoCompact: 250000 }, '/tmp/schema').includes('model_auto_compact_token_limit=250000'));
  assert.ok(codexArgs(o, '/tmp/schema').some((a) => a.startsWith('additional_developer_instructions=')));
});

test('Codex runner parses JSONL result, tokens, session, and activity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fake-codex-'));
  const bin = join(dir, 'cli.mjs');
  writeFileSync(bin, `process.stdin.resume(); process.stdin.on('end', () => {
    for (const event of [
      {type:'thread.started',thread_id:'session-1'},
      {type:'item.started',item:{type:'command_execution',command:'npm test'}},
      {type:'item.completed',item:{type:'agent_message',text:'{"status":"done","summary":"ok"}'}},
      {type:'turn.completed',usage:{input_tokens:12,output_tokens:4}}
    ]) process.stdout.write(JSON.stringify(event)+'\\n');
  });`);
  const previous = process.env.CODEX_BIN;
  process.env.CODEX_BIN = bin;
  try {
    const activity: string[] = [];
    const result = await runCodex({ prompt: 'task', model: '', cwd: dir, schema: { type: 'object', properties: { status: { type: 'string' }, summary: { type: 'string' } }, required: ['status', 'summary'] }, onActivity: (items) => activity.push(...items.map((x) => x.text)) });
    assert.equal(result.ok, true);
    assert.equal(result.sessionId, 'session-1');
    assert.equal(result.structured.summary, 'ok');
    assert.equal(result.inputTokens, 12);
    assert.ok(activity.some((x) => x.includes('npm test')));
    const rules = readFileSync(join(dir, '.codex', 'rules', 'agent-office.rules'), 'utf8');
    assert.match(rules, /\["git", "push"\].*forbidden/);
  } finally { if (previous === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = previous; }
});

test('Microsoft Foundry config routes Codex to the Azure resource and uses the deployment as model', () => {
  const azure = { endpoint: 'https://x.openai.azure.com/', apiKey: 'secret-key', deployment: 'gpt-5-mini' };
  const args = codexArgs({ prompt: 'x', model: '', cwd: '.', azure }, '/tmp/schema');
  assert.ok(args.includes('model_provider="azure"'));
  assert.ok(args.includes('model_providers.azure.base_url="https://x.openai.azure.com/openai/v1"'));
  assert.equal(args[args.indexOf('--model') + 1], 'gpt-5-mini');
  assert.ok(!args.join(' ').includes('secret-key'), 'the key is never put on the command line');
  const own = codexArgs({ prompt: 'x', model: 'other', cwd: '.', azure }, '/tmp/schema');
  assert.equal(own[own.indexOf('--model') + 1], 'other');
  assert.ok(!codexArgs({ prompt: 'x', model: '', cwd: '.' }, '/tmp/schema').includes('model_provider="azure"'));
});

test('AzureStore saves privately, hides the key, keeps it when blank, and only accepts Azure hosts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'azure-'));
  const store = new AzureStore(dir, {});
  assert.equal(store.get(), undefined);
  assert.throws(() => store.set({ endpoint: 'https://evil.example.com/', apiKey: 'k' }));
  assert.throws(() => store.set({ endpoint: 'http://x.openai.azure.com/', apiKey: 'k' }));
  assert.throws(() => store.set({ endpoint: 'https://x.openai.azure.com/', apiKey: '' }), /key/);
  const pub = store.set({ endpoint: 'https://x.openai.azure.com/openai/v1', apiKey: 'k1', deployment: 'gpt-5-mini' });
  assert.deepEqual(pub, { endpoint: 'https://x.openai.azure.com/', deployment: 'gpt-5-mini', keySet: true });
  assert.ok(!JSON.stringify(pub).includes('k1'));
  assert.equal(statSync(join(dir, 'azure.json')).mode & 0o077, 0, 'file is private');
  store.set({ endpoint: 'https://x.openai.azure.com/', apiKey: '', deployment: 'other' });
  assert.deepEqual(store.get(), { endpoint: 'https://x.openai.azure.com/', apiKey: 'k1', deployment: 'other', codexHome: join(dir, 'codex-home') });
  assert.equal(new AzureStore(mkdtempSync(join(tmpdir(), 'azure-')), { AZURE_OPENAI_ENDPOINT: 'https://e.openai.azure.com/', AZURE_OPENAI_API_KEY: 'envk' }).get()?.apiKey, 'envk', 'env vars are a fallback');
  assert.equal(azureBaseUrl('https://x.openai.azure.com/'), 'https://x.openai.azure.com/openai/v1');
});
