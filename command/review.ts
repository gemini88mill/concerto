import { dirname, resolve } from "path";
import type { Command } from "commander";
import {
  buildHandoffFromPlan,
  runReviewer,
} from "../orchestrator/state-machine";
import { writeJson } from "../orchestrator/artifacts";
import { readImplementorResultFile, readPlanFile } from "./shared";

interface ReviewOptions {
  plan: string;
  impl: string;
}

export const registerReviewCommand = (program: Command) => {
  program
    .command("review")
    .description("Run S3 only.")
    .requiredOption("--plan <path>", "Path to plan JSON.")
    .requiredOption("--impl <path>", "Path to implementor result JSON.")
    .action(async (options: ReviewOptions) => {
      const planPath = resolve(options.plan);
      const runDir = dirname(planPath);
      const plan = await readPlanFile(options.plan);
      const implementorResult = await readImplementorResultFile(options.impl);
      const handoff = await buildHandoffFromPlan(plan);

      const reviewResult = await runReviewer(handoff, implementorResult);
      if (!reviewResult.ok || !reviewResult.value) {
        console.log(JSON.stringify(reviewResult, null, 2));
        return;
      }

      await writeJson(`${runDir}/review.json`, reviewResult.value);
      console.log(JSON.stringify(reviewResult.value, null, 2));
    });
};
