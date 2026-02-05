import { Command } from "commander";
import { z } from "zod";
import type { ImplementorResult } from "./agents/implementor/implementor.types";
import type { Plan } from "./agents/planner/planner.types";
import type { ReviewerDecisionResult } from "./agents/reviewer/reviewer.types";
import type { TesterResult } from "./agents/tester/tester.types";
import { createRunContext, readJson, writeJson } from "./orchestrator/artifacts";
import {
  buildHandoffFromPlan,
  createTask,
  runFullPipeline,
  runImplementor,
  runPlanner,
  runReviewer,
  runTester,
} from "./orchestrator/state-machine";

const program = new Command();

program
  .name("orchestrator")
  .description("CLI for orchestrator runs and artifacts.")
  .configureHelp({
    sortSubcommands: true,
    subcommandTerm: (cmd) => cmd.name(),
  });

const planSchema = z.object({
  summary: z.string().min(1),
  scope: z.object({
    estimatedFilesChanged: z.number().int().nonnegative(),
    highRisk: z.boolean(),
    breakingChange: z.boolean(),
  }),
  tasks: z.array(
    z.object({
      id: z.string().min(1),
      description: z.string().min(1),
      affectedAreas: z.array(z.string().min(1)),
      estimatedFiles: z.number().int().positive(),
      requiresTests: z.boolean(),
      handoffTo: z.literal("implementer"),
    })
  ),
  assumptions: z.array(z.string()),
  outOfScope: z.array(z.string()),
});

const implementorResultSchema = z.object({
  status: z.enum(["completed", "blocked"]),
  stepId: z.string().min(1),
  diff: z.string(),
  filesChanged: z.array(z.string().min(1)),
  blockedReason: z.string(),
  escalation: z.string(),
});

const readPlanFile = async (path: string): Promise<Plan> => {
  const raw = await readJson(path);
  return planSchema.parse(raw);
};

const readImplementorResultFile = async (path: string): Promise<ImplementorResult> => {
  const raw = await readJson(path);
  return implementorResultSchema.parse(raw);
};

program
  .command("run <task>")
  .description("Run the full state machine with a human checkpoint at PR creation.")
  .action(async (task: string) => {
    const result = await runFullPipeline(task);
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("plan <task>")
  .description("Run S0 → S1 only, output PlanHandoff.")
  .action(async (task: string) => {
    const taskRecord = createTask(task);
    const context = await createRunContext(taskRecord);

    const planResult = await runPlanner(task, {
      maxPlanRetries: 2,
      maxImplementorRetries: 1,
      testCommand: "bunx vitest",
      testFramework: "vitest",
    });

    if (!planResult.ok || !planResult.value) {
      await writeJson(`${context.run_dir}/plan.error.json`, planResult);
      console.log(JSON.stringify(planResult, null, 2));
      return;
    }

    await writeJson(`${context.run_dir}/plan.json`, planResult.value);
    console.log(JSON.stringify(planResult.value, null, 2));
  });

program
  .command("implement")
  .description("Run S2 only.")
  .requiredOption("--plan <path>", "Path to plan JSON.")
  .action(async (options: { plan: string }) => {
    const plan = await readPlanFile(options.plan);
    const handoff = await buildHandoffFromPlan(plan);

    if (handoff.allowed_files.length === 0 || handoff.steps.length === 0) {
      console.log("Plan did not provide executable steps or allowed files.");
      return;
    }

    const result = await runImplementor(handoff, {
      maxPlanRetries: 2,
      maxImplementorRetries: 1,
      testCommand: "bunx vitest",
      testFramework: "vitest",
    });

    if (!result.ok || !result.value) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    await writeJson("implementor.json", result.value);
    console.log(JSON.stringify(result.value, null, 2));
  });

program
  .command("review")
  .description("Run S3 only.")
  .requiredOption("--plan <path>", "Path to plan JSON.")
  .requiredOption("--impl <path>", "Path to implementor result JSON.")
  .action(async (options: { plan: string; impl: string }) => {
    const plan = await readPlanFile(options.plan);
    const implementorResult = await readImplementorResultFile(options.impl);
    const handoff = await buildHandoffFromPlan(plan);

    const reviewResult = await runReviewer(handoff, implementorResult);
    if (!reviewResult.ok || !reviewResult.value) {
      console.log(JSON.stringify(reviewResult, null, 2));
      return;
    }

    await writeJson("review.json", reviewResult.value);
    console.log(JSON.stringify(reviewResult.value, null, 2));
  });

program
  .command("test")
  .description("Run S4 only.")
  .requiredOption("--plan <path>", "Path to plan JSON.")
  .requiredOption("--impl <path>", "Path to implementor result JSON.")
  .action(async (options: { plan: string; impl: string }) => {
    const plan = await readPlanFile(options.plan);
    const implementorResult = await readImplementorResultFile(options.impl);
    const handoff = await buildHandoffFromPlan(plan);

    const testResult = await runTester(handoff, implementorResult, {
      maxPlanRetries: 2,
      maxImplementorRetries: 1,
      testCommand: "bunx vitest",
      testFramework: "vitest",
    });

    if (!testResult.ok || !testResult.value) {
      console.log(JSON.stringify(testResult, null, 2));
      return;
    }

    await writeJson("test.json", testResult.value);
    console.log(JSON.stringify(testResult.value, null, 2));
  });

program
  .command("pr")
  .description("Run S5 → S7 with human checkpoint.")
  .requiredOption("--from-run <path>", "Path to orchestrator run directory.")
  .action(async (options: { fromRun: string }) => {
    console.log(`PR creation is not wired yet. Use artifacts in ${options.fromRun}.`);
  });

program.parse();
