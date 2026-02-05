import OpenAI from "openai";
import { z } from "zod";
import type {
  Plan,
  PlannerAgent,
  PlannerAgentOptions,
  PlannerInput,
} from "./planner.types";

const plannerInputSchema = z.object({
  task: z.string().min(1),
  repoSummary: z.string().min(1),
  constraints: z.object({
    maxFilesPerTask: z.number().int().positive(),
    testPolicy: z.string().min(1),
    codingStandardsRef: z.string().min(1),
  }),
});

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

const planJsonSchema: Record<string, unknown> = {
  name: "Plan",
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "scope",
    "tasks",
    "allowed_files",
    "steps",
    "assumptions",
    "outOfScope",
  ],
  properties: {
    summary: { type: "string" },
    scope: {
      type: "object",
      additionalProperties: false,
      required: ["estimatedFilesChanged", "highRisk", "breakingChange"],
      properties: {
        estimatedFilesChanged: { type: "integer", minimum: 0 },
        highRisk: { type: "boolean" },
        breakingChange: { type: "boolean" },
      },
    },
    tasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "description",
          "affectedAreas",
          "estimatedFiles",
          "requiresTests",
          "handoffTo",
        ],
        properties: {
          id: { type: "string" },
          description: { type: "string" },
          affectedAreas: {
            type: "array",
            items: { type: "string" },
          },
          estimatedFiles: { type: "integer", minimum: 1 },
          requiresTests: { type: "boolean" },
          handoffTo: { type: "string", enum: ["implementer"] },
        },
      },
    },
    allowed_files: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
    },
    steps: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "file", "action", "description"],
        properties: {
          id: { type: "string" },
          file: { type: "string" },
          action: { type: "string", enum: ["modify", "create", "delete"] },
          description: { type: "string" },
        },
      },
    },
    assumptions: {
      type: "array",
      items: { type: "string" },
    },
    outOfScope: {
      type: "array",
      items: { type: "string" },
    },
  },
};

const DEFAULT_SYSTEM_PROMPT_PATH = "agents/planner/planner.system.md";
const DEFAULT_DEVELOPER_PROMPT_PATH = "agents/planner/planner.developer.md";

const readPrompt = async (path: string) => {
  const file = Bun.file(path);
  const exists = await file.exists();
  if (!exists) {
    throw new Error(`Prompt file not found: ${path}`);
  }
  return file.text();
};

const buildUserPrompt = (input: PlannerInput) => {
  const plannerInputJson = JSON.stringify(input, null, 2);
  return ["PlannerInput:", plannerInputJson].join("\n\n");
};

const parsePlan = (outputText: string) => {
  const parsed = JSON.parse(outputText);
  return planSchema.parse(parsed);
};

const createPlannerAgent = (
  options: PlannerAgentOptions = {}
): PlannerAgent => {
  const model = options.model ?? process.env.OPENAI_MODEL ?? "gpt-5-nano";
  const systemPromptPath =
    options.systemPromptPath ?? DEFAULT_SYSTEM_PROMPT_PATH;
  const developerPromptPath =
    options.developerPromptPath ?? DEFAULT_DEVELOPER_PROMPT_PATH;

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  const plan = async (rawInput: PlannerInput): Promise<Plan> => {
    const input = plannerInputSchema.parse(rawInput);
    const userPrompt = buildUserPrompt(input);
    const systemPrompt = await readPrompt(systemPromptPath);
    const developerPrompt = await readPrompt(developerPromptPath);

    const response = await openai.responses.create({
      model,
      instructions: systemPrompt,
      input: [
        { role: "developer", content: developerPrompt },
        { role: "user", content: userPrompt },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "Plan",
          schema: planJsonSchema,
          strict: true,
        },
      },
    });

    const outputText = response.output_text;
    if (!outputText) {
      throw new Error("Planner returned empty output.");
    }

    return parsePlan(outputText);
  };

  return { plan };
};

export { createPlannerAgent };
export type { PlannerAgent, PlannerInput, Plan };
