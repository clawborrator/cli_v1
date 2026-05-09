// `claw login` — GitHub OAuth Authorization Code with PKCE, using a
// localhost callback. Standard CLI OAuth pattern (gh, az, gcloud do
// the same thing):
//
//   1. Spawn an ephemeral HTTP server on a random local port.
//   2. Generate a PKCE code_verifier + code_challenge.
//   3. Open the user's browser to /api/v1/auth/oauth/start with
//      redirect_uri pointing at our localhost server.
//   4. The hub redirects to GitHub, GitHub redirects back to the hub
//      callback, the hub redirects to our localhost server with a
//      single-use ?code= and the original ?state=.
//   5. We POST { code, code_verifier } to /api/v1/auth/oauth/token,
//      receive a session token, store it in ~/.clawborrator/config.json.
//
// The session token is a hub-issued credential (`cw_sess_<...>`); the
// hub's auth middleware accepts it as `Authorization: Bearer …`.

import { Command } from 'commander';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { ApiError } from '../client/api.js';
import { loadConfig, saveConfig } from '../config.js';
import type { ApiUser } from '../shared/index.js';

interface TokenResponse {
  user:    ApiUser;
  session: { token: string; expiresAt: string };
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function openBrowser(url: string): void {
  // Best-effort cross-platform launch. If it fails, the URL stays
  // printed so the user can paste it manually.
  const platform = process.platform;
  try {
    if (platform === 'win32') {
      // CMD's `start` builtin needs the URL inside double quotes —
      // OAuth URLs contain `&`, which CMD otherwise treats as a
      // command separator and silently truncates everything past
      // the first param. windowsVerbatimArguments stops Node from
      // wrapping the args itself; we control the quoting.
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

interface CallbackResult { code: string; state: string }

function awaitCallback(server: ReturnType<typeof createServer>): Promise<CallbackResult> {
  return new Promise((resolve, reject) => {
    server.on('request', (req, res) => {
      // Connection: close on every response so the browser doesn't
      // keep a TCP keep-alive open. Otherwise server.close() waits
      // for the idle socket to time out before the Node event loop
      // can drain — visible to the user as "auth completed but the
      // CLI never returns to the prompt."
      res.setHeader('Connection', 'close');
      const u = new URL(req.url ?? '/', 'http://localhost');
      if (u.pathname !== '/callback') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      const code  = u.searchParams.get('code')  ?? '';
      const state = u.searchParams.get('state') ?? '';
      const error = u.searchParams.get('error');
      if (error) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(`<html><body><h2>login failed: ${error}</h2><p>you can close this tab.</p></body></html>`);
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
      res.end('<html><body><h2>logged in</h2><p>you can close this tab and return to the terminal.</p><script>setTimeout(() => window.close(), 1500);</script></body></html>');
      resolve({ code, state });
    });
    server.on('error', reject);
  });
}

async function browserOAuthFlow(hubUrl: string): Promise<TokenResponse> {
  const verifier  = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state     = base64url(randomBytes(16));

  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://localhost:${port}/callback`;

  const startUrl = new URL('/api/v1/auth/oauth/start', hubUrl);
  startUrl.searchParams.set('redirect_uri',          redirectUri);
  startUrl.searchParams.set('state',                 state);
  startUrl.searchParams.set('code_challenge',        challenge);
  startUrl.searchParams.set('code_challenge_method', 'S256');

  console.log('opening browser to authenticate with GitHub…');
  console.log(`  if it doesn't open automatically, paste this URL into a browser:`);
  console.log(`    ${startUrl}`);
  console.log('');
  openBrowser(startUrl.toString());

  let cb: CallbackResult;
  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    cb = await Promise.race([
      awaitCallback(server),
      new Promise<CallbackResult>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error('login timed out after 5 minutes')),
          5 * 60 * 1000,
        );
      }),
    ]);
  } finally {
    // Clear the 5-min watchdog so it doesn't keep the event loop
    // alive after a successful callback.
    if (timeoutHandle) clearTimeout(timeoutHandle);
    server.close();
    // Force any idle keep-alive sockets to close immediately. Without
    // this, server.close() can hang for ~5s on Node's default
    // keep-alive timeout while the browser holds the connection.
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
  }
  if (cb.state !== state) throw new Error('state mismatch — possible CSRF; aborting');

  // Exchange code → session token. We don't go through the typed `api`
  // client because at this point the CLI has no session yet; bare
  // fetch is simpler than threading `token: null` through the helper.
  const res = await fetch(hubUrl.replace(/\/$/, '') + '/api/v1/auth/oauth/token', {
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
  return res.json() as Promise<TokenResponse>;
}

export const loginCmd = new Command('login')
  .description('authenticate against a hub_v1 instance via GitHub OAuth (browser callback)')
  .option('--hub <url>', 'hub URL (overrides config and CLAWBORRATOR_HUB; persists on success). Default: https://next.clawborrator.com')
  .action(async (opts: { hub?: string }) => {
    const cfg = loadConfig();
    const hubUrl = (opts.hub ?? cfg.hubUrl).replace(/\/+$/, '');
    console.log(`hub: ${hubUrl}`);
    try {
      const { user, session } = await browserOAuthFlow(hubUrl);
      saveConfig({ hubUrl, sessionToken: session.token });
      console.log(`logged in as @${user.githubLogin}`);
      console.log(`hub:        ${hubUrl}`);
      console.log(`session:    ${session.token.slice(0, 16)}…  (stored in ~/.clawborrator/config.json)`);
      console.log(`expires at: ${session.expiresAt}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) {
        console.error('error: this hub does not have GitHub OAuth configured');
        console.error('       hub operator must register a GitHub OAuth App, set GITHUB_CLIENT_ID +');
        console.error('       GITHUB_CLIENT_SECRET, and add the callback URL.');
        process.exit(2);
      }
      throw e;
    }
  });
