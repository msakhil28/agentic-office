import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sessions } from '../server/sessions.ts';

test('existing office becomes original session; new session is isolated and selection survives restart', () => {
  const data = mkdtempSync(join(tmpdir(), 'office-sessions-data-'));
  const oldWorkspace = mkdtempSync(join(tmpdir(), 'office-sessions-old-'));
  const newWorkspace = mkdtempSync(join(tmpdir(), 'office-sessions-new-'));
  writeFileSync(join(data, 'office.json'), JSON.stringify({
    agents: [], tasks: [], questions: [], chat: [{ id: 'old', from: 'akhil', text: 'prior work', at: '' }],
    usage: { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, byDay: {} }, workspace: oldWorkspace,
  }));
  const options = { workspace: oldWorkspace, permissionMode: 'acceptEdits', run: async () => ({ ok: true, costUsd: 0 }) };
  const sessions = new Sessions(data, options);
  assert.equal(sessions.activeId, 'default');
  assert.equal(sessions.active.store.state.chat[0].text, 'prior work');
  assert.equal(sessions.active.office.currentWorkspace, oldWorkspace);
  sessions.active.office.setSettings({ provider: 'openai', openaiModel: 'gpt-original' });
  const fresh = sessions.create({ name: 'Other project', workspace: newWorkspace });
  assert.equal(sessions.activeId, fresh.id);
  assert.equal(sessions.active.store.state.chat.length, 0);
  assert.equal(sessions.active.office.currentWorkspace, newWorkspace);
  assert.equal(sessions.active.store.state.settings.provider, 'claude', 'new sessions start with independent settings');
  sessions.active.office.setSettings({ claudeModel: 'claude-other' });
  sessions.active.office.hire({ title: 'Developer', jobDescription: 'code' });
  assert.equal(sessions.active.store.state.agents.length, 1);
  sessions.select('default');
  assert.equal(sessions.active.store.state.agents.length, 0);
  assert.equal(sessions.active.store.state.chat[0].text, 'prior work');
  assert.deepEqual(sessions.active.store.state.settings, { provider: 'openai', claudeModel: 'claude-sonnet-5-5', openaiModel: 'gpt-original' });
  sessions.select(fresh.id);
  assert.deepEqual(sessions.active.store.state.settings, { provider: 'claude', claudeModel: 'claude-other', openaiModel: '' });
  assert.deepEqual(sessions.list().map((s) => s.provider), ['openai', 'claude']);
  sessions.flush();
  const restarted = new Sessions(data, options);
  assert.equal(restarted.activeId, fresh.id);
  assert.equal(restarted.active.store.state.agents.length, 1);
  restarted.select('default');
  assert.equal(restarted.active.store.state.chat[0].text, 'prior work');
  assert.equal(restarted.active.store.state.settings.openaiModel, 'gpt-original');
  restarted.select(fresh.id);
  assert.equal(restarted.active.store.state.settings.claudeModel, 'claude-other');
  assert.throws(() => restarted.create({ workspace: join(data, 'missing') }));
});
