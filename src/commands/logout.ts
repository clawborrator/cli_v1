// `claw logout` — drops the stored session token. Best-effort revokes
// it server-side so it can't be replayed if exfiltrated.

import { Command } from 'commander';
import { api } from '../client/api.js';
import { clearSession, loadConfig } from '../config.js';

export const logoutCmd = new Command('logout')
  .description('forget the locally-stored session token')
  .option('--keep-server', 'do not revoke the session server-side (default: revoke)')
  .action(async (opts: { keepServer?: boolean }) => {
    const cfg = loadConfig();
    if (!cfg.sessionToken) {
      console.log('not logged in; nothing to do');
      return;
    }
    if (!opts.keepServer) {
      try {
        await api.post('/api/v1/auth/logout');
      } catch (e: any) {
        // Best-effort revoke. If it fails (offline, hub gone, expired
        // already), drop the local token anyway — that's the user-
        // facing intent of `logout`.
        console.warn(`warning: server-side revoke failed: ${e?.message ?? e}`);
      }
    }
    clearSession();
    console.log('logged out (session cleared from local config)');
  });
