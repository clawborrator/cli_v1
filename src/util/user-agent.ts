// Compress a long User-Agent into a one-line surface tag for CLI
// table output. Recognized patterns get a short label; anything else
// falls back to "Browser on Unknown" or a truncation. Shared between
// `claw auth-sessions ls` and `claw token ls` so both commands
// surface the same shorthand.

export function shortUserAgent(ua: string | null | undefined): string {
  if (!ua) return '(unknown)';
  if (ua.includes('clawborrator-cli'))         return 'clawborrator-cli';
  if (ua.includes('clawborrator-supervisor'))  return 'clawborrator-supervisor';
  // Browser detection — order matters (Edge contains "Chrome", iPhone
  // Chrome contains "CriOS" without standard "Chrome", etc).
  let browser = 'Browser';
  if      (/\bCriOS\//.test(ua))   browser = 'Chrome';
  else if (/\bEdg\//.test(ua))     browser = 'Edge';
  else if (/\bFirefox\//.test(ua)) browser = 'Firefox';
  else if (/\bChrome\//.test(ua))  browser = 'Chrome';
  else if (/\bSafari\//.test(ua))  browser = 'Safari';
  let os = 'Unknown';
  if      (/\bWindows NT\b/.test(ua))                       os = 'Windows';
  else if (/\bMacintosh\b/.test(ua))                        os = 'macOS';
  else if (/\bLinux\b/.test(ua) && !/\bAndroid\b/.test(ua)) os = 'Linux';
  else if (/\bAndroid\b/.test(ua))                          os = 'Android';
  else if (/\biPhone\b|\biPad\b/.test(ua))                  os = 'iOS';
  return `${browser} on ${os}`;
}
