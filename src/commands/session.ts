// `claw session ...` — list/info/archive/share/etc. v1 of v1 ships
// list + info; mutations land alongside the TUI work in Phase 3.

import { Command } from 'commander';
import { api } from '../client/api.js';
import { loadConfig } from '../config.js';
import { sessionAttach } from './session-attach.js';
import { pickCandidate, AmbiguousError } from '../util/disambiguate.js';
import type { ApiSession, ApiFile } from '../shared/index.js';

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const sec = Math.floor(ms / 1000);
  if (sec < 60)        return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60)        return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24)         return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function fmtAgo(iso: string): string {
  return fmtDuration(Date.now() - new Date(iso).getTime());
}

// Resolve a session reference into a UUID. Accepts:
//   • UUID                 (passed through)
//   • @driver, driver      (own session, @ optional — PowerShell strips
//                           bare `@driver` via splatting)
//   • @MRIIOT/driver,
//     MRIIOT/driver        (qualified form: routing name `@driver`
//                           owned by user MRIIOT — what list output
//                           displays so muscle memory carries over)
// The list endpoint is already scoped server-side to (sessions I own
// ∪ sessions shared with me), so a single GET resolves all three forms.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RoutingParts { ownerLogin: string | null; slug: string }

function splitRoutingRef(ref: string): RoutingParts {
  // Normalize: ensure leading '@', then split owner/slug if present.
  const needle = ref.startsWith('@') ? ref : '@' + ref;
  const slash  = needle.indexOf('/');
  if (slash > 0) {
    return {
      ownerLogin: needle.slice(1, slash),
      slug:       '@' + needle.slice(slash + 1).replace(/^@/, ''),
    };
  }
  return { ownerLogin: null, slug: needle };
}

function filterByRoutingParts(items: ApiSession[], parts: RoutingParts): ApiSession[] {
  let candidates = items.filter((s) => s.routingName === parts.slug);
  if (parts.ownerLogin !== null) {
    // Qualified `@owner/slug` — must match owner exactly.
    candidates = candidates.filter((s) => s.startedByLogin === parts.ownerLogin);
  } else {
    // Bare or `@slug` — when both an owned and a shared session use
    // the same routing name (e.g. you have @frontend AND Alice
    // shared her @frontend with you), prefer your own. To target the
    // shared one explicitly, type `@alice/frontend`.
    const mine = candidates.filter((s) => s.role === 'owner');
    if (mine.length > 0) candidates = mine;
  }
  return candidates;
}

function noRoutingMatchError(parts: RoutingParts): Error {
  const err: any = new Error(
    parts.ownerLogin
      ? `no session @${parts.ownerLogin}/${parts.slug.slice(1)} (run \`claw session list\`)`
      : `no session with routing name ${parts.slug} (run \`claw session list\`)`,
  );
  err.code = 'CLW_NO_ROUTING_MATCH';
  return err;
}

function ambiguousError(idOrName: string, e: AmbiguousError): Error {
  const usedQualified = idOrName.includes('/');
  const advice = usedQualified
    ? `'${idOrName}' is ambiguous even within owner — multiple sessions share the same routing name (different cwds with matching basenames). Re-run with a UUID:`
    : `'${idOrName}' is ambiguous — re-run with the qualified @owner/slug form, or with a UUID if even that collides:`;
  const err: any = new Error(
    advice + '\n' +
    e.candidates.map((c) => `  ${c.id}  @${c.startedByLogin}/${(c.routingName ?? '').replace(/^@/, '')}  ${c.cwd ?? ''}`).join('\n'),
  );
  err.code = 'CLW_AMBIGUOUS';
  return err;
}

async function resolveSessionId(idOrName: string, opts: { destructive?: boolean } = {}): Promise<string> {
  if (UUID_RE.test(idOrName)) return idOrName;
  const parts = splitRoutingRef(idOrName);
  const data  = await api.get<{ items: ApiSession[] }>('/api/v1/sessions');
  const candidates = filterByRoutingParts(data.items, parts);
  if (candidates.length === 0) throw noRoutingMatchError(parts);
  // If multiple candidates remain, the operator can't be sure which
  // one their command will hit — prompt (or, in non-TTY contexts,
  // throw with the candidate list so they can rerun with a UUID).
  // For destructive ops, prompt on any multi-match (online + offline
  // both count); for read ops, prefer-live silently.
  try {
    const picked = await pickCandidate(idOrName, candidates, { destructive: !!opts.destructive });
    return picked.id;
  } catch (e: any) {
    if (e instanceof AmbiguousError) throw ambiguousError(idOrName, e);
    throw e;
  }
}

function buildSessionListQs(opts: { connected?: boolean; all?: boolean }): string {
  const qs = new URLSearchParams();
  if (opts.connected) qs.set('connected', 'true');
  if (opts.all)       qs.set('archived',  'true');
  return qs.toString() ? '?' + qs : '';
}

function printSessionListRow(s: ApiSession): void {
  const dot       = s.connected ? '●' : '○';
  const slug      = s.routingName ?? '';
  const qualified = slug
    ? `@${s.startedByLogin}/${slug.replace(/^@/, '')}`
    : '(no routing name)';
  const where = s.cwd ? ` ${s.cwd}` : '';
  const role  = s.role.padEnd(8);
  const seen  = s.connected ? 'online' : `offline · ${fmtAgo(s.lastSeenAt)}`;
  const arch  = s.archivedAt ? ' · ARCHIVED' : '';
  console.log(`${dot} ${qualified.padEnd(28)} ${role}${where}  [${seen}]${arch}`);
  console.log(`    id: ${s.id}`);
}

function printSessionListFooter(): void {
  console.log('');
  console.log('  attach to a session:    claw session attach <ref>');
  console.log('  recent hook/chat:       claw session events <ref>');
  console.log('  operator-to-op chat:    claw session messages <ref>');
  console.log('  <ref> = UUID, @owner/slug, @slug, or bare slug');
  console.log('  (PowerShell tip: use the bare-slug form — `@driver` is parsed as');
  console.log('   a splatting operator and stripped before reaching the CLI)');
}

const sessionList = new Command('list')
  .alias('ls')
  .description('list sessions you can see')
  .option('--connected',        'only sessions whose channel WS is currently open')
  .option('--all',              'include archived sessions')
  .action(async (opts: { connected?: boolean; all?: boolean }) => {
    const data = await api.get<{ items: ApiSession[] }>(
      '/api/v1/sessions' + buildSessionListQs(opts),
    );
    if (data.items.length === 0) {
      console.log('no sessions');
      return;
    }
    // Compact two-line-per-session listing. Line 1 is the human
    // summary (qualified routing name, role, cwd, status); line 2
    // is the full UUID. The qualified form `@<owner>/<slug>` is
    // the wire-format addressing convention — surfacing it here
    // builds operator muscle memory. UUID stays the authoritative
    // identifier and most commands also accept the short
    // `@<slug>` (or even bare `<slug>`) form.
    for (const s of data.items) printSessionListRow(s);
    printSessionListFooter();
  });

const sessionInfo = new Command('info')
  .description('show metadata for a single session')
  .argument('<ref>', 'session UUID or @routingName')
  .action(async (ref: string) => {
    const id = await resolveSessionId(ref);
    const s = await api.get<ApiSession>(`/api/v1/sessions/${encodeURIComponent(id)}`);
    console.log(`session  : ${s.id}`);
    console.log(`routing  : ${s.routingName ?? '(none)'}`);
    console.log(`owner    : @${s.startedByLogin}`);
    console.log(`my role  : ${s.role}`);
    console.log(`host     : ${s.host ?? '?'}`);
    console.log(`cwd      : ${s.cwd ?? '?'}`);
    console.log(`channel v: ${s.channelVersion ?? '?'}`);
    console.log(`started  : ${s.startedAt}`);
    console.log(`last seen: ${s.lastSeenAt}`);
    console.log(`status   : ${s.connected ? 'connected' : 'offline'}${s.archivedAt ? ' · ARCHIVED' : ''}`);
    // Managed-session block — only printed when the session is
    // managed by a desktop daemon. Surfaces the fields the SPA's
    // Actions menu shows (autoStart, autoEnter) so the CLI is at
    // parity for inspection.
    if (s.managedBy?.machineId) {
      const ver = s.managedBy.daemonVersion ? ` (daemon ${s.managedBy.daemonVersion})` : '';
      console.log(`managed  : ${s.managedBy.machineId}${ver}`);
      console.log(`autoStart: ${s.autoStart ? 'ON' : 'OFF'}`);
      // autoEnter undefined → server is older than the persistence
      // change; show '?' rather than guessing the default.
      const ae = s.autoEnter === undefined ? '?' : (s.autoEnter ? 'ON (auto)' : 'OFF (manual)');
      console.log(`autoEnter: ${ae}`);
      // extraFlags undefined → server is pre-persistence (older hub);
      // empty array → recorded but no flags supplied at create.
      const flags = s.extraFlags;
      if (flags === undefined)        console.log('flags    : ?');
      else if (flags.length === 0)    console.log('flags    : (none)');
      else                            console.log(`flags    : ${flags.join(' ')}`);
    }
    if (s.agentHandle) {
      console.log(`agent    : ${s.agentHandle}`);
    }
  });

interface ApiEvent {
  id:        number;
  sessionId: string;
  kind:      'chat' | 'tail';
  type:      string;
  payload:   Record<string, unknown>;
  ts:        string;
}

interface ApiOpMessage {
  id:           number;
  sessionId:    string;
  authorLogin:  string;
  text:         string;
  mentions:     string[];
  ts:           string;
  editedAt:     string | null;
  deletedAt:    string | null;
}

interface PagedResponse<T> {
  items:   T[];
  firstId: number | null;
  lastId:  number | null;
  hasMore: boolean;
}

interface EventsOpts {
  limit?: string; after?: string; before?: string;
  kind?: string; type?: string; json?: boolean;
}

function buildEventsQs(opts: EventsOpts): URLSearchParams {
  const qs = new URLSearchParams({ limit: opts.limit ?? '200' });
  if (opts.after)  qs.set('after',  opts.after);
  if (opts.before) qs.set('before', opts.before);
  if (opts.kind)   qs.set('kind',   opts.kind);
  if (opts.type)   qs.set('type',   opts.type);
  return qs;
}

function printEventRow(ev: ApiEvent): void {
  const ts = ev.ts.slice(11, 19);
  const text = (ev.payload?.text ?? ev.payload?.preview ?? '');
  const preview = typeof text === 'string' && text
    ? (text.length > 200 ? text.slice(0, 200) + '…' : text).replace(/\s+/g, ' ')
    : '';
  console.log(`#${String(ev.id).padStart(5)} ${ts} ${ev.kind.padEnd(4)} ${ev.type.padEnd(20)} ${preview}`);
}

function printPagedHasMore<T>(data: PagedResponse<T>, json: boolean | undefined): void {
  if (data.hasMore && !json) {
    console.log(`(more — older: --before ${data.firstId} · newer: --after ${data.lastId})`);
  }
}

const sessionEvents = new Command('events')
  .description('dump recent events for a session (history; non-TUI)')
  .argument('<ref>', 'session UUID or @routingName')
  .option('--limit <n>',   'max events to return (default 200, max 1000)', '200')
  .option('--after <id>',  'forward pagination: events with id > given')
  .option('--before <id>', 'backward pagination: events with id < given')
  .option('--kind <k>',    'filter to chat or tail')
  .option('--type <t>',    'filter by type (e.g. PreToolUse, reply)')
  .option('--json',        'emit one JSON object per line instead of human-readable')
  .action(async (ref: string, opts: EventsOpts) => {
    if (opts.after && opts.before) { console.error('error: use --after OR --before, not both'); process.exit(2); }
    const id = await resolveSessionId(ref);
    const qs = buildEventsQs(opts);
    const data = await api.get<PagedResponse<ApiEvent>>(
      `/api/v1/sessions/${encodeURIComponent(id)}/events?${qs.toString()}`,
    );
    if (data.items.length === 0) {
      if (!opts.json) console.log('no events');
      return;
    }
    for (const ev of data.items) {
      if (opts.json) { console.log(JSON.stringify(ev)); continue; }
      printEventRow(ev);
    }
    printPagedHasMore(data, opts.json);
  });

interface MessagesOpts {
  limit?: string; after?: string; before?: string; json?: boolean;
}

function buildMessagesQs(opts: MessagesOpts): URLSearchParams {
  const qs = new URLSearchParams({ limit: opts.limit ?? '100' });
  if (opts.after)  qs.set('after',  opts.after);
  if (opts.before) qs.set('before', opts.before);
  return qs;
}

function printOpMessageRow(m: ApiOpMessage): void {
  const ts = m.ts.slice(11, 19);
  const flag = m.deletedAt ? ' [deleted]' : (m.editedAt ? ' [edited]' : '');
  console.log(`#${String(m.id).padStart(5)} ${ts} @${m.authorLogin.padEnd(20)} ${m.text}${flag}`);
}

const sessionMessages = new Command('messages')
  .alias('msgs')
  .description('dump operator-to-operator chat for a session (op-messages history)')
  .argument('<ref>', 'session UUID or @routingName')
  .option('--limit <n>',   'max messages to return (default 100, max 500)', '100')
  .option('--after <id>',  'forward pagination')
  .option('--before <id>', 'backward pagination')
  .option('--json',        'emit one JSON object per line')
  .action(async (ref: string, opts: MessagesOpts) => {
    if (opts.after && opts.before) { console.error('error: use --after OR --before, not both'); process.exit(2); }
    const id = await resolveSessionId(ref);
    const qs = buildMessagesQs(opts);
    const data = await api.get<PagedResponse<ApiOpMessage>>(
      `/api/v1/sessions/${encodeURIComponent(id)}/op-messages?${qs.toString()}`,
    );
    if (data.items.length === 0) {
      if (!opts.json) console.log('no op-messages');
      return;
    }
    for (const m of data.items) {
      if (opts.json) { console.log(JSON.stringify(m)); continue; }
      printOpMessageRow(m);
    }
    printPagedHasMore(data, opts.json);
  });

const sessionArchive = new Command('archive')
  .description('soft-delete a session (sets archivedAt). Note: register-time reconnect unarchives, so a session whose UUID is still in a project\'s .claude/clawborrator/identity.json will resurrect on its next start.')
  .argument('<ref>', 'session UUID or @routingName')
  .action(async (ref: string) => {
    const id = await resolveSessionId(ref);
    const r = await api.post<{ ok: boolean; alreadyArchived?: boolean; sessionId: string; archivedAt: string }>(
      `/api/v1/sessions/${encodeURIComponent(id)}/archive`, {});
    if (r.alreadyArchived) {
      console.log(`(already archived: ${r.sessionId} at ${r.archivedAt})`);
    } else {
      console.log(`✓ archived ${r.sessionId} at ${r.archivedAt}`);
    }
  });

interface PruneResult {
  ok:      boolean;
  dryRun:  boolean;
  kept:    { routingName: string; sessionId: string }[];
  deleted: { routingName: string; sessionId: string; lastSeenAt: string; wasArchived: boolean }[];
}

function buildPruneBody(opts: { dryRun?: boolean; routing?: string }): Record<string, unknown> {
  const body: Record<string, unknown> = { dryRun: !!opts.dryRun };
  if (opts.routing) body.routingName = opts.routing.startsWith('@') ? opts.routing : '@' + opts.routing;
  return body;
}

function printPruneResult(r: PruneResult): void {
  const verb = r.dryRun ? 'would delete' : 'deleted';
  console.log(`${verb} ${r.deleted.length} duplicate${r.deleted.length === 1 ? '' : 's'}:`);
  for (const d of r.deleted) {
    const tag = d.wasArchived ? ' [was archived]' : '';
    console.log(`  ✗ ${d.routingName.padEnd(20)} ${d.sessionId}  (last seen ${d.lastSeenAt})${tag}`);
  }
  console.log(`keeping:`);
  for (const k of r.kept) {
    console.log(`  ✓ ${k.routingName.padEnd(20)} ${k.sessionId}`);
  }
  if (r.dryRun) console.log('\n(--dry-run — re-run without it to apply)');
}

const sessionPrune = new Command('prune')
  .description('hard-delete duplicate session rows that share a routing name. The live (or most-recently-seen) row is kept; the rest are removed along with their events / op-messages / shares (FK cascade). Use --dry-run first if unsure.')
  .option('--dry-run',          'show what would be deleted without writing')
  .option('--routing <name>',   'narrow to a single routing name (e.g. @driver)')
  .action(async (opts: { dryRun?: boolean; routing?: string }) => {
    const r = await api.post<PruneResult>(`/api/v1/sessions/prune`, buildPruneBody(opts));
    if (r.deleted.length === 0) {
      console.log('nothing to prune (no routing-name duplicates).');
      return;
    }
    printPruneResult(r);
  });

const sessionDelete = new Command('delete')
  .description('hard-delete a single session — cascades events / op-messages / shares / files (refcount-sweeps blobs). Irreversible. Use `archive` for the soft form (auto-resurrects on reconnect). Prompts if the routing name matches more than one row, even when only one is online — both are equally permanent to delete.')
  .argument('<ref>', 'session UUID or @routingName')
  .option('--hard', 'required: confirm you want a permanent delete (no soft form is offered without this flag)')
  .action(async (ref: string, opts: { hard?: boolean }) => {
    if (!opts.hard) {
      console.error('error: hard delete requires --hard. Did you mean `claw session archive <ref>`?');
      process.exit(2);
    }
    // destructive=true so the disambiguator prompts whenever the
    // routing name matches more than one non-archived row, online
    // or offline. Default (read-side) behavior would silently pick
    // the live one, leaving the offline ghost for the operator to
    // discover by re-running and accidentally deleting it too.
    const id = await resolveSessionId(ref, { destructive: true });
    const r = await api.delete<{ ok: boolean; sessionId: string; deleted: boolean; blobsSwept?: number; bytesFreed?: number }>(
      `/api/v1/sessions/${encodeURIComponent(id)}?hard=true`);
    const sweep = (r.blobsSwept && r.blobsSwept > 0)
      ? ` · swept ${r.blobsSwept} blob${r.blobsSwept === 1 ? '' : 's'} (${r.bytesFreed ?? 0} bytes freed)`
      : '';
    // Cascade list mirrors the FK chain on the hub: sessions →
    // events / op-messages / shares / files / permission_requests /
    // reply_chunks (direct), AND sessions → agents → agent_query_log
    // (two-hop). If the session was published as an agent, the
    // agent row + its entire audit trail go with it. Honest message
    // beats the "events / op-messages / shares / files" half-truth
    // that hid the agent_query_log loss.
    console.log(`✗ deleted ${r.sessionId} (events / op-messages / shares / files / permission_requests / reply_chunks / any agent + agent_query_log cascaded)${sweep}`);
  });

const sessionPrompt = new Command('prompt')
  .description('send a one-shot prompt to a session\'s live Claude. Fire-and-forget — to find the eventual reply, run `claw session events <ref> --kind=chat --type=reply` (or `claw route <peer> "..."` for ask-mode that blocks for the answer). Use `--attach <fileId>` (repeatable) to attach files structurally — equivalent to inlining `fileId=N` tokens but cleaner; the receiving session sees the rewritten ids in its prompt text after forward-clone.')
  .argument('<ref>',  'session UUID or @routingName')
  .argument('<text>', 'prompt text — quote multi-word; may be empty if --attach is supplied')
  .option('--attach <fileId>', 'fileId to attach (repeatable). Each upload happens via POST /api/v1/sessions/<ref>/files first; this flag references an existing fileId.', (v: string, prev: number[] = []) => {
    const n = Number.parseInt(v, 10);
    if (!Number.isInteger(n) || n < 1) throw new Error(`--attach expects a positive integer fileId, got: ${v}`);
    return [...prev, n];
  })
  .action(async (ref: string, text: string, opts: { attach?: number[] }) => {
    const id = await resolveSessionId(ref);
    const attachments = opts.attach && opts.attach.length > 0 ? opts.attach : undefined;
    const body: { text: string; attachments?: number[] } = { text };
    if (attachments) body.attachments = attachments;
    const out = await api.post<{ ok: boolean; chatId: string; ts: string; routedToAgent?: string }>(
      `/api/v1/sessions/${encodeURIComponent(id)}/prompt`,
      body,
    );
    const attachNote = attachments ? ` · ${attachments.length} attachment(s): ${attachments.join(', ')}` : '';
    const routeNote  = out.routedToAgent ? ` · routed to @${out.routedToAgent}` : '';
    console.log(`✓ delivered (chatId=${out.chatId})${routeNote}${attachNote}`);
  });

const VALID_ROLES = ['viewer', 'prompter', 'approver'] as const;

const sessionShareCmd = new Command('share')
  .description('grant another GitHub user access to a session. role defaults to prompter (viewer = read-only events; prompter = + send prompts/op-messages; approver = + resolve permission requests).')
  .argument('<ref>',   'session UUID or @routingName')
  .argument('<login>', 'GitHub login of the user to share with (with or without leading @)')
  .option('--role <role>', `viewer | prompter | approver`, 'prompter')
  .action(async (ref: string, login: string, opts: { role?: string }) => {
    const role = (opts.role ?? 'prompter').toLowerCase();
    if (!(VALID_ROLES as readonly string[]).includes(role)) {
      console.error(`error: --role must be one of: ${VALID_ROLES.join(', ')}`);
      process.exit(2);
    }
    const id = await resolveSessionId(ref);
    const cleanLogin = login.replace(/^@/, '');
    const out = await api.post<{ ok: boolean; sessionId: string; login: string; role: string }>(
      `/api/v1/sessions/${encodeURIComponent(id)}/shares`,
      { login: cleanLogin, role },
    );
    console.log(`✓ shared ${out.sessionId.slice(0, 8)}… with @${out.login} as ${out.role}`);
    console.log(`  they can now: claw session attach ${id}      (or @${out.login}/<slug> from their attach)`);
  });

const sessionSharesCmd = new Command('shares')
  .description('list users granted access to a session via share. Owner-only view.')
  .argument('<ref>', 'session UUID or @routingName')
  .action(async (ref: string) => {
    const id = await resolveSessionId(ref);
    const out = await api.get<{ items: { login: string; role: string; createdAt: string }[] }>(
      `/api/v1/sessions/${encodeURIComponent(id)}/shares`,
    );
    if (out.items.length === 0) {
      console.log('(no shares — only the owner has access)');
      return;
    }
    for (const s of out.items) {
      console.log(`  @${s.login.padEnd(20)} ${s.role.padEnd(9)} since ${s.createdAt}`);
    }
  });

function fmtBytes(n: number): string {
  if (n < 1024)            return `${n} B`;
  if (n < 1024 * 1024)     return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3)       return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

const sessionFiles = new Command('files')
  .description("list a session's file attachments. Use --all to include soft-deleted rows.")
  .argument('<ref>', 'session UUID or @routingName')
  .option('--all',  'include soft-deleted rows')
  .option('--json', 'emit one JSON object per line')
  .action(async (ref: string, opts: { all?: boolean; json?: boolean }) => {
    const id = await resolveSessionId(ref);
    const data = await api.get<{ items: ApiFile[] }>(`/api/v1/sessions/${encodeURIComponent(id)}/files`);
    const live = opts.all ? data.items : data.items.filter((f) => !f.deletedAt);
    if (live.length === 0) {
      if (!opts.json) console.log('no files');
      return;
    }
    // Newest first matches the route's own ordering.
    for (const f of live) {
      if (opts.json) { console.log(JSON.stringify(f)); continue; }
      const ts   = f.uploadedAt.slice(0, 19).replace('T', ' ');
      const flag = f.deletedAt ? ' [deleted]' : '';
      const sha  = f.sha256.slice(0, 12);
      console.log(`#${String(f.id).padStart(5)} ${ts}  ${fmtBytes(f.size).padStart(8)}  @${f.uploaderLogin.padEnd(20)} ${f.scope.padEnd(11)} sha=${sha}…  ${f.filename}${flag}`);
    }
  });

const sessionFileRm = new Command('file-rm')
  .description('delete a file by id. Soft-deletes the row; on-disk blob is swept once no live row references its sha. Prompter+ on the file\'s session.')
  .argument('<fileId>', 'file id (from `claw session files` output, the # column)')
  .action(async (fileId: string) => {
    const id = Number(fileId);
    if (!Number.isFinite(id) || id <= 0) { console.error('error: fileId must be a positive integer'); process.exit(2); }
    const r = await api.delete<{ ok: boolean; alreadyDeleted?: boolean; blobDeleted?: boolean; refsRemaining?: number; freedBytes?: number }>(
      `/api/v1/files/${id}`,
    );
    if (r.alreadyDeleted) {
      console.log(`(file #${id} was already deleted)`);
      return;
    }
    const refs = r.refsRemaining ?? 0;
    if (r.blobDeleted) {
      console.log(`✗ deleted file #${id} — blob swept (${fmtBytes(r.freedBytes ?? 0)} freed; was the last reference)`);
    } else {
      console.log(`✗ deleted file #${id} — blob retained (${refs} other live reference${refs === 1 ? '' : 's'})`);
    }
  });

const sessionUnshareCmd = new Command('unshare')
  .description('revoke a user\'s share access to a session. Owner-only.')
  .argument('<ref>',   'session UUID or @routingName')
  .argument('<login>', 'GitHub login (with or without leading @)')
  .action(async (ref: string, login: string) => {
    const id = await resolveSessionId(ref);
    const cleanLogin = login.replace(/^@/, '');
    const out = await api.delete<{ ok: boolean; sessionId: string; login: string; removed: number }>(
      `/api/v1/sessions/${encodeURIComponent(id)}/shares/${encodeURIComponent(cleanLogin)}`,
    );
    if (out.removed === 0) {
      console.log(`(no share to revoke — @${out.login} didn't have access)`);
    } else {
      console.log(`✗ revoked @${out.login}'s access to ${out.sessionId.slice(0, 8)}…`);
    }
  });

// Managed-session ops — only valid for sessions whose `managedBy`
// is set (i.e., spawned by a desktop daemon). The hub forwards each
// of these to the daemon over /supervisor and waits for the response.

const sessionKill = new Command('kill')
  .description('kill the CC process for a managed session (keeps the session row)')
  .argument('<ref>', 'session UUID, @routingName, or @owner/slug')
  .action(async (ref: string) => {
    const id = await resolveSessionId(ref, { destructive: true });
    await api.post(`/api/v1/sessions/${encodeURIComponent(id)}/kill`, {});
    console.log(`✗ killed CC process for ${id.slice(0, 8)}…`);
  });

const sessionRestart = new Command('restart')
  .description('kill + respawn the CC process for a managed session')
  .argument('<ref>', 'session UUID, @routingName, or @owner/slug')
  .action(async (ref: string) => {
    const id = await resolveSessionId(ref, { destructive: true });
    const out = await api.post<{ sessionId: string }>(
      `/api/v1/sessions/${encodeURIComponent(id)}/restart`, {},
    );
    console.log(`↺ restarted: ${out.sessionId}`);
  });

const sessionScreenshot = new Command('screenshot')
  .description('print the current rendered terminal frame for a managed session')
  .argument('<ref>', 'session UUID, @routingName, or @owner/slug')
  .action(async (ref: string) => {
    const id = await resolveSessionId(ref);
    const out = await api.get<{ rows: number; cols: number; text: string; cursor?: { row: number; col: number } }>(
      `/api/v1/sessions/${encodeURIComponent(id)}/screenshot`,
    );
    console.error(`(${out.cols}×${out.rows} terminal — cursor at ${out.cursor?.row ?? '?'},${out.cursor?.col ?? '?'})`);
    process.stdout.write(out.text.endsWith('\n') ? out.text : out.text + '\n');
  });

// `claw session input` — type raw bytes into a managed session's
// PTY. Useful for ad-hoc CC interactive prompts. Special keys are
// the operator's responsibility (e.g. `--enter` adds \r at the
// end; for arrow keys / ctrl-codes you'd shell-escape the bytes).
const sessionInput = new Command('input')
  .description('type bytes into a managed session\'s PTY')
  .argument('<ref>', 'session UUID, @routingName, or @owner/slug')
  .argument('<bytes>', 'raw bytes to write (UTF-8). use $\'\\r\' for Enter, etc.')
  .option('--enter', 'append a CR after the bytes (handy for "type a line and submit")')
  .action(async (ref: string, bytes: string, opts: { enter?: boolean }) => {
    const id = await resolveSessionId(ref);
    const payload = opts.enter ? bytes + '\r' : bytes;
    const out = await api.post<{ ok: boolean; wrote?: number }>(
      `/api/v1/sessions/${encodeURIComponent(id)}/input`, { bytes: payload },
    );
    console.error(`✓ wrote ${out.wrote ?? payload.length} bytes`);
  });

export const sessionCmd = new Command('session')
  .description('manage Claude Code sessions registered with this hub')
  .addCommand(sessionList)
  .addCommand(sessionInfo)
  .addCommand(sessionAttach)
  .addCommand(sessionEvents)
  .addCommand(sessionMessages)
  .addCommand(sessionArchive)
  .addCommand(sessionPrune)
  .addCommand(sessionPrompt)
  .addCommand(sessionDelete)
  .addCommand(sessionShareCmd)
  .addCommand(sessionSharesCmd)
  .addCommand(sessionUnshareCmd)
  .addCommand(sessionFiles)
  .addCommand(sessionFileRm)
  .addCommand(sessionKill)
  .addCommand(sessionRestart)
  .addCommand(sessionScreenshot)
  .addCommand(sessionInput);
