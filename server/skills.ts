import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILLS_DIR = fileURLToPath(new URL('../.agents/skills/', import.meta.url));
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export interface Skill {
  name: string;
  description: string;
  source: string;
  path: string;
  compatibility?: string;
  requiresChrome?: boolean;
}

/** Strips YAML quotes and decodes their escapes: '' inside single quotes, \" and \\ inside double quotes. */
export function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'").trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\(["\\])/g, '$1').trim();
  return v.trim();
}

export function parseFrontmatter(text: string): Record<string, string> {
  const m = text.match(FRONTMATTER);
  const out: Record<string, string> = {};
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (kv[1] === 'metadata' && !v) {
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) v += lines[++i].trim() + '\n';
    }
    if (/^[>|][+-]?$/.test(v)) {
      v = '';
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) v += ` ${lines[++i].trim()}`;
    }
    out[kv[1]] = unquote(v);
  }
  return out;
}

/** The shared catalog belongs to the office repo, independently of the task's workspace. */
export function listSkills(dir = SKILLS_DIR): Skill[] {
  let folders;
  try {
    folders = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills: Skill[] = [];
  for (const folder of folders) {
    if (!folder.isDirectory() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(folder.name) || folder.name.length > 64) continue;
    const path = join(dir, folder.name, 'SKILL.md');
    try {
      if (!lstatSync(path).isFile()) continue;
      const fm = parseFrontmatter(readFileSync(path, 'utf8'));
      if (fm.name !== folder.name || !fm.description || fm.description.length > 1024) continue;
      const compatibility = fm.compatibility || fm.metadata?.match(/^office-compatibility: (.+)$/m)?.[1];
      skills.push({
        name: fm.name,
        description: fm.description,
        source: 'Agentic Office repo',
        path,
        ...(compatibility ? { compatibility } : {}),
        ...(/^office-requires: claude-chrome$/m.test(fm.metadata ?? '') ? { requiresChrome: true } : {}),
      });
    } catch {
      continue;
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function readSkillBody(skill: Skill): string {
  return readFileSync(skill.path, 'utf8').replace(FRONTMATTER, '').trim();
}
