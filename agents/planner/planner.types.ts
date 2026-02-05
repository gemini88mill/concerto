interface PlannerConstraints {
  maxFilesPerTask: number;
  testPolicy: string;
  codingStandardsRef: string;
}

interface PlannerInput {
  task: string;
  repoSummary: string;
  constraints: PlannerConstraints;
}

interface PlanScope {
  estimatedFilesChanged: number;
  highRisk: boolean;
  breakingChange: boolean;
}

interface PlanStep {
  id: string;
  file: string;
  action: "modify" | "create" | "delete";
  description: string;
}

interface PlanTask {
  id: string;
  description: string;
  affectedAreas: string[];
  estimatedFiles: number;
  requiresTests: boolean;
  handoffTo: "implementer";
}

interface Plan {
  summary: string;
  scope: PlanScope;
  tasks: PlanTask[];
  allowed_files: string[];
  steps: PlanStep[];
  assumptions: string[];
  outOfScope: string[];
}

interface PlannerAgentOptions {
  model?: string;
  systemPromptPath?: string;
  developerPromptPath?: string;
}

interface PlannerAgent {
  plan: (input: PlannerInput) => Promise<Plan>;
}

export type {
  PlannerAgent,
  PlannerAgentOptions,
  PlannerConstraints,
  PlannerInput,
  Plan,
  PlanScope,
  PlanStep,
  PlanTask,
};
