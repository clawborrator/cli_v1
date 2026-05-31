// Compress a long User-Agent into a one-line surface tag for CLI
// table output. Recognized patterns get a short label; anything else
// falls back to "Browser on Unknown" or a truncation. Shared between
// `claw auth-sessions ls` and `claw token ls` so both commands
// surface the same shorthand.

// Exact-substring app agents, checked first and returned verbatim.
const APP_AGENTS: ReadonlyArray<readonly [needle: string, label: string]> = [
  ['clawborrator-cli',        'clawborrator-cli'],
  ['clawborrator-supervisor', 'clawborrator-supervisor'],
];

// Browser detection, first match wins. Order matters: Edge's UA
// contains "Chrome", and iOS Chrome reports "CriOS" without the
// standard "Chrome" token.
const BROWSER_RULES: ReadonlyArray<readonly [re: RegExp, label: string]> = [
  [/\bCriOS\//,   'Chrome'],
  [/\bEdg\//,     'Edge'],
  [/\bFirefox\//, 'Firefox'],
  [/\bChrome\//,  'Chrome'],
  [/\bSafari\//,  'Safari'],
];

// OS detection, first match wins. Android MUST precede Linux: Android
// UAs contain "Linux", so the original code special-cased Linux with
// "&& !Android". Ordering Android first is the table-driven equivalent.
const OS_RULES: ReadonlyArray<readonly [re: RegExp, label: string]> = [
  [/\bWindows NT\b/,      'Windows'],
  [/\bMacintosh\b/,       'macOS'],
  [/\bAndroid\b/,         'Android'],
  [/\bLinux\b/,           'Linux'],
  [/\biPhone\b|\biPad\b/, 'iOS'],
];

export function shortUserAgent(ua: string | null | undefined): string {
  if (!ua) return '(unknown)';
  for (const [needle, label] of APP_AGENTS) {
    if (ua.includes(needle)) return label;
  }
  const browser = BROWSER_RULES.find(([re]) => re.test(ua))?.[1] ?? 'Browser';
  const os      = OS_RULES.find(([re]) => re.test(ua))?.[1] ?? 'Unknown';
  return `${browser} on ${os}`;
}
