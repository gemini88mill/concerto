import type { Command } from "commander";
import { createRunContext, writeJson } from "../orchestrator/artifacts";
import { createInitialHandoff, updateHandoff } from "../orchestrator/handoff";
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

      const requiresTests = planResult.value.tasks.some(
        (planTask) => planTask.requiresTests
      );

      const baseHandoff = createInitialHandoff({
        run: {
          id: context.run_id,
          createdAt: context.task.created_at,
          repo: {
            root: ".",
            branch: "",
            baseBranch: "",
          },
        },
        task: {
          id: context.task.task_id,
          prompt: context.task.description,
          mode: "plan",
        },
        artifacts: {
          task: "task.json",
          plan: "plan.json",
          implementation: "implementor.json",
          review: "review.json",
          tests: "test.json",
          prDraft: "pr-draft.json",
          handoff: "handoff.json",
          handoffImplementor: "handoff.implementor.json",
          handoffReview: "handoff.review.json",
          handoffTest: "handoff.test.json",
        },
        constraints: {
          estimatedFilesChangedLimit: planResult.value.scope.estimatedFilesChanged,
          noBreakingChanges: !planResult.value.scope.breakingChange,
          requireTestsForBehaviorChange: requiresTests,
        },
        next: {
          agent: "implementer",
          inputArtifacts: ["plan.json"],
          instructions: [
            "Implement the plan within allowed files.",
            "Update handoff.json for reviewer.",
          ],
        },
      });

      const handoff = updateHandoff({
        handoff: baseHandoff,
        phase: "plan",
        status: "completed",
        artifact: "plan.json",
        endedAt: new Date().toISOString(),
        next: baseHandoff.next,
      });

      await writeJson(`${context.run_dir}/handoff.json`, handoff);
      await writeJson(`${context.run_dir}/handoff.implementor.json`, handoff);
      console.log(JSON.stringify(planResult.value, null, 2));
    });
};
