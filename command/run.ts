import type { Command } from "commander";
import { runFullPipeline } from "../orchestrator/state-machine";
import { stepStartOutput } from "./shared";

export const registerRunCommand = (program: Command) => {
  program
    .command("run <task>")
    .description(
      "Run the full state machine with a human checkpoint at PR creation."
    )
    .action(async (task: string) => {
      console.log(JSON.stringify(stepStartOutput("run"), null, 2));
      const result = await runFullPipeline(task);
      console.log(JSON.stringify(result, null, 2));
    });
};
