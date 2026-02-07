import { Command } from 'commander';
import { registerImplementCommand } from './command/implement';
import { registerPlanCommand } from './command/plan';
import { registerReviewCommand } from './command/review';
import { registerRunCommand } from './command/run';
import { registerStatusCommand } from './command/status';
import { registerTestCommand } from './command/test';
import { registerWorkerCommand } from './command/worker';
import { registerCancelCommand } from './command/cancel';
import { logger } from './core/logger';

const program = new Command();

program
  .name('orchestrator')
  .description('CLI for orchestrator runs and artifacts.')
  .configureHelp({
    sortSubcommands: true,
    subcommandTerm: (cmd) => cmd.name(),
  });

program.hook('preAction', (thisCommand) => {
  const name = thisCommand.name() || 'unknown';
  logger.info(`Starting command: ${name}`);
});

registerRunCommand(program);
registerPlanCommand(program);
registerImplementCommand(program);
registerReviewCommand(program);
registerTestCommand(program);
registerStatusCommand(program);
registerWorkerCommand(program);
registerCancelCommand(program);
// registerPrCommand(program);

program.parse();
