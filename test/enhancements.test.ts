import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { Store } from '../server/store.ts';
import { Office, isOwnerTopic, isDeferral } from '../server/office.ts';
import { describeTool, type ClaudeRunner } from '../server/claude.ts';
import { unquote } from '../server/skills.ts';
import { openOnHost } from '../server/files.ts';

const wait = async (fn: () => boolean) => {
  for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(fn(), 'condition not met');
};
function setup(run: ClaudeRunner) {
  const store = new Store(null);
  const office = new Office({ store, run, workspace: join(tmpdir(), 'office-test-ws'), permissionMode: 'acceptEdits' });
  return { store, office };
}
const worker = (summary = 'ok', cost = 0): ClaudeRunner => async (o) => (o.tools === '' ? { ok: true, costUsd: 0, structured: { reply: 'ok', delegations: [] } } : { ok: true, costUsd: cost, structured: { status: 'done', summary } });

test('YAML quotes in skill descriptions are decoded', () => {
  assert.equal(unquote("'the implementer''s view'"), "the implementer's view");
  assert.equal(unquote('"say \\"hi\\""'), 'say "hi"');
  assert.equal(unquote('plain text'), 'plain text');
});

test('owner topics and deferrals are recognised', () => {
  assert.ok(isOwnerTopic('Pricing: is PlateMate free?'));
  assert.ok(isOwnerTopic('Can we use this license?'));
  assert.ok(!isOwnerTopic('Which colour for the button?'));
  assert.ok(isDeferral('Pricing is a business decision only Akhil can make, so I can\'t confirm it.'));
  assert.ok(!isDeferral('Use blue.'));
});

test('a money question is escalated to the Inbox even when the PM would answer it', async () => {
  const run: ClaudeRunner = async (o) => {
    if (o.systemPrompt?.includes('TRIAGE MODE')) return { ok: true, costUsd: 0, structured: { action: 'answer', answer: 'Make it free.' } };
    if (o.tools === '') return { ok: true, costUsd: 0, structured: { reply: 'ok', delegations: [] } };
    return { ok: true, sessionId: 's', costUsd: 0, structured: { status: 'needs_input', summary: '', question: 'What pricing should we state?' } };
  };
  const { office, store } = setup(run);
  const a = office.hire({ title: 'Marketing Manager', jobDescription: 'x' });
  office.createTask(a.id, 'copy', 'x');
  await wait(() => store.state.questions.length === 1);
  assert.equal(store.state.questions[0].status, 'open');
  assert.equal(store.state.questions[0].answeredBy, undefined);
});

test('an "answer" that only defers to Akhil is escalated, not recorded as answered', async () => {
  const run: ClaudeRunner = async (o) => {
    if (o.systemPrompt?.includes('TRIAGE MODE')) return { ok: true, costUsd: 0, structured: { action: 'answer', answer: 'Only Akhil can decide this.' } };
    if (o.tools === '') return { ok: true, costUsd: 0, structured: { reply: 'ok', delegations: [] } };
    return { ok: true, sessionId: 's', costUsd: 0, structured: { status: 'needs_input', summary: '', question: 'Which colour scheme?' } };
  };
  const { office, store } = setup(run);
  const a = office.hire({ title: 'Software Engineer', jobDescription: 'x' });
  office.createTask(a.id, 'ui', 'x');
  await wait(() => store.state.questions.length === 1);
  assert.equal(store.state.questions[0].status, 'open');
});

test('@Name messages go straight to that agent without a Boss call', async () => {
  let bossCalls = 0;
  const run: ClaudeRunner = async (o) => {
    if (o.tools === '') { bossCalls++; return { ok: true, costUsd: 0, structured: { reply: 'ok', delegations: [] } }; }
    return { ok: true, costUsd: 0, structured: { status: 'done', summary: 'fixed' } };
  };
  const { office, store } = setup(run);
  const a = office.hire({ name: 'Dev', title: 'Software Engineer', jobDescription: 'x' });
  await office.chat('@dev please fix the footer');
  assert.equal(store.state.tasks.length, 1);
  assert.equal(store.state.tasks[0].agentId, a.id);
  assert.equal(store.state.tasks[0].instructions, 'please fix the footer');
  await wait(() => store.state.tasks[0].status === 'done');
  assert.equal(bossCalls, 0);
  await office.chat('@nobody hello');
  assert.equal(store.state.tasks.length, 1, 'unknown names still go to the Boss');
});

test('the budget cap stops new tasks until it is raised', async () => {
  const { office, store } = setup(worker('ok', 0.1));
  const a = office.hire({ title: 'Dev', jobDescription: 'x' });
  office.setSettings({ budgetUsd: 0.05 });
  const t1 = office.createTask(a.id, 't1', 'x');
  const t2 = office.createTask(a.id, 't2', 'x');
  await wait(() => t1.status === 'done');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(t2.status, 'queued');
  assert.ok(store.state.chat.some((m) => m.text.includes('Budget of $0.05 reached')));
  office.setSettings({ budgetUsd: 5 });
  await wait(() => t2.status === 'done');
  assert.throws(() => office.setSettings({ budgetUsd: -1 }), /invalid budgetUsd/);
});

test('pause holds new tasks and resume releases them', async () => {
  const { office } = setup(worker());
  const a = office.hire({ title: 'Dev', jobDescription: 'x' });
  office.setSettings({ paused: true });
  const t = office.createTask(a.id, 't', 'x');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(t.status, 'queued');
  office.setSettings({ paused: false });
  await wait(() => t.status === 'done');
});

test('a wave that only applied answers gets no follow-up review', async () => {
  const run: ClaudeRunner = async (o) => {
    if (o.tools === '') return { ok: true, costUsd: 0, structured: { reply: 'ok', delegations: [] } };
    if (o.prompt.includes("Apply Akhil's answers")) return { ok: true, costUsd: 0, structured: { status: 'done', summary: 'applied', subtasks: [{ key: 'a', agentId: dev, title: 'Tweak copy', instructions: 'x' }] } };
    return { ok: true, costUsd: 0, structured: { status: 'done', summary: 'ok' } };
  };
  const { office, store } = setup(run);
  const pm = office.hire({ title: 'Project Manager', jobDescription: 'plans', kind: 'manager' });
  var dev = office.hire({ title: 'Software Engineer', jobDescription: 'x' }).id;
  office.createTask(pm.id, "Apply Akhil's answers", 'x');
  await wait(() => store.state.tasks.some((t) => t.title === 'Tweak copy' && t.status === 'done'));
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(!store.state.tasks.some((t) => t.review), 'no review task was created');
});

test('tool descriptions include the action and text of browser tools', () => {
  assert.equal(describeTool('mcp__claude-in-chrome__computer', { action: 'left_click' }), 'mcp__claude-in-chrome__computer left_click');
  assert.equal(describeTool('mcp__claude-in-chrome__javascript_tool', { text: 'document.title' }), 'mcp__claude-in-chrome__javascript_tool document.title');
});

test('openOnHost refuses programs, folders for open, and paths outside the workspace', () => {
  const ws = mkdtempSync(join(tmpdir(), 'open-ws-'));
  writeFileSync(join(ws, 'run.sh'), 'echo hi');
  assert.throws(() => openOnHost(ws, 'run.sh', 'open'), /can't be opened/);
  assert.throws(() => openOnHost(ws, '../etc/passwd', 'open'), /outside the workspace|not found/);
});

test('a plan with no dependsOn is ordered: spec, then build, QA, fix, retest', async () => {
  const ids: Record<string, string> = {};
  const run: ClaudeRunner = async (o) => {
    if (o.tools === '') return { ok: true, costUsd: 0, structured: { reply: 'ok', delegations: [] } };
    if (o.prompt.includes('GOAL')) return { ok: true, costUsd: 0, structured: { status: 'done', summary: 'planned', subtasks: [
      { key: 'qa2', agentId: ids.qa, title: 'QA retest', instructions: 'x' },
      { key: 'fix', agentId: ids.dev, title: 'Fix QA bugs', instructions: 'x' },
      { key: 'qa', agentId: ids.qa, title: 'Browser QA', instructions: 'x' },
      { key: 'mk', agentId: ids.mk, title: 'Marketing pack', instructions: 'x' },
      { key: 'dev', agentId: ids.dev, title: 'Build prototype', instructions: 'x' },
      { key: 'spec', agentId: ids.pm2, title: 'One-page spec', instructions: 'x' },
    ] } };
    await new Promise((r) => setTimeout(r, 400));
    return { ok: true, costUsd: 0, structured: { status: 'done', summary: 'ok' } };
  };
  const { office, store } = setup(run);
  const pm = office.hire({ title: 'Project Manager', jobDescription: 'plans', kind: 'manager' });
  ids.pm2 = office.hire({ title: 'Product Manager', jobDescription: 'spec' }).id;
  ids.dev = office.hire({ title: 'Software Engineer', jobDescription: 'code' }).id;
  ids.qa = office.hire({ title: 'QA Engineer', jobDescription: 'test' }).id;
  ids.mk = office.hire({ title: 'Marketing Manager', jobDescription: 'copy' }).id;
  office.createTask(pm.id, 'Launch', 'GOAL: launch it');
  await wait(() => store.state.tasks.length === 7);
  const by = (t: string) => store.state.tasks.find((x) => x.title === t)!;
  const titles = (t: string) => by(t).dependsOn.map((id) => store.state.tasks.find((x) => x.id === id)!.title).sort();
  assert.deepEqual(titles('One-page spec'), []);
  assert.deepEqual(titles('Build prototype'), ['One-page spec']);
  assert.deepEqual(titles('Marketing pack'), ['One-page spec']);
  assert.deepEqual(titles('Browser QA'), ['Build prototype']);
  assert.deepEqual(titles('Fix QA bugs'), ['Browser QA']);
  assert.deepEqual(titles('QA retest'), ['Fix QA bugs']);
});

test('after two routing reviews the next one is final and may not route more work', async () => {
  let dev = '';
  const run: ClaudeRunner = async (o) => {
    if (o.tools === '') return { ok: true, costUsd: 0, structured: { reply: 'ok', delegations: [] } };
    if (o.prompt.includes('FINAL REVIEW')) return { ok: true, costUsd: 0, structured: { status: 'done', summary: 'Project complete: done' } };
    if (o.prompt.includes('GOAL') || o.prompt.includes('current wave of tasks has settled')) return { ok: true, costUsd: 0, structured: { status: 'done', summary: 'more', subtasks: [{ key: 'k', agentId: dev, title: 'Polish', instructions: 'x' }] } };
    return { ok: true, costUsd: 0, structured: { status: 'done', summary: 'ok' } };
  };
  const { office, store } = setup(run);
  const pm = office.hire({ title: 'Project Manager', jobDescription: 'plans', kind: 'manager' });
  dev = office.hire({ title: 'Software Engineer', jobDescription: 'x' }).id;
  office.createTask(pm.id, 'Launch', 'GOAL: go');
  await wait(() => store.state.tasks.filter((t) => t.review && t.status === 'done').length === 3);
  await new Promise((r) => setTimeout(r, 100));
  const reviews = store.state.tasks.filter((t) => t.review);
  assert.equal(reviews.length, 3);
  assert.ok(reviews[2].instructions.includes('FINAL REVIEW'));
  assert.ok(!reviews[1].instructions.includes('FINAL REVIEW'));
});
