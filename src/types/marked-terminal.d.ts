// Minimal ambient declaration for marked-terminal v7 — the package
// ships no `.d.ts` and @types/marked-terminal lags behind. We only
// use the named export `markedTerminal` as a marked extension, so a
// loose signature is enough.
declare module 'marked-terminal' {
  export function markedTerminal(opts?: Record<string, unknown>): unknown;
}
