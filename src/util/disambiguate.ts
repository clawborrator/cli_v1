// Interactive disambiguator for session-ref resolution.
//
// Default behavior (read-side commands like info/events/attach):
// prompt only when there are multiple LIVE matches. The operator
// almost always means the running one when they say `@driver` for a
// status / read op, so we prefer-live silently.
//
// Destructive callers (delete --hard) pass `destructive: true`,
// which broadens the prompt rule to "any time there's more than one
// non-archived match, regardless of online state." Auto-picking the
// live row and leaving the offline ghost for a second `delete`
// invocation is exactly the footgun this option closes.

import { createInterface } from 'node:readline';

export interface CandidateLike {
  id:              string;
  routingName:     string | null;
  startedByLogin:  string;
  cwd:             string | null;
  host:            string | null;
  lastSeenAt:      string;
  connected:       boolean;
  role?:           string;
}

const RESET = '\x1b[0m';
const DIM   = '\x1b[2m';
const BOLD  = '\x1b[1m';

export class AmbiguousError extends Error {
  code = 'CLW_AMBIGUOUS';
  constructor(public candidates: CandidateLike[], public input: string) {
    super(`ambiguous reference '${input}' — multiple online sessions match`);
  }
}

export interface PickOptions {
  /** Prompt on ANY multi-match instead of just multi-live. Use for
   *  destructive ops (delete --hard) where silently picking the live
   *  row leaves the offline ghost as a second-invocation footgun. */
  destructive?: boolean;
}

// Decide which candidates to prompt the user about.
// - Read mode: prompt only when multiple LIVE candidates exist;
//   prefer-live silently otherwise.
// - Destructive mode: prompt whenever there are multiple matches at
//   all (live + offline both count), so an online + offline pair
//   doesn't get auto-resolved to "delete the online one first."
// Returns either the single candidate to auto-pick, or the set to
// prompt over.
function selectPromptSet(
  candidates: CandidateLike[],
  opts: PickOptions,
): { auto: CandidateLike } | { promptSet: CandidateLike[] } {
  const live = candidates.filter((c) => c.connected);
  if (opts.destructive) {
    if (candidates.length <= 1) return { auto: candidates[0] };
    return { promptSet: candidates };
  }
  if (live.length <= 1) return { auto: live[0] ?? candidates[0] };
  return { promptSet: live };
}

function formatCandidateLine(c: CandidateLike, idx: number): string {
  const qualified = c.routingName
    ? `@${c.startedByLogin}/${c.routingName.replace(/^@/, '')}`
    : `(no routing name)`;
  const status = c.connected ? `${BOLD}● online${RESET}` : `${DIM}○ offline${RESET}`;
  const cwd  = c.cwd  ? `  ${DIM}${c.cwd}${RESET}` : '';
  const host = c.host ? `  ${DIM}${c.host}${RESET}` : '';
  const seen = c.lastSeenAt ? `  ${DIM}last seen ${c.lastSeenAt}${RESET}` : '';
  return `  ${BOLD}${idx + 1}${RESET}. ${qualified}  ${status}${host}${cwd}${seen}\n     ${DIM}id ${c.id}${RESET}`;
}

function renderPromptList(input: string, promptSet: CandidateLike[]): void {
  process.stderr.write(`${BOLD}'${input}' is ambiguous — pick a session:${RESET}\n`);
  for (let i = 0; i < promptSet.length; i++) {
    process.stderr.write(formatCandidateLine(promptSet[i], i) + '\n');
  }
  process.stderr.write(`  ${BOLD}q${RESET}. cancel\n`);
}

async function readSelection(promptSet: CandidateLike[]): Promise<CandidateLike> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((resolve) => {
    rl.question(`pick [1-${promptSet.length}]: `, resolve);
  });
  rl.close();
  const trimmed = answer.trim().toLowerCase();
  if (trimmed === 'q' || trimmed === 'quit' || trimmed === '') {
    throw new Error('cancelled');
  }
  const idx = parseInt(trimmed, 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > promptSet.length) {
    throw new Error(`invalid selection '${answer}'`);
  }
  return promptSet[idx - 1];
}

/**
 * Pick a single candidate. If TTY, prompt; otherwise throw an
 * AmbiguousError so the caller can render an actionable message
 * (with UUIDs to copy into a re-run).
 */
export async function pickCandidate(
  input: string,
  candidates: CandidateLike[],
  opts: PickOptions = {},
): Promise<CandidateLike> {
  if (candidates.length === 1) return candidates[0];
  const sel = selectPromptSet(candidates, opts);
  if ('auto' in sel) return sel.auto;
  const promptSet = sel.promptSet;

  // Non-interactive path: error out with full info so the operator
  // can re-run with a UUID or qualified form.
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new AmbiguousError(promptSet, input);
  }

  // Interactive prompt — to stderr so stdout stays clean for piping.
  renderPromptList(input, promptSet);
  return readSelection(promptSet);
}
