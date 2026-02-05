import { z } from "zod";
import type {
  TestStrategy,
  TesterInput,
  TesterResult,
  ValidationResult,
} from "./tester.types";
import type { ImplementorResult } from "../implementor/implementor.types";

const testerInputSchema = z.object({
  handoff: z.object({
    handoff_version: z.literal("1.0.0"),
    task: z.object({
      id: z.string().min(1),
      summary: z.string().min(1),
      change_type: z.string().min(1),
    }),
    allowed_files: z.array(z.string().min(1)).min(1),
    constraints: z.object({
      max_files: z.number().int().positive(),
      max_diff_lines: z.number().int().positive(),
      max_diff_bytes: z.number().int().positive(),
      no_new_dependencies: z.boolean(),
      no_tests: z.boolean(),
      no_architecture_changes: z.boolean(),
    }),
    steps: z
      .array(
        z.object({
          id: z.string().min(1),
          file: z.string().min(1),
          action: z.enum(["modify", "create", "delete"]),
          description: z.string().min(1),
        })
      )
      .min(1),
    injected_files: z.array(
      z.object({
        path: z.string().min(1),
        content: z.string(),
      })
    ),
  }),
  implementor_result: z.object({
    status: z.enum(["completed", "blocked"]),
    stepId: z.string().min(1),
    diff: z.string(),
    filesChanged: z.array(z.string().min(1)),
    blockedReason: z.string(),
    escalation: z.string(),
  }),
  project_test_rules: z.string().min(1),
  test_framework: z.string().min(1),
  test_command: z.string().min(1),
});

const testerResultSchema = z.object({
  task_id: z.string().min(1),
  status: z.enum(["passed", "failed"]),
  tests_added: z.array(z.string()),
  test_summary: z.string(),
  coverage_notes: z.array(z.string()),
  reason: z.string(),
  logs: z.string(),
});

const buildErrorResult = <T>(errors: string[]): ValidationResult<T> => ({
  ok: false,
  errors,
});

const buildOkResult = <T>(value: T): ValidationResult<T> => ({
  ok: true,
  errors: [],
  value,
});

const validateTesterInput = (input: unknown): ValidationResult<TesterInput> => {
  const parsed = testerInputSchema.safeParse(input);
  if (!parsed.success) {
    return buildErrorResult(parsed.error.issues.map((issue) => issue.message));
  }

  return buildOkResult(parsed.data);
};

const validateTesterOutput = (input: unknown): ValidationResult<TesterResult> => {
  const parsed = testerResultSchema.safeParse(input);
  if (!parsed.success) {
    return buildErrorResult(parsed.error.issues.map((issue) => issue.message));
  }

  const result = parsed.data;
  const errors: string[] = [];

  if (result.status === "passed") {
    if (result.reason.trim().length > 0) {
      errors.push("reason must be empty when status is passed.");
    }
  }

  if (result.status === "failed") {
    if (result.reason.trim().length === 0) {
      errors.push("reason is required when status is failed.");
    }
    if (result.logs.trim().length === 0) {
      errors.push("logs are required when status is failed.");
    }
  }

  if (errors.length > 0) {
    return buildErrorResult(errors);
  }

  return buildOkResult(result);
};

const isTestPath = (path: string) => {
  const normalized = path.toLowerCase();
  return (
    normalized.includes("/test/") ||
    normalized.includes("/tests/") ||
    normalized.includes("__tests__") ||
    normalized.includes("__snapshots__") ||
    normalized.includes("/fixtures/") ||
    normalized.endsWith(".spec.ts") ||
    normalized.endsWith(".spec.tsx") ||
    normalized.endsWith(".test.ts") ||
    normalized.endsWith(".test.tsx") ||
    normalized.endsWith(".snap")
  );
};

const validateTestChanges = (testsAdded: string[]): ValidationResult<null> => {
  const errors: string[] = [];

  const nonTestFiles = testsAdded.filter((file) => !isTestPath(file));
  if (nonTestFiles.length > 0) {
    errors.push("Only test files may be modified by the tester.");
  }

  if (errors.length > 0) {
    return buildErrorResult(errors);
  }

  return buildOkResult(null);
};

const determineTestStrategy = (input: TesterInput): TestStrategy => {
  const files = input.handoff.allowed_files;
  const usesApi = files.some((file) => file.includes("/api/"));
  const usesRoutes = files.some((file) => file.includes("/routes/"));
  const usesE2e = files.some((file) => file.includes("/e2e/"));

  if (usesE2e) {
    return {
      level: "e2e",
      rationale: "Planner touches e2e paths; use end-to-end coverage.",
      target_files: files,
    };
  }

  if (usesApi || usesRoutes) {
    return {
      level: "integration",
      rationale: "Planner touches API/routes; use integration tests.",
      target_files: files,
    };
  }

  return {
    level: "unit",
    rationale: "Default to unit tests for localized changes.",
    target_files: files,
  };
};

const validateImplementorOutput = (
  result: ImplementorResult
): ValidationResult<ImplementorResult> => {
  const errors: string[] = [];

  if (result.status !== "completed") {
    errors.push("Implementor result must be completed before testing.");
  }

  if (!result.diff.trimStart().startsWith("diff --git ")) {
    errors.push("Implementor diff must be a unified diff.");
  }

  if (errors.length > 0) {
    return buildErrorResult(errors);
  }

  return buildOkResult(result);
};

const runTests = async (command: string): Promise<{ ok: boolean; logs: string }> => {
  const parts = command.split(" ").filter((part) => part.length > 0);
  const [cmd, ...args] = parts;
  if (!cmd) {
    return { ok: false, logs: "Missing test command." };
  }

  const proc = Bun.spawn({
    cmd: [cmd, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdoutText, stderrText] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  return {
    ok: exitCode === 0,
    logs: [stdoutText, stderrText].filter((value) => value.length > 0).join("\n"),
  };
};

const handleTesterResult = (result: TesterResult) => {
  if (result.status === "passed") {
    return { action: "ready_for_pr" };
  }
  return { action: "rework" };
};

export {
  determineTestStrategy,
  handleTesterResult,
  runTests,
  validateImplementorOutput,
  validateTestChanges,
  validateTesterInput,
  validateTesterOutput,
};
