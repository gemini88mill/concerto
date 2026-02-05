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
  PlanTask,
};
