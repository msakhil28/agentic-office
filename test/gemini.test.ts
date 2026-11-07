import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agyArgs, extractJson, normalizeAgyModel, runGemini } from '../server/gemini.ts';

test('agyArgs: Boss/triage (no tools) are read-only in plan mode, workers run sandboxed', () => {
  const boss = agyArgs({ prompt: 'x', model: '', cwd: '.', tools: '' });
  assert.equal(boss[boss.indexOf('--mode') + 1], 'plan');
  assert.ok(!boss.includes('--dangerously-skip-permissions'));
  const worker = agyArgs({ prompt: 'x', model: 'gemini-3.8-pro', cwd: '.', tools: 'Read,Write', resume: 'conv-1', schema: { type: 'object' } });
  assert.ok(worker.includes('--sandbox') && worker.includes('--dangerously-skip-permissions') && !worker.includes('--mode'));
  assert.equal(worker[worker.indexOf('--model') + 1], 'gemini-4-argon-medium');
  assert.equal(worker[worker.indexOf('--conversation') + 1], 'conv-1');
  assert.equal(worker[worker.indexOf('--json-schema') + 1], '{"type":"object"}');
  assert.equal(worker[worker.indexOf('--output-format') + 1], 'stream-json');
});

test('normalizeAgyModel only produces model ids that `agy models` lists', () => {
  assert.equal(normalizeAgyModel('gemini-3.8-pro'), 'gemini-4-argon-medium');
  assert.equal(normalizeAgyModel('gemini-2.5-pro'), 'gemini-4-argon-medium');
  assert.equal(normalizeAgyModel('gemini-4-argon'), 'gemini-4-argon-medium');
  assert.equal(normalizeAgyModel('gemini-4-argon-high'), 'gemini-4-argon-high');
  assert.equal(normalizeAgyModel('gemini-3.8-flash'), 'gemini-3.8-flash-medium');
  assert.equal(normalizeAgyModel('gemini-3.8-flash-low'), 'gemini-3.8-flash-low');
  assert.equal(normalizeAgyModel('claude-sonnet-5-5-high'), 'claude-sonnet-5-5-high');
  assert.equal(normalizeAgyModel(''), '');
});

test('extractJson extracts structured data from various formats', () => {
  assert.deepEqual(extractJson('{"hello":"world"}'), { hello: 'world' });
  assert.deepEqual(extractJson('Here is your json:\n```json\n{"status":"done"}\n```\nDone!'), { status: 'done' });
  assert.deepEqual(extractJson('Prefix text {"key":123} suffix'), { key: 123 });
  assert.equal(extractJson('not json at all'), undefined);
  assert.equal(extractJson(''), undefined);
});

const withFakeAgy = async (script: string, fn: (dir: string) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), 'fake-agy-'));
  const bin = join(dir, 'agy.mjs');
  writeFileSync(bin, script);
  const prev = process.env.AGY_BIN;
  process.env.AGY_BIN = bin;
  try { await fn(dir); } finally { if (prev === undefined) delete process.env.AGY_BIN; else process.env.AGY_BIN = prev; }
};

test('runGemini reads agy stream-json: tool steps become activity, the result event gives answer, id and usage', async () => {
  await withFakeAgy(`
    const ev = [
      { event: 'init', conversation_id: 'conv-9', init: {} },
      { event: 'step_update', step_update: { conversation_id: 'conv-9', step_type: 'tool', state: 'ACTIVE', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls -la' } } } },
      { event: 'step_update', step_update: { conversation_id: 'conv-9', step_type: 'tool', state: 'DONE', tool_name: 'run_command' } },
      { event: 'step_update', step_update: { conversation_id: 'conv-9', step_type: 'tool', state: 'ACTIVE', tool_name: 'write_to_file', tool_info: { name: 'write_to_file', parameters: { Path: '/ws/a.txt' } } } },
      { event: 'result', result: { conversation_id: 'conv-9', status: 'SUCCESS', response: 'plan chatter\\n{"status":"done","summary":"agy ok"}', structured_output: { status: 'done', summary: 'agy ok' }, usage: { input_tokens: 25, output_tokens: 10, cache_read_tokens: 5 } } },
    ];
    for (const e of ev) process.stdout.write(JSON.stringify(e) + '\\n');
  `, async (dir) => {
    const seen: string[] = [];
    const result = await runGemini({ prompt: 'task', model: 'gemini-3.8-flash', cwd: dir, tools: 'Read', schema: { type: 'object' }, onActivity: (items) => seen.push(...items.map((x) => x.text)) });
    assert.equal(result.ok, true);
    assert.equal(result.sessionId, 'conv-9');
    assert.equal(result.structured?.summary, 'agy ok');
    assert.equal(result.inputTokens, 25);
    assert.equal(result.outputTokens, 10);
    assert.equal(result.cacheReadTokens, 5);
    assert.deepEqual(seen, ['run_command: ls -la', 'write_to_file: /ws/a.txt']);
  });
});

test('runGemini falls back to JSON found in the answer text when there is no structured_output', async () => {
  await withFakeAgy(`process.stdout.write(JSON.stringify({ event: 'result', result: { conversation_id: 'c', status: 'SUCCESS', response: 'Done:\\n\`\`\`json\\n{"status":"done","summary":"x"}\\n\`\`\`' } }) + '\\n');`, async (dir) => {
    const result = await runGemini({ prompt: 't', model: '', cwd: dir, tools: 'Read', schema: { type: 'object' } });
    assert.equal(result.ok, true);
    assert.equal(result.structured?.summary, 'x');
  });
});

test('runGemini reports a non-zero exit with agy\'s error output', async () => {
  await withFakeAgy(`process.stderr.write('agy auth failed\\n'); process.exit(1);`, async (dir) => {
    const result = await runGemini({ prompt: 'fail', model: '', cwd: dir });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /agy auth failed/);
  });
});

test('runGemini says how to fix a missing agy binary', async () => {
  const prev = process.env.AGY_BIN;
  process.env.AGY_BIN = '/nonexistent/agy';
  try {
    const result = await runGemini({ prompt: 'x', model: '', cwd: tmpdir() });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /AGY_BIN/);
  } finally { if (prev === undefined) delete process.env.AGY_BIN; else process.env.AGY_BIN = prev; }
});
