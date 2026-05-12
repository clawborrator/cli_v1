// `claw` CLI entrypoint. One command per file under src/commands/;
// this file just wires them into commander.

import { Command } from 'commander';
import { loginCmd } from './commands/login.js';
import { logoutCmd } from './commands/logout.js';
import { whoamiCmd } from './commands/whoami.js';
import { sessionCmd } from './commands/session.js';
import { tokenCmd } from './commands/token.js';
import { peersCmd, routeCmd, probeCmd } from './commands/peers.js';
import { webhookCmd } from './commands/webhook.js';
import { agentsCmd } from './commands/agents.js';
import { appsCmd } from './commands/apps.js';
import { desktopCmd } from './commands/desktop.js';
import { authSessionsCmd } from './commands/auth-sessions.js';

// Version comes from package.json via esbuild's --define at bundle
// time — see `bundle` script in package.json. tsc reads the declared
// fallback ('dev') and the CJS bundle gets the real version
// substituted in. Single source of truth: package.json. Bumping it
// (or running `npm version patch`) flows through to `claw --version`
// without a code edit.
declare const __CLAW_VERSION__: string;
const CLAW_VERSION: string = (typeof __CLAW_VERSION__ === 'string') ? __CLAW_VERSION__ : 'dev';

const program = new Command();
program
  .name('claw')
  .description('clawborrator CLI — control your Claude Code sessions from the terminal')
  .version(CLAW_VERSION);

program.addCommand(loginCmd);
program.addCommand(logoutCmd);
program.addCommand(whoamiCmd);
program.addCommand(sessionCmd);
program.addCommand(tokenCmd);
program.addCommand(peersCmd);
program.addCommand(routeCmd);
program.addCommand(probeCmd);
program.addCommand(webhookCmd);
program.addCommand(agentsCmd);
program.addCommand(appsCmd);
program.addCommand(desktopCmd);
program.addCommand(authSessionsCmd);

program.parseAsync(process.argv).catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
