import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

interface GitCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

const WORKSPACES_ROOT = ".orchestrator/workspaces";

const runGitCommand = async (
  args: string[],
  cwd: string
): Promise<GitCommandResult> => {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return {
    ok: exitCode === 0,
    stdout,
    stderr,
    exitCode,
  };
};

const ensureWorkspaceRoot = async () => {
  const root = join(process.cwd(), WORKSPACES_ROOT);
  await mkdir(root, { recursive: true });
  return root;
};

const cloneRepo = async (repoUrl: string, runId: string) => {
  const workspaceRoot = await ensureWorkspaceRoot();
  const workspaceDir = join(workspaceRoot, runId);
  await rm(workspaceDir, { recursive: true, force: true });

  const cloneResult = await runGitCommand(
    ["clone", "--depth", "1", repoUrl, workspaceDir],
    process.cwd()
  );
  if (!cloneResult.ok) {
    const message = cloneResult.stderr || cloneResult.stdout || "Unknown error.";
    throw new Error(`Git clone failed: ${message}`);
  }

  return workspaceDir;
};

const getCurrentBranch = async (repoRoot: string) => {
  const result = await runGitCommand(
    ["rev-parse", "--abbrev-ref", "HEAD"],
    repoRoot
  );
  if (!result.ok) {
    return "";
  }
  return result.stdout.trim();
};

const slugifyBranchName = (value: string) => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  if (normalized.length === 0) {
    return "task";
  }
  return normalized.length > 60 ? normalized.slice(0, 60) : normalized;
};

const createWorkBranch = async (repoRoot: string, taskDescription: string) => {
  const baseBranch = await getCurrentBranch(repoRoot);
  const branchName = `concerto/${slugifyBranchName(taskDescription)}`;
  const result = await runGitCommand(
    ["checkout", "-b", branchName],
    repoRoot
  );
  if (!result.ok) {
    const message = result.stderr || result.stdout || "Unknown error.";
    throw new Error(`Git branch creation failed: ${message}`);
  }
  return { branchName, baseBranch };
};

const checkoutTrackingBranch = async (repoRoot: string, branch: string) => {
  const result = await runGitCommand(
    ["checkout", "-B", branch, `origin/${branch}`],
    repoRoot
  );
  if (!result.ok) {
    const message = result.stderr || result.stdout || "Unknown error.";
    throw new Error(`Git checkout failed: ${message}`);
  }
};

const branchExists = async (repoRoot: string, branch: string) => {
  const result = await runGitCommand(
    ["show-ref", "--verify", `refs/remotes/origin/${branch}`],
    repoRoot
  );
  return result.ok;
};

const resolveBaseBranch = async (repoRoot: string, preferred?: string) => {
  if (preferred && preferred.trim().length > 0) {
    const exists = await branchExists(repoRoot, preferred);
    if (!exists) {
      throw new Error(`Base branch '${preferred}' not found on origin.`);
    }
    await checkoutTrackingBranch(repoRoot, preferred);
    return preferred;
  }

  if (await branchExists(repoRoot, "main")) {
    await checkoutTrackingBranch(repoRoot, "main");
    return "main";
  }
  if (await branchExists(repoRoot, "master")) {
    await checkoutTrackingBranch(repoRoot, "master");
    return "master";
  }

  return await getCurrentBranch(repoRoot);
};

export {
  WORKSPACES_ROOT,
  branchExists,
  cloneRepo,
  createWorkBranch,
  getCurrentBranch,
  resolveBaseBranch,
  runGitCommand,
};
