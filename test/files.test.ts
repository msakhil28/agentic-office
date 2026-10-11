import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listDir, readFileView, rawImage, MAX_TEXT_BYTES } from '../server/files.ts';

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'files-'));
  const ws = join(base, 'ws');
  mkdirSync(join(ws, 'src'), { recursive: true });
  mkdirSync(join(ws, '.git'));
  writeFileSync(join(ws, 'README.md'), '# hi');
  writeFileSync(join(ws, 'src', 'a.ts'), 'const a = 1;');
  writeFileSync(join(ws, 'bin.dat'), Buffer.from([1, 2, 0, 3]));
  writeFileSync(join(ws, 'pic.png'), Buffer.from([137, 80, 78, 71]));
  writeFileSync(join(ws, 'big.txt'), 'x'.repeat(MAX_TEXT_BYTES + 10));
  writeFileSync(join(base, 'secret.txt'), 'top secret');
  symlinkSync(join(base, 'secret.txt'), join(ws, 'link.txt'));
  return { base, ws };
}

test('lists folders first, hides .git, reads text/binary/image/truncated', () => {
  const { ws } = fixture();
  const top = listDir(ws, '').entries.map((e) => e.name);
  assert.equal(top[0], 'src');
  assert.ok(!top.includes('.git'));
  assert.deepEqual(listDir(ws, 'src').entries.map((e) => e.name), ['a.ts']);
  const md = readFileView(ws, 'README.md');
  assert.equal(md.kind === 'text' && md.content, '# hi');
  assert.equal(readFileView(ws, 'bin.dat').kind, 'binary');
  assert.equal(readFileView(ws, 'pic.png').kind, 'image');
  const big = readFileView(ws, 'big.txt');
  assert.ok(big.kind === 'text' && big.truncated && big.content.length === MAX_TEXT_BYTES);
  assert.equal(rawImage(ws, 'pic.png').mime, 'image/png');
  assert.throws(() => rawImage(ws, 'README.md'), /not an image/);
});

test('cannot escape the workspace via .., absolute paths or symlinks', () => {
  const { ws } = fixture();
  assert.throws(() => readFileView(ws, '../secret.txt'), /outside the workspace/);
  assert.throws(() => listDir(ws, '..'), /outside the workspace/);
  assert.throws(() => readFileView(ws, join(ws, '..', 'secret.txt')), /outside the workspace|not found/);
  assert.throws(() => readFileView(ws, 'link.txt'), /outside the workspace/);
  assert.throws(() => readFileView(ws, 'nope.txt'), /not found/);
  assert.equal(listDir(ws, '/src').path, 'src');
});

test('git status shows for repos (folder rows and current folder) and not for plain folders', async () => {
  const { execFileSync } = await import('node:child_process');
  const base = mkdtempSync(join(tmpdir(), 'gitfiles-'));
  mkdirSync(join(base, 'repo'));
  mkdirSync(join(base, 'plain'));
  execFileSync('git', ['-C', join(base, 'repo'), 'init', '-q', '-b', 'main']);
  writeFileSync(join(base, 'repo', 'a.txt'), 'x');
  const top = listDir(base, '');
  assert.equal(top.git, undefined);
  assert.equal(top.entries.find((e) => e.name === 'plain')?.git, undefined);
  const g = top.entries.find((e) => e.name === 'repo')?.git;
  assert.equal(g?.branch, 'main');
  assert.equal(g?.total, 1);
  assert.match(g!.changes[0], /a\.txt/);
  assert.equal(listDir(base, 'repo').git?.branch, 'main');
});
