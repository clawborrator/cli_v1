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

const program = new Command();
program
  .name('claw')
  .description('clawborrator CLI — control your Claude Code sessions from the terminal')
  .version('0.2.6');

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

program.parseAsync(process.argv).catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
