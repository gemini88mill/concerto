interface ImplementorTask {
  id: string;
  summary: string;
  change_type: string;
}

interface ImplementorConstraints {
  max_files: number;
  max_diff_lines: number;
  max_diff_bytes: number;
  no_new_dependencies: boolean;
  no_tests: boolean;
  no_architecture_changes: boolean;
}

interface ImplementorStep {
  id: string;
  file: string;
  action: "modify" | "create" | "delete";
  description: string;
}

interface InjectedFile {
  path: string;
  content: string;
}

interface ReviewFeedback {
  decision: "approved" | "rejected" | "blocked";
  notes: string[];
  required_actions: string[];
  reasons: string[];
  reason: string;
  suggested_escalation: string;
}

interface ImplementorHandoff {
  handoff_version: "1.0.0";
  task: ImplementorTask;
  allowed_files: string[];
  constraints: ImplementorConstraints;
  steps: ImplementorStep[];
  injected_files: InjectedFile[];
  review_feedback?: ReviewFeedback;
}

interface ImplementorResult {
  status: "completed" | "blocked";
  stepId: string;
  diff: string;
  filesChanged: string[];
  proposed_actions: ProposedAction[];
  blockedReason: string;
  escalation: string;
}

interface ProposedAction {
  type: "write_file" | "delete_file";
  path: string;
  content: string;
}

interface DiffStats {
  filesChanged: string[];
  addedLines: number;
  removedLines: number;
  totalChangedLines: number;
  totalBytes: number;
}

interface DiffResult {
  result: ImplementorResult;
  stats?: DiffStats;
}

interface ValidationResult<T> {
  ok: boolean;
  errors: string[];
  value?: T;
}

interface ImplementorAgentOptions {
  model?: string;
  systemPromptPath?: string;
  developerPromptPath?: string;
}

interface ImplementorAgent {
  runStep: (step: ImplementorStep, handoff: ImplementorHandoff) => Promise<ImplementorResult>;
}

interface ImplementorRunContext {
  handoff: ImplementorHandoff;
  options?: ImplementorAgentOptions;
}

export type {
  DiffStats,
  DiffResult,
  ImplementorAgent,
  ImplementorAgentOptions,
  ImplementorConstraints,
  ImplementorHandoff,
  ImplementorResult,
  ImplementorStep,
  ImplementorTask,
  ImplementorRunContext,
  InjectedFile,
  ProposedAction,
  ReviewFeedback,
  ValidationResult,
};
