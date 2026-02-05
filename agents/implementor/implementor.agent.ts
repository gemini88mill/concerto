import OpenAI from "openai";
import type {
  ResponseFunctionToolCall,
  ResponseInputItem,
} from "openai/resources/responses/responses";
import type {
  ImplementorAgent,
  ImplementorAgentOptions,
  ImplementorHandoff,
  ImplementorResult,
  ImplementorStep,
} from "./implementor.types";
import {
  enforceImplementorConstraints,
  validateImplementorHandoff,
  validateImplementorResult,
} from "./implementor.validators";
import { executeTool, toolDefinitions } from "./implementor.tools";

const DEFAULT_SYSTEM_PROMPT_PATH =
  "agents/implementor/implementor.system.md";
const DEFAULT_DEVELOPER_PROMPT_PATH =
  "agents/implementor/implementor.developer.md";

const RESULT_JSON_SCHEMA: Record<string, unknown> = {
  name: "ImplementorResult",
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "stepId",
    "diff",
    "filesChanged",
    "blockedReason",
    "escalation",
  ],
  properties: {
    status: { type: "string", enum: ["completed", "blocked"] },
    stepId: { type: "string" },
    diff: { type: "string" },
    filesChanged: {
      type: "array",
      items: { type: "string" },
    },
    blockedReason: { type: "string" },
    escalation: { type: "string" },
  },
};

const readPrompt = async (path: string) => {
  const file = Bun.file(path);
  const exists = await file.exists();
  if (!exists) {
    throw new Error(`Prompt file not found: ${path}`);
  }
  return file.text();
};

const buildUserInput = (step: ImplementorStep, handoff: ImplementorHandoff) => {
  const injectedFile = handoff.injected_files.find(
    (file) => file.path === step.file
  );

  const payload = {
    handoff_version: handoff.handoff_version,
    task: handoff.task,
    constraints: handoff.constraints,
    allowed_files: handoff.allowed_files,
    step,
    injected_file: injectedFile ?? null,
  };

  return JSON.stringify(payload, null, 2);
};

const createImplementorAgent = (
  options: ImplementorAgentOptions = {}
): ImplementorAgent => {
  const model = options.model ?? process.env.OPENAI_MODEL ?? "gpt-5";
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

    while (iterations < 8) {
      iterations += 1;
      const response = await openai.responses.create({
        model,
        instructions: systemPrompt,
        input: pendingInput,
        tools: toolDefinitions,
        text: {
          format: {
            type: "json_schema",
            name: "ImplementorResult",
            schema: RESULT_JSON_SCHEMA,
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

  const runStep = async (
    step: ImplementorStep,
    handoff: ImplementorHandoff
  ): Promise<ImplementorResult> => {
    const validated = validateImplementorHandoff(handoff);
    if (!validated.ok || !validated.value) {
      return {
        status: "blocked",
        stepId: step.id,
        diff: "",
        filesChanged: [],
        blockedReason: validated.errors.join(" "),
        escalation: "Validate handoff input and retry.",
      };
    }

    const systemPrompt = await readPrompt(systemPromptPath);
    const developerPrompt = await readPrompt(developerPromptPath);
    const userInput = buildUserInput(step, validated.value);

    const response = await runWithTools(systemPrompt, [
      {
        role: "developer",
        content: developerPrompt,
      },
      {
        role: "user",
        content: userInput,
      },
    ]);

    const outputText = response.output_text;
    if (!outputText) {
      return {
        status: "blocked",
        stepId: step.id,
        diff: "",
        filesChanged: [],
        blockedReason: "Implementor returned empty output.",
        escalation: "Check model output and retry.",
      };
    }

    const parsed = validateImplementorResult(JSON.parse(outputText));
    if (!parsed.ok || !parsed.value) {
      return {
        status: "blocked",
        stepId: step.id,
        diff: "",
        filesChanged: [],
        blockedReason: parsed.errors.join(" "),
        escalation: "Fix implementor output format and retry.",
      };
    }

    const enforced = enforceImplementorConstraints(parsed.value, handoff);
    if (!enforced.ok) {
      return {
        status: "blocked",
        stepId: step.id,
        diff: "",
        filesChanged: [],
        blockedReason: enforced.errors.join(" "),
        escalation: "Revise step or constraints and retry.",
      };
    }

    return parsed.value;
  };

  return { runStep };
};

export { createImplementorAgent };
