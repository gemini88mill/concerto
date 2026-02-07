import { extname, resolve } from "path";

interface TaskInputResult {
  task: string;
  source: "cli" | "file";
  filePath?: string;
}

interface StringMap {
  [key: string]: unknown;
}

const isRecord = (value: unknown): value is StringMap =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const findStringField = (value: StringMap, keys: string[]) => {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return "";
};

const readTaskFromJson = async (filePath: string) => {
  const text = await Bun.file(filePath).text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Invalid JSON.";
    throw new Error(`Unable to parse JSON task file: ${message}`);
  }

  if (typeof parsed === "string") {
    const trimmed = parsed.trim();
    if (trimmed.length === 0) {
      throw new Error("JSON task file is an empty string.");
    }
    return trimmed;
  }

  if (!isRecord(parsed)) {
    throw new Error("JSON task file must be a string or object.");
  }

  const direct = findStringField(parsed, ["task", "description", "prompt"]);
  if (direct.length > 0) {
    return direct;
  }

  const nestedTask = parsed["task"];
  if (isRecord(nestedTask)) {
    const nested = findStringField(nestedTask, [
      "description",
      "prompt",
      "task",
    ]);
    if (nested.length > 0) {
      return nested;
    }
  }

  throw new Error(
    "JSON task file must include a string field named task, description, or prompt."
  );
};

export const resolveTaskInput = async (
  input: string
): Promise<TaskInputResult> => {
  const ext = extname(input).toLowerCase();
  if (ext === ".md" || ext === ".json") {
    const filePath = resolve(process.cwd(), input);
    const file = Bun.file(filePath);
    if (await file.exists()) {
      if (ext === ".md") {
        const text = await file.text();
        const trimmed = text.trim();
        if (trimmed.length === 0) {
          throw new Error("Markdown task file is empty.");
        }
        return { task: trimmed, source: "file", filePath };
      }

      const task = await readTaskFromJson(filePath);
      return { task, source: "file", filePath };
    }
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error("Task input must not be empty.");
  }
  return { task: trimmed, source: "cli" };
};
