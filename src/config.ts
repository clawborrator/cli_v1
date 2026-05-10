// Config + session-token storage. v1 uses a JSON file at
// ~/.clawborrator/cli_v1.json with mode 0600 (POSIX) — OS secret-store
// integration is a future hardening pass.
//
// File name is component-scoped (`cli_v1.json` rather than the more
// generic `config.json`) so that future siblings under
// ~/.clawborrator/ — daemon scratch dirs, per-folder sidecars, etc. —
// don't collide. Forward-only rename: 0.2.4+ does NOT read the old
// ~/.clawborrator/config.json; users on the upgrade path re-login
// once.
//
// `sessionToken` is the post-OAuth session credential the CLI got
// from /api/v1/auth/oauth/token. Format: `cw_sess_<32 hex>`. The
// hub's auth middleware reads it as `Authorization: Bearer ...`.
// Pre-migration this field was `pat` (cw_pat_); on load we migrate
// the old key forward so existing configs don't lose their value
// just-in-case (the server-side migration deleted PAT rows so it'll
// 401 anyway, but no point keeping a half-broken config around).

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';

const CONFIG_DIR  = resolve(homedir(), '.clawborrator');
const CONFIG_PATH = resolve(CONFIG_DIR, 'cli_v1.json');

export interface CliConfig {
  hubUrl:       string;
  sessionToken: string | null;
}

const DEFAULTS: CliConfig = {
  // Default to the public hub. Local-dev users override via either
  // CLAWBORRATOR_HUB=http://localhost:8787 or `claw login --hub <url>`,
  // which persists into ~/.clawborrator/cli_v1.json.
  hubUrl:       process.env.CLAWBORRATOR_HUB ?? 'https://next.clawborrator.com',
  sessionToken: null,
};

export function loadConfig(): CliConfig {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULTS };
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CliConfig> & { pat?: string | null };
    return {
      hubUrl:       parsed.hubUrl?.trim() || DEFAULTS.hubUrl,
      // Forward-migrate a legacy `pat` field. The token itself is now
      // dead on the server side, but carrying it forward avoids loud
      // "config corrupt" errors — the next API call will 401 cleanly
      // and prompt re-login.
      sessionToken: parsed.sessionToken ?? parsed.pat ?? null,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(cfg: CliConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  try { chmodSync(CONFIG_PATH, 0o600); } catch { /* Windows ACLs handle this */ }
}

export function clearSession(): void {
  const cfg = loadConfig();
  saveConfig({ ...cfg, sessionToken: null });
}

export function configPath(): string {
  return CONFIG_PATH;
}
