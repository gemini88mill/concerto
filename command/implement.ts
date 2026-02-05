import { resolve } from "path";
import type { Command } from "commander";
import {
  buildHandoffFromPlan,
  runImplementor,
} from "../orchestrator/state-machine";
import { writeJson } from "../orchestrator/artifacts";
import { updateHandoff } from "../orchestrator/handoff";
import { defaultAgentRunOptions, readPlanFile, readRunHandoffFile, resolveRunDir } from "./shared";

interface ImplementOptions {
  run?: string;
}

export const registerImplementCommand = (program: Command) => {
  program
    .command("implement")
    .description("Run S2 only.")
    .option("--run <path>", "Path to orchestrator run directory.")
    .action(async (options: ImplementOptions) => {
      const runDir = await resolveRunDir(options.run);
      const handoffPath = resolve(runDir, "handoff.json");
      const runHandoff = await readRunHandoffFile(handoffPath);
      if (runHandoff.next?.agent !== "implementer") {
        console.log("handoff.json does not point to implementer as next agent.");
        return;
      }
      const planFile = runHandoff.artifacts.plan ?? "plan.json";
      const planPath = resolve(runDir, planFile);
      const plan = await readPlanFile(planPath);
      const implementorHandoff = await buildHandoffFromPlan(plan);

      if (
        implementorHandoff.allowed_files.length === 0 ||
        implementorHandoff.steps.length === 0
      ) {
        console.log("Plan did not provide executable steps or allowed files.");
        return;
      }

      const result = await runImplementor(
        implementorHandoff,
        defaultAgentRunOptions
      );

      if (!result.ok || !result.value) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      await writeJson(`${runDir}/implementor.json`, result.value);
      const updated = updateHandoff({
        handoff: runHandoff,
        phase: "implement",
        status: "completed",
        artifact: "implementor.json",
        endedAt: new Date().toISOString(),
        artifacts: {
          implementation: "implementor.json",
        },
        next: {
          agent: "reviewer",
          inputArtifacts: [planFile, "implementor.json"],
          instructions: [
            "Review the implementation against the plan and project guidelines.",
            "If rejecting, provide actionable fixes only; do not implement.",
          ],
        },
      });
      await writeJson(`${runDir}/handoff.json`, updated);
      await writeJson(`${runDir}/handoff.review.json`, updated);
      console.log(JSON.stringify(result.value, null, 2));
    });
};
