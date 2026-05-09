// `claw session attach <ref>` — opens a WS to /cli, subscribes to
// the session, and runs an inline TUI:
//
//   - Bare-text input is sent as a PROMPT to the session's live
//     Claude. This is the "drive my CC remotely" use case.
//   - LEADING `@target` redirects the prompt to a different session
//     of yours (cross-session routing from the operator side):
//        @other-driver clean up unused imports
//        @MRIIOT/other-driver run the test suite
//     The currently-attached session keeps streaming its events;
//     only the destination of *that* line changes.
//   - `/m <text>` sends an op-message (operator-to-operator chat)
//     to the currently-attached session — the old default.
//   - `/y` `/n` approve / deny the most recent permission request.
//   - `/q` quits.
//   - Ctrl-C closes the WS and exits.
//
// Caveat: prompts queue in the receiving Claude's inbox; they land
// only when Claude calls the `await_routed_prompt` MCP tool. Same
// constraint peer-routed prompts have via route_to_peer.

import { Command } from 'commander';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import WebSocket from 'ws';
import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import { loadConfig } from '../config.js';
import { api } from '../client/api.js';
import { pickCandidate, AmbiguousError } from '../util/disambiguate.js';
import type { ApiSession, ApiUser, CliInbound, CliOutbound } from '../shared/index.js';

const RESET  = '\x1b[0m';
const DIM    = '\x1b[2m';
const AMBER  = '\x1b[33m';
const BLUE   = '\x1b[36m';
const RED    = '\x1b[31m';
const BOLD   = '\x1b[1m';
const GREEN  = '\x1b[32m';

function ts(): string {
  return new Date().toLocaleTimeString();
}

// Markdown rendering for assistant_text and reply payloads. Toggled
// by the attach command's --no-markdown flag; default-on so Claude's
// **bold**, lists, code blocks, etc. render formatted in the TUI
// instead of as raw markdown source.
let markdownEnabled = true;

// --debug: after every rendered event, print its full JSON payload
// indented and dimmed. Surfaces fields the type-specific renderers
// hide for noise control — most useful for SubagentStop (which
// otherwise prints just the marker line, hiding `last_assistant_message`)
// and for PreToolUse / PostToolUse where the renderer summarizes
// tool_input / tool_response.
let debugMode = false;

// Working-state indicator + sticky-input box.
//
// Both problems are about the same line: the bottom of the screen.
// readline's input prompt lives there. Events stream in from above
// (or so we want). And the operator wanted an animated "claude
// working" dot. So:
//
//   * The spinner becomes a PROMPT PREFIX. We rotate the dot frame
//     on a timer and call _refreshLine to redraw. Same line readline
//     was going to use anyway — no conflict.
//   * Every external log (events, op-messages, presence, errors) is
//     routed through `say()` which:
//       1. Wipes the current input line (\r\x1b[K)
//       2. Writes the log line
//       3. Calls readline._refreshLine() to redraw prompt + buffer
//          + restore cursor
//     Result: typed text never gets fragmented across event lines.
//     The input box appears anchored at the bottom while events
//     scroll above it.
//
// `_refreshLine` is a private readline method but has been stable
// across node 12+. The fallback writes prompt + line manually if
// it ever disappears.
let statusEnabled = true;
let working       = false;
let rlRef:        ReadlineInterface | null = null;

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerFrame  = 0;
let spinnerTimer: NodeJS.Timeout | null = null;

const PROMPT_BASE = `${DIM}>${RESET} `;

function buildPrompt(): string {
  if (!working) return PROMPT_BASE;
  return `${AMBER}${SPINNER_FRAMES[spinnerFrame]}${RESET} ${PROMPT_BASE}`;
}

function refreshPrompt(): void {
  if (!rlRef) return;
  rlRef.setPrompt(buildPrompt());
  // _refreshLine redraws prompt + current input buffer + positions
  // cursor where the user had it. Stable since node 12.
  const r = rlRef as unknown as { _refreshLine?: () => void };
  if (typeof r._refreshLine === 'function') r._refreshLine();
  else rlRef.prompt(true);
}

function startWorking(): void {
  if (working) return;
  working = true;
  if (!statusEnabled || !process.stdout.isTTY) { refreshPrompt(); return; }
  if (spinnerTimer) return;
  spinnerTimer = setInterval(() => {
    spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
    refreshPrompt();
  }, 80);
  refreshPrompt();
}

function stopWorking(): void {
  if (!working) return;
  working = false;
  if (spinnerTimer) { clearInterval(spinnerTimer); spinnerTimer = null; }
  refreshPrompt();
}

// Watchdog for routed (cross-session) prompts. The source session's
// Claude only resumes — and emits its turn-closing tail/Stop — once
// the peer's reply lands. If the peer's Claude denies the
// mcp__clawborrator__reply tool, no reply ever lands; the spinner
// would otherwise spin until the hub's tracker GCs (~2 min).
//
// One shared timer is good enough: rapid-fire routed sends just reset
// it, and the first inbound peer-reply / peer-timeout for ANY
// outstanding send is a strong "things are moving" signal.
let routeWatchdog: NodeJS.Timeout | null = null;
const ROUTE_WATCHDOG_MS = 60_000;
function armRouteWatchdog(): void {
  if (routeWatchdog) clearTimeout(routeWatchdog);
  routeWatchdog = setTimeout(() => {
    routeWatchdog = null;
    say(`${DIM}[${ts()}]${RESET} ${RED}⚠ no peer reply within 60s${RESET} ${DIM}— peer's Claude may have denied the reply tool${RESET}`);
    stopWorking();
  }, ROUTE_WATCHDOG_MS);
  routeWatchdog.unref();
}
function disarmRouteWatchdog(): void {
  if (routeWatchdog) { clearTimeout(routeWatchdog); routeWatchdog = null; }
}

// External-log helper. Use this instead of console.log from any path
// that can run while the readline prompt is active. Guarantees the
// input line stays clean and re-renders after the log.
function say(line: string): void {
  if (!process.stdout.isTTY || !rlRef) {
    console.log(line);
    return;
  }
  process.stdout.write('\r\x1b[K');     // CR + erase to end of line
  console.log(line);
  refreshPrompt();
}

function sayErr(line: string): void {
  if (!process.stdout.isTTY || !rlRef) {
    console.error(line);
    return;
  }
  process.stdout.write('\r\x1b[K');
  console.error(line);
  refreshPrompt();
}
const md = new Marked();
md.use(markedTerminal({
  width: process.stdout.columns ?? 100,
  reflowText: true,
  tab: 2,
}) as any);
// Note: marked-terminal pulls in cli-highlight + highlight.js (~2 MB
// of the bundle). The dep is hard-imported at module load — esbuild
// can't tree-shake it without a full package replacement. CLI tools
// at this size are normal; npx caches after first install.

function renderMarkdown(text: string): string {
  if (!markdownEnabled) return text;
  try {
    const out = md.parse(text);
    if (typeof out === 'string') return out.replace(/\n+$/, '');
    return text;
  } catch {
    return text;
  }
}

// Two-line layout helper for chat rows where the body might be
// multi-line (markdown rendering can produce several lines). Single-
// line bodies stay inline with the prefix; multi-line bodies break
// out under the prefix with a 2-space indent.
function emitChatLine(prefix: string, body: string): void {
  if (!body.includes('\n')) {
    say(`${prefix}  ${body}`);
    return;
  }
  say(prefix);
  for (const line of body.split('\n')) {
    say(`  ${line}`);
  }
}

// ----- Bootstrap helpers (run during `claw session attach` startup) -----

interface AttachOpts {
  limit?: string;
  opMessages?: boolean;
  markdown?: boolean;
  debug?: boolean;
  status?: boolean;
}

function applyAttachFlags(opts: AttachOpts): void {
  if (opts.markdown === false) markdownEnabled = false;
  if (opts.debug)              debugMode = true;
  if (opts.status === false)   statusEnabled = false;
}

async function fetchMyLogin(): Promise<string | null> {
  // Identity lookup — needed so the renderer can suppress mirrors of
  // the operator's own prompts. Without this the sender sees their
  // text twice: once as their local "→ prompt" echo, again as the
  // server-mirrored "@<self> ›" event broadcast for other attached
  // operators. One round-trip at startup, no further calls.
  try {
    const me = await api.get<ApiUser>('/api/v1/me');
    return me.githubLogin;
  } catch {
    // Falling back to "render everything" is safer than failing the
    // attach — the dup is annoying but not blocking.
    return null;
  }
}

const ATTACH_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface NameParts { ownerLogin: string | null; slug: string }

function splitRoutingRef(ref: string): NameParts {
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

function filterCandidatesByName(items: ApiSession[], parts: NameParts): ApiSession[] {
  let candidates = items.filter((s) => s.routingName === parts.slug);
  if (parts.ownerLogin !== null) {
    candidates = candidates.filter((s) => s.startedByLogin === parts.ownerLogin);
  } else {
    // Bare/`@slug` — prefer own when own + shared collide on the same routing name.
    const mine = candidates.filter((s) => s.role === 'owner');
    if (mine.length > 0) candidates = mine;
  }
  return candidates;
}

function reportAmbiguousAndExit(ref: string, e: AmbiguousError): never {
  const usedQualified = ref.includes('/');
  const advice = usedQualified
    ? `'${ref}' is ambiguous even within owner — multiple sessions share the same routing name. Re-run with a session UUID:`
    : `'${ref}' is ambiguous — re-run with the qualified @owner/slug form, or with a UUID if even that collides:`;
  console.error(`error: ${advice}`);
  for (const c of e.candidates) {
    console.error(`  ${c.id}  @${c.startedByLogin}/${(c.routingName ?? '').replace(/^@/, '')}  ${c.cwd ?? ''}`);
  }
  process.exit(2);
}

// Resolve into UUID. Same shape-matrix as session.ts/resolveSessionId:
// UUID | @driver | driver | @MRIIOT/driver | MRIIOT/driver. Kept
// standalone (rather than imported) to keep this file's bundle
// graph minimal.
async function resolveAttachSessionId(ref: string): Promise<string> {
  if (ATTACH_UUID_RE.test(ref)) return ref;
  const parts = splitRoutingRef(ref);
  const data  = await api.get<{ items: ApiSession[] }>('/api/v1/sessions');
  const candidates = filterCandidatesByName(data.items, parts);
  if (candidates.length === 0) {
    const label = parts.ownerLogin ? `@${parts.ownerLogin}/${parts.slug.slice(1)}` : parts.slug;
    console.error(`error: no session with routing name ${label} (run \`claw session list\` to see what's available)`);
    process.exit(2);
  }
  try {
    const picked = await pickCandidate(ref, candidates);
    return picked.id;
  } catch (e: any) {
    if (e instanceof AmbiguousError) reportAmbiguousAndExit(ref, e);
    console.error(`error: ${e?.message ?? String(e)}`);
    process.exit(2);
  }
}

function parseHistoryLimit(opts: AttachOpts): number {
  const limitArg = String(opts.limit ?? '50').toLowerCase();
  if (limitArg === 'all') return 5000;
  if (limitArg === '0')   return 0;
  return Math.max(0, parseInt(limitArg, 10) || 0);
}

type TimelineItem =
  | { kind: 'event'; id: number; ts: string; event: { kind: 'chat' | 'tail'; type: string; payload: Record<string, unknown>; ts: string } }
  | { kind: 'op-message'; id: number; ts: string; authorLogin: string; text: string; mentions: string[] }
  | { kind: 'file'; id: number; ts: string; action: 'uploaded' | 'deleted'; file: { id: number; filename: string; size: number; mime: string; uploaderLogin: string } };

function renderTimelineItem(item: TimelineItem, myLogin: string | null): void {
  if (item.kind === 'event') {
    renderEvent(item.event, myLogin, /* fromBacklog */ true);
    return;
  }
  if (item.kind === 'op-message') {
    console.log(`${DIM}[${shortTs(item.ts)}]${RESET} ${GREEN}@${item.authorLogin}${RESET}  ${item.text}`);
    return;
  }
  // file
  const verb = item.action === 'uploaded' ? `${GREEN}📎 uploaded${RESET}` : `${RED}✗ deleted${RESET}`;
  console.log(`${DIM}[${shortTs(item.ts)}]${RESET} ${BLUE}@${item.file.uploaderLogin}${RESET}  ${verb} ${BOLD}${item.file.filename}${RESET} ${DIM}(${fmtBytes(item.file.size)} · fileId=${item.file.id})${RESET}`);
}

// Backlog: fetch the most-recent N timeline items (events + op-
// messages, intertwined chronologically) and render them before
// the WS subscription opens. This is what gives an operator
// context when they attach mid-stream — without it they'd see
// only events that fire AFTER attach.
//
// The render-then-subscribe order leaves a small race: events
// that land between the timeline fetch and the WS subscribe
// might be missed. For most operator use this is invisible
// (sub-second window). If you need exact continuity use
// `claw session events <ref> --after=<id>` after attach.
async function drainHistoryBacklog(
  sessionId: string,
  opts: AttachOpts,
  myLogin: string | null,
): Promise<void> {
  const historyLimit = parseHistoryLimit(opts);
  if (historyLimit <= 0) return;
  // /timeline now returns event + op-message + file by default.
  // Drop op-messages when --no-op-messages was passed; files are
  // always inline (cheap to render, useful for backlog scrubbing).
  const kindsParam = opts.opMessages === false ? '&kinds=event,file' : '';
  try {
    const tl = await api.get<{ items: TimelineItem[] }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/timeline?limit=${historyLimit}${kindsParam}`,
    );
    if (tl.items.length === 0) return;
    console.log(`${DIM}─── history (${tl.items.length} item${tl.items.length === 1 ? '' : 's'}) ───${RESET}`);
    for (const item of tl.items) renderTimelineItem(item, myLogin);
    console.log(`${DIM}─── live ───${RESET}`);
  } catch (e: any) {
    console.error(`${DIM}(history fetch failed: ${e?.message ?? String(e)} — continuing live)${RESET}`);
  }
}

// ----- Connection (WS) handlers -----

interface PendingPerm { requestId: string; tool: string; sessionId: string }

interface AttachState {
  ws: WebSocket;
  sessionId: string;
  myLogin: string | null;
  hubUrl: string;
  wsUrl: string;
  sessionToken: string;
  mySubscription: boolean;
  pendingPerms: PendingPerm[];
  stopRequested: boolean;
  reconnectAttempt: number;
  reconnectTimer: NodeJS.Timeout | null;
}

const BACKOFF = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000];

function onWsOpen(state: AttachState): void {
  if (state.reconnectAttempt > 0) {
    say(`${DIM}[${ts()}]${RESET} ${AMBER}reconnected${RESET} to ${state.hubUrl}`);
  } else {
    say(`${DIM}[${ts()}]${RESET} connected to ${state.hubUrl}`);
  }
  state.reconnectAttempt = 0;
  state.mySubscription = false;
  const sub: CliOutbound = { type: 'subscribe', sessionId: state.sessionId };
  state.ws.send(JSON.stringify(sub));
}

function trackPendingPerm(state: AttachState, msg: CliInbound): void {
  if (msg.type === 'permission_request') {
    state.pendingPerms.push({ requestId: msg.requestId, tool: msg.tool, sessionId: msg.sessionId });
    return;
  }
  if (msg.type === 'permission_resolved') {
    const i = state.pendingPerms.findIndex((p) => p.requestId === msg.requestId);
    if (i >= 0) state.pendingPerms.splice(i, 1);
  }
}

function onWsMessage(state: AttachState, data: WebSocket.RawData): void {
  let msg: CliInbound;
  try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
  trackPendingPerm(state, msg);
  printInbound(msg, state.myLogin);
  if (msg.type === 'subscribed') {
    state.mySubscription = true;
    say(`${DIM}attached as ${BOLD}${msg.role}${RESET}${DIM}. type for prompt · @other <text> to route · /m <text> for op-msg · /y /n on permissions · /q to quit${RESET}`);
  }
  // Auth errors are fatal — bail without retrying so the
  // operator isn't stuck in a reconnect loop on a revoked PAT.
  if (msg.type === 'error' && (msg.code === 'auth_failed' || msg.code === 'token_revoked')) {
    state.stopRequested = true;
  }
}

function onWsClose(state: AttachState, reconnect: () => void, code: number, reason: Buffer): void {
  stopWorking();
  if (state.stopRequested || code === 1000 /* normal */) {
    say(`${DIM}[${ts()}] disconnected (${code}${reason && reason.length ? ': ' + reason.toString() : ''})${RESET}`);
    process.exit(0);
  }
  if (code === 1008 /* policy violation — auth */) {
    sayErr(`${RED}disconnected (${code}): auth rejected — won't retry${RESET}`);
    process.exit(2);
  }
  const delay = BACKOFF[Math.min(state.reconnectAttempt, BACKOFF.length - 1)];
  state.reconnectAttempt += 1;
  say(`${DIM}[${ts()}] ${AMBER}disconnected${RESET} (${code}${reason && reason.length ? ': ' + reason.toString() : ''})${DIM} — reconnecting in ${delay / 1000}s (attempt ${state.reconnectAttempt})${RESET}`);
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  state.reconnectTimer = setTimeout(() => { state.reconnectTimer = null; reconnect(); }, delay);
}

function onWsError(state: AttachState, err: Error): void {
  // Don't print 'error' on intentional close races — only when
  // the socket isn't already closing/closed. Routine close
  // emits 'error' on Windows even when the close handler will
  // run cleanly afterwards.
  if (state.ws.readyState === WebSocket.CLOSING || state.ws.readyState === WebSocket.CLOSED) return;
  sayErr(`${RED}ws error: ${err.message}${RESET}`);
}

function connectWs(state: AttachState): void {
  const reconnect = (): void => connectWs(state);
  state.ws = new WebSocket(state.wsUrl, { headers: { Authorization: `Bearer ${state.sessionToken}` } });
  state.ws.on('open',    () => onWsOpen(state));
  state.ws.on('message', (data) => onWsMessage(state, data));
  state.ws.on('close',   (code, reason) => onWsClose(state, reconnect, code, reason));
  state.ws.on('error',   (err) => onWsError(state, err));
}

// ----- Input-line dispatch (rl.on('line', ...)) -----

interface LineCtx {
  state: AttachState;
}

function handleQuitCmd(ctx: LineCtx): void {
  ctx.state.stopRequested = true;     // suppress the reconnect path
  if (ctx.state.reconnectTimer) { clearTimeout(ctx.state.reconnectTimer); ctx.state.reconnectTimer = null; }
  ctx.state.ws.close(1000, 'user quit');
}

// /debug — toggle the per-event payload dump mid-session.
// Forms: `/debug` (toggle), `/debug on`, `/debug off`. Useful
// when --debug is too noisy under heavy traffic; flip it off
// until you actually want to inspect, then flip on briefly.
function handleDebugCmd(text: string): void {
  const arg = text.slice('/debug'.length).trim().toLowerCase();
  if (arg === 'on')       debugMode = true;
  else if (arg === 'off') debugMode = false;
  else                    debugMode = !debugMode;
  say(`${DIM}debug: ${debugMode ? `${AMBER}on${RESET}${DIM}` : 'off'}${RESET}`);
}

function handleApprovalCmd(ctx: LineCtx, text: string): void {
  const pending = ctx.state.pendingPerms[ctx.state.pendingPerms.length - 1];
  if (!pending) {
    say(`${DIM}(no pending permission to act on)${RESET}`);
    return;
  }
  const decision = (text === '/y' || text === '/yes') ? 'allow' : 'deny';
  const approval: CliOutbound = {
    type:      'approval',
    sessionId: pending.sessionId,    // owner of the permission, may not be `sessionId`
    requestId: pending.requestId,
    decision,
  };
  ctx.state.ws.send(JSON.stringify(approval));
}

// /m <text> — operator-to-operator chat (the old default).
function handleOpMessageCmd(ctx: LineCtx, text: string): void {
  const opText = text.slice(2).trim();
  if (!opText) {
    say(`${DIM}usage: /m <text> (sends as op-message; bare text is a prompt)${RESET}`);
    return;
  }
  const out: CliOutbound = { type: 'op_message', sessionId: ctx.state.sessionId, text: opText };
  ctx.state.ws.send(JSON.stringify(out));
}

// /p <text> — kept as an explicit alias for prompt; identical
// to bare-text now that prompt is the default. Useful if
// someone scripted around the old slash form.
function handlePromptCmd(ctx: LineCtx, text: string): void {
  const promptText = text.slice(2).trim();
  if (!promptText) {
    say(`${DIM}usage: /p <text> (or just type — bare text is a prompt now)${RESET}`);
    return;
  }
  const out: CliOutbound = { type: 'prompt', sessionId: ctx.state.sessionId, text: promptText };
  ctx.state.ws.send(JSON.stringify(out));
  say(`${DIM}[${ts()}]${RESET} ${AMBER}→ prompt sent${RESET}  ${promptText}`);
  startWorking();   // optimistic — dot lights up before the round-trip mirror lands
}

const REDIRECT_UUID_RE = /^@?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REDIRECT_LINE_RE = /^(@?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|@[A-Za-z0-9._\-/]+)\s+([\s\S]+)$/i;

function sendRedirectByUuid(ctx: LineCtx, targetRef: string, promptText: string): void {
  const peerSessionId = targetRef.replace(/^@/, '');
  const out: CliOutbound = {
    type:            'prompt',
    sessionId:       peerSessionId,
    text:            promptText,
    sourceSessionId: ctx.state.sessionId,
  };
  ctx.state.ws.send(JSON.stringify(out));
  say(`${DIM}[${ts()}]${RESET} ${AMBER}→ prompt → ${peerSessionId.slice(0, 8)}…${RESET}  ${promptText}`);
  startWorking();
  armRouteWatchdog();
}

function reportRedirectAmbiguous(targetRef: string, liveMatches: ApiSession[]): void {
  const usedQualified = targetRef.includes('/');
  const advice = usedQualified
    ? `'${targetRef}' is ambiguous even within owner — re-issue using a session UUID:`
    : `'${targetRef}' is ambiguous — use the qualified form @owner/slug, or a UUID if the qualified form still collides:`;
  sayErr(`${RED}error: ${advice}${RESET}`);
  for (const c of liveMatches) {
    sayErr(`  ${c.id}  @${c.startedByLogin}/${(c.routingName ?? '').replace(/^@/, '')}  ${DIM}${c.cwd ?? ''}${RESET}`);
  }
}

// Resolve via the same matrix as session.ts/resolveSessionId.
// We do an API hit per redirect rather than caching — simpler,
// and at typing speed the latency is invisible.
async function resolveRedirectAndSend(ctx: LineCtx, targetRef: string, promptText: string): Promise<void> {
  const parts = splitRoutingRef(targetRef);
  try {
    const data = await api.get<{ items: ApiSession[] }>('/api/v1/sessions');
    const candidates = filterCandidatesByName(data.items, parts);
    if (candidates.length === 0) {
      sayErr(`${RED}error: no session ${targetRef} (try \`claw session list\` in another terminal)${RESET}`);
      return;
    }
    const liveMatches = candidates.filter((c) => c.connected);
    if (liveMatches.length > 1) {
      reportRedirectAmbiguous(targetRef, liveMatches);
      return;
    }
    const match = candidates[0];
    const out: CliOutbound = {
      type: 'prompt',
      sessionId: match.id,
      text: promptText,
      sourceSessionId: ctx.state.sessionId,
    };
    ctx.state.ws.send(JSON.stringify(out));
    say(`${DIM}[${ts()}]${RESET} ${AMBER}→ prompt → ${targetRef}${RESET}  ${promptText}`);
    startWorking();   // optimistic — dot lights up before the round-trip mirror lands
    armRouteWatchdog();
  } catch (e: any) {
    sayErr(`${RED}error: ${e?.message ?? String(e)}${RESET}`);
  }
}

// Cross-session redirect: leading @<who> retargets the prompt
// to a different session you have access to. Forms accepted:
//   @driver something            (your own routing name)
//   @MRIIOT/driver something     (qualified — useful when
//                                shares ship and routing names
//                                might overlap across owners)
// The session you're attached to keeps streaming events; only
// the destination of *this* line changes.
// Match either `@<routing-token> <text>` OR a bare UUID
// (with or without optional `@` prefix). UUIDs are unambiguous
// — the only reason to type one as a redirect target is to
// disambiguate when @owner/slug isn't enough (e.g. two
// sessions with the same owner AND routing name from cwds
// with matching basenames).
function handleRedirectLine(ctx: LineCtx, xMatch: RegExpExecArray): void {
  const targetRef  = xMatch[1];
  const promptText = xMatch[2].trim();
  if (!promptText) {
    say(`${DIM}usage: ${targetRef} <prompt>${RESET}`);
    return;
  }
  // UUID fast-path — skip the name resolver entirely. Strip
  // any leading `@` and use the UUID directly as sessionId.
  if (REDIRECT_UUID_RE.test(targetRef)) {
    sendRedirectByUuid(ctx, targetRef, promptText);
    return;
  }
  void resolveRedirectAndSend(ctx, targetRef, promptText);
}

function handleBarePrompt(ctx: LineCtx, text: string): void {
  const out: CliOutbound = { type: 'prompt', sessionId: ctx.state.sessionId, text };
  ctx.state.ws.send(JSON.stringify(out));
  say(`${DIM}[${ts()}]${RESET} ${AMBER}→ prompt${RESET}  ${text}`);
  startWorking();   // optimistic — dot lights up before the round-trip mirror lands
}

// Table-driven slash dispatcher. Each entry's `match` decides whether
// the handler claims this line; first match wins. Returning true from
// the handler means the line was handled (no fall-through).
const SLASH_HANDLERS: Array<{
  match: (text: string) => boolean;
  run:   (ctx: LineCtx, text: string) => void;
}> = [
  { match: (t) => t === '/q' || t === '/quit',                                  run: (c) => handleQuitCmd(c) },
  { match: (t) => t === '/debug' || t.startsWith('/debug '),                    run: (_, t) => handleDebugCmd(t) },
  { match: (t) => t === '/y' || t === '/yes' || t === '/n' || t === '/no',     run: (c, t) => handleApprovalCmd(c, t) },
  { match: (t) => t === '/m' || t.startsWith('/m '),                            run: (c, t) => handleOpMessageCmd(c, t) },
  { match: (t) => t === '/p' || t.startsWith('/p '),                            run: (c, t) => handlePromptCmd(c, t) },
];

function dispatchSlash(ctx: LineCtx, text: string): boolean {
  for (const h of SLASH_HANDLERS) {
    if (h.match(text)) { h.run(ctx, text); return true; }
  }
  if (text.startsWith('/')) {
    say(`${DIM}unknown slash-command: ${text} (try /m /y /n /debug /q)${RESET}`);
    return true;
  }
  return false;
}

function handleInputLine(ctx: LineCtx, raw: string): void {
  const text = raw.trim();
  if (!text) return;
  if (!ctx.state.mySubscription) {
    say(`${DIM}(not subscribed yet — waiting...)${RESET}`);
    return;
  }
  if (dispatchSlash(ctx, text)) return;
  const xMatch = REDIRECT_LINE_RE.exec(text);
  if (xMatch) { handleRedirectLine(ctx, xMatch); return; }
  // Bare text = prompt to the currently-attached session.
  handleBarePrompt(ctx, text);
}

function setupReadline(ctx: LineCtx): void {
  // terminal: true so readline manages the input line rendering
  // (prompt, cursor, line editing). Combined with say()/sayErr()
  // wrapping every event-side console.log, the input box stays
  // anchored at the bottom while events scroll above.
  const rl = createInterface({
    input:    process.stdin,
    output:   process.stdout,
    terminal: process.stdout.isTTY ? true : false,
    prompt:   PROMPT_BASE,
  });
  rlRef = rl;
  if (process.stdout.isTTY) rl.prompt(true);
  rl.on('line', (raw) => handleInputLine(ctx, raw));
  process.on('SIGINT', () => {
    ctx.state.stopRequested = true;     // don't try to reconnect after Ctrl-C
    if (ctx.state.reconnectTimer) { clearTimeout(ctx.state.reconnectTimer); ctx.state.reconnectTimer = null; }
    ctx.state.ws.close(1000, 'sigint');
  });
}

export const sessionAttach = new Command('attach')
  .description('open a TUI on a session — see the chat stream, post op-messages')
  .argument('<ref>', 'session UUID or @routingName (e.g. @driver)')
  .option('--limit <n>',     'history items to load before the live stream begins. 0 = none. "all" = up to 5000. default 50.', '50')
  .option('--no-op-messages', 'exclude op-messages from the history backlog (live ones still arrive once attached)')
  .option('--no-markdown',    'render assistant_text and reply payloads as raw text instead of formatted markdown')
  .option('--debug',          'after every rendered event, print its full JSON payload (truncated at 2 KB) — surfaces fields the renderer normally hides (e.g., SubagentStop\'s last_assistant_message, PreToolUse tool_input details)')
  .option('--no-status',      'disable the animated "claude working" dot at the bottom of the TUI (useful for piped output or rough-ANSI terminals)')
  .action(async (ref: string, opts: AttachOpts) => {
    applyAttachFlags(opts);
    const cfg = loadConfig();
    if (!cfg.sessionToken) {
      console.error('error: not logged in. run `claw login`.');
      process.exit(2);
    }
    const myLogin   = await fetchMyLogin();
    const sessionId = await resolveAttachSessionId(ref);
    await drainHistoryBacklog(sessionId, opts, myLogin);

    // Pending permission requests survive reconnects intentionally —
    // the hub's permission_requests rows persist across restarts, so
    // /y and /n on a perm queued before the disconnect still resolves
    // correctly afterwards.
    //
    // Reconnect-with-backoff. Hub restarts (fly deploys, crashes,
    // network blips) used to drop the TUI with a 1006 close. Now we
    // hold the conn and retry on the same backoff schedule channel_v1
    // uses for its WS, with the same fatal-on-auth carve-out.
    const state: AttachState = {
      ws:               undefined as unknown as WebSocket,    // assigned by connectWs()
      sessionId,
      myLogin,
      hubUrl:           cfg.hubUrl,
      wsUrl:            cfg.hubUrl.replace(/^http/i, 'ws') + '/cli',
      sessionToken:     cfg.sessionToken,
      mySubscription:   false,
      pendingPerms:     [],
      stopRequested:    false,
      reconnectAttempt: 0,
      reconnectTimer:   null,
    };
    connectWs(state);
    // Below this point, callers reference `state.ws` for sending — and
    // it's reassigned on each reconnect, so the latest socket is always
    // what gets the next send.
    setupReadline({ state });
  });

function printInboundOpMessage(msg: Extract<CliInbound, { type: 'op_message' }>): void {
  say(`${DIM}[${shortTs(msg.ts)}]${RESET} ${GREEN}@${msg.authorLogin}${RESET}  ${msg.text}`);
}

function printInboundPermissionRequest(msg: Extract<CliInbound, { type: 'permission_request' }>): void {
  say(`${RED}[!] ${shortTs(msg.ts)}${RESET}  approval needed: ${BOLD}${msg.tool}${RESET} — ${msg.inputPreview}`);
}

function printInboundPermissionResolved(msg: Extract<CliInbound, { type: 'permission_resolved' }>): void {
  const dec = msg.decision === 'allow' ? `${GREEN}allowed${RESET}` :
              msg.decision === 'deny'  ? `${RED}denied${RESET}` :
                                         `${DIM}expired${RESET}`;
  say(`${DIM}[${ts()}]${RESET} permission ${msg.requestId} ${dec} by @${msg.resolverLogin ?? '?'}`);
}

function printInboundPresence(msg: Extract<CliInbound, { type: 'presence' }>): void {
  // Lead with the delta when known so operators don't have to
  // diff the attached list against the previous one to figure
  // out who just joined or left. Falls back to the bare list
  // when no delta is provided (e.g., refresh broadcasts).
  const list = msg.attached.map((l) => '@' + l).join(', ') || '(empty)';
  let line: string;
  if (msg.joined) {
    line = `${GREEN}+ @${msg.joined} joined${RESET}${DIM} (attached: ${list})${RESET}`;
  } else if (msg.left) {
    line = `${AMBER}- @${msg.left} left${RESET}${DIM} (attached: ${list})${RESET}`;
  } else {
    line = `${DIM}presence: ${list}${RESET}`;
  }
  say(`${DIM}[${ts()}]${RESET} ${line}`);
}

function printInboundChannelStatus(msg: Extract<CliInbound, { type: 'channel_status' }>): void {
  // Explicit "the CC channel for this session just (dis)connected"
  // signal — distinct from `presence` which only tracks attached
  // OPERATORS, not whether CC itself is alive.
  const tag = msg.connected
    ? `${GREEN}● channel online${RESET}`
    : `${RED}○ channel offline${RESET}`;
  say(`${DIM}[${shortTs(msg.ts)}]${RESET} ${tag}`);
  // If the channel went offline mid-turn, the spinner stops
  // tracking real activity — wipe it so the operator doesn't
  // think Claude is still working.
  if (!msg.connected) stopWorking();
}

function printInboundFileEvent(msg: Extract<CliInbound, { type: 'file_event' }>): void {
  // Operator on the same session uploaded or deleted a file —
  // surface it inline so attached operators don't have to refresh
  // a separate /files view to notice. Same shape the timeline
  // backlog uses for kind=file items, just over the WS now.
  const verb = msg.action === 'uploaded'
    ? `${GREEN}📎 uploaded${RESET}`
    : `${RED}✗ deleted${RESET}`;
  const f = msg.file;
  say(`${DIM}[${ts()}]${RESET} ${BLUE}@${f.uploaderLogin}${RESET}  ${verb} ${BOLD}${f.filename}${RESET} ${DIM}(${fmtBytes(f.size)} · fileId=${f.id})${RESET}`);
}

type InboundPrinter = (msg: any, myLogin: string | null) => void;

const INBOUND_PRINTERS: Record<string, InboundPrinter> = {
  subscribed:           ()        => { /* header printed by the open handler */ },
  event:                (msg, ml) => renderEvent(msg.event, ml),
  op_message:           (msg)     => printInboundOpMessage(msg),
  permission_request:   (msg)     => printInboundPermissionRequest(msg),
  permission_resolved:  (msg)     => printInboundPermissionResolved(msg),
  presence:             (msg)     => printInboundPresence(msg),
  channel_status:       (msg)     => printInboundChannelStatus(msg),
  file_event:           (msg)     => printInboundFileEvent(msg),
  ack:                  ()        => { /* suppress — too noisy */ },
  error:                (msg)     => sayErr(`${RED}error (${msg.code}): ${msg.message}${RESET}`),
};

function printInbound(msg: CliInbound, myLogin: string | null): void {
  const fn = INBOUND_PRINTERS[msg.type];
  if (fn) fn(msg, myLogin);
}

function shortTs(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString() : iso.slice(11, 19);
}

function fmtBytes(n: number): string {
  if (n < 1024)            return `${n} B`;
  if (n < 1024 * 1024)     return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3)       return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function previewPayload(p: Record<string, unknown>): string {
  const text = (p?.text ?? p?.preview ?? p?.outputPreview ?? '');
  if (typeof text === 'string' && text.length > 0) {
    return text.length > 240 ? text.slice(0, 240) + '…' : text;
  }
  return JSON.stringify(p).slice(0, 240);
}

// Print the full payload as dimmed, indented JSON when --debug is
// active. Caps at 2 KB so a giant tool_response doesn't drown the
// terminal. Runs after the type-specific renderer line so the debug
// dump appears as a sub-block under each event.
function maybeDebugDump(p: Record<string, unknown>): void {
  if (!debugMode) return;
  let json: string;
  try { json = JSON.stringify(p, null, 2); }
  catch { json = String(p); }
  const TRUNC = 2000;
  if (json.length > TRUNC) json = json.slice(0, TRUNC) + '\n... [truncated, payload was ' + json.length + ' bytes]';
  for (const line of json.split('\n')) {
    say(`  ${DIM}${line}${RESET}`);
  }
}

// Suppress the chat/prompt own-mirror dup ONLY for live events.
// The operator's local-echo line already showed when they hit
// enter, so the mirror back is duplicate noise. But on a TUI
// restart the local echo never happened — so we render the
// persisted event normally to recover history.
function isOwnPromptMirror(
  ev: { kind: 'chat' | 'tail'; type: string },
  p: Record<string, unknown>,
  myLogin: string | null,
  fromBacklog: boolean,
): boolean {
  if (fromBacklog) return false;
  if (ev.kind !== 'chat' || ev.type !== 'prompt') return false;
  const src = String(p.source ?? '');
  if (src !== 'operator' && src !== 'operator-route') return false;
  return !!myLogin && p.authorLogin === myLogin;
}

// Render an inbound event with type-specific shape. A chat-stream
// event lands in the "conversation" lane (you / claude); a tail
// event lands in the "activity" lane (tool calls, lifecycle markers).
// Unknown types fall back to the generic [kind:type] form.
function renderEvent(
  ev: { kind: 'chat' | 'tail'; type: string; payload: Record<string, unknown>; ts: string },
  myLogin: string | null,
  fromBacklog: boolean = false,
): void {
  const ts = shortTs(ev.ts);
  const p  = ev.payload || {};
  if (isOwnPromptMirror(ev, p, myLogin, fromBacklog)) return;
  // Wrap in try/finally so each event ALWAYS gets a debug dump after
  // the type-specific renderer prints, regardless of which branch
  // returned.
  try { renderEventBody(ev, ts, p, myLogin); }
  finally { maybeDebugDump(p); }
}

// Working-state heartbeat: any chat/prompt or tail/PreToolUse means
// a turn is in progress; tail/Stop closes it. tail/SubagentStop is
// intentionally NOT a turn boundary (parent agent is still running).
function applyWorkingHeartbeat(ev: { kind: 'chat' | 'tail'; type: string }): void {
  if (ev.kind === 'chat' && ev.type === 'prompt') startWorking();
  else if (ev.kind === 'tail' && ev.type === 'PreToolUse') startWorking();
  else if (ev.kind === 'tail' && ev.type === 'Stop')       stopWorking();
}

function extractPromptText(p: Record<string, unknown>): string {
  const raw = String(p.text ?? p.prompt ?? '').trim();
  return raw || JSON.stringify(p).slice(0, 200);
}

function shortPeer(p: Record<string, unknown>): string {
  const peer = String(p.peerLogin ?? p.peerSessionId ?? '?');
  return peer.length > 36 ? peer.slice(0, 8) + '…' : peer;
}

function promptLabel(p: Record<string, unknown>, source: string): string {
  if (source === 'operator') return `${BOLD}@${String(p.authorLogin ?? 'remote')} ›${RESET}`;
  return `${BOLD}(cli) ›${RESET}`;
}

function renderChatPromptBody(ts: string, p: Record<string, unknown>): void {
  const text = extractPromptText(p);
  // source-tag origin: 'cli' = local user typed at CC's terminal
  // (UserPromptSubmit hook), 'operator' = remote operator sent
  // via /cli WS (cli.ts mirror). Default to (cli) when missing —
  // matches old behavior for hook-derived prompts that didn't
  // carry a marker.
  // Own-mirror suppression for source='operator' + authorLogin
  // === myLogin already happened in renderEvent before we got
  // here, so we'd never see one of our own prompts in this path.
  const source = String(p.source ?? 'cli');
  // operator-route: this is the operator's outbound prompt to a
  // peer session, persisted in source-session events so reattach
  // can recover the dispatch alongside the eventual peer-reply.
  // Render style mirrors the live local-echo at submit time:
  // `→ <peer>  text`.
  if (source === 'operator-route') {
    say(`${DIM}[${ts}]${RESET} ${AMBER}→ prompt → ${shortPeer(p)}${RESET}  ${text}`);
    return;
  }
  say(`${DIM}[${ts}]${RESET} ${promptLabel(p, source)} ${text}`);
}

function renderChatAssistantTextBody(ts: string, p: Record<string, unknown>): void {
  const text = String(p.text ?? '').trim();
  const isPlaceholder = !!p.placeholder;
  const tag = isPlaceholder ? `${DIM}claude · thinking${RESET}` : `${AMBER}claude${RESET}`;
  const prefix = `${DIM}[${ts}]${RESET} ${tag}`;
  // Placeholders are short single-line "thinking" markers; skip
  // markdown rendering and dim them inline.
  if (isPlaceholder) {
    say(`${prefix}  ${DIM}${text}${RESET}`);
    return;
  }
  emitChatLine(prefix, renderMarkdown(text));
}

function renderChatReplyBody(ts: string, p: Record<string, unknown>): void {
  const text = String(p.text ?? '').trim();
  // peer-reply: this row was synthesized by the hub from a
  // chat_event reply that landed in another session whose
  // chatId we registered when the operator @-redirected a
  // prompt. Label it so the operator knows which peer answered.
  const tag = p.source === 'peer-reply' && p.peerLogin
    ? `${AMBER}${String(p.peerLogin)} answered${RESET}`
    : (p.chatId
      ? `${AMBER}claude${RESET} ${DIM}(reply to ${String(p.chatId).slice(0, 8)})${RESET}`
      : `${AMBER}claude${RESET}`);
  emitChatLine(`${DIM}[${ts}]${RESET} ${tag}`, renderMarkdown(text));
  // Reply landed — the route is no longer pending. Source
  // Claude will emit its own tail/Stop once it consumes the
  // peer report, so leave the spinner running.
  if (p.source === 'peer-reply') disarmRouteWatchdog();
}

function renderChatPeerTimeoutBody(ts: string, p: Record<string, unknown>): void {
  // Hub's op-route tracker GC'd without ever seeing a reply
  // (most often: the peer's Claude denied the
  // mcp__clawborrator__reply tool call). Surface it and clear
  // the watchdog so the spinner stops if it's still spinning.
  const peer = String(p.peerLogin ?? p.peerSessionId ?? '?');
  const peerShort = peer.length > 36 ? peer.slice(0, 8) + '…' : peer;
  say(`${DIM}[${ts}]${RESET} ${RED}⚠ ${peerShort} did not reply${RESET} ${DIM}— peer's Claude may have denied the reply tool${RESET}`);
  disarmRouteWatchdog();
  stopWorking();
}

function renderChatBody(ev: { type: string }, ts: string, p: Record<string, unknown>): void {
  if (ev.type === 'prompt')         { renderChatPromptBody(ts, p);        return; }
  if (ev.type === 'assistant_text') { renderChatAssistantTextBody(ts, p); return; }
  if (ev.type === 'reply')          { renderChatReplyBody(ts, p);         return; }
  if (ev.type === 'peer-timeout')   { renderChatPeerTimeoutBody(ts, p);   return; }
  // Generic chat fallback
  say(`${DIM}[${ts}]${RESET} ${AMBER}[chat:${ev.type}]${RESET} ${previewPayload(p)}`);
}

function renderTailPreToolUseBody(ts: string, p: Record<string, unknown>): void {
  const tool  = String(p.tool_name ?? p.toolName ?? p.tool ?? '?');
  const input = renderToolInput(p);
  say(`${DIM}[${ts}]${RESET} ${BLUE}→ ${tool}${RESET} ${DIM}${input}${RESET}`);
}

function renderTailPostToolUseBody(ts: string, p: Record<string, unknown>): void {
  const tool = String(p.tool_name ?? p.toolName ?? p.tool ?? '?');
  const out  = stringifyToolResponse(p.tool_response ?? p.toolResponse ?? p.outputPreview ?? p.output);
  const ok   = p.ok === false ? `${RED}✗${RESET}` : `${BLUE}✓${RESET}`;
  say(`${DIM}[${ts}]${RESET} ${ok} ${tool}${out ? '  ' + DIM + truncate(out, 200) + RESET : ''}`);
}

function renderTailPostToolUseFailureBody(ts: string, p: Record<string, unknown>): void {
  const tool = String(p.tool_name ?? p.toolName ?? p.tool ?? '?');
  const err  = stringifyToolResponse(p.error ?? p.message ?? p.tool_response);
  say(`${DIM}[${ts}]${RESET} ${RED}✗ ${tool}${RESET}  ${RED}${truncate(err, 200)}${RESET}`);
}

function renderTailTaskBody(ts: string, p: Record<string, unknown>, which: string): void {
  const desc = String(p.description ?? p.agentType ?? '');
  say(`${DIM}[${ts}] ${BLUE}↪ ${which}${RESET}${desc ? ' ' + desc : ''}`);
}

function renderTailNotificationBody(ts: string, p: Record<string, unknown>): void {
  const msg = String(p.message ?? p.text ?? '').trim();
  say(`${DIM}[${ts}]${RESET} ${BOLD}🔔${RESET} ${msg || JSON.stringify(p).slice(0, 200)}`);
}

type TailRenderer = (ts: string, p: Record<string, unknown>, type: string) => void;

const TAIL_RENDERERS: Record<string, TailRenderer> = {
  PreToolUse:         (ts, p) => renderTailPreToolUseBody(ts, p),
  PostToolUse:        (ts, p) => renderTailPostToolUseBody(ts, p),
  PostToolUseFailure: (ts, p) => renderTailPostToolUseFailureBody(ts, p),
  Stop:               (ts)    => say(`${DIM}[${ts}]  — turn end —${RESET}`),
  SessionStart:       (ts)    => say(`${DIM}[${ts}]  ▸ session start${RESET}`),
  SessionEnd:         (ts)    => say(`${DIM}[${ts}]  ◂ session end${RESET}`),
  TaskCreated:        (ts, p, type) => renderTailTaskBody(ts, p, type),
  SubagentStart:      (ts, p, type) => renderTailTaskBody(ts, p, type),
  SubagentStop:       (ts, p, type) => renderTailTaskBody(ts, p, type),
  TaskCompleted:      (ts, p, type) => renderTailTaskBody(ts, p, type),
  Notification:       (ts, p) => renderTailNotificationBody(ts, p),
};

function renderTailBody(ev: { type: string }, ts: string, p: Record<string, unknown>): void {
  const fn = TAIL_RENDERERS[ev.type];
  if (fn) { fn(ts, p, ev.type); return; }
  say(`${DIM}[${ts}]${RESET} ${BLUE}[${ev.type}]${RESET} ${previewPayload(p)}`);
}

function renderEventBody(
  ev: { kind: 'chat' | 'tail'; type: string; payload: Record<string, unknown>; ts: string },
  ts: string,
  p: Record<string, unknown>,
  _myLogin: string | null,
): void {
  applyWorkingHeartbeat(ev);
  if (ev.kind === 'chat') { renderChatBody(ev, ts, p); return; }
  renderTailBody(ev, ts, p);
}

// Claude Code's PostToolUse hook payload carries `tool_response`
// in a few shapes:
//   - plain string (most native tools)
//   - { type: 'text', text: '...' }  (single-block content)
//   - [{ type: 'text', text: '...' }, ...]  (array of blocks)
//   - { content: [{ type: 'text', text: '...' }, ...] }  (MCP-style)
//   - any other object — fall back to JSON
// String() on any object form yields '[object Object]', so we walk
// the common shapes before giving up.
function isTextBlock(v: unknown): v is { type: 'text'; text: string } {
  return typeof v === 'object' && v !== null
    && (v as Record<string, unknown>).type === 'text'
    && typeof (v as { text?: unknown }).text === 'string';
}

function stringifyToolResponseScalar(v: unknown): string | null {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

function stringifyToolResponseArray(v: unknown[]): string | null {
  const texts: string[] = [];
  for (const b of v) if (isTextBlock(b)) texts.push(b.text);
  if (texts.length === 0) return null;
  return texts.join('\n').trim();
}

function stringifyToolResponseFallback(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}

function stringifyToolResponse(v: unknown): string {
  const scalar = stringifyToolResponseScalar(v);
  if (scalar !== null) return scalar;
  // Single block: { type: 'text', text: '...' }
  if (isTextBlock(v)) return v.text.trim();
  // Array of blocks
  if (Array.isArray(v)) {
    const out = stringifyToolResponseArray(v);
    if (out !== null) return out;
  }
  // MCP-style { content: [...] }
  if (typeof v === 'object' && v !== null && Array.isArray((v as { content?: unknown }).content)) {
    return stringifyToolResponse((v as { content: unknown[] }).content);
  }
  // Last resort: JSON. Keep it terse so it doesn't blow the line.
  return stringifyToolResponseFallback(v);
}

function renderToolInput(p: Record<string, unknown>): string {
  const input = (p as { tool_input?: unknown; toolInput?: unknown }).tool_input
              ?? (p as { tool_input?: unknown; toolInput?: unknown }).toolInput;
  if (!input || typeof input !== 'object') return '';
  // Pull the most-useful single-line summary out of common shapes.
  const obj = input as Record<string, unknown>;
  const candidates = ['command', 'file_path', 'path', 'query', 'pattern', 'url', 'prompt'];
  for (const k of candidates) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return `(${truncate(v, 120)})`;
  }
  return `(${truncate(JSON.stringify(obj), 120)})`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
