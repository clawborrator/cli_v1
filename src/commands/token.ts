// `claw token mint|list|revoke|scopes` — channel-token management.
// PATs are gone; CLI auth is now session-based via `claw login`.
// This subcommand only handles channel tokens (the secret that
// clawborrator-mcp ships into .mcp.json so a CC instance can register
// against the hub).

import { Command } from 'commander';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { api } from '../client/api.js';
import type { ApiToken, ApiTokenWithPlaintext } from '../shared/index.js';
import { loadConfig } from '../config.js';

const tokenMint = new Command('mint')
  .description('create a new channel token')
  .requiredOption('--name <name>',     'human-readable label (e.g. "alice-laptop")')
  .option('--mcp-snippet',             'after minting, also produce a ready-to-use .mcp.json block. By default writes to stdout (prose to stderr); pair with --out=<path> to write the file directly (recommended on Windows — `>` redirection in PowerShell encodes as UTF-16 w/ BOM, which CC rejects).')
  .option('--out <path>',              'when used with --mcp-snippet, write the JSON to <path> (UTF-8, no BOM) instead of stdout. Pass `.mcp.json` for the canonical project location.')
  .action(async (opts: { name: string; mcpSnippet?: boolean; out?: string }) => {
    const out = await api.post<ApiTokenWithPlaintext>('/api/v1/tokens/channel', { name: opts.name });
    const proseToStderr = opts.mcpSnippet && !opts.out;
    const prose = proseToStderr ? console.error : console.log;
    prose(`✓ channel token minted: ${out.name}`);
    prose(`  ${out.token}`);
    prose('  (shown ONCE — store it now)');
    if (opts.mcpSnippet) {
      const cfg = loadConfig();
      const wsUrl = cfg.hubUrl.replace(/^http(s?):\/\//, 'ws$1://');
      const json = JSON.stringify({
        mcpServers: {
          clawborrator: {
            command: 'npx',
            args:    ['-y', 'clawborrator-mcp'],
            env: {
              CLAWBORRATOR_HUB_URL: wsUrl,
              CLAWBORRATOR_TOKEN:   out.token,
            },
          },
        },
      }, null, 2) + '\n';
      if (opts.out) {
        const target = resolve(opts.out);
        writeFileSync(target, json, 'utf8');     // UTF-8, no BOM, regardless of host shell
        prose('');
        prose(`✓ wrote ${target}`);
      } else {
        process.stdout.write(json);
      }
      prose('');
      prose('  next: launch CC with the clawborrator channel enabled —');
      prose('    claude --dangerously-load-development-channels server:clawborrator');
    }
  });

const tokenList = new Command('list')
  .alias('ls')
  .description('list channel tokens for the current user')
  .action(async () => {
    const data = await api.get<{ items: ApiToken[] }>('/api/v1/tokens');
    if (data.items.length === 0) { console.log('no active channel tokens'); return; }
    for (const t of data.items) {
      const used = t.lastUsedAt ? `last used ${fmtAgo(t.lastUsedAt)}` : 'never used';
      console.log(`${t.id.toString().padStart(3)}  ${t.prefix}…  ${t.name.padEnd(28)} ${used}`);
    }
  });

const tokenRevoke = new Command('revoke')
  .description('revoke a channel token by id')
  .argument('<id>', 'token id (from `claw token list`)')
  .action(async (id: string) => {
    await api.delete(`/api/v1/tokens/${encodeURIComponent(id)}`);
    console.log(`✓ token ${id} revoked`);
  });

export const tokenCmd = new Command('token')
  .description('mint, list, and revoke channel tokens')
  .addCommand(tokenMint)
  .addCommand(tokenList)
  .addCommand(tokenRevoke);

function fmtAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000)        return Math.max(1, Math.floor(ms / 1000)) + 's ago';
  if (ms < 3600_000)      return Math.floor(ms / 60_000) + 'm ago';
  if (ms < 86400_000)     return Math.floor(ms / 3600_000) + 'h ago';
  return Math.floor(ms / 86400_000) + 'd ago';
}
