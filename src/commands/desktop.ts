// `claw desktop ...` — list registered desktop daemons + drive
// session control via the supervisor RPC. Mirrors what the SPA
// renders in the orchard-chat header (managed-session affordances)
// but from the terminal.

import { Command } from 'commander';
import { api } from '../client/api.js';

type DesktopRole = 'owner' | 'operator' | 'viewer';

interface ApiDesktop {
  id:            number;
  machineId:     string;
  hostname:      string | null;
  daemonVersion: string | null;
  registeredAt:  string;
  lastSeenAt:    string;
  online:        boolean;
  role:          DesktopRole;
  ownerLogin:    string;
}

const desktopList = new Command('list')
  .alias('ls')
  .description('list desktop daemons the caller owns OR has been granted a desktop_share on. The id column is the integer desktops.id used by the share subcommands; the long uuid is the machineId used by `claw desktop delete`.')
  .action(async () => {
    const data = await api.get<{ items: ApiDesktop[] }>('/api/v1/desktops');
    if (data.items.length === 0) { console.log('no registered desktops'); return; }
    for (const d of data.items) {
      const dot  = d.online ? '●' : '○';
      const host = d.hostname ?? '(unknown host)';
      const ver  = d.daemonVersion ?? '?';
      const attribution = d.role === 'owner' ? '' : ` (shared by @${d.ownerLogin} as ${d.role})`;
      console.log(`${dot} #${String(d.id).padEnd(4)} ${d.machineId}  ${host.padEnd(24)} v${ver.padEnd(8)} last-seen ${fmtAgo(d.lastSeenAt)}${attribution}`);
    }
  });

const desktopDelete = new Command('delete')
  .description('hard-delete a desktop daemon registration. Revokes any tokens stamped with this machine_id (today: clawborrator-supervisor app tokens) and unmanages any sessions whose managed_by_machine_id matches (the session row survives as unmanaged; destroy it separately if you want it gone). Closes the live /supervisor WS if connected.')
  .argument('<machineId>', 'desktop machine id (from `claw desktop list`)')
  .option('--yes', 'skip the confirmation prompt')
  .action(async (machineId: string, opts: { yes?: boolean }) => {
    if (!opts.yes) {
      // Minimal confirm — operator already typed the machineId, so
      // this is mostly to surface what's about to happen rather than
      // gate against typos.
      process.stdout.write(`Hard-delete desktop ${machineId} and revoke its associated tokens? [y/N] `);
      const answer = await new Promise<string>((res) => {
        process.stdin.once('data', (d) => res(d.toString().trim().toLowerCase()));
      });
      // .once() on stdin puts the stream into flowing mode; without
      // pause() Node keeps the event loop alive after the listener
      // fires and the CLI hangs after printing its success message.
      process.stdin.pause();
      if (answer !== 'y' && answer !== 'yes') { console.log('cancelled'); return; }
    }
    const out = await api.delete<{ ok: boolean; tokensRevoked: number; sessionsUnmanaged: number; wsClosed?: boolean }>(
      `/api/v1/desktops/${encodeURIComponent(machineId)}`,
    );
    console.log(`✓ deleted desktop ${machineId}`);
    console.log(`  tokens revoked:    ${out.tokensRevoked}`);
    console.log(`  sessions unmanaged: ${out.sessionsUnmanaged}`);
    if (out.wsClosed) console.log(`  closed the live /supervisor WS`);
  });

const desktopCreate = new Command('create-session')
  .description('ask a desktop daemon to spawn a managed CC session in a folder. The first arg accepts either a machineId (the long uuid) for your OWN desktops or the integer desktops.id (the # column from `claw desktop list`) for desktops shared with you. Shared desktops require an `operator` role.')
  .argument('<desktop>', 'desktops.id (e.g. 12) for shared desktops, or machineId (uuid) for desktops you own')
  .argument('<folder>',    'absolute path on the desktop where CC should be spawned')
  .option('--routing-name <name>',    'optional routing name for the new session (e.g. @frontend)')
  .option('--flag <flag...>',         'extra CLI flag to pass to claude. Repeat for multiple. Use one argv slot per --flag (e.g. --flag --model --flag opus, or --flag --model=opus). Reference: https://code.claude.com/docs/en/cli-reference#cli-flags')
  .option('--manual-start',           'do NOT auto-press Enter on startup; operator answers prompts via screenshot PIP / `claw session input`')
  .option('--auto-start',             'respawn this session whenever the desktop daemon reconnects (e.g. after PC reboot). With --preserve-session-id, the respawn keeps the same sessionId; without it, each respawn mints a fresh sessionId + token.')
  .option('--preserve-session-id',    'opt the session into sessionId-permanence: Reset (soft restart) becomes available, autoStart-respawn keeps the same sessionId, and history + agent.session_id + webhook pins survive across all restart shapes. Default false (impermanent — every restart rotates state).')
  .action(async (desktop: string, folder: string, opts: { routingName?: string; flag?: string[]; manualStart?: boolean; autoStart?: boolean; preserveSessionId?: boolean }) => {
    const body: Record<string, unknown> = { folder };
    if (opts.routingName)       body.routingName       = opts.routingName;
    if (opts.flag && opts.flag.length > 0) body.flags  = opts.flag;
    if (opts.manualStart)       body.autoEnter         = false;
    if (opts.autoStart)         body.autoStart         = true;
    if (opts.preserveSessionId) body.preserveSessionId = true;
    // The path param is polymorphic on the server: all-digits → desktops.id,
    // anything else → caller's own machineId. The CLI passes the arg through.
    const out = await api.post<{ sessionId: string }>(
      `/api/v1/desktops/${encodeURIComponent(desktop)}/sessions`, body,
    );
    console.log(`✓ session created: ${out.sessionId}`);
    if (opts.autoStart)         console.log(`  auto-start:          ON`);
    if (opts.preserveSessionId) console.log(`  preserve session id: ON`);
  });

// ─── Desktop sharing ─────────────────────────────────────────────────
// Grant other users the right to spawn + control sessions on a desktop
// you own. Mirrors `claw session share` but at the desktop axis.
// See: https://github.com/clawborrator/hub_v1/blob/main/docs/DESKTOP-SHARING.md

const VALID_DESKTOP_ROLES = ['viewer', 'operator'] as const;

function parseDesktopId(s: string): number {
  if (!/^\d+$/.test(s)) {
    console.error(`error: <desktopId> must be the integer id (the # column from \`claw desktop list\`), not a machineId. Got: ${s}`);
    process.exit(2);
  }
  return Number(s);
}

const desktopShare = new Command('share')
  .description('grant another GitHub user access to a desktop you own. role defaults to operator (viewer = see the desktop + its sessions; operator = + spawn new sessions + kill/restart them). Owner-only.')
  .argument('<desktopId>', 'integer desktop id (the # column from `claw desktop list`)')
  .argument('<login>',     'GitHub login of the user to share with (with or without leading @)')
  .option('--role <role>', `viewer | operator`, 'operator')
  .action(async (desktopIdRaw: string, login: string, opts: { role?: string }) => {
    const desktopId = parseDesktopId(desktopIdRaw);
    const role = (opts.role ?? 'operator').toLowerCase();
    if (!(VALID_DESKTOP_ROLES as readonly string[]).includes(role)) {
      console.error(`error: --role must be one of: ${VALID_DESKTOP_ROLES.join(', ')}`);
      process.exit(2);
    }
    const cleanLogin = login.replace(/^@/, '');
    const out = await api.post<{ ok: boolean; desktopId: number; login: string; role: string }>(
      `/api/v1/desktops/${desktopId}/shares`,
      { login: cleanLogin, role },
    );
    console.log(`✓ shared desktop #${out.desktopId} with @${out.login} as ${out.role}`);
    if (out.role === 'operator') {
      console.log(`  they can now: claw desktop create-session ${out.desktopId} <folder>`);
    }
  });

const desktopShares = new Command('shares')
  .description('list users granted access to a desktop. Owner-only view. The sessionCount column is how many live sessions each sharee currently has on the desktop (these get killed on unshare).')
  .argument('<desktopId>', 'integer desktop id (the # column from `claw desktop list`)')
  .action(async (desktopIdRaw: string) => {
    const desktopId = parseDesktopId(desktopIdRaw);
    const out = await api.get<{ items: { userLogin: string; role: string; sharedByLogin: string; createdAt: string; sessionCount: number }[] }>(
      `/api/v1/desktops/${desktopId}/shares`,
    );
    if (out.items.length === 0) {
      console.log('(no shares — only the owner has access)');
      return;
    }
    for (const s of out.items) {
      const count = s.sessionCount > 0 ? `  ${s.sessionCount} live session${s.sessionCount === 1 ? '' : 's'}` : '';
      console.log(`  @${s.userLogin.padEnd(20)} ${s.role.padEnd(9)} by @${s.sharedByLogin.padEnd(15)} since ${s.createdAt}${count}`);
    }
  });

const desktopUnshare = new Command('unshare')
  .description('revoke a user\'s desktop share access. Owner-only. ALSO terminates any sessions the revoked user spawned on this desktop — immediately if the daemon is online, otherwise deferred to the daemon\'s next reconnect (hello-frame reconciliation sweep).')
  .argument('<desktopId>', 'integer desktop id (the # column from `claw desktop list`)')
  .argument('<login>',     'GitHub login (with or without leading @)')
  .option('--yes',         'skip the confirmation prompt')
  .action(async (desktopIdRaw: string, login: string, opts: { yes?: boolean }) => {
    const desktopId = parseDesktopId(desktopIdRaw);
    const cleanLogin = login.replace(/^@/, '');
    if (!opts.yes) {
      process.stdout.write(`Revoke @${cleanLogin}'s access to desktop #${desktopId}? This will also terminate sessions @${cleanLogin} spawned on this desktop. [y/N] `);
      const answer = await new Promise<string>((res) => {
        process.stdin.once('data', (d) => res(d.toString().trim().toLowerCase()));
      });
      process.stdin.pause();
      if (answer !== 'y' && answer !== 'yes') { console.log('cancelled'); return; }
    }
    const out = await api.delete<{ ok: boolean; login: string; removed: number; killed: number; deferred: number }>(
      `/api/v1/desktops/${desktopId}/shares/${encodeURIComponent(cleanLogin)}`,
    );
    if (out.removed === 0) {
      console.log(`(no share to revoke — @${out.login} didn't have access)`);
      return;
    }
    let suffix = '';
    if (out.killed > 0)       suffix += `, terminated ${out.killed} session${out.killed === 1 ? '' : 's'}`;
    else if (out.deferred > 0) suffix += `, ${out.deferred} session${out.deferred === 1 ? '' : 's'} will be killed on daemon reconnect`;
    console.log(`✗ revoked @${out.login}'s access to desktop #${desktopId}${suffix}`);
  });

export const desktopCmd = new Command('desktop')
  .description('inspect + control desktop daemons (clawborrator-supervisor) and manage desktop sharing')
  .addCommand(desktopList)
  .addCommand(desktopDelete)
  .addCommand(desktopCreate)
  .addCommand(desktopShare)
  .addCommand(desktopShares)
  .addCommand(desktopUnshare);

function fmtAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000)    return Math.max(1, Math.floor(ms / 1000)) + 's ago';
  if (ms < 3600_000)  return Math.floor(ms / 60_000) + 'm ago';
  if (ms < 86400_000) return Math.floor(ms / 3600_000) + 'h ago';
  return Math.floor(ms / 86400_000) + 'd ago';
}
