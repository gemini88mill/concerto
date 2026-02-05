import type { Command } from "commander";

interface PrOptions {
  fromRun: string;
}

export const registerPrCommand = (program: Command) => {
  program
    .command("pr")
    .description("Run S5 → S7 with human checkpoint.")
    .requiredOption("--from-run <path>", "Path to orchestrator run directory.")
    .action(async (options: PrOptions) => {
      console.log(`PR creation is not wired yet. Use artifacts in ${options.fromRun}.`);
    });
};
