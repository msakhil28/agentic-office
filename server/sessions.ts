import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { Store } from './store.ts';
import { Office, type OfficeOptions } from './office.ts';

interface SessionRecord { id: string; name: string }
interface Registry { activeSessionId: string; sessions: SessionRecord[] }
interface Context { store: Store; office: Office }

/** Each session owns a separate office state file and a long-lived Office instance. */
export class Sessions {
  private dataDir: string;
  private registryFile: string;
  private registry: Registry;
  private contexts = new Map<string, Context>();
  private listeners = new Set<() => void>();
  private options: Omit<OfficeOptions, 'store'>;

  constructor(dataDir: string, options: Omit<OfficeOptions, 'store'>) {
    this.dataDir = dataDir;
    this.registryFile = join(dataDir, 'sessions.json');
    this.options = options;
    this.registry = existsSync(this.registryFile)
      ? JSON.parse(readFileSync(this.registryFile, 'utf8'))
      : { activeSessionId: 'default', sessions: [{ id: 'default', name: 'Original session' }] };
    if (!this.registry.sessions.some((s) => s.id === this.registry.activeSessionId)) this.registry.activeSessionId = this.registry.sessions[0]?.id ?? 'default';
    for (const record of this.registry.sessions) this.load(record.id);
  }

  get activeId(): string { return this.registry.activeSessionId; }
  get active(): Context { return this.contexts.get(this.activeId)!; }
  get(id: string): Context {
    const context = this.contexts.get(id);
    if (!context) throw new Error('session not found');
    return context;
  }

  list() {
    return this.registry.sessions.map((s) => {
      const { office, store } = this.contexts.get(s.id)!;
      return { ...s, workspace: office.currentWorkspace, provider: store.state.settings.provider, agents: store.state.agents.length, tasks: store.state.tasks.length };
    });
  }

  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private changed(): void { for (const fn of this.listeners) fn(); }

  private file(id: string): string {
    return id === 'default' ? join(this.dataDir, 'office.json') : join(this.dataDir, 'sessions', `${id}.json`);
  }

  private load(id: string, workspace?: string): Context {
    const store = new Store(this.file(id));
    if (workspace) store.state.workspace = workspace;
    const office = new Office({ ...this.options, store, workspace: workspace ?? this.options.workspace });
    const context = { store, office };
    this.contexts.set(id, context);
    store.onChange(() => this.changed());
    if (workspace) store.flush();
    return context;
  }

  create(input: { name?: string; workspace?: string }) {
    const raw = String(input.workspace ?? '').trim();
    const workspace = resolve(raw.startsWith('~') ? join(homedir(), raw.slice(1)) : raw);
    if (!input.workspace || !statSyncSafe(workspace)) throw new Error('Choose an existing workspace folder');
    const name = String(input.name ?? '').trim() || basename(workspace) || 'New session';
    if (name.length > 80) throw new Error('Session name is too long');
    const id = randomUUID();
    this.load(id, workspace);
    this.registry.sessions.push({ id, name });
    this.registry.activeSessionId = id;
    this.saveRegistry();
    this.changed();
    return this.list().find((s) => s.id === id)!;
  }

  select(id: string) {
    if (!this.contexts.has(id)) throw new Error('session not found');
    this.registry.activeSessionId = id;
    this.saveRegistry();
    this.changed();
    return this.list().find((s) => s.id === id)!;
  }

  private saveRegistry(): void {
    mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.registryFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.registry, null, 2));
    renameSync(tmp, this.registryFile);
  }

  flush(): void { for (const { store } of this.contexts.values()) store.flush(); }
}

function statSyncSafe(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}
