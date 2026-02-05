import { z } from "zod";
import type {
  ReviewerDecisionResult,
  ReviewerInput,
  ValidationResult,
} from "./reviewer.types";
import type { ImplementorHandoff, ImplementorResult } from "../implementor/implementor.types";
import { parseUnifiedDiff } from "../implementor/implementor.validators";

const reviewerInputSchema = z.object({
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
  project_rules: z.string(),
  reviewer_constraints: z.object({
    enforceAllowedFiles: z.boolean(),
    enforceNoTests: z.boolean(),
    enforceNoNewDependencies: z.boolean(),
    enforceNoArchitectureChanges: z.boolean(),
  }),
});

const reviewerResultSchema = z.object({
  task_id: z.string().min(1),
  decision: z.enum(["approved", "rejected", "blocked"]),
  notes: z.array(z.string()),
  required_actions: z.array(z.string()),
  reasons: z.array(z.string()),
  reason: z.string(),
  suggested_escalation: z.string(),
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

const validateReviewerInput = (input: unknown): ValidationResult<ReviewerInput> => {
  const parsed = reviewerInputSchema.safeParse(input);
  if (!parsed.success) {
    return buildErrorResult(
      parsed.error.issues.map((issue) => issue.message)
    );
  }

  return buildOkResult(parsed.data);
};

const validateImplementorOutput = (
  result: ImplementorResult
): ValidationResult<ImplementorResult> => {
  const errors: string[] = [];

  if (result.status === "completed") {
    if (!result.diff.trimStart().startsWith("diff --git ")) {
      errors.push("diff must be a unified diff when completed.");
    }
    if (result.filesChanged.length === 0) {
      errors.push("filesChanged must be non-empty when completed.");
    }
    const stats = parseUnifiedDiff(result.diff);
    const diffFiles = new Set(stats.filesChanged);
    const missing = result.filesChanged.filter((file) => !diffFiles.has(file));
    if (missing.length > 0) {
      errors.push("filesChanged must match diff contents.");
    }
  }

  if (result.status === "blocked") {
    if (result.diff.trim().length > 0) {
      errors.push("diff must be empty when blocked.");
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
    normalized.includes(".spec.") ||
    normalized.includes(".test.")
  );
};

const isDependencyFile = (path: string) => {
  const normalized = path.toLowerCase();
  return (
    normalized.endsWith("package.json") ||
    normalized.endsWith("bun.lock") ||
    normalized.endsWith("bun.lockb") ||
    normalized.endsWith("package-lock.json") ||
    normalized.endsWith("pnpm-lock.yaml") ||
    normalized.endsWith("yarn.lock")
  );
};

const isArchitecturePath = (path: string) => {
  const normalized = path.toLowerCase();
  return (
    normalized.startsWith("core/") ||
    normalized.startsWith("providers/") ||
    normalized.includes("/core/") ||
    normalized.includes("/providers/")
  );
};

const checkReviewerConstraints = (
  handoff: ImplementorHandoff,
  result: ImplementorResult,
  enforce: {
    enforceAllowedFiles: boolean;
    enforceNoTests: boolean;
    enforceNoNewDependencies: boolean;
    enforceNoArchitectureChanges: boolean;
  }
): ValidationResult<null> => {
  if (result.status !== "completed") {
    return buildOkResult(null);
  }

  const stats = parseUnifiedDiff(result.diff);
  const filesChanged = stats.filesChanged;
  const allowedSet = new Set(handoff.allowed_files);
  const errors: string[] = [];

  if (enforce.enforceAllowedFiles) {
    const invalid = filesChanged.filter((file) => !allowedSet.has(file));
    if (invalid.length > 0) {
      errors.push("Changed files must be within allowed_files.");
    }
  }

  if (enforce.enforceNoTests && handoff.constraints.no_tests) {
    const testFiles = filesChanged.filter((file) => isTestPath(file));
    if (testFiles.length > 0) {
      errors.push("Tests must not be modified.");
    }
  }

  if (enforce.enforceNoNewDependencies && handoff.constraints.no_new_dependencies) {
    const depFiles = filesChanged.filter((file) => isDependencyFile(file));
    if (depFiles.length > 0) {
      errors.push("Dependency files must not be modified.");
    }
  }

  if (
    enforce.enforceNoArchitectureChanges &&
    handoff.constraints.no_architecture_changes
  ) {
    const architectureFiles = filesChanged.filter((file) => isArchitecturePath(file));
    if (architectureFiles.length > 0) {
      errors.push("Architecture files must not be modified.");
    }
  }

  if (errors.length > 0) {
    return buildErrorResult(errors);
  }

  return buildOkResult(null);
};

const verifyIntent = (
  handoff: ImplementorHandoff,
  result: ImplementorResult
): ValidationResult<null> => {
  if (result.status !== "completed") {
    return buildOkResult(null);
  }

  const stats = parseUnifiedDiff(result.diff);
  const diffFiles = stats.filesChanged;
  const stepFiles = handoff.steps.map((step) => step.file);
  const stepSet = new Set(stepFiles);
  const errors: string[] = [];

  diffFiles.forEach((file) => {
    if (!stepSet.has(file)) {
      errors.push("Diff includes files not referenced by steps.");
    }
  });

  stepFiles.forEach((file) => {
    if (!diffFiles.includes(file)) {
      errors.push("Each step file must be changed in the diff.");
    }
  });

  if (errors.length > 0) {
    return buildErrorResult(errors);
  }

  return buildOkResult(null);
};

const verifyPatterns = (
  _result: ImplementorResult,
  _projectRules: string
): ValidationResult<null> => {
  return buildOkResult(null);
};

const validateReviewerOutput = (
  input: unknown
): ValidationResult<ReviewerDecisionResult> => {
  const parsed = reviewerResultSchema.safeParse(input);
  if (!parsed.success) {
    return buildErrorResult(
      parsed.error.issues.map((issue) => issue.message)
    );
  }

  const result = parsed.data;
  const errors: string[] = [];

  if (result.decision === "approved") {
    if (result.reasons.length > 0) {
      errors.push("reasons must be empty when approved.");
    }
    if (result.reason.trim().length > 0) {
      errors.push("reason must be empty when approved.");
    }
  }

  if (result.decision === "rejected") {
    if (result.reasons.length === 0) {
      errors.push("reasons must be provided when rejected.");
    }
  }

  if (result.decision === "blocked") {
    if (result.reason.trim().length === 0) {
      errors.push("reason must be provided when blocked.");
    }
    if (result.suggested_escalation.trim().length === 0) {
      errors.push("suggested_escalation must be provided when blocked.");
    }
  }

  if (errors.length > 0) {
    return buildErrorResult(errors);
  }

  return buildOkResult(result);
};

const handleReviewerDecision = (decision: ReviewerDecisionResult) => {
  if (decision.decision === "approved") {
    return { action: "tester" };
  }
  if (decision.decision === "blocked") {
    return { action: "planner" };
  }
  return { action: "fail" };
};

export {
  checkReviewerConstraints,
  handleReviewerDecision,
  validateImplementorOutput,
  validateReviewerInput,
  validateReviewerOutput,
  verifyIntent,
  verifyPatterns,
};
