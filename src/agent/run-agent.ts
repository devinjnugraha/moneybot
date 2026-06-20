import {
  generateText,
  type LanguageModel,
  type CoreMessage,
  type CoreTool
} from 'ai'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One tool invocation record — aggregated across all ReAct steps. */
export interface ToolCallRecord {
  toolName: string
  args: unknown
  result: unknown
}

export interface AgentRunResult {
  text: string
  responseMessages: CoreMessage[]
  toolResults: ToolCallRecord[]
}

export interface RunAgentArgs {
  system: string
  messages: CoreMessage[]
  tools: Record<string, CoreTool>
  maxSteps: number
}

export type AgentRunner = (args: RunAgentArgs) => Promise<AgentRunResult>

// ---------------------------------------------------------------------------
// Production runner
// ---------------------------------------------------------------------------

/**
 * Native shape returned by executeTools() at runtime.
 * @see node_modules/ai/dist/index.js → executeTools()
 */
interface RawToolResult {
  type: 'tool-result'
  toolCallId: string
  toolName: string
  args: unknown
  result: unknown
}

/**
 * Build the production runner. The model is captured in the closure so the
 * orchestrator stays decoupled from the SDK and is unit-testable with a fake
 * runner that needs no model at all.
 */
export function createRunner (model: LanguageModel): AgentRunner {
  return async ({ system, messages, tools, maxSteps }) => {
    const result = await generateText({
      model,
      system,
      messages,
      tools,
      maxSteps
    })

    // Aggregate tool results from ALL steps, not just the last one.
    // generateText's top-level `toolResults` only holds the final step's
    // results (typically empty — the last step is the final text response).
    // Intermediate tool calls live inside `result.steps[*].toolResults`.
    const toolResults: ToolCallRecord[] = []
    const seen = new Set<string>() // dedupe by toolCallId
    for (const step of result.steps) {
      for (const tr of step.toolResults as RawToolResult[]) {
        if (seen.has(tr.toolCallId)) continue
        seen.add(tr.toolCallId)
        toolResults.push({
          toolName: tr.toolName,
          args: tr.args,
          result: tr.result
        })
      }
    }

    return {
      text: result.text,
      responseMessages: result.response.messages as CoreMessage[],
      toolResults
    }
  }
}
