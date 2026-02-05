import type { Tool } from "openai/resources/responses/responses";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface ToolResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

interface RunShellInput {
  command: string;
  args: string[];
}

const DEFAULT_ALLOWED_COMMANDS = ["bun", "bunx", "npm", "pnpm", "yarn", "git"];

const ensureTempDir = async () => {
  const dir = join(tmpdir(), "concerto-tools");
  await mkdir(dir, { recursive: true });
  return dir;
};

const getAllowedCommands = () => {
  const raw = process.env.ALLOWED_SHELL_COMMANDS;
  if (!raw) {
    return DEFAULT_ALLOWED_COMMANDS;
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

const runCommand = async (command: string, args: string[]) => {
  const proc = Bun.spawn([command, ...args], {
    cwd: process.cwd(),
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
  };
};

const applyGitPatch = async (patch: string): Promise<ToolResult> => {
  if (!patch.trim().startsWith("diff --git ")) {
    return {
      ok: false,
      stdout: "",
      stderr: "Patch must be a unified git diff.",
    };
  }

  const dir = await ensureTempDir();
  const patchPath = join(dir, `patch-${Bun.randomUUIDv7()}.diff`);
  await writeFile(patchPath, patch, "utf-8");

  return runCommand("git", [
    "apply",
    "--whitespace=nowarn",
    "--recount",
    patchPath,
  ]);
};

const getGitStatus = async (): Promise<ToolResult> => {
  return runCommand("git", ["status", "--porcelain=v1"]);
};

const runShell = async (input: RunShellInput): Promise<ToolResult> => {
  const allowed = getAllowedCommands();
  if (!allowed.includes(input.command)) {
    return {
      ok: false,
      stdout: "",
      stderr: `Command not allowed. Allowed commands: ${allowed.join(", ")}`,
    };
  }

  const args = input.args ?? [];
  return runCommand(input.command, args);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parsePatchInput = (value: unknown) => {
  if (!isRecord(value) || typeof value.patch !== "string") {
    return null;
  }
  return { patch: value.patch };
};

const parseRunShellInput = (value: unknown) => {
  if (!isRecord(value) || typeof value.command !== "string") {
    return null;
  }
  const args = Array.isArray(value.args)
    ? value.args.filter((item) => typeof item === "string")
    : [];
  return { command: value.command, args };
};

const toolDefinitions: Tool[] = [
  {
    type: "function",
    name: "apply_git_patch",
    description: "Apply a unified git diff patch to the repo working tree.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["patch"],
      properties: {
        patch: { type: "string" },
      },
    },
  },
  {
    type: "function",
    name: "git_status",
    description: "Return git status --porcelain=v1 from repo root.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    type: "function",
    name: "run_shell",
    description: "Run an allowlisted shell command from repo root.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["command", "args"],
      properties: {
        command: { type: "string" },
        args: {
          type: "array",
          items: { type: "string" },
        },
      },
    },
  },
];

const executeTool = async (name: string, input: string) => {
  try {
    if (name === "apply_git_patch") {
      const parsed = parsePatchInput(JSON.parse(input));
      if (!parsed) {
        return {
          ok: false,
          stdout: "",
          stderr: "Invalid apply_git_patch payload.",
        };
      }
      return applyGitPatch(parsed.patch);
    }
    if (name === "git_status") {
      return getGitStatus();
    }
    if (name === "run_shell") {
      const parsed = parseRunShellInput(JSON.parse(input));
      if (!parsed) {
        return {
          ok: false,
          stdout: "",
          stderr: "Invalid run_shell payload.",
        };
      }
      return runShell(parsed);
    }
    return { ok: false, stdout: "", stderr: `Unknown tool: ${name}` };
  } catch (error) {
    return {
      ok: false,
      stdout: "",
      stderr: error instanceof Error ? error.message : "Tool execution failed.",
    };
  }
};

export { executeTool, toolDefinitions };
