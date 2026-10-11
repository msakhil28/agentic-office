import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const COOKIE = 'office_pin';
const MAX_TRIES = 5, BASE_LOCK_MS = 60_000, MAX_LOCK_MS = 3_600_000;

export type Attempt = { ok: true } | { ok: false; left: number; retryAfterSec: number };

/**
 * 4-digit PIN gate. A device that enters the PIN gets a cookie signed with a secret kept in the
 * data dir, so it stays unlocked across restarts; changing the PIN signs every device out.
 * Five wrong tries lock that IP out for 1 min, doubling per lockout up to 1 h.
 */
export class PinGate {
  private readonly pin: string;
  private readonly now: () => number;
  private readonly token: string;
  private readonly fails = new Map<string, { count: number; lockouts: number; until: number }>();

  constructor(pin: string, dataDir: string, now = () => Date.now()) {
    this.pin = pin; this.now = now;
    if (!/^\d{4}$/.test(pin)) throw new Error('OFFICE_PIN must be exactly 4 digits');
    mkdirSync(dataDir, { recursive: true });
    const file = join(dataDir, 'auth-secret');
    if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 });
    this.token = createHmac('sha256', readFileSync(file, 'utf8').trim()).update('pin:' + pin).digest('hex');
  }

  cookieHeader(): string {
    return `${COOKIE}=${this.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`;
  }

  isUnlocked(cookieHeader: string | undefined): boolean {
    const v = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(cookieHeader ?? '')?.[1];
    return !!v && safeEqual(v, this.token);
  }

  attempt(ip: string, pin: unknown): Attempt {
    const f = this.fails.get(ip) ?? { count: 0, lockouts: 0, until: 0 };
    const now = this.now();
    if (f.until > now) return { ok: false, left: 0, retryAfterSec: Math.ceil((f.until - now) / 1000) };
    if (typeof pin === 'string' && safeEqual(pin, this.pin)) { this.fails.delete(ip); return { ok: true }; }
    f.count++;
    if (f.count >= MAX_TRIES) {
      f.until = now + Math.min(BASE_LOCK_MS * 2 ** f.lockouts, MAX_LOCK_MS);
      f.lockouts++; f.count = 0;
    }
    this.fails.set(ip, f);
    return { ok: false, left: f.until > now ? 0 : MAX_TRIES - f.count, retryAfterSec: f.until > now ? Math.ceil((f.until - now) / 1000) : 0 };
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
