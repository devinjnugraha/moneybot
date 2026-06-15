import { generateText, type LanguageModel, type CoreMessage, type CoreTool } from 'ai';

export interface AgentRunResult {
  text: string;
  responseMessages: CoreMessage[];
  toolResults: Array<{ toolName: string; result: unknown }>;
}

export interface RunAgentArgs {
  system: string;
  messages: CoreMessage[];
  tools: Record<string, CoreTool>;
  maxSteps: number;
}

export type AgentRunner = (args: RunAgentArgs) => Promise<AgentRunResult>;

/**
 * Build the production runner. The model is captured in the closure so the
 * orchestrator stays decoupled from the SDK and is unit-testable with a fake
 * runner that needs no model at all.
 */
export function createRunner(model: LanguageModel): AgentRunner {
  return async ({ system, messages, tools, maxSteps }) => {
    const result = await generateText({ model, system, messages, tools, maxSteps });
    return {
      text: result.text,
      responseMessages: result.response.messages as CoreMessage[],
      // generateText types toolResults via a mapped conditional over TOOLS' concrete
      // keys, which collapses to `never` for the seam's generic Record<string, CoreTool>.
      // Our contract is intentionally the looser {toolName, result} shape.
      toolResults: (result.toolResults as Array<{ toolName: string; result: unknown }>).map((tr) => ({
        toolName: tr.toolName,
        result: tr.result,
      })),
    };
  };
}
