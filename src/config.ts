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
import { randomUUID } from 'node:crypto';

const CONFIG_DIR  = resolve(homedir(), '.clawborrator');
const CONFIG_PATH = resolve(CONFIG_DIR, 'cli_v1.json');

export interface CliConfig {
  hubUrl:       string;
  sessionToken: string | null;
  // Stable per-install identifier minted on first login. Sent to the
  // hub at /oauth/start so it can revoke any prior CLI auth_sessions
  // for this (user, machine) before issuing the new one — avoids
  // accumulating dead session rows every time `claw login` runs.
  // Wiping cli_v1.json regenerates it; that's a known orphan source
  // (same as the supervisor's machine_id), cleanable via a future
  // `claw auth-sessions revoke` or hub-side admin.
  machineId:    string;
}

const DEFAULTS: CliConfig = {
  // Default to the public hub. Local-dev users override via either
  // CLAWBORRATOR_HUB=http://localhost:8787 or `claw login --hub <url>`,
  // which persists into ~/.clawborrator/cli_v1.json.
  hubUrl:       process.env.CLAWBORRATOR_HUB ?? 'https://next.clawborrator.com',
  sessionToken: null,
  machineId:    '',                    // populated on first loadConfig()
};

export function loadConfig(): CliConfig {
  let parsed: Partial<CliConfig> & { pat?: string | null } = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = readFileSync(CONFIG_PATH, 'utf8');
      parsed = JSON.parse(raw) as Partial<CliConfig> & { pat?: string | null };
    } catch {
      // Fall through with parsed = {} → behaves like first-run.
    }
  }
  let machineId = parsed.machineId?.trim() || '';
  if (!machineId) {
    machineId = randomUUID();
    // Persist the new machineId immediately so subsequent reads (and
    // any concurrent CLI invocations) see the same value.
    saveConfig({
      hubUrl:       parsed.hubUrl?.trim() || DEFAULTS.hubUrl,
      sessionToken: parsed.sessionToken ?? parsed.pat ?? null,
      machineId,
    });
  }
  return {
    hubUrl:       parsed.hubUrl?.trim() || DEFAULTS.hubUrl,
    // Forward-migrate a legacy `pat` field. The token itself is now
    // dead on the server side, but carrying it forward avoids loud
    // "config corrupt" errors — the next API call will 401 cleanly
    // and prompt re-login.
    sessionToken: parsed.sessionToken ?? parsed.pat ?? null,
    machineId,
  };
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
