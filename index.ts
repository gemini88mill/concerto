import { Command } from 'commander';
import { registerImplementCommand } from './command/implement';
import { registerPlanCommand } from './command/plan';
import { registerReviewCommand } from './command/review';
import { registerRunCommand } from './command/run';
import { registerTestCommand } from './command/test';

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
  const ts = new Date().toISOString();
  console.info('[' + ts + '] Starting command: ' + name);
});

registerRunCommand(program);
registerPlanCommand(program);
registerImplementCommand(program);
registerReviewCommand(program);
registerTestCommand(program);
// registerPrCommand(program);

program.parse();
