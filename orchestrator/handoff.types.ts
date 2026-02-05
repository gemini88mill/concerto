interface RunRepoInfo {
  root: string;
  branch: string;
  baseBranch: string;
}

interface RunInfo {
  id: string;
  createdAt: string;
  repo: RunRepoInfo;
}

interface TaskInfo {
  id: string;
  prompt: string;
  mode: string;
}

interface HandoffHistoryItem {
  phase: string;
  status: string;
  endedAt: string;
  artifact: string;
}

interface HandoffState {
  phase: string;
  status: string;
  iteration: number;
  maxIterations: number;
  history: HandoffHistoryItem[];
}

interface HandoffConstraints {
  estimatedFilesChangedLimit?: number;
  noBreakingChanges?: boolean;
  requireTestsForBehaviorChange?: boolean;
}

interface HandoffBudgets {
  maxTokens?: number;
  maxToolCalls?: number;
  timeLimitSeconds?: number;
}

interface HandoffArtifacts {
  task?: string;
  plan?: string;
  implementation?: string;
  review?: string;
  tests?: string;
  prDraft?: string;
  implementorHandoff?: string;
  handoff?: string;
  handoffImplementor?: string;
  handoffReview?: string;
  handoffTest?: string;
}

interface HandoffNext {
  agent: string;
  inputArtifacts: string[];
  instructions: string[];
}

interface RunHandoff {
  run: RunInfo;
  task: TaskInfo;
  state: HandoffState;
  constraints?: HandoffConstraints;
  budgets?: HandoffBudgets;
  artifacts: HandoffArtifacts;
  next?: HandoffNext;
  notes: string[];
}

export type {
  HandoffArtifacts,
  HandoffBudgets,
  HandoffConstraints,
  HandoffHistoryItem,
  HandoffNext,
  HandoffState,
  RunHandoff,
  RunInfo,
  RunRepoInfo,
  TaskInfo,
};
