import { resolve } from "path";
import type { Command } from "commander";
import { buildHandoffFromPlan, runTester } from "../orchestrator/state-machine";
import { writeJson } from "../orchestrator/artifacts";
import { updateHandoff } from "../orchestrator/handoff";
import {
  defaultAgentRunOptions,
  readImplementorResultFile,
  readPlanFile,
  readRunHandoffFile,
  resolveRunDir,
} from "./shared";

interface TestOptions {
  run?: string;
}

export const registerTestCommand = (program: Command) => {
  program
    .command("test")
    .description("Run S4 only.")
    .option("--run <path>", "Path to orchestrator run directory.")
    .action(async (options: TestOptions) => {
      const runDir = await resolveRunDir(options.run);
      const handoffPath = resolve(runDir, "handoff.json");
      const runHandoff = await readRunHandoffFile(handoffPath);
      if (runHandoff.next?.agent !== "tester") {
        console.log("handoff.json does not point to tester as next agent.");
        return;
      }
      const planFile = runHandoff.artifacts.plan ?? "plan.json";
      const implementorFile =
        runHandoff.artifacts.implementation ?? "implementor.json";
      const planPath = resolve(runDir, planFile);
      const implementorPath = resolve(runDir, implementorFile);
      const plan = await readPlanFile(planPath);
      const implementorResult = await readImplementorResultFile(implementorPath);
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

      const testsPassed = testResult.value.status === "passed";
      const nextAgent = testsPassed
        ? {
            agent: "pr",
            inputArtifacts: [planFile, implementorFile, "review.json", "test.json"],
            instructions: [
              "Prepare a PR draft based on the approved implementation and tests.",
            ],
          }
        : {
            agent: "implementer",
            inputArtifacts: [planFile, implementorFile, "review.json", "test.json"],
            instructions: ["Fix implementation issues that caused test failures."],
          };

      const updated = updateHandoff({
        handoff: runHandoff,
        phase: "test",
        status: "completed",
        artifact: "test.json",
        endedAt: new Date().toISOString(),
        artifacts: {
          tests: "test.json",
        },
        next: nextAgent,
      });
      await writeJson(`${runDir}/test.json`, testResult.value);
      await writeJson(`${runDir}/handoff.json`, updated);
      console.log(JSON.stringify(testResult.value, null, 2));
    });
};
