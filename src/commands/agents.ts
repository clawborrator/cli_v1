// `claw agents list|publish|unpublish|inbound` — public expert
// agent management. Agents are addressable as `@<owner>/<slug>` in
// any prompt; the hub intercepts that pattern and routes to the
// agent's session.

import { Command } from 'commander';
import { api } from '../client/api.js';
import type { ApiAgent, ApiAgentInbound, ApiAgentThreadsResponse } from '../shared/index.js';

function buildAgentsListQs(opts: { mine?: boolean; owner?: string; q?: string }): string {
  const params = new URLSearchParams();
  if (opts.mine)  params.set('mine',  'true');
  if (opts.owner) params.set('owner', opts.owner);
  if (opts.q)     params.set('q',     opts.q);
  return params.toString() ? '?' + params.toString() : '';
}

function printAgentRow(a: ApiAgent): void {
  const dot   = a.online ? '●' : '○';
  const tag   = a.status === 'draft' ? ' [draft]' : '';
  const iso   = a.isolated ? ' [isolated]' : ' [composable]';
  const live  = a.liveView ? (a.publicAsk ? ' [📡 public-view+ask]' : ' [📡 public-view (watch-only)]') : '';
  const stats = `${a.queriesAllTime} queries`;
  const tagln = a.tagline ? ` — ${a.tagline}` : '';
  console.log(`${dot} @${a.handle}${tag}${iso}${live}  ${a.name}  ${stats}${tagln}`);
}

const agentsList = new Command('list')
  .alias('ls')
  .description('list published agents (default) or your own agents (--mine)')
  .option('--mine',          'list every agent you own, including drafts')
  .option('--owner <login>', 'list a specific creator\'s published agents')
  .option('--q <text>',      'substring match on handle / name / tagline')
  .action(async (opts: { mine?: boolean; owner?: string; q?: string }) => {
    const data = await api.get<{ items: ApiAgent[] }>(`/api/v1/agents${buildAgentsListQs(opts)}`);
    if (data.items.length === 0) { console.log('no agents'); return; }
    for (const a of data.items) printAgentRow(a);
  });

const agentsPublish = new Command('publish')
  .description('publish a session as a public agent')
  .requiredOption('--session <id>', 'the session UUID to back the agent')
  .requiredOption('--name <name>',  'display name (e.g. "viper-rust-expert")')
  .option('--tagline <text>',   'one-line description (160 chars max)')
  .option('--description <text>', 'long-form description, markdown allowed (4 KB max)')
  .option('--slug <slug>',      'explicit slug (default: derived from session routingName)')
  .option('--draft',            'publish as draft (status=draft); use --published to go live immediately')
  .option('--published',        'publish as live (status=published)')
  .option('--budget <n>',       'daily budget in queries (default 1000, max 100000)', (v) => parseInt(v, 10))
  .option('--concurrency <n>',  'concurrent in-flight queries cap (default 5, max 20)', (v) => parseInt(v, 10))
  .option('--isolated',         'isolated mode: agent CC cannot use cross-session routing tools while answering (default true; safer)')
  .option('--composable',       'composable mode: agent CC may use cross-session routing tools (gated against the requester\'s own access)')
  .option('--live-view',        'expose this agent on next.clawborrator.com (anonymous visitors can watch the terminal + chat). Everything on the terminal becomes public — use a scratch session.')
  .option('--no-live-view',     'force live-view OFF (default)')
  .option('--public-ask',       'let anonymous visitors chat/ask this agent with no login (requires --live-view). Off = watch-only.')
  .option('--no-public-ask',    'force public-ask OFF (default; watch-only public surface)')
  .option('--suggested-prompt <text>', 'chip prompt shown above the live-view composer (repeatable, max 6)', collectRepeatable, [])
  .action(async (opts: PublishOpts) => {
    const r = await api.post<ApiAgent & { restored?: boolean }>('/api/v1/agents', buildPublishBody(opts));
    printPublishResult(r);
  });

// Commander's repeatable-option collector: each --flag <v> append into
// the accumulator array. Pass as the third arg to .option() with an
// initial [] to make a flag repeatable.
function collectRepeatable(value: string, prev: string[]): string[] {
  return prev.concat([value]);
}

interface PublishOpts {
  session: string; name: string; tagline?: string; description?: string;
  slug?: string; draft?: boolean; published?: boolean;
  budget?: number; concurrency?: number;
  isolated?: boolean; composable?: boolean;
  liveView?: boolean; publicAsk?: boolean; suggestedPrompt?: string[];
}

function buildPublishBody(opts: PublishOpts): Record<string, unknown> {
  const status: 'draft' | 'published' = opts.published ? 'published' : 'draft';
  const body: Record<string, unknown> = {
    sessionId: opts.session,
    name:      opts.name,
    status,
  };
  if (opts.tagline)     body.tagline     = opts.tagline;
  if (opts.description) body.description = opts.description;
  if (opts.slug)        body.slug        = opts.slug;
  if (typeof opts.budget === 'number')      body.dailyBudgetQueries = opts.budget;
  if (typeof opts.concurrency === 'number') body.concurrencyCap     = opts.concurrency;
  if (opts.composable)                      body.isolated = false;
  else if (opts.isolated)                   body.isolated = true;
  // --live-view / --no-live-view. Commander encodes --no-X by setting
  // the same option to `false`, so an explicit absence stays
  // undefined (server default applies).
  if (typeof opts.liveView === 'boolean')   body.liveView = opts.liveView;
  // public_ask is a subset of liveView; the server clamps it off when
  // live-view is off. Pass it through verbatim when the operator used
  // the flag so --live-view --public-ask lands a conductor in one shot.
  if (typeof opts.publicAsk === 'boolean')  body.publicAsk = opts.publicAsk;
  if (opts.suggestedPrompt && opts.suggestedPrompt.length) {
    body.suggestedPrompts = opts.suggestedPrompt;
  }
  return body;
}

function printPublishResult(r: ApiAgent & { restored?: boolean }): void {
  console.log(`✓ ${r.restored ? 'restored' : 'published'} agent: @${r.handle}`);
  console.log(`  name:    ${r.name}`);
  console.log(`  status:  ${r.status}`);
  console.log(`  mode:    ${r.isolated ? 'isolated (cross-session routing disabled while answering)' : 'composable (CC may route to peers)'}`);
  console.log(`  budget:  ${r.dailyBudgetQueries}/day, concurrency ${r.concurrencyCap}`);
  if (r.liveView) {
    console.log(`  public:  view ON, ask ${r.publicAsk ? 'ON (anonymous chat)' : 'OFF (watch-only)'}`);
  }
  console.log(`  session: ${r.sessionId}`);
  if (r.status === 'draft') {
    console.log(`  next:    'claw agents update --status published @${r.handle}' to make it live`);
  } else {
    console.log(`  call as: '@${r.handle} <question>' from any session prompt`);
  }
}

const agentsUpdate = new Command('update')
  .description('update an agent')
  .argument('<handle>', '@owner/slug')
  .option('--status <s>',  'draft | published')
  .option('--name <name>')
  .option('--tagline <text>')
  .option('--description <text>')
  .option('--budget <n>',      'daily budget in queries', (v) => parseInt(v, 10))
  .option('--concurrency <n>', 'concurrency cap',         (v) => parseInt(v, 10))
  .option('--isolated',        'switch to isolated mode (block cross-session routing while answering)')
  .option('--composable',      'switch to composable mode (allow cross-session routing tools)')
  .option('--live-view',       'enable public live-view on next.clawborrator.com (requires status=published)')
  .option('--no-live-view',    'disable public live-view (also forces public-ask off)')
  .option('--public-ask',      'enable anonymous chat/ask on the public surface (requires live-view)')
  .option('--no-public-ask',   'disable anonymous chat/ask (watch-only public surface)')
  .option('--suggested-prompt <text>', 'replace the chip-prompt list (repeatable, max 6). Pass with no values to clear.', collectRepeatable, [])
  .action(async (handleArg: string, opts: any) => {
    const handle = handleArg.replace(/^@/, '');
    const agent = await api.get<ApiAgent>(`/api/v1/agents/by-handle/${encodeURIComponent(handle.split('/')[0])}/${encodeURIComponent(handle.split('/')[1] ?? '')}`);
    const body = buildUpdateBody(opts);
    if (Object.keys(body).length === 0) { console.error('no fields to update'); process.exit(2); }
    const r = await api.patch<ApiAgent>(`/api/v1/agents/${agent.id}`, body);
    console.log(`✓ updated @${r.handle}`);
    console.log(`  status:  ${r.status}`);
    console.log(`  mode:    ${r.isolated ? 'isolated' : 'composable'}`);
    console.log(`  budget:  ${r.dailyBudgetQueries}/day, concurrency ${r.concurrencyCap}`);
  });

function buildUpdateBody(opts: any): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (opts.status)      body.status      = opts.status;
  if (opts.name)        body.name        = opts.name;
  if (opts.tagline)     body.tagline     = opts.tagline;
  if (opts.description) body.description = opts.description;
  if (typeof opts.budget === 'number')      body.dailyBudgetQueries = opts.budget;
  if (typeof opts.concurrency === 'number') body.concurrencyCap     = opts.concurrency;
  if (opts.composable)  body.isolated = false;
  else if (opts.isolated) body.isolated = true;
  if (typeof opts.liveView === 'boolean')   body.liveView           = opts.liveView;
  if (typeof opts.publicAsk === 'boolean')  body.publicAsk          = opts.publicAsk;
  // Only send suggestedPrompts when the operator actually used the
  // flag (commander gives [] when not used, but we can't distinguish
  // that from "explicitly clear" without a sentinel — using --no-live-
  // view to clear is the cleaner path; sending [] here would clobber
  // existing chips silently).
  if (Array.isArray(opts.suggestedPrompt) && opts.suggestedPrompt.length > 0) {
    body.suggestedPrompts = opts.suggestedPrompt;
  }
  return body;
}

const agentsUnpublish = new Command('unpublish')
  .description('soft-delete an agent (drops its handle)')
  .argument('<handle>', '@owner/slug')
  .action(async (handleArg: string) => {
    const handle = handleArg.replace(/^@/, '');
    const [owner, slug] = handle.split('/');
    if (!owner || !slug) { console.error('expected handle in @owner/slug form'); process.exit(2); }
    const agent = await api.get<ApiAgent>(`/api/v1/agents/by-handle/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`);
    await api.delete(`/api/v1/agents/${agent.id}`);
    console.log(`✓ unpublished @${handle}`);
  });

const agentsInbound = new Command('inbound')
  .description('audit view: who has been calling your agent')
  .argument('<handle>', '@owner/slug')
  .option('--days <n>', '1-30 (default 7)', (v) => parseInt(v, 10), 7)
  .action(async (handleArg: string, opts: { days: number }) => {
    const handle = handleArg.replace(/^@/, '');
    const [owner, slug] = handle.split('/');
    if (!owner || !slug) { console.error('expected handle in @owner/slug form'); process.exit(2); }
    const agent = await api.get<ApiAgent>(`/api/v1/agents/by-handle/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`);
    const data = await api.get<ApiAgentInbound>(`/api/v1/agents/${agent.id}/inbound?days=${opts.days}`);
    printInboundReport(data);
  });

function printInboundReport(data: ApiAgentInbound): void {
  console.log(`@${data.agent.handle}  (${data.window.days}-day window)`);
  console.log(`  total: ${data.summary.total}  ok: ${data.summary.ok}  denied: ${data.summary.denied}  avg-latency: ${data.summary.avgLatencyMs ?? '—'}ms  askers: ${data.summary.distinctAskers}`);
  if (data.publicThreadStats) {
    const p = data.publicThreadStats;
    console.log(`  public threads: ${p.total} total · ${p.today} today · ${p.active} active`);
  }
  if (data.topAskers.length) printInboundTopAskers(data.topAskers);
  if (data.recent.length)    printInboundRecent(data.recent);
}

// '(public)' is the server-side sentinel for anonymous public-ask
// traffic (post-migration 0022). Render those rows without the @
// prefix so they don't read as a GitHub user handle.
function formatAskerLogin(login: string): string {
  return login === '(public)' ? '(public)' : '@' + login;
}

function printInboundTopAskers(items: ApiAgentInbound['topAskers']): void {
  console.log('');
  console.log('top askers:');
  for (const t of items) {
    console.log(`  ${formatAskerLogin(t.login).padEnd(21)} ${String(t.count).padStart(4)} queries  last: ${t.lastAt}`);
  }
}

function printInboundRecent(items: ApiAgentInbound['recent']): void {
  console.log('');
  console.log('recent:');
  for (const r of items.slice(0, 20)) {
    const flag = r.ok ? '✓' : '✗';
    const lat  = r.latencyMs != null ? ` ${r.latencyMs}ms` : '';
    const why  = r.deniedReason ? ` [${r.deniedReason}]` : '';
    const q    = r.question.length > 70 ? r.question.slice(0, 67) + '…' : r.question;
    console.log(`  ${flag} ${r.ts}  ${formatAskerLogin(r.askerLogin)}${lat}${why}  ${q}`);
  }
}

const agentsThreads = new Command('threads')
  .description('list anonymous public-view chat threads for an agent (creator-only)')
  .argument('<handle>', '@owner/slug')
  .option('--limit <n>',   '1-200 (default 50)', (v) => parseInt(v, 10), 50)
  .option('--status <s>',  'active | capped | closed | soft_deleted')
  .action(async (handleArg: string, opts: { limit: number; status?: string }) => {
    const handle = handleArg.replace(/^@/, '');
    const [owner, slug] = handle.split('/');
    if (!owner || !slug) { console.error('expected handle in @owner/slug form'); process.exit(2); }
    const agent = await api.get<ApiAgent>(`/api/v1/agents/by-handle/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`);
    const qs = new URLSearchParams();
    qs.set('limit', String(opts.limit));
    if (opts.status) qs.set('status', opts.status);
    const data = await api.get<ApiAgentThreadsResponse>(`/api/v1/agents/${agent.id}/threads?${qs.toString()}`);
    printThreadsReport(data, handle);
  });

function printThreadsReport(data: ApiAgentThreadsResponse, handle: string): void {
  const s = data.summary;
  console.log(`@${handle}  public-view threads`);
  console.log(`  ${s.total} total · ${s.today} today · ${s.active} active`);
  if (data.items.length === 0) {
    console.log('  (none)');
    return;
  }
  console.log('');
  for (const t of data.items) {
    const status = t.status === 'active' ? '●' : t.status === 'capped' ? '◐' : '○';
    const last = new Date(t.lastSeenAt).toISOString();
    const prompt = t.lastPrompt ? ' — "' + t.lastPrompt + '"' : '';
    console.log(`  ${status} ${t.threadId}  ${String(t.messageCount).padStart(2)} msgs  last: ${last}${prompt}`);
  }
}

export const agentsCmd = new Command('agents')
  .description('public expert agents — list, publish, update, audit, threads')
  .addCommand(agentsList)
  .addCommand(agentsPublish)
  .addCommand(agentsUpdate)
  .addCommand(agentsUnpublish)
  .addCommand(agentsInbound)
  .addCommand(agentsThreads);
