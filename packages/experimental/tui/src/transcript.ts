/**
 * Project durable Session events onto transcript items. The same projector
 * serves live updates and the replay of a resumed session, so a resumed
 * conversation reads exactly like the one that produced it.
 * @module @deepseek-ai/dsh-experimental-tui/transcript
 */

import type {} from '@deepseek-ai/dsh-compaction'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ChildStep, Item, Store, TodoEntry } from './store.ts'
import { toolTitle } from './tool-format.ts'

/** Parse raw tool-call arguments the way the executor does. */
export function parseArgs(raw: string): Record<string, unknown> {
  if (raw.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { value: parsed }
  } catch {
    return { raw }
  }
}

/** Join text blocks of a content array. */
export function joinText(blocks: readonly { type: string; text?: string }[]): string {
  return blocks
    .filter((block): block is { type: string; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

/** Whether a user message came from the human (not injected runtime context). */
export function isHumanMessage(source: unknown): boolean {
  return typeof source === 'object' && source !== null && (source as { kind?: unknown }).kind === 'user'
}

/** One nested call inside a `run_code` program, keyed by subCallId. */
interface DispatchStep extends ChildStep {
  readonly subCallId: string
}

/** Options for one projection pass. */
export interface ProjectorHooks {
  /** Thinking duration for the attempt that produced this message, when known. */
  thinkingMs?: () => number | undefined
  /** Whether user messages should be rendered (replay) or were already echoed (live). */
  renderUserMessages: boolean
  /** Call ids whose approval the user rejected. */
  deniedCalls?: ReadonlySet<string>
}

/** Strip the TUI's own @file attachment wrappers back to the typed prompt. */
export function visiblePrompt(text: string): { text: string; mentions: string[] } {
  const mentions: string[] = []
  const stripped = text.replace(/\n*<attached-file path="([^"]+)"[^>]*>[\s\S]*?<\/attached-file>/g, (_match, path: string) => {
    mentions.push(path)
    return ''
  })
  return { text: stripped.trimEnd(), mentions }
}

/**
 * Apply one durable event to the store.
 * @param store - UI store.
 * @param event - the session event.
 * @param hooks - live/replay behaviour.
 * @returns whether the event was consumed.
 */
export function projectEvent(store: Store, event: SessionEvent, hooks: ProjectorHooks): boolean {
  switch (event.type) {
    case 'user/message': {
      if (!hooks.renderUserMessages) return false
      const message = event.data
      if (!isHumanMessage(message.source)) return false
      const { text, mentions } = visiblePrompt(joinText(message.content))
      if (text === '' && mentions.length === 0) return false
      store.push({ kind: 'user', id: store.nextId('u'), text, ...mentions.length > 0 ? { mentions } : {} })
      return true
    }
    case 'assistant/message': {
      const content = event.data.message.content
      const reasoning = content.filter(block => block.type === 'reasoning').map(block => (block as { text: string }).text).join('').trim()
      const text = joinText(content).trim()
      store.update((draft) => {
        if (reasoning !== '') {
          const ms = hooks.thinkingMs?.()
          let first = true
          for (let index = draft.items.length - 1; index >= 0; index -= 1) {
            const kind = draft.items[index]?.kind
            if (kind === 'user' || kind === 'command' || kind === 'banner') break
            if (kind === 'thinking' || kind === 'assistant' || kind === 'tool') { first = false; break }
          }
          draft.items.push({ kind: 'thinking', id: store.nextId('t'), text: reasoning, ...ms === undefined ? {} : { ms }, ...first ? { first } : {} })
        }
        if (text !== '') draft.items.push({ kind: 'assistant', id: store.nextId('a'), text })
        draft.live = undefined
      })
      return true
    }
    case 'tool/call': {
      const args = parseArgs(event.data.arguments)
      const item: Item = {
        kind: 'tool',
        id: store.nextId('k'),
        callId: event.data.callId,
        name: event.data.name,
        args,
        rawArgs: event.data.arguments,
        status: 'running',
        startedAt: Date.now(),
      }
      store.push(item)
      if (event.data.name === 'todo_write') {
        const todos = args.todos
        if (Array.isArray(todos)) store.update((draft) => { draft.todos = todos as TodoEntry[] })
      }
      return true
    }
    case 'tool/result': {
      if (event.surfaceOp !== 'append') return false
      const message = event.data.message
      const callId = message.toolCallId
      const text = joinText(message.content)
      const denied = hooks.deniedCalls?.has(callId) === true
      store.update((draft) => {
        for (let index = draft.items.length - 1; index >= 0; index -= 1) {
          const item = draft.items[index]
          if (item?.kind !== 'tool' || item.callId !== callId) continue
          draft.items[index] = {
            ...item,
            status: denied ? 'denied' : message.isError === true ? 'error' : 'ok',
            result: text,
            isError: message.isError === true,
            endedAt: Date.now(),
            ...item.children === undefined ? {} : {
              children: item.children.map(child => child.status === 'running' ? { ...child, status: 'ok' as const } : child),
            },
          }
          break
        }
      })
      return true
    }
    case 'todo/write': {
      store.update((draft) => { draft.todos = event.data.todos })
      return true
    }
    case 'plan/mode': {
      store.update((draft) => {
        draft.planActive = event.data.active
        draft.planPending = false
      })
      return true
    }
    case 'permission/preset': {
      store.update((draft) => { draft.preset = event.data.preset })
      return true
    }
    case 'approval/policy': {
      store.update((draft) => { draft.approvalPolicy = event.data.policy })
      return true
    }
    case 'session/title': {
      const title = (event.data as { title?: unknown }).title
      if (typeof title === 'string') store.update((draft) => { draft.title = title })
      return true
    }
    case 'compaction/start': {
      store.update((draft) => {
        draft.toast = { text: 'Compacting conversation…', tone: 'info', at: Date.now() }
      })
      return true
    }
    case 'compaction/summary': {
      store.push({
        kind: 'compacted',
        id: store.nextId('c'),
        text: `Conversation compacted · ${String(event.data.shadowedTokenCount)} tokens summarized`,
      })
      return true
    }
    case 'compaction/end': {
      if (event.data.error !== undefined) {
        store.push({ kind: 'notice', id: store.nextId('n'), tone: 'error', text: `Compaction failed: ${event.data.error}` })
      }
      store.update((draft) => { draft.toast = undefined })
      return true
    }
    case 'tool/ptc-dispatch-start': {
      const data = event.data
      const step: DispatchStep = {
        subCallId: data.subCallId,
        label: dispatchLabel(data.name, data.arguments),
        status: 'running',
      }
      store.update((draft) => {
        const index = findTool(draft.items, data.rootCallId)
        const item = index < 0 ? undefined : draft.items[index]
        if (item?.kind !== 'tool') return
        draft.items[index] = { ...item, children: [...item.children ?? [], step] }
      })
      // A program can keep the checklist too; mirror it like a top-level call.
      const todos = (data.arguments as { todos?: unknown } | null)?.todos
      if (data.name === 'todo_write' && Array.isArray(todos)) store.update((draft) => { draft.todos = todos as TodoEntry[] })
      return true
    }
    case 'tool/ptc-dispatch': {
      const data = event.data
      store.update((draft) => {
        const index = findTool(draft.items, data.rootCallId)
        const item = index < 0 ? undefined : draft.items[index]
        if (item?.kind !== 'tool' || item.children === undefined) return
        const children = item.children.map(child => isDispatch(child) && child.subCallId === data.subCallId
          ? { ...child, status: data.isError ? 'error' as const : 'ok' as const }
          : child)
        draft.items[index] = { ...item, children }
      })
      return true
    }
    case 'turn/end': {
      const reason = event.data.reason
      store.update((draft) => {
        draft.live = undefined
        if (reason.kind === 'aborted') {
          draft.items.push({ kind: 'notice', id: store.nextId('n'), tone: 'error', text: 'Interrupted by user', detail: 'What should DeepSeek do instead?' })
        } else if (reason.kind === 'error') {
          const failure = (reason as { error?: { code?: string; message?: string } }).error
          draft.items.push({
            kind: 'notice', id: store.nextId('n'), tone: 'error',
            text: `${failure?.code ?? 'ERROR'}: ${failure?.message ?? 'the turn failed'}`,
          })
        } else if (reason.kind === 'blocked') {
          draft.items.push({ kind: 'notice', id: store.nextId('n'), tone: 'warn', text: 'Turn blocked by a policy hook' })
        }
        // Any tool still marked running when its turn ended was cancelled.
        draft.items = draft.items.map(item => item.kind === 'tool' && (item.status === 'running' || item.status === 'waiting')
          ? { ...item, status: 'cancelled', endedAt: Date.now() }
          : item)
      })
      return true
    }
    default:
      return false
  }
}

function isDispatch(step: ChildStep): step is DispatchStep {
  return 'subCallId' in step
}

function findTool(items: readonly Item[], callId: string): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item?.kind === 'tool' && item.callId === callId) return index
  }
  return -1
}

/** `Read(src/limiter.js)` style label for one nested dispatch. */
function dispatchLabel(name: string, args: unknown): string {
  const record = args !== null && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {}
  return toolTitle(name, record)
}
