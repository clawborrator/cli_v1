// `claw auth-sessions ...` — list and revoke the caller's hub-issued
// auth_sessions rows (cookie + CLI bearer credentials minted via the
// OAuth flows). Distinct from `claw token` (channel + app tokens)
// and `claw session` (CC sessions).

import { Command } from 'commander';
import { api } from '../client/api.js';

interface ApiAuthSession {
  id:          string;
  source:      'web' | 'cli';
  userAgent:   string | null;
  machineId:   string | null;
  createdAt:   string;
  lastUsedAt:  string;
  expiresAt:   string;
  revokedAt:   string | null;
  isCurrent:   boolean;
}

// Compress a long User-Agent into a one-line surface tag. Recognized
// patterns get a short label; anything else is truncated. Keeps the
// `auth-sessions ls` output to one row per session.
function shortUserAgent(ua: string | null): string {
  if (!ua) return '(unknown)';
  if (ua.includes('clawborrator-cli'))         return 'clawborrator-cli';
  if (ua.includes('clawborrator-supervisor'))  return 'clawborrator-supervisor';
  // Browser detection — order matters (Edge contains "Chrome", iPhone
  // Chrome contains "CriOS", etc).
  const isMobile = /\b(iPhone|iPad|Android|Mobile)\b/.test(ua);
  let browser = 'Browser';
  if      (/\bCriOS\//.test(ua)) browser = 'Chrome';
  else if (/\bEdg\//.test(ua))   browser = 'Edge';
  else if (/\bFirefox\//.test(ua)) browser = 'Firefox';
  else if (/\bChrome\//.test(ua) && !/\bEdg\//.test(ua)) browser = 'Chrome';
  else if (/\bSafari\//.test(ua) && !/\bChrome\//.test(ua)) browser = 'Safari';
  let os = 'Unknown';
  if      (/\bWindows NT\b/.test(ua))    os = 'Windows';
  else if (/\bMacintosh\b/.test(ua))     os = 'macOS';
  else if (/\bLinux\b/.test(ua) && !/\bAndroid\b/.test(ua)) os = 'Linux';
  else if (/\bAndroid\b/.test(ua))       os = 'Android';
  else if (/\biPhone\b|\biPad\b/.test(ua)) os = 'iOS';
  return `${browser} on ${os}${isMobile && !/\biPhone|\biPad|\bAndroid\b/.test(ua) ? ' (mobile)' : ''}`;
}

function fmtAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000)        return Math.max(1, Math.floor(ms / 1000)) + 's ago';
  if (ms < 3600_000)      return Math.floor(ms / 60_000) + 'm ago';
  if (ms < 86400_000)     return Math.floor(ms / 3600_000) + 'h ago';
  return Math.floor(ms / 86400_000) + 'd ago';
}

const authSessionsList = new Command('list')
  .alias('ls')
  .description("list this user's hub auth_sessions (cookie + CLI bearer). The row used to authenticate THIS request is flagged with ←current.")
  .option('--all', 'include revoked sessions')
  .action(async (opts: { all?: boolean }) => {
    const qs = opts.all ? '?includeRevoked=true' : '';
    const data = await api.get<{ items: ApiAuthSession[] }>('/api/v1/auth-sessions' + qs);
    if (data.items.length === 0) { console.log('no auth_sessions'); return; }
    for (const a of data.items) {
      const status  = a.revokedAt ? 'REVOKED' : 'active';
      const cur     = a.isCurrent ? ' ←current' : '';
      const used    = `last ${fmtAgo(a.lastUsedAt)}`;
      const ua      = shortUserAgent(a.userAgent).padEnd(30);
      const mach    = a.machineId ? ` mach=${a.machineId.slice(0, 12)}…` : '';
      console.log(`${a.id.slice(0, 12)}…  ${a.source.padEnd(4)} ${ua}  ${used.padEnd(14)} ${status}${cur}${mach}`);
    }
  });

const authSessionsRevoke = new Command('revoke')
  .description('revoke an auth_session by id or unique id-prefix (≥4 hex chars). Cannot revoke the row used by this CLI session — use `claw logout` for that.')
  .argument('<idPrefix>', 'sha256 id or unique prefix from `claw auth-sessions list`')
  .action(async (idPrefix: string) => {
    const out = await api.post<{ ok: boolean; id: string }>(
      `/api/v1/auth-sessions/${encodeURIComponent(idPrefix)}/revoke`,
    );
    console.log(`✓ revoked ${out.id.slice(0, 12)}…`);
  });

export const authSessionsCmd = new Command('auth-sessions')
  .alias('auth')
  .description('list + revoke hub-issued auth_sessions (the cookie / CLI bearer credentials minted via OAuth). Different from `claw token` (channel + app tokens).')
  .addCommand(authSessionsList)
  .addCommand(authSessionsRevoke);
