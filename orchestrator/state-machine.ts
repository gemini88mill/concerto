import { createPlannerAgent } from "../agents/planner/planner.agent";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
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
  OrchestratorDiagnostic,
  OrchestratorResult,
  OrchestratorTask,
} from "./orchestrator.types";
import { logger } from "../core/logger";
import {
  cloneRepo,
  createWorkBranch,
  resolveBaseBranch,
  runGitCommand,
} from "./git";

const DEFAULT_CONFIG: OrchestratorConfig = {
  maxPlanRetries: 2,
  maxImplementorRetries: 3,
  maxReviewRetries: 3,
  testCommand: "bunx vitest",
  testFramework: "vitest",
};

const cleanupWorkspace = async (workspaceDir: string) => {
  await rm(workspaceDir, { recursive: true, force: true });
};

interface RepoInfo {
  owner: string;
  repo: string;
  host: string;
}

const parseGitHubRepoUrl = (repoUrl: string): RepoInfo => {
  const trimmed = repoUrl.trim();
  if (trimmed.startsWith("git@")) {
    const match = /^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/.exec(trimmed);
    if (!match) {
      throw new Error("Unsupported SSH repository URL format.");
    }
    return {
      host: match[1] ?? "",
      owner: match[2] ?? "",
      repo: match[3] ?? "",
    };
  }

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const url = new URL(trimmed);
    const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (parts.length < 2) {
      throw new Error("Repository URL missing owner or repo.");
    }
    const repo = (parts[1] ?? "").replace(/\.git$/i, "");
    return {
      host: url.hostname,
      owner: parts[0] ?? "",
      repo,
    };
  }

  throw new Error("Unsupported repository URL format.");
};

const createPullRequest = async (params: {
  repoUrl: string;
  token: string;
  head: string;
  base: string;
  title: string;
  body: string;
}) => {
  const info = parseGitHubRepoUrl(params.repoUrl);
  if (info.host !== "github.com") {
    throw new Error("Only github.com repositories are supported.");
  }

  const response = await fetch(
    `https://api.github.com/repos/${info.owner}/${info.repo}/pulls`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "concerto-orchestrator",
      },
      body: JSON.stringify({
        title: params.title,
        head: params.head,
        base: params.base,
        body: params.body,
      }),
    }
  );

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub PR creation failed: ${text}`);
  }

  const data = JSON.parse(text);
  return {
    url: typeof data.html_url === "string" ? data.html_url : "",
    number: typeof data.number === "number" ? data.number : 0,
  };
};

const getGitStatus = async (repoRoot: string) => {
  const result = await runGitCommand(["status", "--porcelain"], repoRoot);
  if (!result.ok) {
    return {
      ok: false,
      error: result.stderr || result.stdout || "Git status failed.",
    };
  }
  return { ok: true, output: result.stdout };
};

const commitChanges = async (repoRoot: string, message: string) => {
  const addResult = await runGitCommand(["add", "-A"], repoRoot);
  if (!addResult.ok) {
    return {
      ok: false,
      error: addResult.stderr || addResult.stdout || "Git add failed.",
    };
  }

  const commitResult = await runGitCommand(["commit", "-m", message], repoRoot);
  if (!commitResult.ok) {
    return {
      ok: false,
      error: commitResult.stderr || commitResult.stdout || "Git commit failed.",
    };
  }

  return { ok: true };
};

const readProjectRules = async (repoRoot: string) => {
  const path = join(repoRoot, "AGENTS.md");
  const file = Bun.file(path);
  const exists = await file.exists();
  if (!exists) {
    return "No project rules provided.";
  }
  return file.text();
};

const resolveRepoPath = (repoRoot: string, filePath: string) => {
  if (filePath.trim().length === 0) {
    throw new Error("Path must not be empty.");
  }
  if (isAbsolute(filePath)) {
    throw new Error(`Path must be repo-relative: ${filePath}`);
  }

  const resolvedRoot = resolve(repoRoot);
  const resolvedPath = resolve(resolvedRoot, filePath);
  const rootLower = resolvedRoot.toLowerCase();
  const pathLower = resolvedPath.toLowerCase();
  const rootPrefix = resolvedRoot.endsWith(sep) ? rootLower : rootLower + sep;

  if (pathLower !== rootLower && !pathLower.startsWith(rootPrefix)) {
    throw new Error(`Path escapes repo root: ${filePath}`);
  }

  return resolvedPath;
};

const withStep = <T>(
  result: OrchestratorResult<T>,
  step: string,
  diagnostic?: OrchestratorDiagnostic
): OrchestratorResult<T> => ({
  ...result,
  step,
  diagnostic,
});

const getAgentModel = (
  agent: "planner" | "implementor" | "reviewer" | "tester"
) => {
  const shared = process.env.OPENAI_MODEL;
  if (agent === "planner") {
    return process.env.OPENAI_PLANNER_MODEL ?? shared ?? "gpt-5-nano";
  }
  if (agent === "implementor") {
    return process.env.OPENAI_IMPLEMENTOR_MODEL ?? shared ?? "gpt-5";
  }
  if (agent === "reviewer") {
    return process.env.OPENAI_REVIEWER_MODEL ?? shared ?? "gpt-5";
  }
  return process.env.OPENAI_TESTER_MODEL ?? shared ?? "gpt-5";
};

const logAgentStart = (
  agent: "planner" | "implementor" | "reviewer" | "tester"
) => {
  logger.info(`Step: ${agent} - started (model=${getAgentModel(agent)})`);
};

const createTask = (description: string): OrchestratorTask => {
  return {
    task_id: Bun.randomUUIDv7(),
    description,
    created_at: new Date().toISOString(),
  };
};

const buildInjectedFiles = async (repoRoot: string, allowedFiles: string[]) => {
  const injectedFiles: { path: string; content: string }[] = [];

  for (const file of allowedFiles) {
    const resolvedPath = resolveRepoPath(repoRoot, file);
    const fileHandle = Bun.file(resolvedPath);
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

const ensureTempDir = async () => {
  const dir = join(tmpdir(), "concerto-orchestrator");
  await mkdir(dir, { recursive: true });
  return dir;
};

const applyPatchToRepo = async (repoRoot: string, patch: string) => {
  const dir = await ensureTempDir();
  const normalizedPatch = patch.endsWith("\n") ? patch : `${patch}\n`;
  const patchPath = join(dir, `patch-${Bun.randomUUIDv7()}.diff`);
  await writeFile(patchPath, normalizedPatch, "utf-8");

  const proc = Bun.spawn(
    ["git", "apply", "--whitespace=nowarn", "--recount", patchPath],
    {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return {
    ok: exitCode === 0,
    stdout,
    stderr,
  };
};

const applyProposedActionsToRepo = async (
  repoRoot: string,
  actions: ImplementorResult["proposed_actions"]
) => {
  for (const action of actions) {
    const targetPath = resolveRepoPath(repoRoot, action.path);
    if (action.type === "delete_file") {
      await rm(targetPath, { force: true });
      continue;
    }
    const content = action.content ?? "";
    const dir = dirname(targetPath);
    if (dir.length > 0 && dir !== ".") {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(targetPath, content, "utf-8");
  }
};

const getGitDiffForPaths = async (repoRoot: string, paths: string[]) => {
  if (paths.length === 0) {
    return { ok: true, stdout: "", stderr: "" };
  }

  const proc = Bun.spawn(["git", "diff", "--no-ext-diff", "--", ...paths], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return {
    ok: exitCode === 0,
    stdout,
    stderr,
  };
};

interface ResolvedPlanFiles {
  allowedFiles: string[];
  steps: ImplementorStep[];
  errors: string[];
}

const isGlobPattern = (value: string) => /[*?\[]/.test(value);

const expandPattern = async (
  repoRoot: string,
  pattern: string
): Promise<string[]> => {
  const glob = new Bun.Glob(pattern);
  const matches: string[] = [];
  for await (const match of glob.scan({ cwd: repoRoot })) {
    matches.push(match);
  }
  return matches;
};

const resolvePlanFiles = async (
  repoRoot: string,
  plan: Plan
): Promise<ResolvedPlanFiles> => {
  const allowedFilesSet = new Set<string>();
  const errors: string[] = [];

  for (const entry of plan.allowed_files) {
    if (isGlobPattern(entry)) {
      const matches = await expandPattern(repoRoot, entry);
      if (matches.length === 0) {
        errors.push(`allowed_files pattern "${entry}" matched no files.`);
      } else {
        matches.forEach((match) => allowedFilesSet.add(match));
      }
    } else {
      allowedFilesSet.add(entry);
    }
  }

  const steps: ImplementorStep[] = [];
  for (const step of plan.steps) {
    if (isGlobPattern(step.file)) {
      const matches = await expandPattern(repoRoot, step.file);
      if (matches.length === 0) {
        errors.push(`Step ${step.id} pattern "${step.file}" matched no files.`);
      } else {
        matches.forEach((match, index) => {
          steps.push({
            ...step,
            id: `${step.id}-${index + 1}`,
            file: match,
            description: `${step.description} (target: ${match})`,
          });
        });
      }
    } else {
      steps.push(step);
    }
  }

  return {
    allowedFiles: Array.from(allowedFilesSet),
    steps,
    errors,
  };
};

const buildHandoffFromPlan = async (
  repoRoot: string,
  plan: Plan
): Promise<ImplementorHandoff> => {
  const resolved = await resolvePlanFiles(repoRoot, plan);
  if (resolved.errors.length > 0) {
    throw new Error(resolved.errors.join(" "));
  }

  const allowedFiles = resolved.allowedFiles;
  const steps: ImplementorStep[] = resolved.steps;
  const injectedFiles = await buildInjectedFiles(repoRoot, allowedFiles);
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
        // NOTE: This summary is repo-specific; update when adapting to other projects.
        repoSummary:
          "Bun-based CLI orchestrator using commander. Entry point index.ts. Agents live under agents/.",
        constraints: {
          maxFilesPerTask: 3,
          testPolicy: "No automated tests required for CLI wiring.",
          codingStandardsRef: "AGENTS.md",
        },
      });
      return withStep({ ok: true, value: plan }, "plan");
    } catch (error) {
      if (attempts > config.maxPlanRetries) {
        return withStep(
          {
            ok: false,
            error: error instanceof Error ? error.message : "Planner failed.",
          },
          "plan"
        );
      }
    }
  }

  return withStep({ ok: false, error: "Planner retries exhausted." }, "plan");
};

const runImplementor = async (
  handoff: ImplementorHandoff,
  config: OrchestratorConfig,
  repoRoot: string
): Promise<OrchestratorResult<ImplementorResult>> => {
  if (handoff.steps.length === 0) {
    return withStep(
      { ok: false, error: "No steps available in handoff." },
      "implement"
    );
  }

  const injectedMap = new Map(
    handoff.injected_files.map((file) => [file.path, file.content])
  );
  const results: ImplementorResult[] = [];
  const changedFiles = new Set<string>();

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
    let lastBlockedReason = "";

    while (attempts < config.maxImplementorRetries) {
      attempts += 1;
      const { result } = await runImplementorStep(step, {
        handoff: stepHandoff,
      });
      if (result.status === "completed") {
        stepResult = result;
        break;
      }
      lastBlockedReason = result.blockedReason;
    }

    if (!stepResult) {
      return withStep(
        {
          ok: false,
          error: `Implementor retries exhausted. ${
            lastBlockedReason || "No reason provided."
          }`,
        },
        "implement"
      );
    }

    results.push(stepResult);
    if (stepResult.proposed_actions.length > 0) {
      const allowedSet = new Set(handoff.allowed_files);
      const invalid = stepResult.proposed_actions.filter(
        (action) => !allowedSet.has(action.path)
      );
      if (invalid.length > 0) {
        return withStep(
          { ok: false, error: "Proposed actions include disallowed files." },
          "implement"
        );
      }

      await applyProposedActionsToRepo(repoRoot, stepResult.proposed_actions);
      stepResult.proposed_actions.forEach((action) => {
        changedFiles.add(action.path);
      });
      for (const action of stepResult.proposed_actions) {
        if (action.type === "delete_file") {
          injectedMap.delete(action.path);
          continue;
        }
        const file = Bun.file(action.path);
        if (await file.exists()) {
          injectedMap.set(action.path, await file.text());
        }
      }
    } else {
      const applyResult = await applyPatchToRepo(repoRoot, stepResult.diff);
      if (!applyResult.ok) {
        return withStep(
          { ok: false, error: applyResult.stderr || "Failed to apply diff." },
          "implement",
          {
            stepId: stepResult.stepId,
            diff: stepResult.diff,
          }
        );
      }
      stepResult.filesChanged.forEach((file) => {
        changedFiles.add(file);
      });
      for (const filePath of stepResult.filesChanged) {
        const file = Bun.file(filePath);
        if (await file.exists()) {
          injectedMap.set(filePath, await file.text());
        } else {
          injectedMap.delete(filePath);
        }
      }
    }
  }

  const filesChanged = Array.from(changedFiles);
  if (filesChanged.length === 0) {
    return withStep(
      { ok: false, error: "No files changed by implementor actions." },
      "implement"
    );
  }

  const diffResult = await getGitDiffForPaths(repoRoot, filesChanged);
  if (!diffResult.ok) {
    return withStep(
      { ok: false, error: diffResult.stderr || "Failed to generate diff." },
      "implement"
    );
  }

  const mergedDiff = diffResult.stdout;
  if (mergedDiff.trim().length === 0) {
    return withStep(
      { ok: false, error: "No diff produced for applied actions." },
      "implement"
    );
  }

  return withStep(
    {
      ok: true,
      value: {
        status: "completed",
        stepId: results[results.length - 1]?.stepId ?? "unknown",
        diff: mergedDiff,
        filesChanged,
        proposed_actions: [],
        blockedReason: "",
        escalation: "",
      },
    },
    "implement"
  );
};

const runReviewer = async (
  handoff: ImplementorHandoff,
  implementorResult: ImplementorResult,
  repoRoot: string
): Promise<OrchestratorResult<ReviewerDecisionResult>> => {
  const projectRules = await readProjectRules(repoRoot);
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
  return withStep({ ok: true, value: decision }, "review");
};

const runTester = async (
  handoff: ImplementorHandoff,
  implementorResult: ImplementorResult,
  config: OrchestratorConfig,
  repoRoot: string
): Promise<OrchestratorResult<TesterResult>> => {
  const projectRules = await readProjectRules(repoRoot);
  const testerInput: TesterInput = {
    handoff,
    implementor_result: implementorResult,
    repo_root: repoRoot,
    project_test_rules: projectRules,
    test_framework: config.testFramework,
    test_command: config.testCommand,
  };

  const tester = createTesterAgent();
  const result = await tester.test(testerInput);
  return withStep({ ok: true, value: result }, "test");
};

interface RunPipelineParams {
  task: string;
  repoUrl: string;
  keepWorkspace?: boolean;
  config?: Partial<OrchestratorConfig>;
  baseBranch?: string;
}

const runFullPipeline = async (params: RunPipelineParams) => {
  const resolvedConfig = { ...DEFAULT_CONFIG, ...params.config };
  const task = createTask(params.task);
  const context = await createRunContext(task);
  const keepWorkspace = params.keepWorkspace ?? false;
  let workspaceDir = "";
  let repoRoot = "";
  let branchInfo: { branchName: string; baseBranch: string } | null = null;
  let pipelineResult: OrchestratorResult<TesterResult | null>;
  let failedDiffIndex = 0;
  const githubToken = process.env.GITHUB_TOKEN ?? "";

  try {
    workspaceDir = await cloneRepo(params.repoUrl, task.task_id);
    repoRoot = workspaceDir;
    await resolveBaseBranch(repoRoot, params.baseBranch);
    branchInfo = await createWorkBranch(repoRoot, task.description);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to clone repository.";
    pipelineResult = withStep({ ok: false, error: message }, "clone");
    await writeJson(`${context.run_dir}/plan.error.json`, pipelineResult);
    if (!keepWorkspace && workspaceDir.length > 0) {
      await cleanupWorkspace(workspaceDir);
    }
    return pipelineResult;
  }

  try {
    logger.info(
      `Models: planner=${getAgentModel("planner")}, implementor=${getAgentModel(
        "implementor"
      )}, reviewer=${getAgentModel("reviewer")}, tester=${getAgentModel(
        "tester"
      )}`
    );
    logAgentStart("planner");
    const planResult = await runPlanner(params.task, resolvedConfig);
    if (!planResult.ok || !planResult.value) {
      await writeJson(`${context.run_dir}/plan.error.json`, planResult);
      return planResult;
    }
    await writeJson(`${context.run_dir}/plan.json`, planResult.value);

    const requiresTests = planResult.value.tasks.some(
      (task) => task.requiresTests
    );
    if (!branchInfo) {
      throw new Error("Failed to create work branch.");
    }
    const baseHandoff = createInitialHandoff({
      run: {
        id: context.run_id,
        createdAt: context.task.created_at,
        repo: {
          root: repoRoot,
          branch: branchInfo.branchName,
          baseBranch: branchInfo.baseBranch,
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
        estimatedFilesChangedLimit:
          planResult.value.scope.estimatedFilesChanged,
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

    logAgentStart("implementor");
    let implementorHandoff: ImplementorHandoff;
    try {
      implementorHandoff = await buildHandoffFromPlan(
        repoRoot,
        planResult.value
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Invalid plan files.";
      const errorResult = withStep({ ok: false, error: message }, "implement");
      await writeJson(`${context.run_dir}/implementor.error.json`, errorResult);
      return errorResult;
    }

    if (
      implementorHandoff.allowed_files.length === 0 ||
      implementorHandoff.steps.length === 0
    ) {
      const error =
        "Planner did not provide executable steps or allowed files.";
      const errorResult = withStep({ ok: false, error }, "implement");
      await writeJson(`${context.run_dir}/implementor.error.json`, errorResult);
      return errorResult;
    }

    let implementResult: OrchestratorResult<ImplementorResult> | null = null;
    let reviewResult: OrchestratorResult<ReviewerDecisionResult> | null = null;
    let rejectionReason = "";

    for (
      let attempt = 1;
      attempt <= resolvedConfig.maxReviewRetries;
      attempt += 1
    ) {
      implementResult = await runImplementor(
        implementorHandoff,
        resolvedConfig,
        repoRoot
      );
      if (!implementResult.ok || !implementResult.value) {
        if (implementResult.diagnostic?.diff) {
          failedDiffIndex += 1;
          await writeJson(
            `${context.run_dir}/implementor.failed.${failedDiffIndex}.json`,
            {
              step: implementResult.step ?? "implement",
              error: implementResult.error ?? "Implementor failed.",
              diagnostic: implementResult.diagnostic,
            }
          );
        }
        await writeJson(
          `${context.run_dir}/implementor.error.json`,
          implementResult
        );
        return implementResult;
      }
      await writeJson(
        `${context.run_dir}/implementor.json`,
        implementResult.value
      );

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

      logAgentStart("reviewer");
      reviewResult = await runReviewer(
        implementorHandoff,
        implementResult.value,
        repoRoot
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
      if (reviewNext.agent === "tester") {
        await writeJson(`${context.run_dir}/handoff.test.json`, runHandoff);
      }

      if (reviewResult.value.decision === "approved") {
        break;
      }

      if (reviewResult.value.decision === "blocked") {
        return {
          ok: false,
          error: `Reviewer blocked: ${reviewResult.value.reason}`,
          step: "review",
        };
      }

      rejectionReason = reviewResult.value.reasons.join(" ");
      if (attempt < resolvedConfig.maxReviewRetries) {
        implementorHandoff = {
          ...implementorHandoff,
          review_feedback: {
            decision: reviewResult.value.decision,
            notes: reviewResult.value.notes,
            required_actions: reviewResult.value.required_actions,
            reasons: reviewResult.value.reasons,
            reason: reviewResult.value.reason,
            suggested_escalation: reviewResult.value.suggested_escalation,
          },
        };
        logAgentStart("implementor");
        continue;
      }

      return {
        ok: false,
        error: `Reviewer rejected: ${rejectionReason || "No reason provided."}`,
        step: "review",
      };
    }

    if (
      !implementResult ||
      !implementResult.value ||
      !reviewResult ||
      !reviewResult.value
    ) {
      return {
        ok: false,
        error: "Implementation or review missing.",
        step: "review",
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

    logAgentStart("tester");
    const testResult = requiresTests
      ? await runTester(
          implementorHandoff,
          implementResult.value,
          resolvedConfig,
          repoRoot
        )
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
          instructions: [
            "Fix implementation issues that caused test failures.",
          ],
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
      return withStep(
        { ok: false, error: `Tester status: ${testResult.value?.status}` },
        "test"
      );
    }

    if (githubToken.trim().length === 0) {
      return withStep(
        { ok: false, error: "GITHUB_TOKEN is required to create PRs." },
        "pr"
      );
    }

    const statusResult = await getGitStatus(repoRoot);
    if (!statusResult.ok) {
      return withStep({ ok: false, error: statusResult.error }, "pr");
    }
    if (statusResult.output?.trim().length === 0) {
      return withStep(
        { ok: false, error: "No changes detected to commit." },
        "pr"
      );
    }

    const commitResult = await commitChanges(
      repoRoot,
      `chore: orchestrator update for ${task.description}`
    );
    if (!commitResult.ok) {
      return withStep({ ok: false, error: commitResult.error }, "pr");
    }

    const pushResult = await runGitCommand(
      ["push", "-u", "origin", baseHandoff.run.repo.branch],
      repoRoot
    );
    if (!pushResult.ok) {
      return withStep(
        {
          ok: false,
          error: pushResult.stderr || pushResult.stdout || "Git push failed.",
        },
        "pr"
      );
    }

    const prBody = [
      `Task: ${task.description}`,
      `Branch: ${baseHandoff.run.repo.branch}`,
      `Base: ${baseHandoff.run.repo.baseBranch}`,
    ].join("\n");

    const prResult = await createPullRequest({
      repoUrl: params.repoUrl,
      token: githubToken,
      head: baseHandoff.run.repo.branch,
      base: baseHandoff.run.repo.baseBranch,
      title: task.description,
      body: prBody,
    });

    await writeJson(`${context.run_dir}/pr-draft.json`, {
      task_id: task.task_id,
      status: "ready_for_review",
      repo: {
        root: repoRoot,
        branch: baseHandoff.run.repo.branch,
        baseBranch: baseHandoff.run.repo.baseBranch,
      },
      pr: {
        url: prResult.url,
        number: prResult.number,
      },
    });

    return withStep({ ok: true, value: testResult.value }, "complete");
  } finally {
    if (!keepWorkspace && workspaceDir.length > 0) {
      await cleanupWorkspace(workspaceDir);
    }
  }
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
