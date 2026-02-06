import OpenAI from "openai";
import type {
  TesterAgent,
  TesterAgentOptions,
  TesterInput,
  TesterResult,
} from "./tester.types";
import {
  determineTestStrategy,
  runTests,
  validateImplementorOutput,
  validateTestChanges,
  validateTesterInput,
  validateTesterOutput,
} from "./tester.validators";

const DEFAULT_SYSTEM_PROMPT_PATH = "agents/tester/tester.system.md";
const DEFAULT_DEVELOPER_PROMPT_PATH = "agents/tester/tester.developer.md";

const RESULT_JSON_SCHEMA: Record<string, unknown> = {
  name: "TesterResult",
  type: "object",
  additionalProperties: false,
  required: [
    "task_id",
    "status",
    "tests_added",
    "test_summary",
    "coverage_notes",
    "reason",
    "logs",
  ],
  properties: {
    task_id: { type: "string" },
    status: { type: "string", enum: ["passed", "failed"] },
    tests_added: { type: "array", items: { type: "string" } },
    test_summary: { type: "string" },
    coverage_notes: { type: "array", items: { type: "string" } },
    reason: { type: "string" },
    logs: { type: "string" },
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

const buildUserInput = (input: TesterInput) => {
  const strategy = determineTestStrategy(input);
  const payload = {
    input,
    strategy,
  };
  return JSON.stringify(payload, null, 2);
};

const buildFailedResult = (taskId: string, reason: string, logs: string): TesterResult => ({
  task_id: taskId,
  status: "failed",
  tests_added: [],
  test_summary: "",
  coverage_notes: [],
  reason,
  logs,
});

const createTesterAgent = (
  options: TesterAgentOptions = {}
): TesterAgent => {
  const model =
    options.model ??
    process.env.OPENAI_TESTER_MODEL ??
    process.env.OPENAI_MODEL ??
    "gpt-5";
  const systemPromptPath = options.systemPromptPath ?? DEFAULT_SYSTEM_PROMPT_PATH;
  const developerPromptPath =
    options.developerPromptPath ?? DEFAULT_DEVELOPER_PROMPT_PATH;

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  const test = async (rawInput: TesterInput): Promise<TesterResult> => {
    const validated = validateTesterInput(rawInput);
    if (!validated.ok || !validated.value) {
      return buildFailedResult("UNKNOWN", validated.errors.join(" "), "");
    }

    const input = validated.value;
    const taskId = input.handoff.task.id;

    const outputValidation = validateImplementorOutput(input.implementor_result);
    if (!outputValidation.ok) {
      return buildFailedResult(taskId, outputValidation.errors.join(" "), "");
    }

    const systemPrompt = await readPrompt(systemPromptPath);
    const developerPrompt = await readPrompt(developerPromptPath);
    const userInput = buildUserInput(input);

    const response = await openai.responses.create({
      model,
      instructions: systemPrompt,
      input: [
        { role: "developer", content: developerPrompt },
        { role: "user", content: userInput },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "TesterResult",
          schema: RESULT_JSON_SCHEMA,
          strict: true,
        },
      },
    });

    const outputText = response.output_text;
    if (!outputText) {
      return buildFailedResult(taskId, "Tester returned empty output.", "");
    }

    const parsed = validateTesterOutput(JSON.parse(outputText));
    if (!parsed.ok || !parsed.value) {
      return buildFailedResult(taskId, parsed.errors.join(" "), "");
    }

    if (parsed.value.status === "failed") {
      return parsed.value;
    }

    const testRun = await runTests(input.test_command, input.repo_root);
    if (!testRun.ok) {
      return buildFailedResult(taskId, "Tests failed to pass.", testRun.logs);
    }

    const diffValidation = validateTestChanges(parsed.value.tests_added);
    if (!diffValidation.ok) {
      return buildFailedResult(taskId, diffValidation.errors.join(" "), "");
    }

    const finalValidation = validateTesterOutput(parsed.value);
    if (!finalValidation.ok || !finalValidation.value) {
      return buildFailedResult(taskId, finalValidation.errors.join(" "), "");
    }

    return finalValidation.value;
  };

  return { test };
};

export { createTesterAgent, buildFailedResult };
