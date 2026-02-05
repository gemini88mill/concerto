import type { ImplementorHandoff, ImplementorResult } from "../implementor/implementor.types";

interface TesterInput {
  handoff: ImplementorHandoff;
  implementor_result: ImplementorResult;
  project_test_rules: string;
  test_framework: string;
  test_command: string;
}

interface TestStrategy {
  level: "unit" | "integration" | "e2e";
  rationale: string;
  target_files: string[];
}

interface TesterResult {
  task_id: string;
  status: "passed" | "failed";
  tests_added: string[];
  test_summary: string;
  coverage_notes: string[];
  reason: string;
  logs: string;
}

interface TesterAgentOptions {
  model?: string;
  systemPromptPath?: string;
  developerPromptPath?: string;
}

interface TesterAgent {
  test: (input: TesterInput) => Promise<TesterResult>;
}

interface ValidationResult<T> {
  ok: boolean;
  errors: string[];
  value?: T;
}

export type {
  TestStrategy,
  TesterAgent,
  TesterAgentOptions,
  TesterInput,
  TesterResult,
  ValidationResult,
};
