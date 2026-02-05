import type {
  OrchestratorRunContext,
  OrchestratorTask,
} from "./orchestrator.types";
import { mkdir, readdir, stat } from "node:fs/promises";

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

const getRunDirectories = async () => {
  try {
    const entries = await readdir(RUNS_ROOT, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${RUNS_ROOT}/${entry.name}`);
  } catch {
    return [];
  }
};

const getLatestRunDir = async () => {
  const runDirs = await getRunDirectories();
  if (runDirs.length === 0) {
    return null;
  }

  let latestDir = runDirs[0];
  let latestTime = (await stat(runDirs[0])).mtimeMs;

  for (const runDir of runDirs.slice(1)) {
    const currentTime = (await stat(runDir)).mtimeMs;
    if (currentTime > latestTime) {
      latestTime = currentTime;
      latestDir = runDir;
    }
  }

  return latestDir;
};

export {
  RUNS_ROOT,
  createRunContext,
  getLatestRunDir,
  readJson,
  writeJson,
};
