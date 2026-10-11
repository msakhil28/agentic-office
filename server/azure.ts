import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface AzureConfig {
  endpoint: string;
  apiKey: string;
  deployment: string;
  /** Private CODEX_HOME for Foundry runs: no plugins, MCP servers or skills, so each call stays small. */
  codexHome?: string;
}

/** What the browser may see: never the key itself. */
export interface AzurePublic {
  endpoint: string;
  deployment: string;
  keySet: boolean;
}

/** Azure OpenAI hosts only, so a typo can't send the key somewhere else. */
const HOST = /\.(openai\.azure\.com|services\.ai\.azure\.com|cognitiveservices\.azure\.com|openai\.azure\.us|openai\.azure\.cn)$/i;

export function cleanEndpoint(raw: string): string {
  let u: URL;
  try { u = new URL(String(raw ?? '').trim()); } catch { throw new Error('endpoint must be a URL like https://<resource>.openai.azure.com/'); }
  if (u.protocol !== 'https:' || !HOST.test(u.hostname)) throw new Error('endpoint must be an https Azure OpenAI address (…openai.azure.com)');
  return `${u.origin}/`;
}

/** Codex base URL for an endpoint: <resource>/openai/v1 (Responses API). */
export function azureBaseUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, '').replace(/\/openai(\/v1)?$/, '')}/openai/v1`;
}

/** Microsoft Foundry (Azure OpenAI) connection saved by the Settings page, kept in the data folder (mode 600). */
export class AzureStore {
  private file: string;
  private home: string;
  private env: NodeJS.ProcessEnv;

  constructor(dataDir: string, env: NodeJS.ProcessEnv = process.env) {
    this.file = join(dataDir, 'azure.json');
    this.home = join(dataDir, 'codex-home');
    this.env = env;
  }

  /** Saved settings, falling back to AZURE_OPENAI_* environment variables. Undefined until endpoint and key exist. */
  get(): AzureConfig | undefined {
    let saved: Partial<AzureConfig> = {};
    try { if (existsSync(this.file)) saved = JSON.parse(readFileSync(this.file, 'utf8')); } catch { /* unreadable: ignore */ }
    const endpoint = (saved.endpoint || this.env.AZURE_OPENAI_ENDPOINT || '').trim();
    const apiKey = (saved.apiKey || this.env.AZURE_OPENAI_API_KEY || '').trim();
    const deployment = (saved.deployment ?? this.env.AZURE_OPENAI_DEPLOYMENT ?? '').trim();
    return endpoint && apiKey ? { endpoint, apiKey, deployment, codexHome: this.home } : undefined;
  }

  public(): AzurePublic {
    const c = this.get();
    return { endpoint: c?.endpoint ?? '', deployment: c?.deployment ?? '', keySet: !!c };
  }

  /** An empty apiKey keeps the saved one. */
  set(input: { endpoint?: string; apiKey?: string; deployment?: string }): AzurePublic {
    const cur = this.get();
    const endpoint = cleanEndpoint(input.endpoint ?? cur?.endpoint ?? '');
    const apiKey = String(input.apiKey ?? '').trim() || cur?.apiKey || '';
    if (!apiKey) throw new Error('API key is required');
    const deployment = String(input.deployment ?? cur?.deployment ?? '').trim();
    if (deployment.length > 120) throw new Error('deployment name is too long');
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ endpoint, apiKey, deployment }), { mode: 0o600 });
    renameSync(tmp, this.file);
    try { chmodSync(this.file, 0o600); } catch { /* best effort */ }
    return this.public();
  }
}
