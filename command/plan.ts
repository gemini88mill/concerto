import type { Command } from "commander";
import { createRunContext, writeJson } from "../orchestrator/artifacts";
import { createTask, runPlanner } from "../orchestrator/state-machine";
import { defaultAgentRunOptions } from "./shared";

export const registerPlanCommand = (program: Command) => {
  program
    .command("plan <task>")
    .description("Run S0 → S1 only, output PlanHandoff.")
    .action(async (task: string) => {
      const taskRecord = createTask(task);
      const context = await createRunContext(taskRecord);

      const planResult = await runPlanner(task, defaultAgentRunOptions);

      if (!planResult.ok || !planResult.value) {
        await writeJson(`${context.run_dir}/plan.error.json`, planResult);
        console.log(JSON.stringify(planResult, null, 2));
        return;
      }

      await writeJson(`${context.run_dir}/plan.json`, planResult.value);
      console.log(JSON.stringify(planResult.value, null, 2));
    });
};
