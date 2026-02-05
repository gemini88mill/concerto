import OpenAI from "openai";
import type {
  ReviewerAgent,
  ReviewerAgentOptions,
  ReviewerDecisionResult,
  ReviewerInput,
} from "./reviewer.types";
import {
  checkReviewerConstraints,
  handleReviewerDecision,
  validateImplementorOutput,
  validateReviewerInput,
  validateReviewerOutput,
  verifyIntent,
  verifyPatterns,
} from "./reviewer.validators";

const DEFAULT_SYSTEM_PROMPT_PATH = "agents/reviewer/reviewer.system.md";
const DEFAULT_DEVELOPER_PROMPT_PATH = "agents/reviewer/reviewer.developer.md";

const RESULT_JSON_SCHEMA: Record<string, unknown> = {
  name: "ReviewerDecision",
  type: "object",
  additionalProperties: false,
  required: [
    "task_id",
    "decision",
    "notes",
    "required_actions",
    "reasons",
    "reason",
    "suggested_escalation",
  ],
  properties: {
    task_id: { type: "string" },
    decision: { type: "string", enum: ["approved", "rejected", "blocked"] },
    notes: { type: "array", items: { type: "string" } },
    required_actions: { type: "array", items: { type: "string" } },
    reasons: { type: "array", items: { type: "string" } },
    reason: { type: "string" },
    suggested_escalation: { type: "string" },
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

const buildUserInput = (input: ReviewerInput) => {
  return JSON.stringify(input, null, 2);
};

const buildRejectedDecision = (
  taskId: string,
  reasons: string[]
): ReviewerDecisionResult => ({
  task_id: taskId,
  decision: "rejected",
  notes: [],
  required_actions: [],
  reasons,
  reason: "",
  suggested_escalation: "",
});

const buildBlockedDecision = (
  taskId: string,
  reason: string,
  escalation: string
): ReviewerDecisionResult => ({
  task_id: taskId,
  decision: "blocked",
  notes: [],
  required_actions: [],
  reasons: [],
  reason,
  suggested_escalation: escalation,
});

const buildApprovedDecision = (taskId: string): ReviewerDecisionResult => ({
  task_id: taskId,
  decision: "approved",
  notes: [],
  required_actions: [],
  reasons: [],
  reason: "",
  suggested_escalation: "",
});

const createReviewerAgent = (
  options: ReviewerAgentOptions = {}
): ReviewerAgent => {
  const model = options.model ?? process.env.OPENAI_MODEL ?? "gpt-5";
  const systemPromptPath = options.systemPromptPath ?? DEFAULT_SYSTEM_PROMPT_PATH;
  const developerPromptPath =
    options.developerPromptPath ?? DEFAULT_DEVELOPER_PROMPT_PATH;

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  const review = async (rawInput: ReviewerInput): Promise<ReviewerDecisionResult> => {
    const validated = validateReviewerInput(rawInput);
    if (!validated.ok || !validated.value) {
      return buildRejectedDecision("UNKNOWN", validated.errors);
    }

    const input = validated.value;
    const taskId = input.handoff.task.id;

    if (input.implementor_result.status === "blocked") {
      return buildBlockedDecision(
        taskId,
        input.implementor_result.blockedReason,
        input.implementor_result.escalation || "planner"
      );
    }

    const outputValidation = validateImplementorOutput(input.implementor_result);
    if (!outputValidation.ok) {
      return buildRejectedDecision(taskId, outputValidation.errors);
    }

    const constraintCheck = checkReviewerConstraints(
      input.handoff,
      input.implementor_result,
      input.reviewer_constraints
    );
    if (!constraintCheck.ok) {
      return buildRejectedDecision(taskId, constraintCheck.errors);
    }

    const intentCheck = verifyIntent(input.handoff, input.implementor_result);
    if (!intentCheck.ok) {
      return buildRejectedDecision(taskId, intentCheck.errors);
    }

    const patternCheck = verifyPatterns(
      input.implementor_result,
      input.project_rules
    );
    if (!patternCheck.ok) {
      return buildRejectedDecision(taskId, patternCheck.errors);
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
          name: "ReviewerDecision",
          schema: RESULT_JSON_SCHEMA,
          strict: true,
        },
      },
    });

    const outputText = response.output_text;
    if (!outputText) {
      return buildRejectedDecision(taskId, ["Reviewer returned empty output."]);
    }

    const parsed = validateReviewerOutput(JSON.parse(outputText));
    if (!parsed.ok || !parsed.value) {
      return buildBlockedDecision(
        taskId,
        `Reviewer output invalid: ${parsed.errors.join(" ")}`,
        "rerun"
      );
    }

    return parsed.value;
  };

  return { review };
};

export { createReviewerAgent, buildApprovedDecision, buildBlockedDecision, buildRejectedDecision };
export { handleReviewerDecision };
