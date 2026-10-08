/**
 * The scripted demo model. It is registered as an ordinary `ctx.llm` adapter
 * under its own provider route, so everything downstream — the agent loop,
 * real tools, sandbox, approvals, questions, persistence, token metering — runs
 * exactly as with a real provider. Only the model's choices are scripted.
 * @module @deepseek-ai/dsh-experimental-tui/demo/adapter
 */

import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock, GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk, TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { planReply, type DemoReply } from './brain.ts'

/** Provider route the demo adapter owns. */
export const DEMO_PROVIDER = 'dsh-tui-demo'

/** The single scripted model id. */
export const DEMO_MODEL = 'scripted-v1'

/** Pacing knobs, in milliseconds per streamed piece. */
export interface DemoPacing {
  readonly reasoning: number
  readonly text: number
  readonly tool: number
  readonly firstToken: number
}

const DEFAULT_PACING: DemoPacing = scaled({ reasoning: 26, text: 15, tool: 6, firstToken: 450 })

/** Split text into small word-ish pieces so it streams like tokens. */
export function tokenize(text: string): string[] {
  const pieces = text.match(/\s*\S{1,6}|\s+/g)
  return pieces ?? []
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Rough character-based token estimate, matching the meter's heuristic. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

function requestChars(options: GenerateOptions): number {
  let chars = (options.system ?? '').length
  for (const message of options.messages) {
    for (const block of message.content) {
      if (block.type === 'text' || block.type === 'reasoning') chars += block.text.length
      else if (block.type === 'tool-call') chars += block.arguments.length + block.name.length
    }
  }
  for (const tool of options.tools ?? []) chars += JSON.stringify(tool.parameters).length + tool.description.length
  return chars
}

/** Scale pacing by `DSH_TUI_DEMO_SPEED` (2 = twice as fast; tests use a large value). */
function scaled(pacing: DemoPacing): DemoPacing {
  const speed = Number(process.env.DSH_TUI_DEMO_SPEED ?? '1')
  const factor = Number.isFinite(speed) && speed > 0 ? 1 / speed : 1
  return {
    reasoning: pacing.reasoning * factor,
    text: pacing.text * factor,
    tool: pacing.tool * factor,
    firstToken: pacing.firstToken * factor,
  }
}

let callCounter = 0

/** The scripted adapter. */
export class DemoLlmAdapter extends LlmAdapter {
  private warm = false

  constructor(private readonly pacing: DemoPacing = DEFAULT_PACING) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Demo (scripted)' }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{
      provider,
      id: DEMO_MODEL,
      name: 'Scripted demo model',
      description: 'Offline scripted model that drives real harness tools',
    }])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: 'Scripted demo model',
      context: { contextWindow: 128_000 },
      reasoning: {
        efforts: [
          { id: 'low' as never, name: 'Low' },
          { id: 'high' as never, name: 'High' },
          { id: 'max' as never, name: 'Max' },
        ],
        defaultEffort: 'high' as never,
      },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const signal = options.signal
    const reply: DemoReply = planReply(options)
    await sleep(reply.delayMs ?? this.pacing.firstToken, signal)
    let index = 0
    let outputChars = 0
    if (reply.reasoning !== undefined && reply.reasoning !== '') {
      const blockIndex = index++
      yield { type: 'block-start', index: blockIndex, blockType: 'reasoning' }
      for (const piece of tokenize(reply.reasoning)) {
        await sleep(this.pacing.reasoning, signal)
        yield { type: 'reasoning-delta', index: blockIndex, text: piece }
      }
      outputChars += reply.reasoning.length
      yield { type: 'block-end', index: blockIndex, block: { type: 'reasoning', text: reply.reasoning } }
    }
    if (reply.text !== undefined && reply.text !== '') {
      const blockIndex = index++
      yield { type: 'block-start', index: blockIndex, blockType: 'text' }
      for (const piece of tokenize(reply.text)) {
        await sleep(this.pacing.text, signal)
        yield { type: 'text-delta', index: blockIndex, text: piece }
      }
      outputChars += reply.text.length
      yield { type: 'block-end', index: blockIndex, block: { type: 'text', text: reply.text } }
    }
    for (const call of reply.toolCalls ?? []) {
      const blockIndex = index++
      callCounter += 1
      const id = ToolCallId(`call_demo_${Date.now().toString(36)}_${String(callCounter)}`)
      const args = JSON.stringify(call.args)
      yield { type: 'block-start', index: blockIndex, blockType: 'tool-call' }
      const pieces = args.match(/.{1,12}/gs) ?? [args]
      let first = true
      for (const piece of pieces) {
        await sleep(this.pacing.tool, signal)
        yield first
          ? { type: 'tool-call-delta', index: blockIndex, id, name: call.name, argumentsDelta: piece }
          : { type: 'tool-call-delta', index: blockIndex, id, argumentsDelta: piece }
        first = false
      }
      outputChars += args.length
      const block: ContentBlock = { type: 'tool-call', id, name: call.name, arguments: args }
      yield { type: 'block-end', index: blockIndex, block }
    }
    const inputTokens = estimateTokens('x'.repeat(requestChars(options)))
    const usage: TokenUsage = {
      inputTokens,
      outputTokens: estimateTokens('x'.repeat(outputChars)),
      cacheReadTokens: this.warm ? Math.floor(inputTokens * 0.86) : 0,
      cacheWriteTokens: 0,
      reasoningTokens: estimateTokens(reply.reasoning ?? ''),
    }
    this.warm = true
    yield { type: 'usage', usage }
    yield { type: 'finish', reason: (reply.toolCalls?.length ?? 0) > 0 ? { kind: 'tool-calls' } : { kind: 'stop' } }
  }
}
