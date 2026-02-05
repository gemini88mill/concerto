import OpenAI from "openai";
import { z } from "zod";
import type {
  ResponseFunctionToolCall,
  ResponseInputItem,
  Tool,
} from "openai/resources/responses/responses";
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

interface ToolResult {
  ok: boolean;
  matches: string[];
  error?: string;
}

interface FindFilesInput {
  pattern: string;
}

const DEFAULT_SYSTEM_PROMPT_PATH = "agents/planner/planner.system.md";
const DEFAULT_DEVELOPER_PROMPT_PATH = "agents/planner/planner.developer.md";

const DEFAULT_IGNORED_PREFIXES = [
  ".git/",
  ".orchestrator/",
  "node_modules/",
  "dist/",
  "coverage/",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isGlobPattern = (value: string) => /[*?\[]/.test(value);

const filterMatches = (matches: string[]) =>
  matches.filter(
    (match) => !DEFAULT_IGNORED_PREFIXES.some((prefix) => match.startsWith(prefix))
  );

const findFiles = async (input: FindFilesInput): Promise<ToolResult> => {
  const trimmed = input.pattern.trim();
  if (!trimmed) {
    return { ok: false, matches: [], error: "pattern is required." };
  }

  const pattern = isGlobPattern(trimmed) ? trimmed : `**/${trimmed}`;
  const glob = new Bun.Glob(pattern);
  const matches: string[] = [];

  for await (const match of glob.scan({ cwd: "." })) {
    matches.push(match);
  }

  return { ok: true, matches: filterMatches(matches) };
};

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

const parseFindFilesInput = (value: unknown): FindFilesInput | null => {
  if (!isRecord(value) || typeof value.pattern !== "string") {
    return null;
  }
  return { pattern: value.pattern };
};

const toolDefinitions: Tool[] = [
  {
    type: "function",
    name: "find_files",
    description:
      "Find repo-relative file paths matching a filename or glob pattern.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["pattern"],
      properties: {
        pattern: { type: "string" },
      },
    },
  },
];

const executeTool = async (name: string, input: string) => {
  try {
    if (name === "find_files") {
      const parsed = parseFindFilesInput(JSON.parse(input));
      if (!parsed) {
        return { ok: false, matches: [], error: "Invalid find_files payload." };
      }
      return findFiles(parsed);
    }
    return { ok: false, matches: [], error: `Unknown tool: ${name}` };
  } catch (error) {
    return {
      ok: false,
      matches: [],
      error: error instanceof Error ? error.message : "Tool execution failed.",
    };
  }
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

  const runWithTools = async (
    systemPrompt: string,
    inputItems: ResponseInputItem[]
  ) => {
    let pendingInput: ResponseInputItem[] = inputItems;
    let iterations = 0;

    while (iterations < 6) {
      iterations += 1;
      const response = await openai.responses.create({
        model,
        instructions: systemPrompt,
        input: pendingInput,
        tools: toolDefinitions,
        text: {
          format: {
            type: "json_schema",
            name: "Plan",
            schema: planJsonSchema,
            strict: true,
          },
        },
      });

      const toolCalls = response.output.filter(
        (item): item is ResponseFunctionToolCall =>
          item.type === "function_call"
      );

      if (toolCalls.length === 0) {
        return response;
      }

      const toolOutputs: ResponseInputItem[] = [];
      for (const call of toolCalls) {
        const result = await executeTool(call.name, call.arguments);
        toolOutputs.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(result),
        });
      }

      pendingInput = [...pendingInput, ...response.output, ...toolOutputs];
    }

    throw new Error("Tool loop exceeded max iterations.");
  };

  const plan = async (rawInput: PlannerInput): Promise<Plan> => {
    const input = plannerInputSchema.parse(rawInput);
    const userPrompt = buildUserPrompt(input);
    const systemPrompt = await readPrompt(systemPromptPath);
    const developerPrompt = await readPrompt(developerPromptPath);

    const response = await runWithTools(systemPrompt, [
      { role: "developer", content: developerPrompt },
      { role: "user", content: userPrompt },
    ]);

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
