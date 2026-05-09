// Cross-session routing commands. Phase 4 of hub_v1; depends on
// Phase D of channel_v1 to actually deliver routed prompts into the
// receiver's Claude. v1 verifies the wire-up; the receiver-side
// "Claude actually sees this prompt" is follow-on work.

import { Command } from 'commander';
import { api } from '../client/api.js';

interface ApiPeer {
  routingName: string;
  ownerLogin:  string;
  mine:        boolean;
  sessionId:   string;
  cwd:         string | null;
  online:      boolean;
}

const peersCmd = new Command('peers')
  .description('list your sessions reachable for cross-session routing — own + shared')
  .action(async () => {
    const data = await api.get<{ items: ApiPeer[] }>('/api/v1/peers');
    if (data.items.length === 0) {
      console.log('no peers (no sessions registered yet)');
      return;
    }
    // Render the qualified `@<owner>/<slug>` form. When you have own
    // and shared sessions with the same slug, qualified form is what
    // disambiguates them in `claw route` / `@-redirect` invocations.
    for (const p of data.items) {
      const dot   = p.online ? '●' : '○';
      const where = p.cwd ? ` ${p.cwd}` : '';
      const qualifiedName = `@${p.ownerLogin}/${p.routingName.replace(/^@/, '')}`;
      const tag   = p.mine ? '' : ' (shared)';
      console.log(`${dot} ${qualifiedName.padEnd(28)} ${p.online ? 'online ' : 'offline'}${tag}${where}`);
    }
  });

interface RouteResponse {
  ok:        boolean;
  chatId:    string;
  sessionId: string;
  mode:      'ask' | 'tell';
  reply?:    string;       // ask + ok
  replyTs?:  string;       // ask + ok
  timedOut?: boolean;      // ask + !ok
  error?:    string;       // !ok
}

const routeCmd = new Command('route')
  .description('send a one-shot prompt to a peer session; ask mode (default) blocks for the reply, tell mode is fire-and-forget')
  .argument('<peer>',   'routingName (e.g. @foo, foo, @owner/foo)')
  .argument('<prompt>', 'text to send (quote it to keep spaces)')
  .option('--mode <mode>', 'ask | tell', 'ask')
  .action(async (peer: string, prompt: string, opts: { mode?: string }) => {
    const mode = opts.mode === 'tell' ? 'tell' : 'ask';
    // Server-side resolvePeerName tolerates leading @ or bare slug;
    // CLI passes through verbatim so PowerShell users can do
    // `claw route driver "..."` without quoting.
    const out = await api.post<RouteResponse>(
      `/api/v1/peers/${encodeURIComponent(peer)}/route`,
      { prompt, mode },
    );
    console.log(`✓ routed to ${peer} (chatId ${out.chatId.slice(0, 8)}…)`);
    if (mode === 'tell') {
      console.log('  mode: tell (fire-and-forget). Watch the reply in `claw session attach` if needed.');
      return;
    }
    if (out.ok && out.reply !== undefined) {
      console.log('');
      console.log(out.reply);
      return;
    }
    if (out.timedOut) {
      console.error(`error: ${out.error}`);
      console.error('  (the peer may still answer later — `claw session events ' + peer + '` will show it if it lands)');
      process.exit(2);
    }
    console.error(`error: ${out.error ?? 'no reply'}`);
    process.exit(2);
  });

const probeCmd = new Command('probe')
  .description('fan-out the same prompt to many peers in parallel')
  .argument('<prompt>', 'text to send (quote it)')
  .option('--peers <csv>', 'comma-separated routing names; default = all online peers')
  .action(async (prompt: string, opts: { peers?: string }) => {
    const peerList = opts.peers ? opts.peers.split(',').map((s) => s.trim()).filter(Boolean) : null;
    const out = await api.post<{ dispatched: { peer: string; sessionId: string; status: string }[] }>(
      '/api/v1/peers/probe',
      { prompt, peers: peerList },
    );
    if (out.dispatched.length === 0) {
      console.log('probe sent to 0 peers (nothing online matched)');
      return;
    }
    console.log(`✓ probe dispatched to ${out.dispatched.length} peer${out.dispatched.length === 1 ? '' : 's'}:`);
    for (const r of out.dispatched) {
      const mark = r.status === 'sent' ? '✓' : '·';
      console.log(`  ${mark} ${r.peer.padEnd(20)} ${r.status}`);
    }
  });

export { peersCmd, routeCmd, probeCmd };
