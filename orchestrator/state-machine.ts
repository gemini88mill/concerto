import { createPlannerAgent } from "../agents/planner/planner.agent";
import type { Plan } from "../agents/planner/planner.types";
import type {
  ImplementorHandoff,
  ImplementorResult,
  ImplementorStep,
} from "../agents/implementor/implementor.types";
import type { ReviewerInput, ReviewerDecisionResult } from "../agents/reviewer/reviewer.types";
import type { TesterInput, TesterResult } from "../agents/tester/tester.types";
import { runImplementorStep } from "../agents/implementor/implementor.runner";
import { createReviewerAgent } from "../agents/reviewer/reviewer.agent";
import { createTesterAgent } from "../agents/tester/tester.agent";
import { createRunContext, writeJson } from "./artifacts";
import type { OrchestratorConfig, OrchestratorResult, OrchestratorTask } from "./orchestrator.types";

const DEFAULT_CONFIG: OrchestratorConfig = {
  maxPlanRetries: 2,
  maxImplementorRetries: 1,
  testCommand: "bunx vitest",
  testFramework: "vitest",
};

const createTask = (description: string): OrchestratorTask => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return {
    task_id: `TASK-${timestamp}`,
    description,
    created_at: new Date().toISOString(),
  };
};

const isFileLike = (value: string) => {
  if (value.includes("/") || value.includes("\\")) {
    return true;
  }
  return /\.[a-z0-9]+$/i.test(value);
};

const collectAllowedFiles = (plan: Plan) => {
  const files: string[] = [];
  plan.tasks.forEach((task) => {
    task.affectedAreas.forEach((area) => {
      if (isFileLike(area) && !files.includes(area)) {
        files.push(area);
      }
    });
  });
  return files;
};

const buildStepsFromPlan = (plan: Plan, allowedFiles: string[]) => {
  const steps: ImplementorStep[] = [];
  const fileSet = new Set(allowedFiles);

  plan.tasks.forEach((task) => {
    const file = task.affectedAreas.find((area) => fileSet.has(area));
    if (!file) {
      return;
    }
    steps.push({
      id: task.id,
      file,
      action: "modify",
      description: task.description,
    });
  });

  return steps;
};

const buildInjectedFiles = async (allowedFiles: string[]) => {
  const injectedFiles: { path: string; content: string }[] = [];

  for (const file of allowedFiles) {
    const fileHandle = Bun.file(file);
    const exists = await fileHandle.exists();
    if (!exists) {
      continue;
    }
    injectedFiles.push({
      path: file,
      content: await fileHandle.text(),
    });
  }

  return injectedFiles;
};

const buildHandoffFromPlan = async (plan: Plan): Promise<ImplementorHandoff> => {
  const allowedFiles = collectAllowedFiles(plan);
  const steps = buildStepsFromPlan(plan, allowedFiles);
  const injectedFiles = await buildInjectedFiles(allowedFiles);
  const maxFiles = Math.max(1, Math.min(allowedFiles.length, 3));

  return {
    handoff_version: "1.0.0",
    task: {
      id: plan.tasks[0]?.id ?? "TASK-UNKNOWN",
      summary: plan.summary,
      change_type: "chore",
    },
    allowed_files: allowedFiles,
    constraints: {
      max_files: maxFiles,
      max_diff_lines: 200,
      max_diff_bytes: 12000,
      no_new_dependencies: true,
      no_tests: true,
      no_architecture_changes: true,
    },
    steps,
    injected_files: injectedFiles,
  };
};

const runPlanner = async (
  description: string,
  config: OrchestratorConfig
): Promise<OrchestratorResult<Plan>> => {
  const planner = createPlannerAgent();
  let attempts = 0;

  while (attempts <= config.maxPlanRetries) {
    attempts += 1;
    try {
      const plan = await planner.plan({
        task: description,
        repoSummary:
          "Bun-based CLI orchestrator using commander. Entry point index.ts. Agents live under agents/.",
        constraints: {
          maxFilesPerTask: 3,
          testPolicy: "No automated tests required for CLI wiring.",
          codingStandardsRef: "AGENTS.md",
        },
      });
      return { ok: true, value: plan };
    } catch (error) {
      if (attempts > config.maxPlanRetries) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "Planner failed.",
        };
      }
    }
  }

  return { ok: false, error: "Planner retries exhausted." };
};

const runImplementor = async (
  handoff: ImplementorHandoff,
  config: OrchestratorConfig
): Promise<OrchestratorResult<ImplementorResult>> => {
  const step = handoff.steps[0];
  if (!step) {
    return { ok: false, error: "No steps available in handoff." };
  }

  let attempts = 0;
  while (attempts <= config.maxImplementorRetries) {
    attempts += 1;
    const { result } = await runImplementorStep(step, { handoff });
    if (result.status === "completed") {
      return { ok: true, value: result };
    }
    if (attempts > config.maxImplementorRetries) {
      return { ok: false, error: result.blockedReason || "Implementor blocked." };
    }
  }

  return { ok: false, error: "Implementor retries exhausted." };
};

const runReviewer = async (
  handoff: ImplementorHandoff,
  implementorResult: ImplementorResult
): Promise<OrchestratorResult<ReviewerDecisionResult>> => {
  const projectRules = await Bun.file("AGENTS.md").text();
  const reviewerInput: ReviewerInput = {
    handoff,
    implementor_result: implementorResult,
    project_rules: projectRules,
    reviewer_constraints: {
      enforceAllowedFiles: true,
      enforceNoTests: true,
      enforceNoNewDependencies: true,
      enforceNoArchitectureChanges: true,
    },
  };

  const reviewer = createReviewerAgent();
  const decision = await reviewer.review(reviewerInput);
  return { ok: true, value: decision };
};

const runTester = async (
  handoff: ImplementorHandoff,
  implementorResult: ImplementorResult,
  config: OrchestratorConfig
): Promise<OrchestratorResult<TesterResult>> => {
  const projectRules = await Bun.file("AGENTS.md").text();
  const testerInput: TesterInput = {
    handoff,
    implementor_result: implementorResult,
    project_test_rules: projectRules,
    test_framework: config.testFramework,
    test_command: config.testCommand,
  };

  const tester = createTesterAgent();
  const result = await tester.test(testerInput);
  return { ok: true, value: result };
};

const runFullPipeline = async (description: string, config?: Partial<OrchestratorConfig>) => {
  const resolvedConfig = { ...DEFAULT_CONFIG, ...config };
  const task = createTask(description);
  const context = await createRunContext(task);

  const planResult = await runPlanner(description, resolvedConfig);
  if (!planResult.ok || !planResult.value) {
    await writeJson(`${context.run_dir}/plan.error.json`, planResult);
    return planResult;
  }
  await writeJson(`${context.run_dir}/plan.json`, planResult.value);

  const handoff = await buildHandoffFromPlan(planResult.value);
  await writeJson(`${context.run_dir}/handoff.json`, handoff);

  if (handoff.allowed_files.length === 0 || handoff.steps.length === 0) {
    const error = "Planner did not provide executable steps or allowed files.";
    await writeJson(`${context.run_dir}/implementor.error.json`, { error });
    return { ok: false, error };
  }

  const implementResult = await runImplementor(handoff, resolvedConfig);
  if (!implementResult.ok || !implementResult.value) {
    await writeJson(`${context.run_dir}/implementor.error.json`, implementResult);
    return implementResult;
  }
  await writeJson(`${context.run_dir}/implementor.json`, implementResult.value);

  const reviewResult = await runReviewer(handoff, implementResult.value);
  if (!reviewResult.ok || !reviewResult.value) {
    await writeJson(`${context.run_dir}/review.error.json`, reviewResult);
    return reviewResult;
  }
  await writeJson(`${context.run_dir}/review.json`, reviewResult.value);

  if (reviewResult.value.decision !== "approved") {
    return { ok: false, error: `Reviewer decision: ${reviewResult.value.decision}` };
  }

  const testResult = await runTester(handoff, implementResult.value, resolvedConfig);
  if (!testResult.ok || !testResult.value) {
    await writeJson(`${context.run_dir}/test.error.json`, testResult);
    return testResult;
  }
  await writeJson(`${context.run_dir}/test.json`, testResult.value);

  if (testResult.value.status !== "passed") {
    return { ok: false, error: `Tester status: ${testResult.value.status}` };
  }

  await writeJson(`${context.run_dir}/pr-draft.json`, {
    task_id: task.task_id,
    status: "pending_human_approval",
  });

  return { ok: true, value: testResult.value };
};

export {
  buildHandoffFromPlan,
  collectAllowedFiles,
  createTask,
  runFullPipeline,
  runImplementor,
  runPlanner,
  runReviewer,
  runTester,
};
