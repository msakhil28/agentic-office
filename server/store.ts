import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_SETTINGS, type OfficeState } from './types.ts';

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

export function now(): string {
  return new Date().toISOString();
}

/** Holds office state in memory, persists it to a JSON file, and notifies listeners on change. */
export class Store {
  state: OfficeState;
  private file: string | null;
  private listeners = new Set<() => void>();
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(file: string | null) {
    this.file = file;
    this.state = { settings: { ...DEFAULT_SETTINGS }, agents: [], tasks: [], questions: [], chat: [], usage: { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, byDay: {} } };
    if (file && existsSync(file)) {
      this.state = migrate({ ...this.state, ...JSON.parse(readFileSync(file, 'utf8')) });
    }
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Call after every mutation. */
  changed(): void {
    for (const fn of this.listeners) fn();
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 200);
  }

  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.file);
  }
}

/** Fills fields added since older saved files were written. */
export function migrate(s: OfficeState): OfficeState {
  s.settings = { ...DEFAULT_SETTINGS, ...s.settings };
  if (!['claude', 'openai', 'azure'].includes(s.settings.provider)) s.settings.provider = 'claude';
  for (const a of s.agents) a.kind ??= 'worker';
  for (const t of s.tasks) t.dependsOn ??= [];
  const old: Partial<OfficeState['usage']> = s.usage ?? {};
  s.usage = { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, byDay: {}, ...old };
  return s;
}
