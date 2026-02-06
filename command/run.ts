import type { Command } from "commander";
import { runFullPipeline } from "../orchestrator/state-machine";

export const registerRunCommand = (program: Command) => {
  program
    .command("run <task>")
    .description(
      "Run the full state machine with a human checkpoint at PR creation."
    )
    .action(async (task: string) => {
      // Emit a human-readable progress message instead of JSON for step reporting
      console.log(`Step: run - starting task '${task}'`);
      const result = await runFullPipeline(task);
      console.log(JSON.stringify(result, null, 2));
    });
};
