process.env.ANSWER_BATCH_MS = '0';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.ts';
import { Office } from '../server/office.ts';
import { buildArgs, mergeLimits, type ClaudeRunner, type RunOptions } from '../server/claude.ts';

const wait = async (fn: () => boolean) => {
  for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(fn(), 'condition not met');
};

function setup(run: ClaudeRunner) {
  const store = new Store(null);
  const office = new Office({ store, run, workspace: join(tmpdir(), 'office-test-ws'), permissionMode: 'acceptEdits' });
  return { store, office };
}

test('hire follows the session model by default and guesses team', () => {
  const { office } = setup(async () => ({ ok: true, costUsd: 0 }));
  const a = office.hire({ title: 'QA Engineer', jobDescription: 'tests' });
  assert.equal(a.model, '');
  assert.equal(a.team, 'QA');
  assert.throws(() => office.hire({ title: '', jobDescription: 'x' }));
});

test('settings route Boss and existing agents through the selected provider and survive restart', async () => {
  const { mkdtempSync } = await import('node:fs');
  const file = join(mkdtempSync(join(tmpdir(), 'settings-')), 'office.json');
  const store = new Store(file);
  const seen: string[] = [];
  const claude: ClaudeRunner = async (o) => {
    seen.push(`claude:${o.model}:${o.tools === '' ? 'boss' : 'worker'}`);
    return { ok: true, costUsd: 0, structured: o.tools === '' ? { reply: 'ok', delegations: [] } : { status: 'done', summary: 'ok' } };
  };
  const openai: ClaudeRunner = async (o) => {
    seen.push(`openai:${o.model}:${o.tools === '' ? 'boss' : 'worker'}`);
    return { ok: true, costUsd: 0, structured: o.tools === '' ? { reply: 'ok', delegations: [] } : { status: 'done', summary: 'ok' } };
  };
  const office = new Office({ store, run: claude, runOpenai: openai, workspace: join(tmpdir(), 'office-test-ws'), permissionMode: 'acceptEdits' });
  const agent = office.hire({ title: 'Developer', jobDescription: 'code' });
  office.setSettings({ provider: 'openai', openaiModel: 'gpt-test' });
  office.createTask(agent.id, 'first', 'x');
  await office.chat('status');
  await wait(() => store.state.tasks[0].status === 'done');
  assert.ok(seen.includes('openai:gpt-test:boss'));
  assert.ok(seen.includes('openai:gpt-test:worker'));
  office.setSettings({ provider: 'claude', claudeModel: 'claude-test' });
  office.createTask(agent.id, 'second', 'x');
  await wait(() => store.state.tasks[1].status === 'done');
  assert.ok(seen.includes('claude:claude-test:worker'));
  assert.throws(() => office.setSettings({ provider: 'other' as any }));
  store.flush();
  assert.equal(new Store(file).state.settings.claudeModel, 'claude-test');
});

test('boss delegates, agent asks a question, answer resumes, worker reports directly', async () => {
  let workerCalls = 0;
  let bossCalls = 0;
  let agentId = '';
  const run: ClaudeRunner = async (o) => {
    if (o.tools === '') {
      bossCalls++;
      // boss turn
      if (o.systemPrompt?.includes('TRIAGE MODE')) { bossCalls--; return { ok: true, costUsd: 0, structured: { answer: '', question: 'OAuth or password?' } }; }
      if (o.prompt.includes('Akhil says')) return { ok: true, costUsd: 0, structured: { reply: 'On it', delegations: [{ agentId, title: 'Build login', instructions: 'do it' }, { agentId: 'bogus', title: 'x', instructions: 'y' }] } };
      return { ok: true, costUsd: 0, structured: { reply: 'Dev finished login.', delegations: [] } };
    }
    workerCalls++;
    if (!o.resume) return { ok: true, sessionId: 's1', costUsd: 0.1, structured: { status: 'needs_input', summary: '', question: 'OAuth or password?' } };
    assert.equal(o.resume, 's1');
    return { ok: true, sessionId: 's1', costUsd: 0.1, structured: { status: 'done', summary: 'login.ts written' } };
  };
  const { office, store } = setup(run);
  agentId = office.hire({ title: 'Software Engineer', jobDescription: 'code' }).id;
  await office.chat('build login');
  assert.equal(store.state.tasks.length, 1, 'bogus agent ignored');
  await wait(() => store.state.questions.length === 1);
  assert.equal(store.state.tasks[0].status, 'waiting_input');
  assert.ok(store.state.chat.some((m) => m.from === 'boss' && m.text.includes('OAuth or password?')));
  office.answer(store.state.questions[0].id, 'password');
  await wait(() => store.state.tasks[0].status === 'done');
  assert.equal(store.state.tasks[0].costUsd, 0.2);
  await wait(() => store.state.chat.some((m) => m.from === 'agent' && m.text.includes('login.ts written')));
  assert.equal(workerCalls, 2);
  assert.equal(bossCalls, 1, 'completion did not trigger another Boss run');
});

test('one task at a time per agent; cancel frees the queue', async () => {
  const run: ClaudeRunner = async (o) => {
    if (o.tools === '') return { ok: true, costUsd: 0, structured: { reply: 'ok', delegations: [] } };
    await new Promise((r) => setTimeout(r, 30));
    return { ok: true, costUsd: 0, structured: { status: 'done', summary: 'ok' } };
  };
  const { office, store } = setup(run);
  const a = office.hire({ title: 'Dev', jobDescription: 'x' });
  const t1 = office.createTask(a.id, 't1', 'x');
  const t2 = office.createTask(a.id, 't2', 'x');
  await wait(() => t1.status === 'running');
  assert.equal(t2.status, 'queued');
  await wait(() => t2.status === 'done');
  assert.equal(store.state.tasks.filter((t) => t.status === 'done').length, 2);
});

test('dependent tasks wait, receive prerequisite results, and cancel if a prerequisite fails', async () => {
  const prompts: Record<string, string> = {};
  const run: ClaudeRunner = async (o) => {
    if (o.tools === '') return { ok: true, costUsd: 0.01, inputTokens: 5, outputTokens: 2, structured: { reply: 'ok', delegations: [] } };
    const m = o.prompt.match(/behalf of Akhil: (.+)/)![1];
    prompts[m] = o.prompt;
    assert.ok(['WebSearch', 'WebFetch', 'Skill', 'Bash(node:*)'].every((t) => o.allowedTools?.includes(t)));
    if (m === 'bad') return { ok: true, costUsd: 0, structured: { status: 'failed', summary: 'nope' } };
    return { ok: true, costUsd: 0, structured: { status: 'done', summary: `${m} result` } };
  };
  const { office, store } = setup(run);
  const a = office.hire({ title: 'Product Manager', jobDescription: 'x' }).id;
  const b = office.hire({ title: 'Software Engineer', jobDescription: 'x' }).id;
  const c = office.hire({ title: 'QA Engineer', jobDescription: 'x' }).id;
  const [spec, build, qa] = office.createBatch([
    { key: 'spec', agentId: a, title: 'spec', instructions: 'x' },
    { key: 'build', agentId: b, title: 'build', instructions: 'x', dependsOn: ['spec'] },
    { key: 'qa', agentId: c, title: 'qa', instructions: 'x', dependsOn: ['build'] },
  ]);
  assert.equal(build.status, 'blocked');
  await wait(() => qa.status === 'done');
  assert.ok(prompts['build'].includes('spec result'));
  assert.ok(prompts['qa'].includes('build result'));
  assert.equal(spec.status, 'done');

  const [bad, after] = office.createBatch([
    { key: 'bad', agentId: b, title: 'bad', instructions: 'x' },
    { key: 'after', agentId: c, title: 'after', instructions: 'x', dependsOn: ['bad'] },
  ]);
  await wait(() => after.status === 'cancelled');
  assert.equal(bad.status, 'failed');
  assert.ok(store.state.usage.calls > 0 && store.state.usage.costUsd > 0);
});

test('a failed task cancels its whole chain with ONE Boss call; prompts stay lean', async () => {
  const bossEvents: string[] = [];
  const prompts: string[] = [];
  const run: ClaudeRunner = async (o) => {
    if (o.tools === '') { bossEvents.push(o.prompt); return { ok: true, costUsd: 0, structured: { reply: 'ok', delegations: [] } }; }
    prompts.push(o.prompt);
    if (/behalf of Akhil: root/.test(o.prompt)) return { ok: true, costUsd: 0, structured: { status: 'done', summary: 'R'.repeat(5000) } };
    if (/behalf of Akhil: bad/.test(o.prompt)) return { ok: true, costUsd: 0, structured: { status: 'failed', summary: 'nope' } };
    return { ok: true, costUsd: 0, structured: { status: 'done', summary: 'ok' } };
  };
  const { office, store } = setup(run);
  const a = office.hire({ title: 'Software Engineer', jobDescription: 'x' }).id;
  const b = office.hire({ title: 'QA Engineer', jobDescription: 'x' }).id;
  const [root, child] = office.createBatch([
    { key: 'root', agentId: a, title: 'root', instructions: 'x' },
    { key: 'child', agentId: b, title: 'child', instructions: 'x', dependsOn: ['root'] },
  ]);
  await wait(() => child.status === 'done');
  const dep = prompts.find((p) => /behalf of Akhil: child/.test(p))!;
  assert.ok(dep.length < 2500 && dep.includes('shortened'), 'long prerequisite results are clipped');
  assert.ok(!dep.includes('Teammates:'), 'workers are not sent the teammate list');
  const [bad, c1, c2, c3] = office.createBatch([
    { key: 'bad', agentId: a, title: 'bad', instructions: 'x' },
    { key: 'c1', agentId: b, title: 'c1', instructions: 'x', dependsOn: ['bad'] },
    { key: 'c2', agentId: b, title: 'c2', instructions: 'x', dependsOn: ['c1'] },
    { key: 'c3', agentId: b, title: 'c3', instructions: 'x', dependsOn: ['c2'] },
  ]);
  await wait(() => c3.status === 'cancelled');
  await wait(() => bossEvents.some((e) => e.includes('were cancelled')));
  await new Promise((r) => setTimeout(r, 400));
  const cascades = bossEvents.filter((e) => e.includes('were cancelled'));
  assert.equal(cascades.length, 1);
  assert.ok(['c1', 'c2', 'c3'].every((n) => cascades[0].includes(`"${n}"`)));
  assert.equal(bad.status, 'failed');
  assert.ok(root && c1 && c2 && store);
  assert.ok(prompts.every((p) => !p.includes('Teammates:')));
});

test('manager plan creates ordered subtasks; release team and manager are detected', async () => {
  let ids: string[] = [];
  const run: ClaudeRunner = async (o) => {
    if (o.tools === '') return { ok: true, costUsd: 0, structured: { reply: 'ok', delegations: [] } };
    if (o.prompt.includes('Ship feature') && !o.prompt.includes('Original goal:')) {
      assert.ok(o.prompt.includes('subtasks'));
      return { ok: true, costUsd: 0, structured: { status: 'done', summary: 'planned', subtasks: [
        { key: 'a', agentId: ids[0], title: 'build', instructions: 'x' },
        { key: 'b', agentId: ids[1], title: 'release', instructions: 'x', dependsOn: ['a'] },
      ] } };
    }
    return { ok: true, costUsd: 0, structured: { status: 'done', summary: 'ok' } };
  };
  const { office, store } = setup(run);
  const mgr = office.hire({ title: 'Project Manager', jobDescription: 'plans' });
  const dev = office.hire({ title: 'Software Engineer', jobDescription: 'x' });
  const rel = office.hire({ title: 'Release Manager', jobDescription: 'ci/cd' });
  assert.equal(mgr.kind, 'manager');
  assert.equal(rel.kind, 'worker');
  assert.equal(rel.team, 'Release');
  ids = [dev.id, rel.id];
  office.createTask(mgr.id, 'Ship feature', 'go');
  await wait(() => store.state.tasks.length === 4 && store.state.tasks.every((t) => t.status === 'done'));
  assert.equal(store.state.tasks[3].review, true, 'the manager reviews once the plan settles');
  assert.deepEqual(store.state.tasks[2].dependsOn, [store.state.tasks[1].id]);
});

test('loads state saved by an older version', async () => {
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const f = join(mkdtempSync(join(tmpdir(), 'old-')), 'office.json');
  writeFileSync(f, JSON.stringify({ agents: [{ id: 'a', name: 'A', title: 'Dev', team: 'Engineering', jobDescription: 'x', model: 'm', skills: [], hiredAt: '' }], tasks: [{ id: 't', agentId: 'a', title: 't', instructions: 'x', status: 'running', costUsd: 0, createdAt: '', updatedAt: '' }], questions: [], chat: [] }));
  const store = new Store(f);
  const run: ClaudeRunner = async () => ({ ok: true, costUsd: 0, structured: { status: 'done', summary: 'ok' } });
  new Office({ store, run, workspace: join(tmpdir(), 'office-test-ws'), permissionMode: 'acceptEdits' });
  await wait(() => store.state.tasks[0].status === 'done');
  assert.equal(store.state.agents[0].kind, 'worker');
  assert.ok(store.state.usage.calls >= 1);
});

test('workspace can be switched; tasks keep the folder they started in', async () => {
  const { mkdtempSync } = await import('node:fs');
  const a = mkdtempSync(join(tmpdir(), 'ws-a-'));
  const b = mkdtempSync(join(tmpdir(), 'ws-b-'));
  const cwds: string[] = [];
  const run: ClaudeRunner = async (o) => {
    if (o.tools !== '') cwds.push(o.cwd);
    return { ok: true, costUsd: 0, structured: o.tools === '' ? { reply: 'ok', delegations: [] } : { status: 'done', summary: 'ok' } };
  };
  const { office, store } = setup(run);
  const id = office.hire({ title: 'Software Engineer', jobDescription: 'code' }).id;
  assert.throws(() => office.setWorkspace(join(a, 'missing')));
  office.setWorkspace(a);
  office.createTask(id, 't1', 'x');
  await wait(() => store.state.tasks[0].status === 'done');
  office.setWorkspace(b);
  office.createTask(id, 't2', 'x');
  await wait(() => store.state.tasks[1].status === 'done');
  assert.deepEqual(cwds, [a, b]);
  assert.equal(store.state.workspace, b);
  assert.equal(office.browse(a).path, a);
});

test('worker calls receive the 250k auto-compact threshold by default', async () => {
  const seen: (number | undefined)[] = [];
  const run: ClaudeRunner = async (o) => {
    seen.push(o.autoCompact);
    return { ok: true, costUsd: 0, structured: o.tools === '' ? { reply: 'ok', delegations: [] } : { status: 'done', summary: 'ok' } };
  };
  const { office, store } = setup(run);
  const id = office.hire({ title: 'Software Engineer', jobDescription: 'code' }).id;
  office.createTask(id, 't', 'x');
  await wait(() => store.state.tasks[0].status === 'done');
  await wait(() => seen.length >= 1);
  assert.ok(seen.every((n) => n === 250000));
  assert.deepEqual(buildArgs({ prompt: '', model: 'm', cwd: '.', autoCompact: 250000 }).slice(-2), ['--autocompact', '250000']);
});

test('Boss and each agent can use their own Claude model; empty follows the session; each provider has its own', async () => {
  const seen: string[] = [];
  const claude: ClaudeRunner = async (o) => {
    seen.push(`${o.tools === '' ? 'boss' : 'worker'}:${o.model}`);
    return { ok: true, costUsd: 0, structured: o.tools === '' ? { reply: 'ok', delegations: [] } : { status: 'done', summary: 'ok' } };
  };
  const store = new Store(null);
  const office = new Office({ store, run: claude, runOpenai: claude, workspace: join(tmpdir(), 'office-test-ws'), permissionMode: 'acceptEdits' });
  const cheap = office.hire({ title: 'QA Engineer', jobDescription: 'tests', model: 'haiku' });
  const plain = office.hire({ title: 'Developer', jobDescription: 'code' });
  office.setSettings({ bossModel: 'haiku' });
  await office.chat('hi');
  office.createTask(cheap.id, 'a', 'x');
  office.createTask(plain.id, 'b', 'x');
  await wait(() => store.state.tasks.every((t) => t.status === 'done'));
  assert.ok(seen.includes('boss:haiku'));
  assert.ok(seen.includes('worker:haiku'));
  assert.ok(seen.includes('worker:claude-sonnet-5-5'));
  office.setAgentModel(plain.id, 'opus');
  assert.equal(store.state.agents.find((a) => a.id === plain.id)!.model, 'opus');
  assert.throws(() => office.setAgentModel('nope', 'x'));
  office.setSettings({ bossModel: '' });
  seen.length = 0;
  await office.chat('again');
  assert.ok(seen.includes('boss:claude-sonnet-5-5'));
  office.setSettings({ provider: 'openai', openaiModel: 'gpt-x' });
  office.createTask(cheap.id, 'c', 'x');
  await wait(() => store.state.tasks[2].status === 'done');
  assert.ok(seen.includes('worker:gpt-x'), 'Claude overrides do not leak into OpenAI runs');
  office.setAgentModel(cheap.id, 'gpt-mini');
  office.setSettings({ bossOpenaiModel: 'gpt-boss' });
  seen.length = 0;
  await office.chat('openai boss');
  office.createTask(cheap.id, 'd', 'x');
  await wait(() => store.state.tasks[3].status === 'done');
  assert.ok(seen.includes('boss:gpt-boss'));
  assert.ok(seen.includes('worker:gpt-mini'));
  assert.equal(store.state.agents.find((a) => a.id === cheap.id)!.model, 'haiku', 'Claude choice is kept');
});

test('only pinned skills reach a Claude worker, inlined in its system prompt', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const home = mkdtempSync(join(tmpdir(), 'skills-home-'));
  mkdirSync(join(home, '.claude', 'skills', 'alpha'), { recursive: true });
  mkdirSync(join(home, '.claude', 'skills', 'beta'), { recursive: true });
  writeFileSync(join(home, '.claude', 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: A\n---\nALPHA-BODY');
  writeFileSync(join(home, '.claude', 'skills', 'beta', 'SKILL.md'), '---\nname: beta\ndescription: B\n---\nBETA-BODY');
  const seen: RunOptions[] = [];
  const store = new Store(null);
  const run: ClaudeRunner = async (o) => { seen.push(o); return { ok: true, costUsd: 0, structured: { status: 'done', summary: 'ok' } }; };
  const office = new Office({ store, run, workspace: join(tmpdir(), 'office-test-ws'), permissionMode: 'acceptEdits', skillsHome: home });
  const a = office.hire({ title: 'Developer', jobDescription: 'code' });
  office.createTask(a.id, 'one', 'x');
  await wait(() => store.state.tasks[0].status === 'done');
  assert.ok(!seen[0].appendSystemPrompt!.includes('ALPHA-BODY'), 'no skills by default');
  office.setAgentSkills(a.id, ['alpha', 'missing', 'alpha']);
  assert.deepEqual(store.state.agents[0].skills, ['alpha', 'missing']);
  office.createTask(a.id, 'two', 'x');
  await wait(() => store.state.tasks[1].status === 'done');
  const sys = seen[1].appendSystemPrompt!;
  assert.ok(sys.includes('ALPHA-BODY') && !sys.includes('BETA-BODY'));
  assert.ok(sys.includes('missing') && sys.includes('not installed'));
  assert.throws(() => office.setAgentSkills(a.id, 'x' as any));
  assert.throws(() => office.setAgentSkills('nope', []));
  assert.ok(buildArgs({ prompt: '', model: 'm', cwd: '.', disableSlashCommands: true }).includes('--disable-slash-commands'));
});

test('every Claude run is lean: no MCP servers, scoped settings, workers get an explicit tool list', async () => {
  const a = buildArgs({ prompt: '', model: 'm', cwd: '.' });
  assert.ok(a.includes('--strict-mcp-config'));
  assert.equal(a[a.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  assert.equal(a[a.indexOf('--setting-sources') + 1], 'project');
  assert.ok(a.includes('--exclude-dynamic-system-prompt-sections'));
  assert.equal(buildArgs({ prompt: '', model: 'm', cwd: '.', settingSources: 'user,project' })[buildArgs({ prompt: '', model: 'm', cwd: '.', settingSources: 'user,project' }).indexOf('--setting-sources') + 1], 'user,project');
  const seen: RunOptions[] = [];
  const { office, store } = setup(async (o) => { seen.push(o); return { ok: true, structured: o.schema ? { status: 'done', summary: 'ok', reply: 'ok', delegations: [] } : undefined, costUsd: 0 }; });
  const id = office.hire({ title: 'Software Engineer', jobDescription: 'code' }).id;
  office.createTask(id, 't', 'x');
  await wait(() => store.state.tasks[0].status === 'done');
  const w = seen.find((o) => o.appendSystemPrompt)!;
  assert.equal(w.tools, 'Bash,Read,Edit,Write,Glob,Grep,WebSearch,WebFetch');
  assert.equal(w.settingSources, 'project');
  assert.equal(w.disableSlashCommands, true);
});

test('usage records each run with role, cache counts, resume state and observed compaction', async () => {
  let workerRuns = 0;
  const run: ClaudeRunner = async (o) => {
    if (o.tools === '') return { ok: true, costUsd: 0.01, inputTokens: 20, outputTokens: 2, structured: o.systemPrompt?.includes('TRIAGE MODE') ? { answer: '', question: 'Which one?' } : { reply: 'ok', delegations: [] } };
    workerRuns++;
    return workerRuns === 1
      ? { ok: true, sessionId: 'resume-me', costUsd: 0.02, inputTokens: 100, outputTokens: 10, cacheReadTokens: 80, cacheCreationTokens: 5, structured: { status: 'needs_input', question: 'Which one?' } }
      : { ok: true, costUsd: 0.03, inputTokens: 120, outputTokens: 12, cacheReadTokens: 90, compactionObserved: true, structured: { status: 'done', summary: 'done' } };
  };
  const { office, store } = setup(run);
  const agent = office.hire({ title: 'Engineer', jobDescription: 'build' });
  await office.chat('hello');
  const task = office.createTask(agent.id, 'Build', 'do it');
  await wait(() => task.status === 'waiting_input');
  office.answer(store.state.questions[0].id, 'the first');
  await wait(() => task.status === 'done');
  const runs = store.state.usage.runs!;
  assert.deepEqual(runs.map((r) => [r.role, r.resumed]), [['boss', false], ['worker', false], ['boss', false], ['worker', true]]);
  assert.equal(runs[1].taskId, task.id);
  assert.equal(runs[1].cacheReadTokens, 80);
  assert.equal(runs[1].cacheCreationTokens, 5);
  assert.equal(runs[3].compactionObserved, true);
});

test('a long worker task continues from a checkpoint in a fresh run', async () => {
  const calls: RunOptions[] = [];
  const run: ClaudeRunner = async (o) => {
    calls.push(o);
    if (calls.length === 1) return { ok: true, sessionId: 'old-session', costUsd: 0, structured: { status: 'continue', summary: 'Edited src/app.ts; run tests next.' } };
    return { ok: true, costUsd: 0, structured: { status: 'done', summary: 'Tests passed.' } };
  };
  const { office, store } = setup(run);
  const task = office.createTask(office.hire({ title: 'Engineer', jobDescription: 'build' }).id, 'Long task', 'implement');
  await wait(() => task.status === 'done');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].resume, undefined);
  assert.match(calls[1].prompt, /Edited src\/app.ts; run tests next/);
  assert.equal(task.checkpointCount, 1);
  assert.equal(store.state.usage.runs?.length, 2);
});

test('plan limits from the CLI are merged and stored', async () => {
  const info = { unifiedWindows: { five_hour: { utilization: 0.49, resetsAt: 100 }, seven_day: { utilization: 0.06, resetsAt: 200 } } };
  assert.deepEqual(mergeLimits(undefined, info), { five_hour: { utilization: 0.49, resetsAt: 100 }, seven_day: { utilization: 0.06, resetsAt: 200 } });
  assert.equal(mergeLimits(undefined, {}), undefined);
  const run: ClaudeRunner = async () => ({ ok: true, costUsd: 0, structured: { reply: 'ok', delegations: [] }, limits: mergeLimits(undefined, info) });
  const { office, store } = setup(run);
  await office.chat('hi');
  assert.equal(store.state.limits?.five_hour?.utilization, 0.49);
});

test('every agent can use the web, even with a custom tool list', async () => {
  const seen: string[][] = [];
  const run: ClaudeRunner = async (o) => {
    if (o.tools !== '') seen.push(o.allowedTools ?? []);
    return { ok: true, costUsd: 0, structured: o.tools === '' ? { reply: 'ok', delegations: [] } : { status: 'done', summary: 'ok' } };
  };
  const store = new Store(null);
  const office = new Office({ store, run, workspace: join(tmpdir(), 'office-test-ws'), permissionMode: 'acceptEdits', allowedTools: ['Bash(ls:*)'] });
  office.createTask(office.hire({ title: 'Software Engineer', jobDescription: 'code' }).id, 't', 'x');
  await wait(() => store.state.tasks[0].status === 'done');
  assert.ok(seen[0].includes('WebSearch') && seen[0].includes('WebFetch') && seen[0].includes('Bash(ls:*)'));
});

test('live activity is recorded on the running task and trimmed when it finishes', async () => {
  const { describeEvent } = await import('../server/claude.ts');
  const items = describeEvent({ message: { content: [{ type: 'thinking', thinking: '' }, { type: 'tool_use', name: 'Read', input: { file_path: '/a/b.ts' } }, { type: 'text', text: '  Looking  at it ' }] } });
  assert.deepEqual(items.map((i) => [i.kind, i.text]), [['tool', 'Read /a/b.ts'], ['text', 'Looking at it']]);
  let seenMid = 0;
  const run: ClaudeRunner = async (o) => {
    if (o.tools === '') return { ok: true, costUsd: 0, structured: { reply: 'ok', delegations: [] } };
    for (let i = 0; i < 14; i++) o.onActivity?.(items);
    seenMid = store.state.tasks[0].activity?.length ?? 0;
    return { ok: true, costUsd: 0, structured: { status: 'done', summary: 'ok' } };
  };
  const { office, store } = setup(run);
  office.createTask(office.hire({ title: 'Software Engineer', jobDescription: 'code' }).id, 't', 'x');
  await wait(() => store.state.tasks[0].status === 'done');
  assert.equal(seenMid, 28);
  assert.equal(store.state.tasks[0].activity?.length, 10);
  assert.ok(store.state.tasks[0].startedAt);
});

test('plan dependencies resolve in any order, by key, title or agent name; bad ones are reported', async () => {
  const gate: { release?: () => void } = {};
  const run: ClaudeRunner = async (o) => {
    if (o.tools === '') return { ok: true, costUsd: 0, structured: { reply: 'ok', delegations: [] } };
    await new Promise<void>((r) => (gate.release = r));
    return { ok: true, costUsd: 0, structured: { status: 'done', summary: 'ok' } };
  };
  const { office, store } = setup(run);
  const maya = office.hire({ name: 'Maya', title: 'Marketing Manager', jobDescription: 'x' }).id;
  const priya = office.hire({ name: 'Priya', title: 'Product Manager', jobDescription: 'x' }).id;
  const quinn = office.hire({ name: 'Quinn', title: 'QA Engineer', jobDescription: 'x' }).id;
  // Quinn is listed FIRST and refers to a task by key, one by title, one by agent name, and one that doesn't exist.
  const made = office.createBatch([
    { key: 'audit', agentId: quinn, title: 'Audit', instructions: 'x', dependsOn: ['research', 'Write recommendation', 'nope'] },
    { key: 'research', agentId: maya, title: 'Research', instructions: 'x' },
    { agentId: priya, title: 'Write recommendation', instructions: 'x', dependsOn: ['Maya'] },
  ]);
  const [audit, research, rec] = made;
  assert.deepEqual(audit.dependsOn.sort(), [research.id, rec.id].sort());
  assert.deepEqual(rec.dependsOn, [research.id]);
  assert.equal(audit.status, 'blocked');
  assert.ok(store.state.chat.some((m) => m.from === 'system' && m.text.includes('"nope"')), 'unresolved dependency is reported');
  assert.equal(research.status === 'running' || research.status === 'queued', true);
  gate.release?.();
  await wait(() => store.state.tasks.every((t) => t.status === 'running' || t.status === 'done' || t.status === 'blocked'));
});

test('dependency cycles are broken and reported', () => {
  const { office, store } = setup(async () => ({ ok: true, costUsd: 0 }));
  const a = office.hire({ title: 'Software Engineer', jobDescription: 'x' }).id;
  const b = office.hire({ title: 'QA Engineer', jobDescription: 'x' }).id;
  const [x, y] = office.createBatch([
    { key: 'x', agentId: a, title: 'X', instructions: '', dependsOn: ['y'] },
    { key: 'y', agentId: b, title: 'Y', instructions: '', dependsOn: ['x'] },
  ]);
  assert.ok(x.dependsOn.length + y.dependsOn.length === 1, 'one of the two edges is dropped');
  assert.ok(store.state.chat.some((m) => m.text.includes('wait on each other')));
});

test('a failed task can be retried and starts a fresh run', async () => {
  let n = 0;
  const run: ClaudeRunner = async (o) => {
    if (o.tools === '') return { ok: true, costUsd: 0, structured: { reply: 'ok', delegations: [] } };
    n++;
    assert.equal(o.resume, undefined);
    return n === 1 ? { ok: true, sessionId: 's1', costUsd: 0, structured: { status: 'failed', summary: 'inputs missing' } } : { ok: true, costUsd: 0, structured: { status: 'done', summary: 'ok' } };
  };
  const { office, store } = setup(run);
  const t = office.createTask(office.hire({ title: 'QA Engineer', jobDescription: 'x' }).id, 'Audit', 'x');
  await wait(() => t.status === 'failed');
  assert.throws(() => office.retry('missing'));
  office.retry(t.id);
  await wait(() => t.status === 'done');
  assert.equal(t.error, undefined);
  assert.throws(() => office.retry(t.id), /only failed or cancelled/);
  assert.equal(store.state.tasks.length, 1);
});

test('agents get broad dev tools, secrets/rm/deploy tools are denied, and workspace gets CLAUDE.md', async () => {
  const { mkdtempSync, existsSync, writeFileSync } = await import('node:fs');
  const ws = mkdtempSync(join(tmpdir(), 'office-mem-'));
  const seen: RunOptions[] = [];
  const run = async (o: RunOptions) => {
    seen.push(o);
    return { ok: true, structured: { status: 'done', report: 'ok' }, costUsd: 0 };
  };
  const office = new Office({ store: new Store(null), run, workspace: ws, permissionMode: 'acceptEdits' });
  assert.ok(existsSync(join(ws, 'CLAUDE.md')));
  const other = mkdtempSync(join(tmpdir(), 'office-mem2-'));
  writeFileSync(join(other, 'AGENTS.md'), 'mine');
  office.setWorkspace(other);
  assert.ok(!existsSync(join(other, 'CLAUDE.md')), 'existing instructions are left alone');
  const a = office.hire({ name: 'D', title: 'Software Engineer', team: 'Engineering', jobDescription: 'x' });
  office.createTask(a.id, 't', 'd');
  await new Promise((r) => setTimeout(r, 50));
  const w = seen.find((o) => o.tools !== '');
  assert.ok(w, 'worker ran');
  {
    assert.ok(['Bash(curl:*)', 'Bash(mv:*)', 'Bash(git:*)', 'Bash(pytest:*)', 'Bash(pip:*)'].every((t) => w.allowedTools?.includes(t)));
    assert.ok(['Read(**/.env)', 'Bash(npm publish:*)', 'Bash(rm:*)'].every((t) => w.disallowedTools?.includes(t)));
  }
});

test('release tasks (from "release"/"deploy"/"push" in Akhil\'s message) may deploy; others may not', async () => {
  const { mkdtempSync } = await import('node:fs');
  const seen: RunOptions[] = [];
  const run = async (o: RunOptions) => {
    seen.push(o);
    if (o.tools === '') return { ok: true, structured: { reply: 'ok', delegations: [{ agentId: (globalThis as any).__id, title: 'ship', instructions: 'x' }] }, costUsd: 0 };
    return { ok: true, structured: { status: 'done', report: 'ok' }, costUsd: 0 };
  };
  const office = new Office({ store: new Store(null), run, workspace: mkdtempSync(join(tmpdir(), 'office-rel-')), permissionMode: 'acceptEdits' });
  (globalThis as any).__id = office.hire({ name: 'R', title: 'Software Engineer', team: 'Engineering', jobDescription: 'x' }).id;
  await office.chat('please do this');
  await office.chat('commit and push this');
  await new Promise((r) => setTimeout(r, 100));
  const workers = seen.filter((o) => o.tools !== '');
  assert.equal(workers.length, 2);
  assert.ok(workers[0].disallowedTools?.includes('Bash(vercel:*)') && workers[0].allowedTools?.includes('Bash(git:*)'));
  assert.ok(!workers[1].disallowedTools?.includes('Bash(vercel:*)') && workers[1].allowedTools?.includes('Bash(vercel:*)'));
  assert.ok(workers[1].disallowedTools?.includes('Bash(rm:*)'), 'rm stays denied on release');
});

test('Boss askAkhil items land in the Inbox (deduped) and answers go back to the Boss', async () => {
  const seen: string[] = [];
  const run = async (o: RunOptions) => {
    seen.push(o.prompt);
    return { ok: true, structured: { reply: 'Need two things.', delegations: [], askAkhil: ['Which CA do we use?', 'Which CA do we use?', 'Approve the price?'] }, costUsd: 0 };
  };
  const store = new Store(null);
  const office = new Office({ store, run, workspace: join(tmpdir(), 'office-test-ws'), permissionMode: 'acceptEdits' });
  await office.chat('plan pricing');
  const open = store.state.questions.filter((q) => q.status === 'open');
  assert.equal(open.length, 2);
  assert.ok(open.every((q) => q.agentId === 'boss' && q.taskId === ''));
  assert.match(store.state.chat.at(-1)!.text, /2 items added to your \*\*Inbox\*\*/);
  office.answer(open[0].id, 'Mehta & Co');
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(seen.at(-1)!.includes('Mehta & Co'));
});

test('agents can raise many non-blocking questions to the Inbox while finishing the task', async () => {
  const seen: string[] = [];
  const run = async (o: RunOptions) => {
    seen.push(o.prompt);
    if (o.tools === '') return { ok: true, structured: { reply: 'ok', delegations: [] }, costUsd: 0 };
    return { ok: true, structured: { status: 'done', summary: 'compiled', questions: ['Q1?', 'Q2?', 'Q1?'] }, costUsd: 0 };
  };
  const store = new Store(null);
  const office = new Office({ store, run, workspace: join(tmpdir(), 'office-test-ws'), permissionMode: 'acceptEdits' });
  const a = office.hire({ name: 'P', title: 'Product Manager', team: 'Product', jobDescription: 'x' });
  const t = office.createTask(a.id, 'Raise questions', 'do it');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(t.status, 'done');
  const open = store.state.questions.filter((q) => q.status === 'open');
  assert.deepEqual(open.map((q) => q.text), ['Q1?', 'Q2?']);
  assert.ok(open.every((q) => q.agentId === a.id && q.taskId === t.id));
  office.answer(open[0].id, 'yes');
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(seen.at(-1)!.includes('Answer: yes'));
});

test('the --chrome flag is passed only when a run asks for it', async () => {
  const { buildArgs } = await import('../server/claude.ts');
  assert.ok(buildArgs({ prompt: 'x', model: 'm', cwd: '.', chrome: true }).includes('--chrome'));
  assert.ok(!buildArgs({ prompt: 'x', model: 'm', cwd: '.' }).includes('--chrome'));
});

test('the Boss answers a blocked agent itself; Akhil is asked only when it is his call', async () => {
  const seen: string[] = [];
  const run: ClaudeRunner = async (o) => {
    if (o.tools === '') return { ok: true, costUsd: 0, structured: o.prompt.trimEnd().endsWith('Which db?') ? { answer: 'Use SQLite.' } : { answer: '', question: 'Approve the $500 spend?' } };
    seen.push(o.prompt);
    return seen.length === 1
      ? { ok: true, sessionId: 's', costUsd: 0, structured: { status: 'needs_input', summary: '', question: 'Which db?' } }
      : seen.length === 2 ? { ok: true, costUsd: 0, structured: { status: 'needs_input', summary: '', question: 'Buy it?' } }
      : { ok: true, costUsd: 0, structured: { status: 'done', summary: 'ok' } };
  };
  const { office, store } = setup(run);
  const task = office.createTask(office.hire({ title: 'Engineer', jobDescription: 'build' }).id, 'Build', 'do it');
  await wait(() => store.state.questions.some((q) => q.status === 'open'));
  const [first, second] = store.state.questions;
  assert.equal(first.status, 'answered');
  assert.equal(first.answeredBy, 'boss');
  assert.equal(first.answer, 'Use SQLite.');
  assert.equal(second.text, 'Approve the $500 spend?', 'real owner decision reaches the Inbox');
  assert.equal(task.autoAnswers, 1);
  office.answer(second.id, 'yes');
  await wait(() => task.status === 'done');
  assert.ok(seen[2].includes('yes'), 'the owner answer is passed on (earlier ones live in the resumed session)');
  assert.ok(seen[0].includes('do it') && !seen[0].includes('Do NOT ask'), 'first run has no answer history');
});

test('the Boss clears what it can from an agent\'s question list; the rest reaches the Inbox', async () => {
  const run: ClaudeRunner = async (o) => {
    if (o.tools === '') return { ok: true, costUsd: 0, structured: { answers: ['Use 12 months of fees.', '', ''] } };
    return { ok: true, costUsd: 0, structured: { status: 'done', summary: 'drafted', questions: ['Liability cap?', 'GSTIN', 'Refund policy'] } };
  };
  const { office, store } = setup(run);
  const task = office.createTask(office.hire({ title: 'Legal Counsel', jobDescription: 'law' }).id, 'Draft terms', 'x');
  await wait(() => store.state.questions.length === 3);
  const byText = (t: string) => store.state.questions.find((q) => q.text === t)!;
  assert.equal(byText('Liability cap?').status, 'answered');
  assert.equal(byText('Liability cap?').answeredBy, 'boss');
  assert.equal(byText('GSTIN').status, 'open');
  assert.equal(byText('Refund policy').status, 'open');
  assert.equal(task.status, 'done');
});

test('a manager reviews his plan when its tasks settle, routes more work, and reports completion', async () => {
  let pm = '', dev = '';
  const reviews: string[] = [];
  const run: ClaudeRunner = async (o) => {
    if (o.tools === '') return { ok: true, costUsd: 0, structured: { reply: 'ok', delegations: [] } };
    if (o.prompt.includes('Task from the Boss') && o.prompt.includes('Original goal:')) {
      reviews.push(o.prompt);
      return reviews.length === 1
        ? { ok: true, costUsd: 0, structured: { status: 'done', summary: 'Needs a QA pass.', subtasks: [{ key: 'qa', agentId: dev, title: 'QA pass', instructions: 'test it' }] } }
        : { ok: true, costUsd: 0, structured: { status: 'done', summary: 'Project complete: shipped.' } };
    }
    if (o.prompt.includes('Plan it')) return { ok: true, costUsd: 0, structured: { status: 'done', summary: 'planned', subtasks: [{ key: 'a', agentId: dev, title: 'Build', instructions: 'x' }, { key: 'b', agentId: dev, title: 'Docs', instructions: 'y' }] } };
    return { ok: true, costUsd: 0, structured: { status: 'done', summary: 'ok' } };
  };
  const { office, store } = setup(run);
  pm = office.hire({ title: 'Project Manager', jobDescription: 'plans' }).id;
  dev = office.hire({ title: 'Software Engineer', jobDescription: 'code' }).id;
  office.createTask(pm, 'Ship the thing', 'build and document it');
  await wait(() => store.state.chat.some((m) => m.text.includes('Project complete: shipped.')));
  assert.equal(reviews.length, 2, 'one review per settled wave, none while tasks were still running');
  assert.ok(reviews[0].includes('Build') && reviews[0].includes('Docs'));
  const revs = store.state.tasks.filter((t) => t.review);
  assert.equal(revs.length, 2);
  assert.ok(revs.every((t) => t.agentId === pm && t.status === 'done'));
});

test('answers given together reach the Boss as one event; tasks can wait on an open task by id', async () => {
  const events: string[] = [];
  let devId = '';
  let firstId = '';
  const run: ClaudeRunner = async (o) => {
    if (o.tools === '') {
      events.push(o.prompt);
      return { ok: true, costUsd: 0, structured: { reply: 'ok', delegations: o.prompt.includes('answered') ? [{ agentId: devId, title: 'Follow-up', instructions: 'x', dependsOn: [firstId] }] : [] } };
    }
    await new Promise((r) => setTimeout(r, 60));
    return { ok: true, costUsd: 0, structured: { status: 'done', summary: 'ok' } };
  };
  const { office, store } = setup(run);
  devId = office.hire({ title: 'Engineer', jobDescription: 'x' }).id;
  const first = office.createTask(devId, 'First', 'x');
  firstId = first.id;
  const q = (text: string) => { const x = { id: `q-${text}`, taskId: '', agentId: 'boss', text, status: 'open' as const, createdAt: '' }; store.state.questions.push(x); return x.id; };
  process.env.ANSWER_BATCH_MS = '40';
  office.answer(q('one?'), 'a');
  office.answer(q('two?'), 'b');
  await wait(() => store.state.tasks.length === 2);
  process.env.ANSWER_BATCH_MS = '0';
  assert.equal(events.filter((e) => e.includes('answered')).length, 1, 'two answers, one Boss run');
  const follow = store.state.tasks[1];
  assert.deepEqual(follow.dependsOn, [firstId], 'waits for the open task');
  assert.equal(follow.status, 'blocked');
  await wait(() => follow.status === 'done');
});

test('a Project Manager settles a blocked question: reads files, asks a teammate, and owner decisions or repeats reach Akhil', async () => {
  let lena = '', dev = '';
  const triage: RunOptions[] = [];
  const devPrompts: string[] = [];
  const run: ClaudeRunner = async (o) => {
    if (o.systemPrompt?.includes('TRIAGE MODE')) {
      triage.push(o);
      const q = o.prompt.trimEnd();
      if (q.endsWith('Which legal text?')) return { ok: true, costUsd: 0, structured: { action: 'ask_teammate', teammateId: lena, teammateTask: 'Write the clause.' } };
      if (q.endsWith('Approve spend?')) return { ok: true, costUsd: 0, structured: { action: 'answer', answer: 'Yes', ownerDecision: true, question: 'Approve the spend?' } };
      return { ok: true, costUsd: 0, structured: { action: 'answer', answer: 'Use Postgres.' } };
    }
    if (o.tools === '') return { ok: true, costUsd: 0, structured: { reply: 'ok', delegations: [] } };
    if (o.prompt.includes('Answer for')) return { ok: true, costUsd: 0, structured: { status: 'done', summary: 'CLAUSE TEXT' } };
    devPrompts.push(o.prompt);
    const q = ['Which db?', 'Which legal text?', 'Approve spend?', 'Which db?'][devPrompts.length - 1];
    return q ? { ok: true, sessionId: 's', costUsd: 0, structured: { status: 'needs_input', summary: '', question: q } } : { ok: true, costUsd: 0, structured: { status: 'done', summary: 'ok' } };
  };
  const { office, store } = setup(run);
  office.hire({ title: 'Project Manager', jobDescription: 'plans' });
  lena = office.hire({ title: 'Legal Counsel', jobDescription: 'law' }).id;
  dev = office.hire({ title: 'Software Engineer', jobDescription: 'code' }).id;
  const task = office.createTask(dev, 'Build', 'do it');
  await wait(() => store.state.questions.some((q) => q.status === 'open'));
  const qs = store.state.questions;
  assert.equal(triage[0].tools, 'Read,Glob,Grep', 'the PM triages with read-only tools');
  assert.ok(triage[0].systemPrompt!.includes('Project Manager'));
  assert.equal(qs.find((q) => q.text === 'Which db?')!.answeredBy, 'pm');
  assert.equal(qs.find((q) => q.text === 'Which legal text?')!.answer, 'CLAUSE TEXT', 'the teammate result became the answer');
  assert.ok(devPrompts[2].includes('CLAUSE TEXT'));
  const spend = qs.find((q) => q.text === 'Approve the spend?')!;
  assert.equal(spend.status, 'open', 'owner decisions are never auto-answered');
  assert.equal(devPrompts.length, 3);
  office.answer(spend.id, 'approved');
  // The dev then repeats its first question: it goes straight to Akhil, with no further PM call.
  await wait(() => store.state.questions.filter((q) => q.status === 'open').length === 1 && devPrompts.length === 4);
  const triageCalls = triage.length;
  const again = store.state.questions.find((q) => q.status === 'open')!;
  assert.equal(again.text, 'Which db?');
  assert.equal(triage.length, triageCalls);
  assert.equal(task.status, 'waiting_input');
});

test("Akhil's answer to a non-blocking item goes to the Project Manager as one task", async () => {
  const run: ClaudeRunner = async (o) => {
    if (o.tools === '') return { ok: true, costUsd: 0, structured: { reply: 'ok', delegations: [], answers: [''] } };
    return { ok: true, costUsd: 0, structured: { status: 'done', summary: 'ok', questions: ['GSTIN?'] } };
  };
  const { office, store } = setup(run);
  const pm = office.hire({ title: 'Project Manager', jobDescription: 'plans' });
  const dev = office.hire({ title: 'Software Engineer', jobDescription: 'code' });
  office.createTask(dev.id, 'Build', 'x');
  await wait(() => store.state.questions.some((q) => q.status === 'open'));
  office.answer(store.state.questions[0].id, 'not registered');
  await wait(() => store.state.tasks.some((t) => t.agentId === pm.id && t.title === "Apply Akhil's answers"));
  const t = store.state.tasks.find((x) => x.agentId === pm.id)!;
  assert.ok(t.instructions.includes('not registered'));
});

test('resetUsage clears totals and the run log but keeps tasks', async () => {
  const run: ClaudeRunner = async () => ({ ok: true, costUsd: 0.5, inputTokens: 10, outputTokens: 5, structured: { status: 'done', summary: 'ok' } });
  const { office, store } = setup(run);
  const task = office.createTask(office.hire({ title: 'Engineer', jobDescription: 'x' }).id, 'T', 'x');
  await wait(() => task.status === 'done');
  assert.ok(store.state.usage.calls > 0 && store.state.usage.runs!.length > 0);
  office.resetUsage();
  assert.deepEqual(store.state.usage, { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, byDay: {}, runs: [] });
  assert.equal(store.state.tasks.length, 1);
});

test('MEMORY.md is seeded and its facts are put in worker prompts', async () => {
  const { mkdtempSync, existsSync, readFileSync, writeFileSync } = await import('node:fs');
  const ws = mkdtempSync(join(tmpdir(), 'office-brain-'));
  const prompts: string[] = [];
  const run = async (o: RunOptions) => {
    if (o.tools !== '') prompts.push(o.prompt);
    return { ok: true, structured: { status: 'done', report: 'ok' }, costUsd: 0 };
  };
  const office = new Office({ store: new Store(null), run, workspace: ws, permissionMode: 'acceptEdits' });
  assert.ok(existsSync(join(ws, 'MEMORY.md')));
  assert.match(readFileSync(join(ws, 'CLAUDE.md'), 'utf8'), /MEMORY\.md/);
  const a = office.hire({ name: 'D', title: 'Software Engineer', team: 'Engineering', jobDescription: 'x' });
  office.createTask(a.id, 't1', 'd');
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!prompts[0].includes('Shared memory ('), 'empty template adds nothing');
  writeFileSync(join(ws, 'MEMORY.md'), readFileSync(join(ws, 'MEMORY.md'), 'utf8') + '- Brand voice is casual\n');
  office.createTask(a.id, 't2', 'd');
  await new Promise((r) => setTimeout(r, 50));
  assert.match(prompts[1], /Shared memory[\s\S]*Brand voice is casual/);
});
