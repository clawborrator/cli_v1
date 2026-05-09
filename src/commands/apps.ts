// `claw apps mint|list|revoke|test-oauth` — SPA app-token management.
// App tokens (`cw_app_…`) are the bearer credentials cross-origin SPAs
// use to call the hub. The "real" path to mint one is the SPA OAuth
// flow at /api/v1/auth/spa/{start,exchange}; these commands give CLI-
// authenticated developers shortcuts:
//
//   * `mint`        — typesafe wrapper around mintAppToken on the hub;
//                     skips OAuth round-trip during local build-out.
//   * `list`        — filters /api/v1/tokens to kind='app'.
//   * `revoke`      — DELETE /api/v1/tokens/:id with a y/N confirm.
//   * `test-oauth`  — walks the full PKCE flow end-to-end as a debug
//                     tool. Same local-listener pattern as `claw login`,
//                     but redeems the code at /spa/exchange instead of
//                     /oauth/token, yielding a kind='app' token rather
//                     than a session.

import { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { api, ApiError } from '../client/api.js';
import { loadConfig } from '../config.js';
import type { ApiToken } from '../shared/index.js';

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function fmtAgo(iso: string | null): string {
  if (!iso) return 'never';
  // SQLite's CURRENT_TIMESTAMP default emits 'YYYY-MM-DD HH:MM:SS' in
  // UTC, with no timezone marker. `new Date()` parses that as LOCAL
  // time, throwing the diff off by the local offset (and producing
  // a negative ms when the local zone is east of UTC). Normalize to
  // ISO-with-Z when the string lacks a timezone suffix.
  let s = iso;
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) s = s.replace(' ', 'T') + 'Z';
  const ms = Date.now() - new Date(s).getTime();
  if (!Number.isFinite(ms))      return '—';
  if (ms < 0)                    return 'just now';   // small clock drift
  if (ms < 60_000)               return Math.max(1, Math.floor(ms / 1000)) + 's ago';
  if (ms < 3600_000)             return Math.floor(ms / 60_000) + 'm ago';
  if (ms < 86400_000)            return Math.floor(ms / 3600_000) + 'h ago';
  return Math.floor(ms / 86400_000) + 'd ago';
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function openBrowser(url: string): void {
  // Cross-platform best-effort. Identical to login.ts so behavior is
  // predictable; if it fails the URL stays on stdout for copy-paste.
  const platform = process.platform;
  try {
    if (platform === 'win32') {
      // CMD's `start` builtin needs the URL inside double quotes —
      // OAuth URLs contain `&`, which CMD treats as a command
      // separator and silently truncates everything past the first
      // param.
      spawn('cmd', ['/c', 'start', '""', `"${url}"`], {
        stdio: 'ignore',
        detached: true,
        windowsVerbatimArguments: true,
      }).unref();
    } else {
      const cmd = platform === 'darwin' ? 'open' : 'xdg-open';
      spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
    }
  } catch { /* user falls back to copy-paste */ }
}

// ---------------------------------------------------------------------------
// `claw apps mint`
// ---------------------------------------------------------------------------

interface MintResponse { token: string; tokenName: string; kind: 'app'; createdAt: string }

const appsMint = new Command('mint')
  .description('mint a new SPA app token (cw_app_…) for testing — equivalent to walking the OAuth flow but uses the CLI\'s already-authenticated session')
  .argument('<name>', 'human-readable label for the token, shown in `claw apps list`')
  .action(async (name: string) => {
    const out = await api.post<MintResponse>('/api/v1/auth/apps/mint', { name });
    console.log(`✓ minted app token "${out.tokenName}"`);
    console.log(out.token);
    console.log('');
    console.log('Stash this somewhere safe — it can\'t be retrieved later. Use as `Authorization: Bearer ' + out.token + '` for any /api/v1/* call. Revoke with `claw apps revoke <id>` (id from `claw apps list`).');
  });

// ---------------------------------------------------------------------------
// `claw apps list`
// ---------------------------------------------------------------------------

function printAppRow(t: ApiToken): void {
  const created = `created ${fmtAgo(t.createdAt)}`;
  const lastUsed = `last used ${fmtAgo(t.lastUsedAt)}`;
  const revoked  = t.revokedAt ? `   REVOKED ${fmtAgo(t.revokedAt)}` : '';
  const label    = (t.appName ?? t.name ?? '').padEnd(28);
  console.log(`@${String(t.id).padStart(4)}  ${label}  ${created}   ${lastUsed}${revoked}`);
}

const appsList = new Command('list')
  .alias('ls')
  .description('list this user\'s SPA app tokens (kind=app). Active only by default; --all to include revoked.')
  .option('--all', 'include revoked tokens')
  .action(async (opts: { all?: boolean }) => {
    const qs   = opts.all ? '?includeRevoked=true' : '';
    const data = await api.get<{ items: ApiToken[] }>('/api/v1/tokens' + qs);
    const apps = data.items.filter((t) => t.kind === 'app');
    if (apps.length === 0) { console.log('no app tokens'); return; }
    for (const t of apps) printAppRow(t);
  });

// ---------------------------------------------------------------------------
// `claw apps revoke`
// ---------------------------------------------------------------------------

async function confirmYesNo(prompt: string): Promise<boolean> {
  // No TTY (e.g. piped input) → bail rather than guess. Operator can
  // re-run with --yes if scripted.
  if (!process.stdin.isTTY) {
    console.error('error: not a TTY — pass --yes to skip the confirmation prompt');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = (await rl.question(prompt + ' [y/N] ')).trim().toLowerCase();
    return ans === 'y' || ans === 'yes';
  } finally {
    rl.close();
  }
}

const appsRevoke = new Command('revoke')
  .description('revoke an app token by id (from `claw apps list`). Idempotent on the server, but prompts here unless --yes.')
  .argument('<id>', 'token id (the @<num> column from `claw apps list`)')
  .option('--yes', 'skip the y/N confirmation prompt')
  .action(async (idArg: string, opts: { yes?: boolean }) => {
    const id = Number(idArg.replace(/^@/, ''));
    if (!Number.isInteger(id) || id <= 0) {
      console.error('error: id must be a positive integer');
      process.exit(2);
    }
    if (!opts.yes) {
      const ok = await confirmYesNo(`revoke app token #${id}?`);
      if (!ok) { console.log('aborted'); return; }
    }
    try {
      await api.delete(`/api/v1/tokens/${id}`);
      console.log(`✓ revoked app token #${id}`);
    } catch (e) {
      if (e instanceof ApiError) {
        console.error(`error: ${e.status} ${e.code} — ${e.message}`);
        process.exit(1);
      }
      throw e;
    }
  });

// ---------------------------------------------------------------------------
// `claw apps test-oauth`
// ---------------------------------------------------------------------------

interface CallbackResult { code: string; state: string }

function awaitSpaCallback(server: ReturnType<typeof createServer>): Promise<CallbackResult> {
  return new Promise((resolve, reject) => {
    server.on('request', (req, res) => {
      // Connection: close so server.close() can drain immediately
      // — otherwise the browser's keep-alive holds the socket and
      // the CLI hangs after a successful callback.
      res.setHeader('Connection', 'close');
      const u = new URL(req.url ?? '/', 'http://localhost');
      // SPA flow redirects to the bare redirect_uri (path '/'),
      // not '/callback'. Accept either to be lenient.
      if (u.pathname !== '/' && u.pathname !== '/callback') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      const code  = u.searchParams.get('code')  ?? '';
      const state = u.searchParams.get('state') ?? '';
      const error = u.searchParams.get('error');
      if (error) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(`<html><body><h2>oauth error: ${error}</h2><p>you can close this tab.</p></body></html>`);
        reject(new Error(`oauth error: ${error}`));
        return;
      }
      if (!code || !state) {
        res.statusCode = 400;
        res.end('missing code or state');
        reject(new Error('callback missing code or state'));
        return;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<html><body><h2>oauth code received</h2><p>you can close this tab and return to the terminal.</p><script>setTimeout(() => window.close(), 1500);</script></body></html>');
      resolve({ code, state });
    });
    server.on('error', reject);
  });
}

interface ExchangeResponse { token: string; tokenName: string; expiresAt: string | null }

async function spaTestOauthFlow(args: { hubUrl: string; port: number }): Promise<ExchangeResponse & { appName: string }> {
  const verifier  = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const stateNonce = base64url(randomBytes(16));
  const appName    = 'claw-cli-test-oauth';

  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(args.port, '127.0.0.1', () => resolve());
  });
  const actualPort = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${actualPort}`;

  const startUrl = new URL('/api/v1/auth/spa/start', args.hubUrl);
  startUrl.searchParams.set('redirect_uri',          redirectUri);
  startUrl.searchParams.set('state',                 stateNonce);
  startUrl.searchParams.set('code_challenge',        challenge);
  startUrl.searchParams.set('code_challenge_method', 'S256');
  startUrl.searchParams.set('app_name',              appName);

  console.log('Opening browser to authorize…');
  console.log(`  if it doesn't open automatically, paste this URL into a browser:`);
  console.log(`    ${startUrl}`);
  console.log('');
  openBrowser(startUrl.toString());

  let cb: CallbackResult;
  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    cb = await Promise.race([
      awaitSpaCallback(server),
      new Promise<CallbackResult>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error('test-oauth timed out after 5 minutes (matches app_code TTL)')),
          5 * 60 * 1000,
        );
      }),
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    server.close();
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
  }
  if (cb.state !== stateNonce) throw new Error('state mismatch — possible CSRF; aborting');

  // Exchange code → cw_app_… token. Bare fetch (no auth header) — the
  // SPA flow is unauth: PKCE proves the SPA initiated the flow.
  const res = await fetch(args.hubUrl.replace(/\/$/, '') + '/api/v1/auth/spa/exchange', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'clawborrator-cli' },
    body:    JSON.stringify({ code: cb.code, code_verifier: verifier }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* ignore */ }
    throw new ApiError(res.status, parsed?.error ?? `http_${res.status}`, parsed?.message ?? parsed?.error ?? text);
  }
  const out = await res.json() as ExchangeResponse;
  return { ...out, appName };
}

const appsTestOauth = new Command('test-oauth')
  .description('walk the full SPA OAuth+PKCE flow end-to-end as a debug tool. Mints a real `cw_app_…` token; revoke afterwards via `claw apps revoke <id>` if you don\'t want it lying around.')
  .option('--port <n>', 'local listener port (default 8765)', (v) => parseInt(v, 10), 8765)
  .action(async (opts: { port: number }) => {
    const cfg    = loadConfig();
    const hubUrl = cfg.hubUrl.replace(/\/+$/, '');
    if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
      console.error('error: --port must be an integer in 1..65535');
      process.exit(2);
    }
    console.log(`hub: ${hubUrl}`);
    try {
      const out = await spaTestOauthFlow({ hubUrl, port: opts.port });
      console.log('');
      console.log('✓ flow completed');
      console.log(`token:    ${out.token}`);
      console.log(`appName:  ${out.appName}`);
      console.log(`curl:     curl -H 'Authorization: Bearer ${out.token}' ${hubUrl}/api/v1/me`);
      console.log('');
      console.log('Note: this token is real (counted against mint quotas etc). List with `claw apps list`,');
      console.log('and revoke via `claw apps revoke <id>` once you\'re done debugging.');
    } catch (e: any) {
      console.error('error: ' + (e?.message ?? String(e)));
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// parent command
// ---------------------------------------------------------------------------

export const appsCmd = new Command('apps')
  .description('manage SPA app tokens (kind=app, `cw_app_…`) — mint, list, revoke, and end-to-end-test the SPA OAuth+PKCE flow')
  .addCommand(appsMint)
  .addCommand(appsList)
  .addCommand(appsRevoke)
  .addCommand(appsTestOauth);
