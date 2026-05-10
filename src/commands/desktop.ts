// `claw desktop ...` — list registered desktop daemons + drive
// session control via the supervisor RPC. Mirrors what the SPA
// renders in the orchard-chat header (managed-session affordances)
// but from the terminal.

import { Command } from 'commander';
import { api } from '../client/api.js';

interface ApiDesktop {
  machineId:     string;
  hostname:      string | null;
  daemonVersion: string | null;
  registeredAt:  string;
  lastSeenAt:    string;
  online:        boolean;
}

const desktopList = new Command('list')
  .alias('ls')
  .description('list desktop daemons registered for the current user. Prints the full machineId so it can be passed verbatim to `claw desktop delete`.')
  .action(async () => {
    const data = await api.get<{ items: ApiDesktop[] }>('/api/v1/desktops');
    if (data.items.length === 0) { console.log('no registered desktops'); return; }
    for (const d of data.items) {
      const dot = d.online ? '●' : '○';
      const host = d.hostname ?? '(unknown host)';
      const ver  = d.daemonVersion ?? '?';
      console.log(`${dot} ${d.machineId}  ${host.padEnd(24)} v${ver.padEnd(8)} last-seen ${fmtAgo(d.lastSeenAt)}`);
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
  .description('ask a desktop daemon to spawn a managed CC session in a folder')
  .argument('<machineId>', 'desktop machine id (from `claw desktop list`)')
  .argument('<folder>',    'absolute path on the desktop where CC should be spawned')
  .option('--routing-name <name>',    'optional routing name for the new session (e.g. @frontend)')
  .option('--flag <flag...>',         'extra CLI flag to pass to claude. Repeat for multiple. Use one argv slot per --flag (e.g. --flag --model --flag opus, or --flag --model=opus). Reference: https://code.claude.com/docs/en/cli-reference#cli-flags')
  .option('--manual-start',           'do NOT auto-press Enter on startup; operator answers prompts via screenshot PIP / `claw session input`')
  .option('--auto-start',             'respawn this session whenever the desktop daemon reconnects (e.g. after PC reboot). With --preserve-session-id, the respawn keeps the same sessionId; without it, each respawn mints a fresh sessionId + token.')
  .option('--preserve-session-id',    'opt the session into sessionId-permanence: Reset (soft restart) becomes available, autoStart-respawn keeps the same sessionId, and history + agent.session_id + webhook pins survive across all restart shapes. Default false (impermanent — every restart rotates state).')
  .action(async (machineId: string, folder: string, opts: { routingName?: string; flag?: string[]; manualStart?: boolean; autoStart?: boolean; preserveSessionId?: boolean }) => {
    const body: Record<string, unknown> = { folder };
    if (opts.routingName)       body.routingName       = opts.routingName;
    if (opts.flag && opts.flag.length > 0) body.flags  = opts.flag;
    if (opts.manualStart)       body.autoEnter         = false;
    if (opts.autoStart)         body.autoStart         = true;
    if (opts.preserveSessionId) body.preserveSessionId = true;
    const out = await api.post<{ sessionId: string }>(
      `/api/v1/desktops/${encodeURIComponent(machineId)}/sessions`, body,
    );
    console.log(`✓ session created: ${out.sessionId}`);
    if (opts.autoStart)         console.log(`  auto-start:          ON`);
    if (opts.preserveSessionId) console.log(`  preserve session id: ON`);
  });

export const desktopCmd = new Command('desktop')
  .description('inspect + control desktop daemons (clawborrator-supervisor)')
  .addCommand(desktopList)
  .addCommand(desktopDelete)
  .addCommand(desktopCreate);

function fmtAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000)    return Math.max(1, Math.floor(ms / 1000)) + 's ago';
  if (ms < 3600_000)  return Math.floor(ms / 60_000) + 'm ago';
  if (ms < 86400_000) return Math.floor(ms / 3600_000) + 'h ago';
  return Math.floor(ms / 86400_000) + 'd ago';
}
