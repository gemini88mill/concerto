import { dirname, resolve } from "path";
import type { Command } from "commander";
import { buildHandoffFromPlan, runTester } from "../orchestrator/state-machine";
import { writeJson } from "../orchestrator/artifacts";
import {
  defaultAgentRunOptions,
  readImplementorResultFile,
  readPlanFile,
} from "./shared";

interface TestOptions {
  plan: string;
  impl: string;
}

export const registerTestCommand = (program: Command) => {
  program
    .command("test")
    .description("Run S4 only.")
    .requiredOption("--plan <path>", "Path to plan JSON.")
    .requiredOption("--impl <path>", "Path to implementor result JSON.")
    .action(async (options: TestOptions) => {
      const planPath = resolve(options.plan);
      const runDir = dirname(planPath);
      const plan = await readPlanFile(options.plan);
      const implementorResult = await readImplementorResultFile(options.impl);
      const handoff = await buildHandoffFromPlan(plan);

      const testResult = await runTester(
        handoff,
        implementorResult,
        defaultAgentRunOptions
      );

      if (!testResult.ok || !testResult.value) {
        console.log(JSON.stringify(testResult, null, 2));
        return;
      }

      await writeJson(`${runDir}/test.json`, testResult.value);
      console.log(JSON.stringify(testResult.value, null, 2));
    });
};
