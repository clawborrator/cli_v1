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
  .description('list desktop daemons registered for the current user')
  .action(async () => {
    const data = await api.get<{ items: ApiDesktop[] }>('/api/v1/desktops');
    if (data.items.length === 0) { console.log('no registered desktops'); return; }
    for (const d of data.items) {
      const dot = d.online ? '●' : '○';
      const host = d.hostname ?? '(unknown host)';
      const ver  = d.daemonVersion ?? '?';
      console.log(`${dot} ${d.machineId.slice(0, 8)}  ${host.padEnd(24)} v${ver.padEnd(8)} last-seen ${fmtAgo(d.lastSeenAt)}`);
    }
  });

const desktopCreate = new Command('create-session')
  .description('ask a desktop daemon to spawn a managed CC session in a folder')
  .argument('<machineId>', 'desktop machine id (from `claw desktop list`)')
  .argument('<folder>',    'absolute path on the desktop where CC should be spawned')
  .option('--routing-name <name>', 'optional routing name for the new session (e.g. @frontend)')
  .option('--flag <flag...>',      'extra CLI flag to pass to claude. Repeat for multiple. Use one argv slot per --flag (e.g. --flag --model --flag opus, or --flag --model=opus). Reference: https://code.claude.com/docs/en/cli-reference#cli-flags')
  .option('--manual-start',        'do NOT auto-press Enter on startup; operator answers prompts via screenshot PIP / `claw session input`')
  .action(async (machineId: string, folder: string, opts: { routingName?: string; flag?: string[]; manualStart?: boolean }) => {
    const body: Record<string, unknown> = { folder };
    if (opts.routingName) body.routingName = opts.routingName;
    if (opts.flag && opts.flag.length > 0) body.flags = opts.flag;
    if (opts.manualStart) body.autoEnter = false;
    const out = await api.post<{ sessionId: string }>(
      `/api/v1/desktops/${encodeURIComponent(machineId)}/sessions`, body,
    );
    console.log(`✓ session created: ${out.sessionId}`);
  });

export const desktopCmd = new Command('desktop')
  .description('inspect + control desktop daemons (clawborrator-supervisor)')
  .addCommand(desktopList)
  .addCommand(desktopCreate);

function fmtAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000)    return Math.max(1, Math.floor(ms / 1000)) + 's ago';
  if (ms < 3600_000)  return Math.floor(ms / 60_000) + 'm ago';
  if (ms < 86400_000) return Math.floor(ms / 3600_000) + 'h ago';
  return Math.floor(ms / 86400_000) + 'd ago';
}
