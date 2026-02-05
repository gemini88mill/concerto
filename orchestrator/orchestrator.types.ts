interface OrchestratorTask {
  task_id: string;
  description: string;
  created_at: string;
}

interface OrchestratorRunContext {
  run_id: string;
  task: OrchestratorTask;
  run_dir: string;
}

interface OrchestratorResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
  step?: string;
  diagnostic?: OrchestratorDiagnostic;
}

interface OrchestratorDiagnostic {
  stepId?: string;
  file?: string;
  diff?: string;
}

interface OrchestratorConfig {
  maxPlanRetries: number;
  maxImplementorRetries: number;
  maxReviewRetries: number;
  testCommand: string;
  testFramework: string;
}

export type {
  OrchestratorConfig,
  OrchestratorDiagnostic,
  OrchestratorResult,
  OrchestratorRunContext,
  OrchestratorTask,
};
