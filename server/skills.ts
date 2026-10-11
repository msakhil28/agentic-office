import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, dirname } from 'node:path';

export interface Skill {
  name: string;
  description: string;
  source: string;
  path: string;
}

function parseFrontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out: Record<string, string> = {};
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^[>|][+-]?$/.test(v)) {
      v = '';
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) v += ` ${lines[++i].trim()}`;
    }
    out[kv[1]] = v.replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

function findSkillFiles(dir: string, depth = 0, acc: string[] = []): string[] {
  if (depth > 8 || !existsSync(dir)) return acc;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e === 'node_modules' || e === '.git') continue;
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) findSkillFiles(p, depth + 1, acc);
    else if (e === 'SKILL.md') acc.push(p);
  }
  return acc;
}

/** Lists skills installed for Claude: user skills plus those shipped in plugins. */
export function listSkills(home = homedir()): Skill[] {
  const roots: [string, string][] = [
    [join(home, '.claude', 'skills'), 'user'],
    [join(home, '.claude', 'plugins'), 'plugin'],
  ];
  const seen = new Map<string, Skill>();
  for (const [root, kind] of roots) {
    for (const file of findSkillFiles(root)) {
      let fm: Record<string, string>;
      try {
        fm = parseFrontmatter(readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      const dir = dirname(file);
      const name = fm.name || basename(dir);
      const plugin = kind === 'plugin' ? file.match(/plugins\/(?:cache|marketplaces)\/([^/]+)/)?.[1] : undefined;
      const source = plugin ? `plugin: ${plugin}` : kind;
      if (!seen.has(`${source}/${name}`)) seen.set(`${source}/${name}`, { name, description: fm.description ?? '', source, path: file });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}
