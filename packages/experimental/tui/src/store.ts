/**
 * UI state for the TUI: a transcript of settled and in-flight items plus the
 * live session status. The store is a tiny external store consumed through
 * `useSyncExternalStore`, so the harness bridge can update it from Cordis
 * event listeners without touching React.
 * @module @deepseek-ai/dsh-experimental-tui/store
 */

/** A todo entry, mirrored from `todo/write`. */
export interface TodoEntry {
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed'
}

/** A nested progress line under a subagent tool block. */
export interface ChildStep {
  readonly label: string
  readonly status: 'running' | 'ok' | 'error'
}

/** Tool block lifecycle. */
export type ToolStatus = 'running' | 'ok' | 'error' | 'denied' | 'cancelled' | 'waiting'

/** One transcript item. */
export type Item =
  | { readonly kind: 'banner'; readonly id: string }
  | { readonly kind: 'user'; readonly id: string; readonly text: string; readonly mentions?: readonly string[]; readonly steered?: boolean }
  | { readonly kind: 'assistant'; readonly id: string; readonly text: string }
  | { readonly kind: 'thinking'; readonly id: string; readonly text: string; readonly ms?: number; readonly first?: boolean }
  | {
    readonly kind: 'tool'
    readonly id: string
    readonly callId: string
    readonly name: string
    readonly args: Record<string, unknown>
    readonly rawArgs: string
    status: ToolStatus
    result?: string
    isError?: boolean
    readonly startedAt: number
    endedAt?: number
    children?: ChildStep[]
    note?: string
    /** Zero-based line where an edit landed, for real line numbers in diffs. */
    lineOffset?: number
  }
  | { readonly kind: 'todos'; readonly id: string; readonly todos: readonly TodoEntry[] }
  | { readonly kind: 'notice'; readonly id: string; readonly tone: 'info' | 'warn' | 'error' | 'success' | 'muted'; readonly text: string; readonly detail?: string }
  | { readonly kind: 'command'; readonly id: string; readonly line: string; readonly ok: boolean; readonly output?: string; readonly markdown?: boolean; readonly pending?: boolean }
  | { readonly kind: 'shell'; readonly id: string; readonly command: string; readonly output: string; readonly code: number | null }
  | { readonly kind: 'memory'; readonly id: string; readonly text: string; readonly file: string }
  | { readonly kind: 'compacted'; readonly id: string; readonly text: string }

/** A picker row. */
export interface PickerOption {
  readonly label: string
  readonly value: string
  readonly description?: string
  readonly current?: boolean
  readonly badge?: string
}

/** Modal requests that take over the input area. */
export type Overlay =
  | {
    readonly kind: 'approval'
    readonly id: string
    readonly toolName: string
    readonly args: Record<string, unknown> | undefined
    readonly reason: string | undefined
    readonly resolve: (choice: 'once' | 'always' | 'reject') => void
  }
  | {
    readonly kind: 'question'
    readonly id: string
    readonly questions: readonly QuestionSpec[]
    readonly resolve: (answers: readonly QuestionAnswer[] | undefined) => void
  }
  | {
    readonly kind: 'picker'
    readonly id: string
    readonly title: string
    readonly hint?: string
    readonly options: readonly PickerOption[]
    readonly resolve: (value: string | undefined) => void
  }

/** One question from `user-questions/request`. */
export interface QuestionSpec {
  readonly id: string
  readonly question: string
  readonly header?: string
  readonly detail?: string
  readonly options: readonly { label: string; description?: string }[]
  readonly multiSelect: boolean
  readonly planReview?: { readonly approve: string }
}

/** One answer for {@link QuestionSpec}. */
export interface QuestionAnswer {
  readonly id: string
  readonly selected: string[]
  readonly custom?: string
}

/** Live streaming state of the current Assistant attempt. */
export interface LiveAttempt {
  reasoning: string
  text: string
  readonly startedAt: number
  reasoningEndedAt?: number
  toolName?: string
}

/** Model route shown in the status line. */
export interface ModelRoute {
  readonly provider: string
  readonly model: string
  readonly effort?: string
}

/** Whole UI state. */
export interface UiState {
  phase: 'booting' | 'ready' | 'fatal'
  fatal?: string
  items: Item[]
  /** Items already handed to Ink's <Static>; only an unsettled head blocks it. */
  flushed: number
  /** Bumped when the transcript must be reprinted from scratch. */
  epoch: number
  live: LiveAttempt | undefined
  running: boolean
  turnStartedAt: number | undefined
  turnOutputChars: number
  queued: string[]
  sessionId: string | undefined
  title: string | undefined
  cwd: string
  branch: string | undefined
  model: ModelRoute
  contextWindow: number | undefined
  preset: string
  presetLabel: string
  approvalPolicy: string
  planActive: boolean
  planPending: boolean
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number }
  pressure: number | undefined
  todos: readonly TodoEntry[]
  overlays: Overlay[]
  toast: { text: string; tone: 'info' | 'warn' | 'error' | 'success'; at: number } | undefined
  demo: boolean
  detail: boolean
  showTodos: boolean
  problems: number
  version: string
  goal: string | undefined
  activeSubagents: number
  jobs: number
  /** Recent sessions for the welcome banner. */
  recent: readonly { id: string; title: string | undefined; ago: string }[]
}

type Listener = () => void

/** Minimal external store. */
export class Store {
  private state: UiState
  private readonly listeners = new Set<Listener>()
  private scheduled = false
  private counter = 0

  constructor(initial: UiState) {
    this.state = initial
  }

  /** Fresh id for transcript items. */
  nextId(prefix = 'i'): string {
    this.counter += 1
    return `${prefix}${String(this.counter)}`
  }

  get(): UiState {
    return this.state
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = (): UiState => this.state

  /** Apply a mutation and notify on the next microtask (coalesces bursts). */
  update(mutate: (draft: UiState) => void): void {
    const draft: UiState = { ...this.state, items: [...this.state.items], overlays: [...this.state.overlays] }
    mutate(draft)
    draft.flushed = computeFlushed(draft.items, draft.flushed)
    this.state = draft
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      for (const listener of this.listeners) listener()
    })
  }

  /** Append an item. */
  push(item: Item): void {
    this.update((draft) => { draft.items.push(item) })
  }

  /** Replace an item by id (items are treated as immutable by the UI). */
  patch(id: string, change: (item: Item) => Item): void {
    this.update((draft) => {
      const index = draft.items.findIndex(item => item.id === id)
      if (index < 0) return
      const current = draft.items[index]
      if (current !== undefined) draft.items[index] = change(current)
    })
  }
}

/** Whether an item may be printed permanently. */
export function isSettled(item: Item): boolean {
  if (item.kind === 'tool') return item.status !== 'running' && item.status !== 'waiting'
  if (item.kind === 'command') return item.pending !== true
  return true
}

/** Advance the flushed pointer over settled items. */
export function computeFlushed(items: readonly Item[], flushed: number): number {
  let next = Math.min(flushed, items.length)
  while (next < items.length) {
    const item = items[next]
    if (item === undefined || !isSettled(item)) break
    next += 1
  }
  return next
}

/** Initial UI state. */
export function initialState(version: string, cwd: string): UiState {
  return {
    phase: 'booting',
    items: [{ kind: 'banner', id: 'b0' }],
    flushed: 0,
    epoch: 0,
    live: undefined,
    running: false,
    turnStartedAt: undefined,
    turnOutputChars: 0,
    queued: [],
    sessionId: undefined,
    title: undefined,
    cwd,
    branch: undefined,
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    contextWindow: undefined,
    preset: 'workspace-write',
    presetLabel: 'Workspace write',
    approvalPolicy: 'ask',
    planActive: false,
    planPending: false,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    pressure: undefined,
    todos: [],
    overlays: [],
    toast: undefined,
    demo: false,
    detail: false,
    showTodos: true,
    problems: 0,
    version,
    goal: undefined,
    activeSubagents: 0,
    jobs: 0,
    recent: [],
  }
}
