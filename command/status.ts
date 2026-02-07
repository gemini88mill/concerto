import { resolve } from "path";
import type { Command } from "commander";
import { readJson } from "../orchestrator/artifacts";
import { logger } from "../core/logger";
import { readRunHandoffFile, resolveRunDir } from "./shared";

interface TaskJson {
  task_id?: string;
  description?: string;
  created_at?: string;
}

interface StatusHistoryItem {
  phase: string;
  status: string;
  endedAt: string;
}

interface StatusOutput {
  runId: string;
  taskId: string;
  task: string;
  createdAt?: string;
  runDir: string;
  phase?: string;
  status?: string;
  iteration?: number;
  maxIterations?: number;
  nextAgent?: string;
  history?: StatusHistoryItem[];
  source: "handoff" | "task";
}

interface StringMap {
  [key: string]: unknown;
}

interface StatusOptions {
  watch?: boolean;
  interval?: string;
}

interface StatusSnapshot {
  status?: StatusOutput;
  warning?: string;
}

interface AnimationController {
  stop: () => void;
}

const isRecord = (value: unknown): value is StringMap =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isAnimationController = (value: unknown): value is AnimationController =>
  isRecord(value) && typeof value.stop === "function";

const WATCH_INTERVAL_DEFAULT_MS = 2000;

const sleep = (ms: number) =>
  new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });

const parseWatchInterval = (raw?: string) => {
  if (!raw) {
    return WATCH_INTERVAL_DEFAULT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 250) {
    logger.warn(
      `Invalid --interval value "${raw}". Falling back to ${WATCH_INTERVAL_DEFAULT_MS}ms.`
    );
    return WATCH_INTERVAL_DEFAULT_MS;
  }
  return parsed;
};

const parseTaskJson = (value: unknown): TaskJson | null => {
  if (!isRecord(value)) {
    return null;
  }
  const taskId =
    typeof value.task_id === "string" && value.task_id.length > 0
      ? value.task_id
      : undefined;
  const description =
    typeof value.description === "string" && value.description.length > 0
      ? value.description
      : undefined;
  const createdAt =
    typeof value.created_at === "string" && value.created_at.length > 0
      ? value.created_at
      : undefined;

  return {
    task_id: taskId,
    description,
    created_at: createdAt,
  };
};

const buildRunDir = (taskId?: string) => {
  if (taskId && taskId.trim().length > 0) {
    return resolve(".orchestrator", "runs", taskId.trim());
  }
  return undefined;
};

const loadStatus = async (runDir: string): Promise<StatusOutput | null> => {
  const handoffPath = resolve(runDir, "handoff.json");
  const handoffFile = Bun.file(handoffPath);
  if (await handoffFile.exists()) {
    const handoff = await readRunHandoffFile(handoffPath);
    const history = handoff.state.history.map((item) => ({
      phase: item.phase,
      status: item.status,
      endedAt: item.endedAt,
    }));
    return {
      runId: handoff.run.id,
      taskId: handoff.task.id,
      task: handoff.task.prompt,
      createdAt: handoff.run.createdAt,
      runDir,
      phase: handoff.state.phase,
      status: handoff.state.status,
      iteration: handoff.state.iteration,
      maxIterations: handoff.state.maxIterations,
      nextAgent: handoff.next?.agent,
      history,
      source: "handoff",
    };
  }

  const taskPath = resolve(runDir, "task.json");
  const taskFile = Bun.file(taskPath);
  if (await taskFile.exists()) {
    const raw = await readJson(taskPath);
    const task = parseTaskJson(raw);
    if (task?.task_id && task.description) {
      return {
        runId: task.task_id,
        taskId: task.task_id,
        task: task.description,
        createdAt: task.created_at,
        runDir,
        source: "task",
      };
    }
  }

  return null;
};

const startThinkingAnimation = async (): Promise<AnimationController | null> => {
  try {
    const moduleValue = await import("chalk-animation");
    const radar =
      isRecord(moduleValue) && typeof moduleValue.radar === "function"
        ? moduleValue.radar
        : isRecord(moduleValue) &&
            isRecord(moduleValue.default) &&
            typeof moduleValue.default.radar === "function"
          ? moduleValue.default.radar
          : null;
    if (!radar) {
      return null;
    }
    const animation = radar("Thinking...");
    if (!isAnimationController(animation)) {
      return null;
    }
    return animation;
  } catch {
    return null;
  }
};

const readStatusSnapshot = async (taskId?: string): Promise<StatusSnapshot> => {
  try {
    const runDirInput = buildRunDir(taskId);
    const runDir = await resolveRunDir(runDirInput);
    const status = await loadStatus(runDir);
    if (!status) {
      return {
        warning: taskId
          ? `No status artifacts found for task id ${taskId}.`
          : "No status artifacts found for latest run.",
      };
    }
    return { status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("No runs found under .orchestrator/runs.")) {
      return { warning: "No runs found under .orchestrator/runs." };
    }
    throw error;
  }
};

const printSnapshot = (snapshot: StatusSnapshot) => {
  if (snapshot.warning) {
    logger.warn(snapshot.warning);
    return;
  }
  if (snapshot.status) {
    console.log(JSON.stringify(snapshot.status, null, 2));
    return;
  }
  logger.warn("No status information available.");
};

const watchStatus = async (taskId: string | undefined, intervalMs: number) => {
  let isStopped = false;
  const stopWatching = () => {
    isStopped = true;
  };
  process.on("SIGINT", stopWatching);
  process.on("SIGTERM", stopWatching);

  try {
    while (!isStopped) {
      const animation = await startThinkingAnimation();
      const snapshot = await readStatusSnapshot(taskId);
      animation?.stop();
      process.stdout.write("\x1Bc");
      logger.info(
        `Watching status${taskId ? ` for ${taskId}` : ""} (interval: ${intervalMs}ms). Press Ctrl+C to stop.`
      );
      printSnapshot(snapshot);
      if (isStopped) {
        break;
      }
      await sleep(intervalMs);
    }
  } finally {
    process.off("SIGINT", stopWatching);
    process.off("SIGTERM", stopWatching);
  }
};

export const registerStatusCommand = (program: Command) => {
  program
    .command("status [taskId]")
    .option("-w, --watch", "Continuously refresh status output.")
    .option(
      "-i, --interval <ms>",
      "Polling interval in milliseconds when --watch is used.",
      String(WATCH_INTERVAL_DEFAULT_MS)
    )
    .description(
      "Show status for the latest run or for a specific task id."
    )
    .action(async (taskId: string | undefined, options: StatusOptions) => {
      if (options.watch) {
        const intervalMs = parseWatchInterval(options.interval);
        await watchStatus(taskId, intervalMs);
        return;
      }

      const snapshot = await readStatusSnapshot(taskId);
      printSnapshot(snapshot);
    });
};
