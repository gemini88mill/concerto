import type { ImplementorHandoff, ImplementorResult } from "../implementor/implementor.types";

interface ReviewerConstraints {
  enforceAllowedFiles: boolean;
  enforceNoTests: boolean;
  enforceNoNewDependencies: boolean;
  enforceNoArchitectureChanges: boolean;
}

interface ReviewerInput {
  handoff: ImplementorHandoff;
  implementor_result: ImplementorResult;
  project_rules: string;
  reviewer_constraints: ReviewerConstraints;
}

interface ReviewerDecisionResult {
  task_id: string;
  decision: "approved" | "rejected" | "blocked";
  notes: string[];
  required_actions: string[];
  reasons: string[];
  reason: string;
  suggested_escalation: string;
}

interface ReviewerAgentOptions {
  model?: string;
  systemPromptPath?: string;
  developerPromptPath?: string;
}

interface ReviewerAgent {
  review: (input: ReviewerInput) => Promise<ReviewerDecisionResult>;
}

interface ValidationResult<T> {
  ok: boolean;
  errors: string[];
  value?: T;
}

export type {
  ReviewerAgent,
  ReviewerAgentOptions,
  ReviewerConstraints,
  ReviewerDecisionResult,
  ReviewerInput,
  ValidationResult,
};
