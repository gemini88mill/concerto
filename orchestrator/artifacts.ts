import type {
  OrchestratorRunContext,
  OrchestratorTask,
} from "./orchestrator.types";
import { mkdir } from "node:fs/promises";

const RUNS_ROOT = ".orchestrator/runs";

const ensureDir = async (path: string) => {
  await mkdir(path, { recursive: true });
};

const writeJson = async (path: string, data: unknown) => {
  const payload = JSON.stringify(data, null, 2);
  await Bun.write(path, payload);
};

const readJson = async (path: string): Promise<unknown> => {
  const text = await Bun.file(path).text();
  return JSON.parse(text);
};

const createRunContext = async (
  task: OrchestratorTask
): Promise<OrchestratorRunContext> => {
  const runDir = `${RUNS_ROOT}/${task.task_id}`;
  await ensureDir(runDir);
  await writeJson(`${runDir}/task.json`, task);
  return {
    run_id: task.task_id,
    task,
    run_dir: runDir,
  };
};

export { RUNS_ROOT, createRunContext, readJson, writeJson };
