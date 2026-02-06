import { z } from "zod";
import type {
  DiffStats,
  ImplementorHandoff,
  ImplementorResult,
  ValidationResult,
} from "./implementor.types";

const HANDOFF_VERSION = "1.0.0";

const handoffSchema = z.object({
  handoff_version: z.literal(HANDOFF_VERSION),
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
});

const resultSchema = z.object({
  status: z.enum(["completed", "blocked"]),
  stepId: z.string().min(1),
  diff: z.string(),
  filesChanged: z.array(z.string().min(1)),
  proposed_actions: z.array(
    z.object({
      type: z.enum(["write_file", "delete_file"]),
      path: z.string().min(1),
      content: z.string(),
    })
  ),
  blockedReason: z.string(),
  escalation: z.string(),
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

const validateImplementorHandoff = (
  input: unknown
): ValidationResult<ImplementorHandoff> => {
  const parsed = handoffSchema.safeParse(input);
  if (!parsed.success) {
    return buildErrorResult(parsed.error.issues.map((issue) => issue.message));
  }

  const errors: string[] = [];
  const handoff = parsed.data;

  if (handoff.constraints.max_files > handoff.allowed_files.length) {
    errors.push("constraints.max_files exceeds allowed_files length.");
  }

  const allowedSet = new Set(handoff.allowed_files);
  const injectedSet = new Set(handoff.injected_files.map((file) => file.path));

  handoff.steps.forEach((step) => {
    if (!allowedSet.has(step.file)) {
      errors.push(`Step ${step.id} references file not in allowed_files.`);
    }
    if (step.action === "modify" && !injectedSet.has(step.file)) {
      errors.push(`Step ${step.id} missing injected file content.`);
    }
  });

  if (errors.length > 0) {
    return buildErrorResult(errors);
  }

  return buildOkResult(handoff);
};

const validateImplementorResult = (
  input: unknown
): ValidationResult<ImplementorResult> => {
  const parsed = resultSchema.safeParse(input);
  if (!parsed.success) {
    return buildErrorResult(parsed.error.issues.map((issue) => issue.message));
  }

  const result = parsed.data;
  const errors: string[] = [];

  if (result.status === "blocked") {
    if (result.blockedReason.trim().length === 0) {
      errors.push("blockedReason is required when status is blocked.");
    }
    if (result.diff.trim().length > 0) {
      errors.push("diff must be empty when status is blocked.");
    }
    if (result.filesChanged.length > 0) {
      errors.push("filesChanged must be empty when status is blocked.");
    }
    if (result.proposed_actions.length > 0) {
      errors.push("proposed_actions must be empty when status is blocked.");
    }
  }

  if (result.status === "completed") {
    if (
      result.diff.trim().length === 0 &&
      result.proposed_actions.length === 0
    ) {
      errors.push(
        "Either diff or proposed_actions is required when status is completed."
      );
    }
  }

  if (errors.length > 0) {
    return buildErrorResult(errors);
  }

  return buildOkResult(result);
};

const parseUnifiedDiff = (diff: string): DiffStats => {
  const files = new Set<string>();
  let addedLines = 0;
  let removedLines = 0;

  const lines = diff.split("\n");
  lines.forEach((line) => {
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (match && match[2]) {
        files.add(match[2]);
      }
      return;
    }
    if (line.startsWith("+++") || line.startsWith("---")) {
      return;
    }
    if (line.startsWith("+")) {
      addedLines += 1;
    }
    if (line.startsWith("-")) {
      removedLines += 1;
    }
  });

  const encoder = new TextEncoder();
  const totalBytes = encoder.encode(diff).length;

  return {
    filesChanged: Array.from(files),
    addedLines,
    removedLines,
    totalChangedLines: addedLines + removedLines,
    totalBytes,
  };
};

const hasValidHunkHeaders = (diff: string): boolean => {
  const lines = diff.split("\n");
  let sawHunk = false;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      sawHunk = true;
      const match = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
      if (!match) {
        return false;
      }
    }
  }

  return sawHunk;
};

const getProposedFiles = (result: ImplementorResult) => {
  const files: string[] = [];
  result.proposed_actions.forEach((action) => {
    files.push(action.path);
  });
  return files;
};

const enforceImplementorConstraints = (
  result: ImplementorResult,
  handoff: ImplementorHandoff
): ValidationResult<DiffStats> => {
  if (result.status === "blocked") {
    return buildErrorResult(["Implementor returned blocked status."]);
  }

  const hasDiff = result.diff.trim().length > 0;
  const proposedFiles = getProposedFiles(result);
  if (!hasDiff && proposedFiles.length === 0) {
    return buildErrorResult([
      "Either diff or proposed_actions must be provided for completed results.",
    ]);
  }

  if (hasDiff) {
    if (!result.diff.trimStart().startsWith("diff --git ")) {
      return buildErrorResult(["Diff must be a unified diff."]);
    }
    if (!hasValidHunkHeaders(result.diff)) {
      return buildErrorResult([
        "Diff must include valid unified diff hunk headers (e.g., '@@ -1,3 +1,4 @@').",
      ]);
    }
  }

  const stats = hasDiff
    ? parseUnifiedDiff(result.diff)
    : {
        filesChanged: proposedFiles,
        addedLines: 0,
        removedLines: 0,
        totalChangedLines: 0,
        totalBytes: 0,
      };
  const allowedSet = new Set(handoff.allowed_files);

  if (stats.filesChanged.length === 0) {
    return buildErrorResult(["Diff must include at least one file."]);
  }

  if (stats.filesChanged.length > handoff.constraints.max_files) {
    return buildErrorResult(["Diff exceeds max_files constraint."]);
  }

  const invalidFiles = stats.filesChanged.filter(
    (file) => !allowedSet.has(file)
  );
  if (invalidFiles.length > 0) {
    return buildErrorResult(["Diff includes files outside allowed_files."]);
  }

  if (stats.totalChangedLines > handoff.constraints.max_diff_lines) {
    return buildErrorResult(["Diff exceeds max_diff_lines constraint."]);
  }

  if (stats.totalBytes > handoff.constraints.max_diff_bytes) {
    return buildErrorResult(["Diff exceeds max_diff_bytes constraint."]);
  }

  const stepMap = new Map(handoff.steps.map((step) => [step.id, step]));
  const step = stepMap.get(result.stepId);
  if (step && !stats.filesChanged.includes(step.file)) {
    return buildErrorResult(["Diff must reference the injected step file."]);
  }

  return buildOkResult(stats);
};

const handleImplementorBlocked = (result: ImplementorResult) => {
  return {
    status: "blocked",
    reason: result.blockedReason,
    escalation: result.escalation,
  };
};

export {
  HANDOFF_VERSION,
  enforceImplementorConstraints,
  handleImplementorBlocked,
  parseUnifiedDiff,
  validateImplementorHandoff,
  validateImplementorResult,
};
