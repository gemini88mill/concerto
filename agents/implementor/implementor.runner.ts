import type {
  DiffResult,
  ImplementorRunContext,
  ImplementorStep,
} from "./implementor.types";
import { createImplementorAgent } from "./implementor.agent";
import { enforceImplementorConstraints } from "./implementor.validators";

const runImplementorStep = async (
  step: ImplementorStep,
  context: ImplementorRunContext
): Promise<DiffResult> => {
  const agent = createImplementorAgent(context.options);
  const result = await agent.runStep(step, context.handoff);

  if (result.status === "completed") {
    const enforced = enforceImplementorConstraints(result, context.handoff);
    if (enforced.ok && enforced.value) {
      return { result, stats: enforced.value };
    }
  }

  return { result };
};

export { runImplementorStep };
