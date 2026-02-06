import type { Command } from "commander";
import { runFullPipeline } from "../orchestrator/state-machine";

interface RunOptions {
  repo: string;
  keepWorkspace?: boolean;
}

export const registerRunCommand = (program: Command) => {
  program
    .command("run <task>")
    .description(
      "Run the full state machine with a human checkpoint at PR creation."
    )
    .requiredOption("-r, --repo <url>", "Git repository URL to clone.")
    .option("--keep-workspace", "Keep cloned repository after run.")
    .action(async (task: string, options: RunOptions) => {
      // Emit a human-readable progress message instead of JSON for step reporting
      console.log(`Step: run - starting task '${task}'`);
      const result = await runFullPipeline({
        task,
        repoUrl: options.repo,
        keepWorkspace: options.keepWorkspace,
      });
      console.log(JSON.stringify(result, null, 2));
    });
};
