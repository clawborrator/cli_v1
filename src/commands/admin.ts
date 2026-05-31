// `claw admin …` — wraps the hub's /api/v1/admin/* endpoints.
// Every endpoint requires the caller's `users.is_admin` bit to be
// set; non-admin operators get a 403 from the hub on first call.
//
// Hidden from top-level `claw --help` (registered in src/index.ts
// with `{ hidden: true }`) so the surface stays quiet for the
// majority of users who can't run these. `claw admin --help` still
// shows the full submenu.

import { Command } from 'commander';
import { api } from '../client/api.js';

// ─── Output helpers ──────────────────────────────────────────────

function maybeJson(opts: { json?: boolean }, data: unknown): boolean {
  if (opts.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return true;
  }
  return false;
}

function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  if (diff < 60_000)        return 'just now';
  if (diff < 3_600_000)     return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000)    return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return iso.slice(0, 10);
}

function shortId(id: string | null | undefined): string {
  if (!id) return '—';
  return id.length > 12 ? id.slice(0, 8) : id;
}

// Pad a string to width N with spaces (right-padded). Used by tabular
// renderers below — keeps things readable without pulling a deps.
function pad(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + ' '.repeat(width - s.length);
}

// ─── stats overview ──────────────────────────────────────────────

interface StatsOverview {
  users:    { total: number; last7d: number; last30d: number };
  sessions: { totalEver: number; currentlyConnected: number; startedLast24h: number };
  events:   { last24h: number; last7d: number };
  permissionRequests: { pending: number; resolvedLast24h: number };
  agentDispatches:    { last24h: number; last7d: number; topAgents: Array<{ handle: string; count: number }> };
  fileUploads:        { last7d: number; bytesStored: number };
  webhookDeliveries:  { last24h: number; succeededLast24h: number; failedLast24h: number };
  opMessages:         { last7d: number };
  generatedAt:        string;
}

function fmtBytes(n: number): string {
  if (n < 1024)              return `${n} B`;
  if (n < 1024 ** 2)         return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3)         return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

const statsOverview = new Command('overview')
  .description('hub-wide stats snapshot (users, sessions, events, dispatches, …)')
  .option('--json', 'emit JSON instead of human-readable tiles')
  .action(async (opts: { json?: boolean }) => {
    const r = await api.get<StatsOverview>('/api/v1/admin/stats/overview');
    if (maybeJson(opts, r)) return;
    const tile = (label: string, value: string | number, sub: string) =>
      console.log(`  ${pad(label, 22)} ${pad(String(value), 12)} ${sub}`);
    console.log('overview as of', r.generatedAt);
    console.log('');
    tile('Users',            r.users.total,                       `+${r.users.last7d} in 7d, +${r.users.last30d} in 30d`);
    tile('Sessions ever',    r.sessions.totalEver,                `${r.sessions.currentlyConnected} connected, +${r.sessions.startedLast24h} in 24h`);
    tile('Events',           r.events.last24h,                    `last 24h (${r.events.last7d.toLocaleString()} in 7d)`);
    tile('Pending gates',    r.permissionRequests.pending,        `${r.permissionRequests.resolvedLast24h} resolved 24h`);
    tile('Agent dispatches', r.agentDispatches.last24h,           `last 24h (${r.agentDispatches.last7d} in 7d)`);
    tile('File uploads',     r.fileUploads.last7d,                `7d, ${fmtBytes(r.fileUploads.bytesStored)} stored`);
    tile('Webhooks 24h',     r.webhookDeliveries.last24h,         `${r.webhookDeliveries.succeededLast24h} ok, ${r.webhookDeliveries.failedLast24h} failing`);
    tile('Op messages',      r.opMessages.last7d,                 'last 7d');
    if (r.agentDispatches.topAgents.length > 0) {
      console.log('');
      console.log('  top agents (7d):');
      for (const a of r.agentDispatches.topAgents) {
        console.log(`    ${pad(a.handle, 30)} ${a.count}`);
      }
    }
  });

// ─── stats timeseries ────────────────────────────────────────────

interface TimeseriesResponse {
  metric:  string;
  window:  string;
  bucket:  'hour' | 'day';
  points:  Array<{ ts: string; count: number }>;
  generatedAt: string;
}

const SPARK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
function spark(points: number[]): string {
  if (points.length === 0) return '';
  const max = Math.max(1, ...points);
  return points.map((n) => SPARK_CHARS[Math.min(SPARK_CHARS.length - 1, Math.floor((n / max) * (SPARK_CHARS.length - 1)))]).join('');
}

const statsTimeseries = new Command('timeseries')
  .description('bucketed series for one metric')
  .argument('<metric>', 'users.signups | sessions.created | events.total | agent.dispatches | webhook.deliveries')
  .option('--window <w>', 'time window (24h | 7d | 30d)', '7d')
  .option('--json',       'emit JSON instead of a Unicode sparkline')
  .action(async (metric: string, opts: { window: string; json?: boolean }) => {
    const r = await api.get<TimeseriesResponse>(`/api/v1/admin/stats/timeseries/${encodeURIComponent(metric)}?window=${encodeURIComponent(opts.window)}`);
    if (maybeJson(opts, r)) return;
    const counts = r.points.map((p) => p.count);
    const total  = counts.reduce((a, n) => a + n, 0);
    const max    = Math.max(0, ...counts);
    console.log(`${r.metric}  window=${r.window}  bucket=${r.bucket}  total=${total}  peak=${max}`);
    console.log(spark(counts));
    console.log(`${r.points[0]?.ts ?? ''}  →  ${r.points[r.points.length - 1]?.ts ?? ''}`);
  });

// ─── stats users active ──────────────────────────────────────────

interface ActiveUser { userId: number; githubLogin: string; sessionCount: number; eventsLast7d: number }

const statsUsersActive = new Command('active')
  .description('top-N users by events emitted in the last 7 days')
  .option('--limit <n>', 'how many users to return (1-50)', (v) => parseInt(v, 10), 10)
  .option('--json',      'emit JSON instead of a table')
  .action(async (opts: { limit: number; json?: boolean }) => {
    const r = await api.get<{ users: ActiveUser[]; limit: number }>(
      `/api/v1/admin/stats/users/active?limit=${opts.limit}`,
    );
    if (maybeJson(opts, r)) return;
    if (r.users.length === 0) { console.log('no activity'); return; }
    for (let i = 0; i < r.users.length; i++) {
      const u = r.users[i];
      console.log(`  #${String(i + 1).padStart(2)} ${pad('@' + u.githubLogin, 28)} ${pad(`${u.sessionCount} sessions`, 14)} ${u.eventsLast7d.toLocaleString()} events`);
    }
  });

const statsUsersCmd = new Command('users')
  .description('user-scoped stats subcommands')
  .addCommand(statsUsersActive);

const statsCmd = new Command('stats')
  .description('hub-wide stats endpoints')
  .addCommand(statsOverview)
  .addCommand(statsTimeseries)
  .addCommand(statsUsersCmd);

// ─── sessions ────────────────────────────────────────────────────

interface AdminSessionRow {
  id: string;
  ownerLogin: string;
  routingName: string | null;
  cwd: string | null;
  host: string | null;
  startedAt: string;
  lastSeenAt: string;
  archivedAt: string | null;
  managedByMachineId: string | null;
  connected: boolean;
  shareCount: number;
  agentHandle: string | null;
}

const sessionsList = new Command('list')
  .alias('ls')
  .description('cross-tenant sessions list')
  .option('--limit <n>',  'page size (1-200)', (v) => parseInt(v, 10), 50)
  .option('--offset <n>', 'page offset',       (v) => parseInt(v, 10), 0)
  .option('--q <text>',   'filter on routing_name / cwd / owner login')
  .option('--json',       'emit JSON instead of a table')
  .action(async (opts: { limit: number; offset: number; q?: string; json?: boolean }) => {
    const qs = new URLSearchParams({ limit: String(opts.limit), offset: String(opts.offset) });
    if (opts.q) qs.set('q', opts.q);
    const r = await api.get<{ items: AdminSessionRow[]; total: number }>(`/api/v1/admin/sessions?${qs}`);
    if (maybeJson(opts, r)) return;
    if (r.items.length === 0) { console.log('no sessions'); return; }
    for (const s of r.items) {
      const dot = s.connected ? '●' : '○';
      const route = s.routingName ?? '(no routing name)';
      const tags  = [
        s.agentHandle ? `agent=${s.agentHandle}` : null,
        s.managedByMachineId ? `managed` : null,
        s.shareCount > 0 ? `shares=${s.shareCount}` : null,
      ].filter(Boolean).join(' ');
      console.log(`${dot} ${pad(route, 26)} owner=@${pad(s.ownerLogin, 18)} ${pad(shortId(s.id), 10)} seen=${fmtRelative(s.lastSeenAt)}${tags ? '  ' + tags : ''}`);
    }
    const from = r.total === 0 ? 0 : opts.offset + 1;
    const to   = opts.offset + r.items.length;
    console.log(`\n${from}–${to} of ${r.total}`);
  });

const sessionsInfo = new Command('info')
  .description('cross-tenant session detail (no membership check)')
  .argument('<id>', 'session UUID')
  .option('--json', 'emit JSON instead of human-readable')
  .action(async (id: string, opts: { json?: boolean }) => {
    const r = await api.get<AdminSessionRow>(`/api/v1/admin/sessions/${encodeURIComponent(id)}`);
    if (maybeJson(opts, r)) return;
    const dot = r.connected ? '●' : '○';
    console.log(`${dot} ${r.routingName ?? '(no routing name)'} — owner @${r.ownerLogin}`);
    console.log(`  id           ${r.id}`);
    console.log(`  cwd          ${r.cwd ?? '—'}`);
    console.log(`  host         ${r.host ?? '—'}`);
    console.log(`  started      ${r.startedAt}`);
    console.log(`  last seen    ${r.lastSeenAt}  (${fmtRelative(r.lastSeenAt)})`);
    console.log(`  archived     ${r.archivedAt ?? 'no'}`);
    console.log(`  managed      ${r.managedByMachineId ?? 'no'}`);
    console.log(`  shares       ${r.shareCount}`);
    console.log(`  agent        ${r.agentHandle ?? '—'}`);
  });

interface AdminTimelineItem {
  kind: 'event' | 'permission';
  ts:   string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

const sessionsTimeline = new Command('timeline')
  .description('read-only events + permissions for a session (admin override; 200-row cap)')
  .argument('<id>', 'session UUID')
  .option('--limit <n>', 'how many rows (max 200)', (v) => parseInt(v, 10), 50)
  .option('--json',      'emit JSON instead of a digest')
  .action(async (id: string, opts: { limit: number; json?: boolean }) => {
    const r = await api.get<{
      items: AdminTimelineItem[]; sessionId: string;
      sessionRoute: string | null; ownerLogin: string;
    }>(`/api/v1/admin/sessions/${encodeURIComponent(id)}/timeline?limit=${opts.limit}`);
    if (maybeJson(opts, r)) return;
    console.log(`${r.sessionRoute ?? '(no routing name)'} — owner @${r.ownerLogin}  (${r.items.length} items)`);
    for (const it of r.items) {
      const label = it.kind === 'event' ? `${it.data.kind}/${it.data.type}` : `permission/${it.data.status}`;
      console.log(`  ${it.ts}  ${pad(label, 26)}  ${shortPayloadLine(it.data)}`);
    }
  });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function shortPayloadLine(data: any): string {
  if (!data) return '';
  if (data.tool)              return `tool=${data.tool}`;
  if (data.payload?.tool)     return `tool=${data.payload.tool}`;
  if (data.payload?.text)     return String(data.payload.text).slice(0, 60).replace(/\n/g, ' ');
  if (typeof data === 'string') return data.slice(0, 60);
  return '';
}

const sessionsCmd = new Command('sessions')
  .description('cross-tenant sessions endpoints')
  .addCommand(sessionsList)
  .addCommand(sessionsInfo)
  .addCommand(sessionsTimeline);

// ─── shares ──────────────────────────────────────────────────────

interface AdminShareRow {
  id: number;
  sessionId: string;
  sessionRoute: string | null;
  subjectLogin: string;
  grantorLogin: string;
  role: string;
  createdAt: string;
}

const sharesList = new Command('list')
  .alias('ls')
  .description('flat list of every session share across all owners')
  .option('--limit <n>',  'page size (1-500)', (v) => parseInt(v, 10), 100)
  .option('--offset <n>', 'page offset',       (v) => parseInt(v, 10), 0)
  .option('--json',       'emit JSON instead of a table')
  .action(async (opts: { limit: number; offset: number; json?: boolean }) => {
    const qs = new URLSearchParams({ limit: String(opts.limit), offset: String(opts.offset) });
    const r = await api.get<{ items: AdminShareRow[]; total: number }>(`/api/v1/admin/shares?${qs}`);
    if (maybeJson(opts, r)) return;
    if (r.items.length === 0) { console.log('no shares'); return; }
    for (const s of r.items) {
      const route = s.sessionRoute ?? shortId(s.sessionId);
      console.log(`  ${pad(route, 24)} @${pad(s.subjectLogin, 18)} ${pad(s.role, 10)} ← @${pad(s.grantorLogin, 18)} ${fmtRelative(s.createdAt)}`);
    }
    const from = r.total === 0 ? 0 : opts.offset + 1;
    const to   = opts.offset + r.items.length;
    console.log(`\n${from}–${to} of ${r.total}`);
  });

const sharesCmd = new Command('shares')
  .description('cross-tenant shares endpoints')
  .addCommand(sharesList);

// ─── agents ──────────────────────────────────────────────────────

interface AdminAgentRow {
  id: number;
  handle: string;
  ownerLogin: string;
  tagline: string | null;
  isolated: boolean;
  sessionRoute: string | null;
  online: boolean;
  status: 'draft' | 'published';
  deletedAt: string | null;
  dailyBudgetQueries: number | null;
  concurrencyCap: number | null;
  createdAt: string;
}

const agentsList = new Command('list')
  .alias('ls')
  .description('every agent across all owners, including isolated and soft-deleted')
  .option('--json', 'emit JSON instead of a table')
  .action(async (opts: { json?: boolean }) => {
    const r = await api.get<{ items: AdminAgentRow[]; total: number }>('/api/v1/admin/agents');
    if (maybeJson(opts, r)) return;
    if (r.items.length === 0) { console.log('no agents published'); return; }
    // Status glyph encodes both online-ness AND lifecycle:
    //   ●  published + online   (the happy path)
    //   ○  published + offline  (agent registered but session is dead)
    //   ◐  draft (created but not made public; not in /agents discovery)
    //   ✘  soft-deleted (deleted_at set; hidden from /agents + public-ask)
    // Soft-deleted takes precedence — these rows linger only for admin
    // forensics and are otherwise invisible to every other API surface.
    for (const a of r.items) {
      let dot;
      if (a.deletedAt)              dot = '✘';
      else if (a.status === 'draft') dot = '◐';
      else                          dot = a.online ? '●' : '○';
      const iso  = a.isolated ? '[isolated]' : '[composable]';
      const tag  = a.tagline ? ` — ${a.tagline}` : '';
      const meta = a.deletedAt
        ? ` [DELETED ${a.deletedAt.slice(0, 10)}]`
        : (a.status === 'draft' ? ' [draft]' : '');
      console.log(`${dot} ${pad(a.handle, 32)} ${iso}${meta}  owner=@${pad(a.ownerLogin, 16)} budget=${a.dailyBudgetQueries ?? '—'}  cap=${a.concurrencyCap ?? '—'}${tag}`);
    }
    console.log(`\n${r.total} total`);
  });

const agentsNs = new Command('agents')
  .description('cross-tenant agents endpoints')
  .addCommand(agentsList);

// ─── tokens ──────────────────────────────────────────────────────

interface AdminTokenRow {
  id:         number;
  kind:       'channel' | 'app';
  name:       string | null;
  prefix:     string;
  userId:     number;
  userLogin:  string | null;
  createdAt:  string;
  lastUsedAt: string | null;
  revokedAt:  string | null;
  active:     boolean;
  appName:    string | null;
  machineId:  string | null;
}

const VALID_KIND   = ['channel', 'app', 'all'];
const VALID_ACTIVE = ['true', 'false', 'all'];

const tokensList = new Command('list')
  .alias('ls')
  .description('every token (channel + app) across all users on the hub')
  .option('--kind <k>',   `filter by kind: ${VALID_KIND.join(' | ')}`, 'all')
  .option('--active <a>', `filter by state: ${VALID_ACTIVE.join(' | ')} (true=active, false=revoked)`, 'all')
  .option('--limit <n>',  'page size (1-500)', (v) => parseInt(v, 10), 200)
  .option('--json',       'emit JSON instead of a table')
  .action(async (opts: { kind: string; active: string; limit: number; json?: boolean }) => {
    if (!VALID_KIND.includes(opts.kind)) {
      console.error(`--kind must be one of: ${VALID_KIND.join(', ')}`); process.exit(1);
    }
    if (!VALID_ACTIVE.includes(opts.active)) {
      console.error(`--active must be one of: ${VALID_ACTIVE.join(', ')}`); process.exit(1);
    }
    const qs = new URLSearchParams({ limit: String(opts.limit), active: opts.active, kind: opts.kind });
    const r = await api.get<{ items: AdminTokenRow[]; total: number; returned: number }>(`/api/v1/admin/tokens?${qs}`);
    if (maybeJson(opts, r)) return;
    if (r.items.length === 0) { console.log('no tokens'); return; }
    // ● active   ✘ revoked
    for (const t of r.items) {
      const dot   = t.active ? '●' : '✘';
      const name  = t.name ?? (t.appName ? `app:${t.appName}` : '(unnamed)');
      const owner = t.userLogin ? `@${t.userLogin}` : `user#${t.userId}`;
      const used  = t.lastUsedAt ? `used=${fmtRelative(t.lastUsedAt)}` : 'never used';
      const rev   = t.revokedAt ? `  revoked=${fmtRelative(t.revokedAt)}` : '';
      console.log(`${dot} ${pad(t.kind, 7)} ${pad(name, 22)} ${pad(t.prefix, 20)} ${pad(owner, 18)} created=${fmtRelative(t.createdAt)}  ${used}${rev}`);
    }
    console.log(`\n${r.returned} shown of ${r.total} total`);
  });

const tokensCmd = new Command('tokens')
  .description('cross-tenant token inventory')
  .addCommand(tokensList);

// ─── users ───────────────────────────────────────────────────────

interface AdminUserRow {
  id:           number;
  github_login: string;
  avatar_url:   string | null;
  is_admin:     boolean;
  is_service:   boolean;
  // Present on hubs with the external_identities schema; the list of
  // providers backing the user (github / google / zoho / service / shadow).
  identities?:  string[];
  // Present on older hubs (pre-external_identities) instead of identities.
  github_id?:   number;
  created_at:   string;
}

const usersList = new Command('list')
  .alias('ls')
  .description('every user on the hub (login, admin/service flags, identity providers)')
  .option('--limit <n>', 'page size (1-500)', (v) => parseInt(v, 10), 200)
  .option('--json',      'emit JSON instead of a table')
  .action(async (opts: { limit: number; json?: boolean }) => {
    const r = await api.get<{ items: AdminUserRow[]; total: number }>(`/api/v1/admin/users?limit=${opts.limit}`);
    if (maybeJson(opts, r)) return;
    if (r.items.length === 0) { console.log('no users'); return; }
    // ★ admin   ⚙ service   · regular
    for (const u of r.items) {
      const dot   = u.is_admin ? '★' : (u.is_service ? '⚙' : '·');
      const provs = u.identities?.length
        ? u.identities.join(',')
        : (u.github_id != null ? `github:${u.github_id}` : '—');
      console.log(`${dot} #${pad(String(u.id), 5)} @${pad(u.github_login, 28)} ${pad(provs, 26)} created=${fmtRelative(u.created_at)}`);
    }
    console.log(`\n${r.total} total  (★ admin  ⚙ service)`);
  });

const usersCmd = new Command('users')
  .description('cross-tenant users list')
  .addCommand(usersList);

// ─── root ────────────────────────────────────────────────────────

export const adminCmd = new Command('admin')
  .description('admin-only endpoints (cross-tenant view + hub-wide stats). Requires users.is_admin on your account.')
  .addCommand(statsCmd)
  .addCommand(sessionsCmd)
  .addCommand(sharesCmd)
  .addCommand(agentsNs)
  .addCommand(tokensCmd)
  .addCommand(usersCmd);
