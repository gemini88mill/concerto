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
}

interface OrchestratorConfig {
  maxPlanRetries: number;
  maxImplementorRetries: number;
  testCommand: string;
  testFramework: string;
}

export type {
  OrchestratorConfig,
  OrchestratorResult,
  OrchestratorRunContext,
  OrchestratorTask,
};
