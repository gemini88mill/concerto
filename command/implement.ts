import { dirname, resolve } from "path";
import type { Command } from "commander";
import {
  buildHandoffFromPlan,
  runImplementor,
} from "../orchestrator/state-machine";
import { writeJson } from "../orchestrator/artifacts";
import { defaultAgentRunOptions, readPlanFile } from "./shared";

interface ImplementOptions {
  plan: string;
}

export const registerImplementCommand = (program: Command) => {
  program
    .command("implement")
    .description("Run S2 only.")
    .requiredOption("--plan <path>", "Path to plan JSON.")
    .action(async (options: ImplementOptions) => {
      const plan = await readPlanFile(options.plan);
      const planPath = resolve(options.plan);
      const runDir = dirname(planPath);
      const handoff = await buildHandoffFromPlan(plan);

      if (handoff.allowed_files.length === 0 || handoff.steps.length === 0) {
        console.log("Plan did not provide executable steps or allowed files.");
        return;
      }

      const result = await runImplementor(handoff, defaultAgentRunOptions);

      if (!result.ok || !result.value) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      await writeJson(`${runDir}/implementor.json`, result.value);
      console.log(JSON.stringify(result.value, null, 2));
    });
};
