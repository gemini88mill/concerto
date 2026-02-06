import OpenAI from "openai";
import type { ResponseInputItem } from "openai/resources/responses/responses";
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

const DEFAULT_SYSTEM_PROMPT_PATH = "agents/implementor/implementor.system.md";
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
    "proposed_actions",
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
    proposed_actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "path", "content"],
        properties: {
          type: { type: "string", enum: ["write_file", "delete_file"] },
          path: { type: "string" },
          content: { type: "string" },
        },
      },
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
  const model =
    options.model ??
    process.env.OPENAI_IMPLEMENTOR_MODEL ??
    process.env.OPENAI_MODEL ??
    "gpt-5";
  const systemPromptPath =
    options.systemPromptPath ?? DEFAULT_SYSTEM_PROMPT_PATH;
  const developerPromptPath =
    options.developerPromptPath ?? DEFAULT_DEVELOPER_PROMPT_PATH;

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  const runWithoutTools = async (
    systemPrompt: string,
    inputItems: ResponseInputItem[]
  ) => {
    return openai.responses.create({
      model,
      instructions: systemPrompt,
      input: inputItems,
      text: {
        format: {
          type: "json_schema",
          name: "ImplementorResult",
          schema: RESULT_JSON_SCHEMA,
          strict: true,
        },
      },
    });
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
        proposed_actions: [],
        blockedReason: validated.errors.join(" "),
        escalation: "Validate handoff input and retry.",
      };
    }

    const systemPrompt = await readPrompt(systemPromptPath);
    const developerPrompt = await readPrompt(developerPromptPath);
    const userInput = buildUserInput(step, validated.value);

    const response = await runWithoutTools(systemPrompt, [
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
        proposed_actions: [],
        blockedReason: "Implementor returned empty output.",
        escalation: "Check model output and retry.",
      };
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(outputText);
    } catch (error) {
      console.error(error);
      console.log(
        `Implementor raw output (invalid JSON): ${outputText.slice(0, 4000)}`
      );
      return {
        status: "blocked",
        stepId: step.id,
        diff: "",
        filesChanged: [],
        proposed_actions: [],
        blockedReason: "Implementor returned invalid JSON output.",
        escalation: "Fix implementor output format and retry.",
      };
    }

    const parsed = validateImplementorResult(parsedJson);
    if (!parsed.ok || !parsed.value) {
      console.log(
        `Implementor raw output (validation failed): ${outputText.slice(
          0,
          4000
        )}`
      );
      return {
        status: "blocked",
        stepId: step.id,
        diff: "",
        filesChanged: [],
        proposed_actions: [],
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
        proposed_actions: [],
        blockedReason: enforced.errors.join(" "),
        escalation: "Revise step or constraints and retry.",
      };
    }

    return parsed.value;
  };

  return { runStep };
};

export { createImplementorAgent };
