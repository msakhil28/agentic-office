import { readdirSync, readFileSync, realpathSync, statSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, sep, extname, basename } from 'node:path';

export const MAX_TEXT_BYTES = 512 * 1024;

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
};

export interface GitInfo {
  branch: string;
  ahead: number;
  behind: number;
  /** Changed or untracked files, `XY path` as in `git status --short` (capped). */
  changes: string[];
  total: number;
}

export interface FileEntry {
  name: string;
  type: 'dir' | 'file';
  size: number;
  mtime: string;
  git?: GitInfo;
}

/** Resolves `rel` inside `workspace`, following symlinks, and refuses anything that escapes it. */
export function safePath(workspace: string, rel: string): string {
  const root = realpathSync(workspace);
  let real: string;
  try {
    real = realpathSync(resolve(root, String(rel ?? '').replace(/^[/\\]+/, '') || '.'));
  } catch {
    throw new Error('not found');
  }
  if (real !== root && !real.startsWith(root + sep)) throw new Error('outside the workspace');
  return real;
}

/** Git status of `dir` when it is inside a repository, else undefined. Read-only; never takes locks. */
export function gitInfo(dir: string): GitInfo | undefined {
  try {
    const out = execFileSync('git', ['-C', dir, 'status', '--porcelain=v1', '-b', '--untracked-files=normal'], {
      encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    const [head, ...rest] = out.split('\n').filter(Boolean);
    const m = head.replace(/^## /, '');
    const branch = m.replace(/^No commits yet on /, '').split('...')[0].replace(/^HEAD \(no branch\)/, 'detached');
    return {
      branch,
      ahead: +(/ahead (\d+)/.exec(m)?.[1] ?? 0),
      behind: +(/behind (\d+)/.exec(m)?.[1] ?? 0),
      changes: rest.slice(0, 40),
      total: rest.length,
    };
  } catch {
    return undefined;
  }
}

/** Folders first, then files, each alphabetical. `.git` is hidden. */
export function listDir(workspace: string, rel: string): { path: string; entries: FileEntry[]; git?: GitInfo } {
  const dir = safePath(workspace, rel);
  if (!statSync(dir).isDirectory()) throw new Error('not a folder');
  const entries: FileEntry[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    try {
      const st = statSync(resolve(dir, e.name)); // follows symlinks; broken links throw and are skipped
      const isDir = st.isDirectory(), git = isDir && existsSync(resolve(dir, e.name, '.git')) ? gitInfo(resolve(dir, e.name)) : undefined;
      entries.push({ name: e.name, type: isDir ? 'dir' : 'file', size: st.size, mtime: st.mtime.toISOString(), ...(git ? { git } : {}) });
    } catch {
      // unreadable entry
    }
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  const git = gitInfo(dir);
  return { path: relTo(workspace, dir), entries, ...(git ? { git } : {}) };
}

export type FileView =
  | { path: string; name: string; kind: 'text'; size: number; mtime: string; content: string; truncated: boolean }
  | { path: string; name: string; kind: 'image' | 'binary'; size: number; mtime: string };

export function readFileView(workspace: string, rel: string): FileView {
  const file = safePath(workspace, rel);
  const st = statSync(file);
  if (!st.isFile()) throw new Error('not a file');
  const base = { path: relTo(workspace, file), name: basename(file), size: st.size, mtime: st.mtime.toISOString() };
  if (IMAGE_MIME[extname(file).toLowerCase()]) return { ...base, kind: 'image' };
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(st.size, MAX_TEXT_BYTES));
    readSync(fd, buf, 0, buf.length, 0);
    if (buf.subarray(0, 8000).includes(0)) return { ...base, kind: 'binary' };
    return { ...base, kind: 'text', content: buf.toString('utf8'), truncated: st.size > MAX_TEXT_BYTES };
  } finally {
    closeSync(fd);
  }
}

/** For serving images. Only image types are ever returned raw. */
export function rawImage(workspace: string, rel: string): { file: string; mime: string; data: Buffer } {
  const file = safePath(workspace, rel);
  const mime = IMAGE_MIME[extname(file).toLowerCase()];
  if (!mime || !statSync(file).isFile()) throw new Error('not an image');
  return { file, mime, data: readFileSync(file) };
}

function relTo(workspace: string, abs: string): string {
  const root = realpathSync(workspace);
  return abs === root ? '' : abs.slice(root.length + 1);
}
