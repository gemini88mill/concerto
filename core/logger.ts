import chalk from "chalk";

interface LogOptions {
  scope?: string;
  data?: unknown;
}

interface Logger {
  success: (message: string, options?: LogOptions) => void;
  info: (message: string, options?: LogOptions) => void;
  warn: (message: string, options?: LogOptions) => void;
  error: (message: string, options?: LogOptions) => void;
}

const formatData = (data: unknown): string => {
  if (data === undefined) {
    return "";
  }
  if (data instanceof Error) {
    return data.stack ?? data.message;
  }
  if (typeof data === "string") {
    return data;
  }
  if (typeof data === "number" || typeof data === "boolean") {
    return String(data);
  }
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return "Unable to serialize log data.";
  }
};

const formatLine = (
  label: string,
  color: (value: string) => string,
  message: string,
  options?: LogOptions
) => {
  const timestamp = new Date().toLocaleString();
  const scope = options?.scope ? ` ${chalk.gray(`[${options.scope}]`)}` : "";
  const data = formatData(options?.data);
  const base = `${chalk.gray(timestamp)} ${color(label)}${scope} ${message}`;
  if (data.length === 0) {
    return base;
  }
  return `${base}\n${data}`;
};

const formatInfoLine = (message: string, options?: LogOptions) => {
  const timestamp = new Date().toLocaleString();
  const scope = options?.scope ? ` ${chalk.gray(`[${options.scope}]`)}` : "";
  const data = formatData(options?.data);
  const base = `${chalk.gray(timestamp)}${scope} ${message}`;
  if (data.length === 0) {
    return base;
  }
  return `${base}\n${data}`;
};

const formatWarnLine = (message: string, options?: LogOptions) => {
  const timestamp = new Date().toLocaleString();
  const scope = options?.scope ? ` [${options.scope}]` : "";
  const data = formatData(options?.data);
  const base = `${chalk.gray(timestamp)} ${chalk.yellowBright(
    `⚠${scope} ${message}`
  )}`;
  if (data.length === 0) {
    return base;
  }
  return `${base}\n${chalk.yellowBright(data)}`;
};

const writeLog = (
  level: "success" | "info" | "warn" | "error",
  message: string,
  options?: LogOptions
) => {
  if (level === "success") {
    console.log(
      formatLine("SUCCESS", chalk.greenBright, message, options)
    );
    return;
  }
  if (level === "info") {
    console.log(formatInfoLine(message, options));
    return;
  }
  if (level === "warn") {
    console.warn(formatWarnLine(message, options));
    return;
  }
  console.error(formatLine("ERROR", chalk.redBright, message, options));
};

export const logger: Logger = {
  success: (message, options) => writeLog("success", message, options),
  info: (message, options) => writeLog("info", message, options),
  warn: (message, options) => writeLog("warn", message, options),
  error: (message, options) => writeLog("error", message, options),
};
