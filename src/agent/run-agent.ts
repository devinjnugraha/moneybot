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
// Gemini tool-name normalization
// ---------------------------------------------------------------------------

/**
 * Gemini via OpenRouter sometimes emits tool-call names with a namespace
 * prefix ("default_api.set_accounts_mode") — Gemini's default API namespace
 * leaking through the OpenAI-compat translation. The SDK looks the literal
 * name up in `tools` and throws NoSuchToolError, killing the whole run. None
 * of our tool names contain a dot, so stripping this prefix can never corrupt
 * a real name.
 */
const GEMINI_TOOL_NAMESPACE = 'default_api.'

function stripToolNamespace (name: string): string {
  return name.startsWith(GEMINI_TOOL_NAMESPACE)
    ? name.slice(GEMINI_TOOL_NAMESPACE.length)
    : name
}

/** Wrap a model so tool-call names come back namespace-free (both call modes). */
export function withNormalizedToolNames (model: LanguageModel): LanguageModel {
  return {
    ...model,
    async doGenerate (...args: Parameters<LanguageModel['doGenerate']>) {
      const response = await model.doGenerate(...args)
      response.toolCalls?.forEach((call) => {
        call.toolName = stripToolNamespace(call.toolName)
      })
      return response
    },
    async doStream (...args: Parameters<LanguageModel['doStream']>) {
      const { stream, ...rest } = await model.doStream(...args)
      return {
        ...rest,
        stream: stream.pipeThrough(
          // Stream part type kept minimal (structural, no provider import):
          // only the tool-call variant carries a toolName.
          new TransformStream<{ type: string, toolName?: string }, { type: string, toolName?: string }>({
            transform (part, controller) {
              controller.enqueue(
                part.type === 'tool-call' && part.toolName
                  ? { ...part, toolName: stripToolNamespace(part.toolName) }
                  : part
              )
            }
          })
        ) as typeof stream
      }
    }
  }
}

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
  const normalizedModel = withNormalizedToolNames(model)
  return async ({ system, messages, tools, maxSteps }) => {
    const result = await generateText({
      model: normalizedModel,
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
