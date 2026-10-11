import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PinGate, COOKIE, type Attempt } from '../server/auth.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'office-auth-'));
const cookieOf = (g: PinGate) => g.cookieHeader().split(';')[0];
const failed = (r: Attempt) => { assert.equal(r.ok, false); return r as Extract<Attempt, { ok: false }>; };

test('right PIN unlocks and the cookie is accepted; wrong or missing cookie is not', () => {
  const g = new PinGate('8888', dir());
  assert.deepEqual(g.attempt('1.1.1.1', '8888'), { ok: true });
  assert.ok(g.isUnlocked(cookieOf(g)));
  assert.ok(g.isUnlocked(`other=1; ${cookieOf(g)}`));
  assert.equal(g.isUnlocked(undefined), false);
  assert.equal(g.isUnlocked(`${COOKIE}=nope`), false);
  assert.match(g.cookieHeader(), /HttpOnly; SameSite=Strict/);
});

test('cookie survives a restart but not a PIN change', () => {
  const d = dir();
  const a = new PinGate('8888', d);
  assert.ok(new PinGate('8888', d).isUnlocked(cookieOf(a)));
  assert.equal(new PinGate('1234', d).isUnlocked(cookieOf(a)), false);
  assert.equal(new PinGate('8888', dir()).isUnlocked(cookieOf(a)), false);
});

test('wrong PINs count down, then lock the IP out with growing lockouts', () => {
  let now = 0;
  const g = new PinGate('8888', dir(), () => now);
  for (let left = 4; left >= 1; left--) assert.deepEqual(g.attempt('ip', '0000'), { ok: false, left, retryAfterSec: 0 });
  assert.deepEqual(g.attempt('ip', '0000'), { ok: false, left: 0, retryAfterSec: 60 });
  assert.equal(g.attempt('ip', '8888').ok, false, 'locked even with the right PIN');
  assert.equal(g.attempt('other-ip', '8888').ok, true, 'other devices are not affected');
  now += 60_000;
  for (let i = 0; i < 4; i++) g.attempt('ip', '9999');
  assert.equal(failed(g.attempt('ip', '9999')).retryAfterSec, 120, 'second lockout doubles');
  now += 120_000;
  assert.equal(g.attempt('ip', '8888').ok, true);
  assert.equal(failed(g.attempt('ip', '0000')).left, 4, 'success resets the count');
});

test('rejects non-string and malformed input', () => {
  const g = new PinGate('8888', dir());
  assert.equal(g.attempt('ip', 8888).ok, false);
  assert.equal(g.attempt('ip', undefined).ok, false);
  assert.throws(() => new PinGate('123', dir()), /4 digits/);
  assert.throws(() => new PinGate('abcd', dir()), /4 digits/);
});
