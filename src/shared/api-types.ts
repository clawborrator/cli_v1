// REST API response shapes. Hand-written to match what
// `server/src/routes/v1/*` returns. Stable contracts — change only
// in additive ways (new optional fields are fine; renames are not).

export interface ApiUser {
  id: number;
  githubLogin: string;
  avatarUrl: string | null;
  isAdmin: boolean;
  createdAt: string;        // ISO-8601
}

export interface ApiToken {
  id: number;
  kind: 'channel' | 'app';    // 'app' = SPA OAuth/PKCE Bearer (`cw_app_…`); 'channel' = clawborrator-mcp register (`ck_live_…`).
  name: string;
  prefix: string;
  appName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface ApiTokenWithPlaintext extends ApiToken {
  /** Returned ONLY on POST /tokens/channel — the plaintext is shown once. */
  token: string;
}

// Public expert agent — addressable as `@<ownerLogin>/<slug>` in
// regular prompt text. The hub intercepts that pattern and routes
// to the agent's session subject to rate-limit gates encoded on the
// row. Different surface from sessionShares (which grants a
// specific user access to a private session).
export interface ApiAgent {
  id:                 number;
  handle:             string;        // <ownerLogin>/<slug>
  ownerLogin:         string;
  sessionId:          string;
  routingName:        string | null; // session.routingName for context
  name:               string;
  tagline:            string;
  description:        string;
  status:             'draft' | 'published';
  online:             boolean;        // derived from liveChannels
  concurrencyCap:     number;
  dailyBudgetQueries: number;
  queriesToday:       number;
  queriesAllTime:     number;
  lastQueryAt:        string | null;
  publishedAt:        string | null;
  createdAt:          string;
  /** When true (default), the agent's CC cannot use cross-session
   *  routing tools while answering a public dispatch. Owners opt
   *  out per-agent for composable / orchestrator workflows. */
  isolated:           boolean;
  /** Project-level CLAUDE.md the agent's CC is configured with.
   *  Owner-curated; rendered expandably on the discovery page so
   *  callers can see the agent's scope before asking. Null when
   *  the owner hasn't filled it in. */
  claudeMd:           string | null;
  /** Free-form narrative on tone, voice, constraints, disclaimers
   *  the owner wants prospective callers to read. Rendered as the
   *  second expandable section on the discovery page. Null when
   *  unset. */
  personalizationPrompt: string | null;
}

export interface ApiAgentInbound {
  agent: ApiAgent;
  window: { days: number; since: string };
  summary: {
    total:           number;
    ok:              number;
    denied:          number;
    avgLatencyMs:    number | null;
    distinctAskers:  number;
  };
  topAskers: { login: string; count: number; lastAt: string }[];
  recent: {
    ts:           string;
    askerLogin:   string;
    ok:           boolean;
    latencyMs:    number | null;
    question:     string;
    routeId:      string | null;
    deniedReason: string | null;
  }[];
}

export interface ApiFile {
  id:            number;            // primary key in `files` table
  sessionId:     string;
  uploaderLogin: string;
  filename:      string;
  mime:          string;
  size:          number;
  sha256:        string;
  scope:         'attachment' | 'reply' | 'corpus';
  expose:        boolean;
  uploadedAt:    string;            // ISO-8601
  expiresAt:     string;
  deletedAt:     string | null;
}

// Session credential (cookie OR Authorization Bearer for the CLI).
// Issued by /api/v1/auth/oauth/token after a successful PKCE redemption.
export interface ApiAuthSession {
  token:     string;          // `cw_sess_<32 hex>`; sent on every request
  expiresAt: string;          // ISO-8601
}
export interface ApiAuthTokenResponse {
  user:    ApiUser;
  session: ApiAuthSession;
}

export type SessionRole = 'owner' | 'viewer' | 'prompter' | 'approver';

export interface ApiSession {
  id: string;                // UUID
  routingName: string | null; // e.g. "@foo"
  startedByLogin: string;
  role: SessionRole;
  host: string | null;
  cwd: string | null;
  channelVersion: string | null;
  startedAt: string;
  lastSeenAt: string;
  archivedAt: string | null;
  connected: boolean;        // derived from live-WS state
  // Set to "<owner>/<slug>" when this session backs a status='published'
  // public agent. Null for private / draft / non-agent sessions.
  // Surfaced so list UIs can mark agent-published sessions with a
  // robot icon without a second round-trip.
  agentHandle?: string | null;
  // When set, this session was created by a desktop daemon and can
  // be remote-controlled (kill / restart / screenshot) via the
  // /supervisor protocol. Null = unmanaged (CLI-spawned, manually-
  // configured MCP, etc).
  managedBy?: { machineId: string; daemonVersion?: string | null } | null;
}

export interface ApiSessionShare {
  userLogin: string;
  role: Exclude<SessionRole, 'owner'>;
  sharedByLogin: string;
  createdAt: string;
}

// Pending or historical permission request from the channel CC.
// REST clients poll GET /api/v1/sessions/:id/permissions to discover
// pending rows and POST /…/resolve to allow or deny them. The /cli
// WS path delivers the same shape live; this is the REST mirror.
export type ApiPermissionStatus = 'pending' | 'allowed' | 'denied' | 'expired';
export interface ApiPermissionRequest {
  requestId:       string;        // channel-supplied id
  tool:            string;
  inputPreview:    string;
  status:          ApiPermissionStatus;
  requestedAt:     string;
  resolvedAt:      string | null;
  resolverLogin:   string | null;
  resolvedMessage: string | null;
}


