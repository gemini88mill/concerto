import { resolve } from "path";
import { z } from "zod";
import type { ImplementorResult } from "../agents/implementor/implementor.types";
import type { Plan } from "../agents/planner/planner.types";
import { getLatestRunDir, readJson } from "../orchestrator/artifacts";
import { isRunHandoff } from "../orchestrator/handoff";
import type { RunHandoff } from "../orchestrator/handoff.types";

const planSchema = z.object({
  summary: z.string().min(1),
  scope: z.object({
    estimatedFilesChanged: z.number().int().nonnegative(),
    highRisk: z.boolean(),
    breakingChange: z.boolean(),
  }),
  tasks: z.array(
    z.object({
      id: z.string().min(1),
      description: z.string().min(1),
      affectedAreas: z.array(z.string().min(1)),
      estimatedFiles: z.number().int().positive(),
      requiresTests: z.boolean(),
      handoffTo: z.literal("implementer"),
    })
  ),
  allowed_files: z.array(z.string().min(1)).min(1),
  steps: z
    .array(
      z.object({
        id: z.string().min(1),
        file: z.string().min(1),
        action: z.enum(["modify", "create", "delete"]),
        description: z.string().min(1),
      })
    )
    .min(1),
  assumptions: z.array(z.string()),
  outOfScope: z.array(z.string()),
});

const implementorResultSchema = z.object({
  status: z.enum(["completed", "blocked"]),
  stepId: z.string().min(1),
  diff: z.string(),
  filesChanged: z.array(z.string().min(1)),
  blockedReason: z.string(),
  escalation: z.string(),
});

interface AgentRunOptions {
  maxPlanRetries: number;
  maxImplementorRetries: number;
  maxReviewRetries: number;
  testCommand: string;
  testFramework: string;
}

interface StepOutput<T> {
  step: string;
  ok: boolean;
  value?: T;
  error?: string;
  diagnostic?: {
    stepId?: string;
    file?: string;
    diff?: string;
  };
}

interface StepStartOutput {
  step: string;
  status: "started";
}

const getAgentModel = (agent: "planner" | "implementor" | "reviewer" | "tester") => {
  const shared = process.env.OPENAI_MODEL;
  if (agent === "planner") {
    return process.env.OPENAI_PLANNER_MODEL ?? shared ?? "gpt-5-nano";
  }
  if (agent === "implementor") {
    return process.env.OPENAI_IMPLEMENTOR_MODEL ?? shared ?? "gpt-5";
  }
  if (agent === "reviewer") {
    return process.env.OPENAI_REVIEWER_MODEL ?? shared ?? "gpt-5";
  }
  return process.env.OPENAI_TESTER_MODEL ?? shared ?? "gpt-5";
};

export const stepStartLine = (
  agent: "planner" | "implementor" | "reviewer" | "tester"
) => `Step: ${agent} - started (model=${getAgentModel(agent)})`;

export const defaultAgentRunOptions: AgentRunOptions = {
  maxPlanRetries: 2,
  maxImplementorRetries: 3,
  maxReviewRetries: 3,
  testCommand: "bunx vitest",
  testFramework: "vitest",
};

export const readPlanFile = async (path: string): Promise<Plan> => {
  const raw = await readJson(path);
  return planSchema.parse(raw);
};

export const readImplementorResultFile = async (
  path: string
): Promise<ImplementorResult> => {
  const raw = await readJson(path);
  return implementorResultSchema.parse(raw);
};

export const resolveRunDir = async (runDir?: string) => {
  if (runDir) {
    return resolve(runDir);
  }

  const latest = await getLatestRunDir();
  if (!latest) {
    throw new Error("No runs found under .orchestrator/runs.");
  }
  return resolve(latest);
};

export const readRunHandoffFile = async (path: string): Promise<RunHandoff> => {
  const raw = await readJson(path);
  if (!isRunHandoff(raw)) {
    throw new Error("handoff.json is missing required fields.");
  }
  return raw;
};

export const toStepOutput = <T>(
  step: string,
  result: {
    ok: boolean;
    value?: T;
    error?: string;
    diagnostic?: {
      stepId?: string;
      file?: string;
      diff?: string;
    };
  }
): StepOutput<T> => ({
  step,
  ok: result.ok,
  value: result.value,
  error: result.error,
  diagnostic: result.diagnostic,
});

export const successOutput = <T>(step: string, value: T): StepOutput<T> => ({
  step,
  ok: true,
  value,
});

export const errorOutput = (step: string, error: string): StepOutput<never> => ({
  step,
  ok: false,
  error,
});

export const stepStartOutput = (step: string): StepStartOutput => ({
  step,
  status: "started",
});
