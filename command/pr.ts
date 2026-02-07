import type { Command } from "commander";
import { logger } from "../core/logger";

interface PrOptions {
  fromRun: string;
}

export const registerPrCommand = (program: Command) => {
  program
    .command("pr")
    .description("Prepare PR artifacts for a completed run (manual publishing).")
    .requiredOption("--from-run <path>", "Path to orchestrator run directory.")
    .action(async (options: PrOptions) => {
      logger.info(
        `PR creation is not wired yet. Use artifacts in ${options.fromRun}.`
      );
    });
};
