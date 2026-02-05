import { createPlannerAgent } from "../agents/planner/planner.agent";
import type { Plan } from "../agents/planner/planner.types";
import type {
  ImplementorHandoff,
  ImplementorResult,
  ImplementorStep,
} from "../agents/implementor/implementor.types";
import type {
  ReviewerInput,
  ReviewerDecisionResult,
} from "../agents/reviewer/reviewer.types";
import type { TesterInput, TesterResult } from "../agents/tester/tester.types";
import { runImplementorStep } from "../agents/implementor/implementor.runner";
import { createReviewerAgent } from "../agents/reviewer/reviewer.agent";
import { createTesterAgent } from "../agents/tester/tester.agent";
import { createRunContext, writeJson } from "./artifacts";
import { createInitialHandoff, updateHandoff } from "./handoff";
import type {
  OrchestratorConfig,
  OrchestratorResult,
  OrchestratorTask,
} from "./orchestrator.types";

const DEFAULT_CONFIG: OrchestratorConfig = {
  maxPlanRetries: 2,
  maxImplementorRetries: 1,
  testCommand: "bunx vitest",
  testFramework: "vitest",
};

const createTask = (description: string): OrchestratorTask => {
  return {
    task_id: Bun.randomUUIDv7(),
    description,
    created_at: new Date().toISOString(),
  };
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

interface DiffApplyResult {
  content: string;
  deleted: boolean;
}

interface DiffFileSection {
  filePath: string;
  lines: string[];
}

const splitDiffByFile = (diff: string): DiffFileSection[] => {
  const sections: DiffFileSection[] = [];
  let current: DiffFileSection | null = null;

  const lines = diff.split("\n");
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (current) {
        sections.push(current);
      }
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      const filePath = match?.[2] ?? "";
      current = { filePath, lines: [line] };
      continue;
    }
    if (current) {
      current.lines.push(line);
    }
  }

  if (current) {
    sections.push(current);
  }

  return sections;
};

const parseHunkHeader = (line: string) => {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!match) {
    return null;
  }
  return {
    oldStart: Number(match[1]),
    oldCount: match[2] ? Number(match[2]) : 1,
    newStart: Number(match[3]),
    newCount: match[4] ? Number(match[4]) : 1,
  };
};

const applyUnifiedDiff = (
  content: string,
  diffLines: string[]
): string | null => {
  const sourceLines = content.split("\n");
  const output: string[] = [];
  let sourceIndex = 0;

  let i = 0;
  while (i < diffLines.length) {
    const line = diffLines[i];
    if (!line?.startsWith("@@")) {
      i += 1;
      continue;
    }

    const header = parseHunkHeader(line ?? "");
    if (!header) {
      return null;
    }

    const targetIndex = Math.max(0, header.oldStart - 1);
    while (sourceIndex < targetIndex && sourceIndex < sourceLines.length) {
      output.push(sourceLines[sourceIndex] ?? "");
      sourceIndex += 1;
    }

    i += 1;
    while (i < diffLines.length && !diffLines[i]?.startsWith("@@")) {
      const hunkLine = diffLines[i];
      if (hunkLine?.startsWith(" ")) {
        output.push(hunkLine?.slice(1) ?? "");
        sourceIndex += 1;
      } else if (hunkLine?.startsWith("-")) {
        sourceIndex += 1;
      } else if (hunkLine?.startsWith("+")) {
        output.push(hunkLine?.slice(1) ?? "");
      } else if (
        hunkLine?.startsWith("\\") &&
        hunkLine?.includes("No newline")
      ) {
        // ignore
      } else if (hunkLine?.startsWith("diff --git ")) {
        break;
      }
      i += 1;
    }
  }

  while (sourceIndex < sourceLines.length) {
    output.push(sourceLines[sourceIndex] ?? "");
    sourceIndex += 1;
  }

  return output.join("\n");
};

const applyDiffToContent = (
  diff: string,
  filePath: string,
  content: string
): DiffApplyResult | null => {
  const sections = splitDiffByFile(diff);
  const section = sections.find((item) => item.filePath === filePath);
  if (!section) {
    return { content, deleted: false };
  }

  const deleted = section.lines.some((line) =>
    line.startsWith("deleted file mode")
  );
  if (deleted) {
    return { content: "", deleted: true };
  }

  const updated = applyUnifiedDiff(content, section.lines);
  if (updated === null) {
    return null;
  }

  return { content: updated, deleted: false };
};

const buildHandoffFromPlan = async (
  plan: Plan
): Promise<ImplementorHandoff> => {
  const allowedFiles = plan.allowed_files;
  const steps: ImplementorStep[] = plan.steps;
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
  if (handoff.steps.length === 0) {
    return { ok: false, error: "No steps available in handoff." };
  }

  const injectedMap = new Map(
    handoff.injected_files.map((file) => [file.path, file.content])
  );
  const results: ImplementorResult[] = [];

  for (const step of handoff.steps) {
    if (step.action === "modify" && !injectedMap.has(step.file)) {
      const file = Bun.file(step.file);
      if (await file.exists()) {
        injectedMap.set(step.file, await file.text());
      }
    }

    const stepHandoff: ImplementorHandoff = {
      ...handoff,
      steps: [step],
      injected_files: Array.from(injectedMap.entries()).map(
        ([path, content]) => ({ path, content })
      ),
    };

    let attempts = 0;
    let stepResult: ImplementorResult | null = null;

    while (attempts <= config.maxImplementorRetries) {
      attempts += 1;
      const { result } = await runImplementorStep(step, {
        handoff: stepHandoff,
      });
      if (result.status === "completed") {
        stepResult = result;
        break;
      }
      if (attempts > config.maxImplementorRetries) {
        return {
          ok: false,
          error: result.blockedReason || "Implementor blocked.",
        };
      }
    }

    if (!stepResult) {
      return { ok: false, error: "Implementor retries exhausted." };
    }

    results.push(stepResult);
    const previousContent = injectedMap.get(step.file) ?? "";
    const applied = applyDiffToContent(
      stepResult.diff,
      step.file,
      previousContent
    );
    if (!applied) {
      return { ok: false, error: "Failed to apply diff for step." };
    }
    if (applied.deleted) {
      injectedMap.delete(step.file);
    } else {
      injectedMap.set(step.file, applied.content);
    }
  }

  const mergedDiff = results.map((result) => result.diff).join("\n");
  const filesChanged = Array.from(
    new Set(results.flatMap((result) => result.filesChanged))
  );

  return {
    ok: true,
    value: {
      status: "completed",
      stepId: results[results.length - 1]?.stepId ?? "unknown",
      diff: mergedDiff,
      filesChanged,
      blockedReason: "",
      escalation: "",
    },
  };
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

const runFullPipeline = async (
  description: string,
  config?: Partial<OrchestratorConfig>
) => {
  const resolvedConfig = { ...DEFAULT_CONFIG, ...config };
  const task = createTask(description);
  const context = await createRunContext(task);

  const planResult = await runPlanner(description, resolvedConfig);
  if (!planResult.ok || !planResult.value) {
    await writeJson(`${context.run_dir}/plan.error.json`, planResult);
    return planResult;
  }
  await writeJson(`${context.run_dir}/plan.json`, planResult.value);

  const requiresTests = planResult.value.tasks.some(
    (task) => task.requiresTests
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
      mode: "full",
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

  let runHandoff = updateHandoff({
    handoff: baseHandoff,
    phase: "plan",
    status: "completed",
    artifact: "plan.json",
    endedAt: new Date().toISOString(),
    next: baseHandoff.next,
  });

  await writeJson(`${context.run_dir}/handoff.json`, runHandoff);
  await writeJson(`${context.run_dir}/handoff.implementor.json`, runHandoff);

  const implementorHandoff = await buildHandoffFromPlan(planResult.value);

  if (
    implementorHandoff.allowed_files.length === 0 ||
    implementorHandoff.steps.length === 0
  ) {
    const error = "Planner did not provide executable steps or allowed files.";
    await writeJson(`${context.run_dir}/implementor.error.json`, { error });
    return { ok: false, error };
  }

  const implementResult = await runImplementor(
    implementorHandoff,
    resolvedConfig
  );
  if (!implementResult.ok || !implementResult.value) {
    await writeJson(
      `${context.run_dir}/implementor.error.json`,
      implementResult
    );
    return implementResult;
  }
  await writeJson(`${context.run_dir}/implementor.json`, implementResult.value);

  runHandoff = updateHandoff({
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
      inputArtifacts: ["plan.json", "implementor.json"],
      instructions: [
        "Review the implementation against the plan and project guidelines.",
        "If rejecting, provide actionable fixes only; do not implement.",
      ],
    },
  });
  await writeJson(`${context.run_dir}/handoff.json`, runHandoff);
  await writeJson(`${context.run_dir}/handoff.review.json`, runHandoff);

  const reviewResult = await runReviewer(
    implementorHandoff,
    implementResult.value
  );
  if (!reviewResult.ok || !reviewResult.value) {
    await writeJson(`${context.run_dir}/review.error.json`, reviewResult);
    return reviewResult;
  }
  await writeJson(`${context.run_dir}/review.json`, reviewResult.value);

  const reviewApproved = reviewResult.value.decision === "approved";
  const reviewNext = reviewApproved
    ? {
        agent: "tester",
        inputArtifacts: ["plan.json", "implementor.json", "review.json"],
        instructions: [
          "Add or update tests if required by the plan.",
          "Run the configured test command and report results.",
        ],
      }
    : {
        agent: "implementer",
        inputArtifacts: ["plan.json", "implementor.json", "review.json"],
        instructions: [
          "Address review feedback and update the implementation.",
        ],
      };

  runHandoff = updateHandoff({
    handoff: runHandoff,
    phase: "review",
    status: "completed",
    artifact: "review.json",
    endedAt: new Date().toISOString(),
    artifacts: {
      review: "review.json",
    },
    next: reviewNext,
  });
  await writeJson(`${context.run_dir}/handoff.json`, runHandoff);
  await writeJson(`${context.run_dir}/handoff.test.json`, runHandoff);

  if (reviewResult.value.decision !== "approved") {
    return {
      ok: false,
      error: `Reviewer decision: ${reviewResult.value.decision}`,
    };
  }

  if (!requiresTests) {
    const skippedResult = {
      task_id: implementorHandoff.task.id,
      status: "passed",
      tests_added: [],
      test_summary: "Tests not required for this run.",
      coverage_notes: [],
      reason: "Tests skipped by policy.",
      logs: "",
    };
    await writeJson(`${context.run_dir}/test.json`, skippedResult);
  }

  const testResult = requiresTests
    ? await runTester(implementorHandoff, implementResult.value, resolvedConfig)
    : { ok: true, value: null };

  if (requiresTests && (!testResult.ok || !testResult.value)) {
    await writeJson(`${context.run_dir}/test.error.json`, testResult);
    return testResult;
  }

  if (requiresTests && testResult.value) {
    await writeJson(`${context.run_dir}/test.json`, testResult.value);
  }

  const testsPassed = requiresTests
    ? testResult.value?.status === "passed"
    : true;
  const testNext = testsPassed
    ? {
        agent: "pr",
        inputArtifacts: [
          "plan.json",
          "implementor.json",
          "review.json",
          "test.json",
        ],
        instructions: [
          "Prepare a PR draft based on the approved implementation and tests.",
        ],
      }
    : {
        agent: "implementer",
        inputArtifacts: [
          "plan.json",
          "implementor.json",
          "review.json",
          "test.json",
        ],
        instructions: ["Fix implementation issues that caused test failures."],
      };

  runHandoff = updateHandoff({
    handoff: runHandoff,
    phase: "test",
    status: "completed",
    artifact: "test.json",
    endedAt: new Date().toISOString(),
    artifacts: {
      tests: "test.json",
    },
    next: testNext,
  });
  await writeJson(`${context.run_dir}/handoff.json`, runHandoff);

  if (requiresTests && testResult.value?.status !== "passed") {
    return { ok: false, error: `Tester status: ${testResult.value?.status}` };
  }

  await writeJson(`${context.run_dir}/pr-draft.json`, {
    task_id: task.task_id,
    status: "pending_human_approval",
  });

  return { ok: true, value: testResult.value };
};

export {
  buildHandoffFromPlan,
  createTask,
  runFullPipeline,
  runImplementor,
  runPlanner,
  runReviewer,
  runTester,
};
