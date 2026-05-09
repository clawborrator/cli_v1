// `claw whoami` — verify auth + show identity. Hits /api/v1/me.

import { Command } from 'commander';
import { api, ApiError } from '../client/api.js';
import { loadConfig } from '../config.js';
import type { ApiUser } from '../shared/index.js';

export const whoamiCmd = new Command('whoami')
  .description('show the currently authenticated user')
  .action(async () => {
    const cfg = loadConfig();
    if (!cfg.sessionToken) {
      console.log('not logged in — run: claw login');
      return;
    }
    try {
      const me = await api.get<ApiUser>('/api/v1/me');
      console.log(`@${me.githubLogin}${me.isAdmin ? ' (admin)' : ''}`);
      console.log(`hub:  ${cfg.hubUrl}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        console.error('error: session rejected by hub. Run: claw login');
        process.exit(2);
      }
      throw e;
    }
  });
