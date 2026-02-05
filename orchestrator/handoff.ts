import type {
  HandoffHistoryItem,
  HandoffNext,
  RunHandoff,
  RunInfo,
  TaskInfo,
} from "./handoff.types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const isRunInfo = (value: unknown): value is RunInfo => {
  if (!isRecord(value)) {
    return false;
  }
  const repo = value.repo;
  if (!isRecord(repo)) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    typeof value.createdAt === "string" &&
    typeof repo.root === "string" &&
    typeof repo.branch === "string" &&
    typeof repo.baseBranch === "string"
  );
};

const isTaskInfo = (value: unknown): value is TaskInfo => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    typeof value.prompt === "string" &&
    typeof value.mode === "string"
  );
};

const isHistoryItem = (value: unknown): value is HandoffHistoryItem => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.phase === "string" &&
    typeof value.status === "string" &&
    typeof value.endedAt === "string" &&
    typeof value.artifact === "string"
  );
};

const isRunHandoff = (value: unknown): value is RunHandoff => {
  if (!isRecord(value)) {
    return false;
  }

  if (!isRunInfo(value.run) || !isTaskInfo(value.task)) {
    return false;
  }

  const state = value.state;
  if (!isRecord(state)) {
    return false;
  }

  if (
    typeof state.phase !== "string" ||
    typeof state.status !== "string" ||
    typeof state.iteration !== "number" ||
    typeof state.maxIterations !== "number" ||
    !Array.isArray(state.history) ||
    !state.history.every(isHistoryItem)
  ) {
    return false;
  }

  if (!isRecord(value.artifacts)) {
    return false;
  }

  if (!isStringArray(value.notes)) {
    return false;
  }

  if (value.next) {
    if (!isRecord(value.next)) {
      return false;
    }
    if (
      typeof value.next.agent !== "string" ||
      !isStringArray(value.next.inputArtifacts) ||
      !isStringArray(value.next.instructions)
    ) {
      return false;
    }
  }

  return true;
};

const createInitialHandoff = (params: {
  run: RunInfo;
  task: TaskInfo;
  iteration?: number;
  maxIterations?: number;
  artifacts: RunHandoff["artifacts"];
  constraints?: RunHandoff["constraints"];
  budgets?: RunHandoff["budgets"];
  next?: HandoffNext;
}): RunHandoff => {
  return {
    run: params.run,
    task: params.task,
    state: {
      phase: "plan",
      status: "completed",
      iteration: params.iteration ?? 1,
      maxIterations: params.maxIterations ?? 3,
      history: [],
    },
    constraints: params.constraints,
    budgets: params.budgets,
    artifacts: params.artifacts,
    next: params.next,
    notes: [],
  };
};

const appendHistory = (
  handoff: RunHandoff,
  entry: HandoffHistoryItem
): RunHandoff => {
  return {
    ...handoff,
    state: {
      ...handoff.state,
      history: [...handoff.state.history, entry],
    },
  };
};

const updateHandoff = (params: {
  handoff: RunHandoff;
  phase: string;
  status: string;
  artifact: string;
  endedAt: string;
  next?: HandoffNext;
  artifacts?: Partial<RunHandoff["artifacts"]>;
  note?: string;
}): RunHandoff => {
  const updated = appendHistory(params.handoff, {
    phase: params.phase,
    status: params.status,
    endedAt: params.endedAt,
    artifact: params.artifact,
  });

  return {
    ...updated,
    state: {
      ...updated.state,
      phase: params.phase,
      status: params.status,
    },
    artifacts: {
      ...updated.artifacts,
      ...params.artifacts,
    },
    next: params.next ?? updated.next,
    notes: params.note ? [...updated.notes, params.note] : updated.notes,
  };
};

export { createInitialHandoff, isRunHandoff, updateHandoff };
