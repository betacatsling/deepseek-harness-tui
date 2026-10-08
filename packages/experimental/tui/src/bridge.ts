/**
 * The harness bridge: everything the TUI does goes through real Cordis
 * services here — `ctx.agents` for the conversation, `ctx.commands` for
 * harness slash commands, the approval and user-question answerer waterfalls
 * for prompts, `ctx.llm` for the model catalog, `ctx.permissionPresets` and
 * `ctx.planMode` for modes, session projections for token usage, and
 * `ctx.sessionQuery` for resume. React components only read the store.
 * @module @deepseek-ai/dsh-experimental-tui/bridge
 */

import { writeSettings } from './settings.ts'
import type { ThemeChoice } from './terminal-theme.ts'
import { setTheme, type ThemeName, type ThemeSetting } from './theme.ts'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-plan-mode'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-tool-todo'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { DEMO_MODEL, DEMO_PROVIDER } from './demo/adapter.ts'
import { expandMentions } from './files.ts'
import { LOCAL_COMMANDS, type LocalCommand } from './local-commands.ts'
import type { LogCapture } from './log-capture.ts'
import type { Overlay, PickerOption, QuestionAnswer, QuestionSpec, Store, TodoEntry } from './store.ts'
import { projectEvent } from './transcript.ts'
import { renderTranscriptMarkdown } from './export.ts'
import { toolArgument, toolVerb } from './tool-format.ts'

/** Startup options resolved by the plugin. */
export interface BridgeOptions {
  readonly demo: boolean
  readonly demoReason: string | undefined
  readonly resume: string | undefined
  readonly continue: boolean
  readonly model: string | undefined
  readonly permission: string | undefined
  readonly prompt: string | undefined
  readonly logs: LogCapture
  readonly requestExit: (code: number) => void
  /** Startup theme resolution (see terminal-theme.ts). */
  readonly theme?: ThemeChoice
}

/** A completion entry for the slash menu. */
/** Fullscreen-mode hooks (see ui/fullscreen.tsx). */
export interface ScreenHooks {
  /** Force a full redraw of the alternate screen. */
  repaint(): void
  /** Forget scroll position, expansions and selection (after /clear). */
  reset(): void
  /** Mouse reporting on/off; returns the new state. */
  setMouse(on: boolean | undefined): boolean
  /** Copy the current transcript selection, if any. */
  copySelection(): boolean
}

export interface SlashEntry {
  readonly name: string
  readonly description: string
  readonly hint?: string
  readonly source: 'tui' | 'harness'
}

/** Whether a DeepSeek key is resolvable from any credential layer the base bundle reads. */
export function hasDeepSeekKey(dshHome: string, cwd: string): boolean {
  if ((process.env.DEEPSEEK_API_KEY ?? '').trim() !== '') return true
  const candidates = [join(dshHome, '.credentials.yaml'), join(cwd, '.env'), join(dshHome, '.env')]
  return candidates.some((file) => {
    try {
      return existsSync(file) && /DEEPSEEK_API_KEY\s*[:=]\s*\S+/.test(readFileSync(file, 'utf8'))
    } catch {
      return false
    }
  })
}

/** The Harness home the CLI uses. */
export function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

function gitBranch(cwd: string): Promise<string | undefined> {
  return new Promise((done) => {
    execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: 1500 }, (error, stdout) => {
      done(error === null ? stdout.trim() || undefined : undefined)
    })
  })
}

function sessionEvents(session: Session): SessionEvent[] {
  const events: SessionEvent[] = []
  for (let seq = 0; seq < session.seq; seq += 1) {
    // oxlint-disable-next-line typescript/no-deprecated -- whole-log replay for transcript reconstruction
    const event = session.eventAt(SessionSeq(seq))
    if (event !== undefined) events.push(event)
  }
  return events
}

const FILE_TOOLS = new Set(['read', 'write', 'edit', 'str_replace_editor', 'read_image'])

/** Bridge between the store and the harness. */
export class Bridge {
  agent: Agent | undefined
  private handle: AgentHandle | undefined
  private readonly selection: ModelSelectionRef = { current: undefined, assembled: undefined }
  private readonly denied = new Set<string>()
  private readonly alwaysAllow = new Set<string>()
  private readonly childToTool = new Map<string, string>()
  private attemptStartedAt: number | undefined
  private reasoningMs: number | undefined
  private readonly disposers: (() => void)[] = []
  readonly history: string[] = []
  /** Installed by the fullscreen UI; undefined in inline mode. */
  screen: ScreenHooks | undefined
  /** Ctrl+Z job control, installed by whichever root is mounted. */
  suspend: (() => Promise<void>) | undefined
  private themeChoice: ThemeChoice
  private historyFile: string
  readonly cwd: string

  constructor(private readonly ctx: Context, readonly store: Store, private readonly options: BridgeOptions) {
    this.themeChoice = options.theme ?? { setting: 'auto', theme: 'dark', source: 'default', detected: 'dark', detectedFrom: 'default' }
    this.cwd = process.cwd()
    this.historyFile = join(dshHome(), 'tui-history.jsonl')
    this.loadHistory()
    // React's dev profiler logs component props by walking them a few levels
    // deep and reading `$$typeof` on every value; Cordis contexts throw on
    // unknown properties. The bridge is passed as a prop, so keep everything
    // but the plain store out of enumeration.
    for (const key of Object.keys(this)) {
      if (key !== 'store') Object.defineProperty(this, key, { enumerable: false })
    }
  }

  // ---------------------------------------------------------------- lifecycle

  /** Boot: wait for the tree, pick a model, open or resume a session. */
  async start(): Promise<void> {
    await this.ctx.get('loader')?.await()
    this.installListeners()
    const branch = await gitBranch(this.cwd)
    const route = await this.initialRoute()
    this.selection.current = route
    this.store.update((draft) => {
      draft.branch = branch
      draft.model = {
        provider: route.provider,
        model: route.model,
        ...route.reasoningEffort === undefined ? {} : { effort: route.reasoningEffort },
      }
      draft.demo = route.provider === DEMO_PROVIDER
    })
    await this.refreshContextWindow()
    let resumeId = this.options.resume
    if (resumeId === undefined && this.options.continue) resumeId = await this.latestSessionId()
    await this.refreshRecent()
    if (resumeId !== undefined) await this.resumeSession(resumeId)
    else await this.newSession()
    if (this.options.permission !== undefined) this.setPreset(this.options.permission)
    this.store.update((draft) => { draft.phase = 'ready' })
    if (this.options.demoReason !== undefined) {
      this.notice('muted', this.options.demoReason)
    }
    if (this.options.prompt !== undefined) await this.submit(this.options.prompt)
    const timer = setInterval(() => { this.refreshMetrics() }, 1000)
    this.disposers.push(() => { clearInterval(timer) })
  }

  /** Tear down listeners and persist the session. */
  async dispose(): Promise<void> {
    for (const dispose of this.disposers.splice(0)) dispose()
    const handle = this.handle
    this.handle = undefined
    if (handle !== undefined) {
      try {
        await this.ctx.get('sessions')?.flush(handle.agent.session)
      } catch (error: unknown) {
        void error
      }
    }
  }

  private async initialRoute(): Promise<ModelSelection> {
    if (this.options.model !== undefined) {
      const parsed = await this.parseRoute(this.options.model)
      if (parsed !== undefined) return parsed
    }
    if (this.options.demo) return { provider: DEMO_PROVIDER, model: DEMO_MODEL, reasoningEffort: 'high' as ReasoningEffortId }
    const selection = this.ctx.get('agentDefaultModel')?.currentSelection()
    if (selection !== undefined) return { ...selection }
    return { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
  }

  private async parseRoute(spec: string): Promise<ModelSelection | undefined> {
    const llm = this.ctx.get('llm')
    if (llm === undefined) return undefined
    const slash = spec.indexOf('/')
    if (slash > 0) return { provider: spec.slice(0, slash), model: spec.slice(slash + 1) }
    for (const provider of llm.listProviders()) {
      const models = await llm.listModels(provider.id).catch(() => [])
      if (models.some(model => model.id === spec)) return { provider: provider.id, model: spec }
    }
    return undefined
  }

  private setup = (agentCtx: Context): void => {
    installModelSelection(agentCtx, this.selection)
  }

  /** Start a fresh session (initial boot and /clear). */
  async newSession(): Promise<void> {
    const agents = this.ctx.get('agents')
    if (agents === undefined) throw new Error('the agents service is not mounted')
    const previous = this.handle
    this.handle = undefined
    if (previous !== undefined) {
      await this.ctx.get('sessions')?.flush(previous.agent.session).catch(() => undefined)
      await previous.dispose().catch(() => undefined)
    }
    const sessionId = brandString<SessionId>(`session-${randomUUID()}`)
    const route = this.selection.current
    this.handle = await agents.create({
      sessionId,
      meta: { cwd: this.cwd },
      ...route === undefined ? {} : {
        agentOptions: {
          provider: route.provider,
          model: route.model,
          ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort },
        },
      },
      setup: this.setup,
    })
    this.agent = this.handle.agent
    this.denied.clear()
    this.childToTool.clear()
    this.store.update((draft) => {
      draft.sessionId = sessionId
      draft.title = undefined
      draft.todos = []
      draft.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      draft.pressure = undefined
      draft.running = false
      draft.live = undefined
      draft.queued = []
    })
    this.refreshModes()
  }

  /** Resume a persisted session and replay its transcript. */
  async resumeSession(id: string): Promise<void> {
    const agents = this.ctx.get('agents')
    if (agents === undefined) return
    const previous = this.handle
    this.handle = undefined
    if (previous !== undefined) {
      await this.ctx.get('sessions')?.flush(previous.agent.session).catch(() => undefined)
      await previous.dispose().catch(() => undefined)
    }
    const route = this.selection.current
    try {
      this.handle = await agents.resume({
        resumeSessionId: brandString<SessionId>(id),
        ...route === undefined ? {} : { agentOptions: { provider: route.provider, model: route.model } },
        setup: this.setup,
      })
    } catch (error: unknown) {
      this.notice('error', `Could not resume ${id}: ${error instanceof Error ? error.message : String(error)}`)
      await this.newSession()
      return
    }
    this.agent = this.handle.agent
    this.store.update((draft) => {
      draft.sessionId = id
      draft.running = false
      draft.live = undefined
      draft.todos = []
    })
    const events = sessionEvents(this.handle.agent.session)
    let replayed = 0
    for (const event of events) {
      if (projectEvent(this.store, event, { renderUserMessages: true, deniedCalls: this.denied })) replayed += 1
    }
    const title = await this.readTitle(id)
    this.store.update((draft) => {
      draft.title = title ?? draft.title
      // Replayed tool calls without a result were interrupted in the old process.
      draft.items = draft.items.map(item => item.kind === 'tool' && item.status === 'running' ? { ...item, status: 'cancelled' } : item)
    })
    this.notice('muted', `Resumed ${title === undefined ? id : `“${title}”`} · ${String(replayed)} events replayed`)
    this.refreshModes()
    this.refreshMetrics()
  }

  private async readTitle(id: string): Promise<string | undefined> {
    const query = this.ctx.get('sessionQuery')
    if (query === undefined) return undefined
    try {
      const observed = await query.readTitle(brandString<SessionId>(id))
      const title = observed?.title
      return typeof title === 'string' && title.trim() !== '' ? title : undefined
    } catch {
      return undefined
    }
  }

  private async latestSessionId(): Promise<string | undefined> {
    const sessions = await this.listResumable()
    return sessions[0]?.id
  }

  /** Persisted root sessions recorded in this directory, newest first. */
  async listResumable(): Promise<{ id: string; createdAt: number; title: string | undefined }[]> {
    const query = this.ctx.get('sessionQuery')
    if (query === undefined) return []
    const records = await query.listSessions().catch(() => [])
    const rows = records
      .filter(record => record.persisted && record.header.cwd === this.cwd && record.header.origin !== 'subagent'
        && record.header.parentSession === undefined && record.header.id !== this.agent?.id)
      .sort((left, right) => right.header.createdAt - left.header.createdAt)
      .slice(0, 30)
    const titled = await Promise.all(rows.map(async record => ({
      id: record.header.id as string,
      createdAt: record.header.createdAt,
      title: await this.readTitle(record.header.id),
    })))
    return titled
  }

  // ------------------------------------------------------------- listeners

  private ownsSession(session: unknown): boolean {
    return session !== undefined && session === this.agent?.session
  }

  private installListeners(): void {
    const ctx = this.ctx
    this.disposers.push(ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      if (agent !== this.agent) return
      if (frame.type === 'start') {
        this.attemptStartedAt = Date.now()
        this.reasoningMs = undefined
        this.store.update((draft) => { draft.live = { reasoning: '', text: '', startedAt: Date.now() } })
        return
      }
      if (frame.type === 'end') {
        if (frame.outcome.kind === 'abandoned') this.store.update((draft) => { draft.live = undefined })
        return
      }
      const chunk = frame.chunk
      if (chunk.type === 'reasoning-delta') {
        this.store.update((draft) => {
          if (draft.live === undefined) return
          draft.live = { ...draft.live, reasoning: draft.live.reasoning + chunk.text }
          draft.turnOutputChars += chunk.text.length
        })
      } else if (chunk.type === 'text-delta') {
        if (this.reasoningMs === undefined && this.attemptStartedAt !== undefined) this.reasoningMs = Date.now() - this.attemptStartedAt
        this.store.update((draft) => {
          if (draft.live === undefined) return
          draft.live = { ...draft.live, text: draft.live.text + chunk.text, reasoningEndedAt: draft.live.reasoningEndedAt ?? Date.now() }
          draft.turnOutputChars += chunk.text.length
        })
      } else if (chunk.type === 'tool-call-delta') {
        if (this.reasoningMs === undefined && this.attemptStartedAt !== undefined) this.reasoningMs = Date.now() - this.attemptStartedAt
        const toolName = chunk.name
        this.store.update((draft) => {
          if (draft.live === undefined) return
          draft.turnOutputChars += chunk.argumentsDelta.length
          if (toolName !== undefined) draft.live = { ...draft.live, toolName, reasoningEndedAt: draft.live.reasoningEndedAt ?? Date.now() }
        })
      }
    }))

    this.disposers.push(ctx.on('session/event', (session, event) => {
      if (this.ownsSession(session)) {
        this.onOwnEvent(event)
        return
      }
      const toolItemId = this.childToTool.get((session).id)
      if (toolItemId !== undefined) this.onChildEvent(toolItemId, event)
    }))

    this.disposers.push(ctx.on('agent/status', ({ agent, status }) => {
      if (agent !== this.agent) return
      this.store.update((draft) => {
        draft.running = status === 'running'
        if (status === 'running' && draft.turnStartedAt === undefined) {
          draft.turnStartedAt = Date.now()
          draft.turnOutputChars = 0
        }
        if (status === 'idle') {
          draft.turnStartedAt = undefined
          draft.live = undefined
          draft.queued = []
        }
      })
      if (status === 'idle') this.refreshMetrics()
    }))

    this.disposers.push(ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      if (agent !== this.agent) return
      const text = message.content.map(block => block.type === 'text' ? block.text : '').join('')
      this.store.update((draft) => {
        const index = draft.queued.findIndex(queued => text.startsWith(queued))
        if (index >= 0) draft.queued = draft.queued.filter((_, i) => i !== index)
      })
    }))

    this.disposers.push(ctx.on('subagent/start', (info) => {
      const tool = [...this.store.get().items].reverse()
        .find(item => item.kind === 'tool' && item.status === 'running' && /subagent|agent|spawn|fork/.test(item.name))
      if (tool !== undefined) this.childToTool.set(info.id, tool.id)
      this.store.update((draft) => { draft.activeSubagents += 1 })
    }))
    this.disposers.push(ctx.on('subagent/end', (info) => {
      this.childToTool.delete(info.id)
      this.store.update((draft) => { draft.activeSubagents = Math.max(0, draft.activeSubagents - 1) })
    }))

    this.disposers.push(ctx.on('approval/request', (request, next) => {
      if (this.agent === undefined) return next()
      return this.askApproval(request.toolName, request.callId, request.reason ?? request.displayReason?.en, request.signal)
    }))

    this.disposers.push(ctx.on('user-questions/request', (request, next) => {
      if (this.agent === undefined) return next()
      return this.askQuestions(request.questions, request.signal)
    }))
  }

  private onOwnEvent(event: SessionEvent): void {
    projectEvent(this.store, event, {
      renderUserMessages: false,
      deniedCalls: this.denied,
      thinkingMs: () => this.reasoningMs,
    })
    if (event.type === 'tool/call' && (event.data.name === 'edit' || event.data.name === 'str_replace_editor')) {
      this.locateEdit(event.data.callId)
    }
    if (event.type === 'assistant/message' || event.type === 'turn/end' || event.type === 'goal/change') this.refreshMetrics()
    if ((event.type as string) === 'llm/retry') {
      const data = (event as unknown as { data: { retry?: number; delayMs?: number } }).data
      this.toast(`Retrying model request (attempt ${String((data.retry ?? 0) + 1)})…`, 'warn')
    }
  }

  /** Record where an edit's `old_string` sits so diffs show real line numbers. */
  private locateEdit(callId: string): void {
    const item = this.store.get().items.find(entry => entry.kind === 'tool' && entry.callId === callId)
    if (item?.kind !== 'tool') return
    const path = item.args.file_path ?? item.args.path
    const before = item.args.old_string ?? item.args.old_str
    if (typeof path !== 'string' || typeof before !== 'string' || before === '') return
    try {
      const text = readFileSync(isAbsolute(path) ? path : join(this.cwd, path), 'utf8')
      const index = text.indexOf(before)
      if (index < 0) return
      const lineOffset = text.slice(0, index).split('\n').length - 1
      this.store.patch(item.id, entry => entry.kind === 'tool' ? { ...entry, lineOffset } : entry)
    } catch (error: unknown) {
      void error
    }
  }

  private onChildEvent(toolItemId: string, event: SessionEvent): void {
    if (event.type === 'tool/call') {
      const arg = toolArgument(event.data.name, parseArgs(event.data.arguments))
      const label = `${toolVerb(event.data.name)}${arg === '' ? '' : `(${arg})`}`
      this.store.patch(toolItemId, item => item.kind === 'tool'
        ? { ...item, children: [...item.children ?? [], { label, status: 'running' }] }
        : item)
    } else if (event.type === 'tool/result' && event.surfaceOp === 'append') {
      const isError = event.data.message.isError === true
      this.store.patch(toolItemId, (item) => {
        if (item.kind !== 'tool' || item.children === undefined) return item
        const children = [...item.children]
        const index = children.findIndex(child => child.status === 'running')
        const child = children[index]
        if (child !== undefined) children[index] = { ...child, status: isError ? 'error' : 'ok' }
        return { ...item, children }
      })
    }
  }

  // ------------------------------------------------------------ prompts

  private pushOverlay(overlay: Overlay): void {
    this.store.update((draft) => { draft.overlays.push(overlay) })
  }

  private dropOverlay(id: string): void {
    this.store.update((draft) => { draft.overlays = draft.overlays.filter(overlay => overlay.id !== id) })
  }

  private askApproval(
    toolName: string, callId: string | undefined, reason: string | undefined, signal: AbortSignal | undefined,
  ): Promise<'allowed-once' | 'rejected' | 'cancelled'> {
    if (this.alwaysAllow.has(toolName)) return Promise.resolve('allowed-once')
    const tool = callId === undefined ? undefined : this.store.get().items.find(item => item.kind === 'tool' && item.callId === callId)
    const args = tool?.kind === 'tool' ? tool.args : undefined
    if (tool !== undefined) this.store.patch(tool.id, item => item.kind === 'tool' ? { ...item, status: 'waiting' } : item)
    const id = this.store.nextId('ap')
    return new Promise((done) => {
      const settle = (outcome: 'allowed-once' | 'rejected' | 'cancelled'): void => {
        signal?.removeEventListener('abort', onAbort)
        this.dropOverlay(id)
        if (tool !== undefined) {
          this.store.patch(tool.id, item => item.kind === 'tool' && item.status === 'waiting'
            ? { ...item, status: outcome === 'allowed-once' ? 'running' : 'denied' }
            : item)
        }
        done(outcome)
      }
      const onAbort = (): void => { settle('cancelled') }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pushOverlay({
        kind: 'approval', id, toolName, args, reason,
        resolve: (choice) => {
          if (choice === 'reject') {
            if (callId !== undefined) this.denied.add(callId)
            settle('rejected')
            return
          }
          if (choice === 'always') {
            this.alwaysAllow.add(toolName)
            this.toast(`${toolName} will run without asking for the rest of this session`, 'info')
          }
          settle('allowed-once')
        },
      })
    })
  }

  private askQuestions(questions: readonly AskUserQuestionItem[], signal: AbortSignal | undefined): Promise<AskUserQuestionAnswer> {
    const specs: QuestionSpec[] = questions.map(question => ({
      id: question.id,
      question: question.question,
      ...question.header === undefined ? {} : { header: question.header },
      ...question.detail === undefined ? {} : { detail: question.detail },
      options: question.options ?? [],
      multiSelect: question.multiSelect === true,
      ...question.intent?.kind === 'plan-review' ? { planReview: { approve: question.intent.approve } } : {},
    }))
    const id = this.store.nextId('q')
    return new Promise((done, fail) => {
      const onAbort = (): void => {
        this.dropOverlay(id)
        fail(signal?.reason instanceof Error ? signal.reason : new Error('question cancelled'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pushOverlay({
        kind: 'question', id, questions: specs,
        resolve: (answers: readonly QuestionAnswer[] | undefined) => {
          signal?.removeEventListener('abort', onAbort)
          this.dropOverlay(id)
          if (answers === undefined) {
            fail(new Error('the user dismissed the question'))
            return
          }
          done({
            answers: answers.map(answer => ({
              id: answer.id,
              selected: [...answer.selected],
              ...answer.custom === undefined ? {} : { custom: answer.custom },
            })),
          })
        },
      })
    })
  }

  /** Open a picker overlay and await the choice. */
  pick(title: string, options: readonly PickerOption[], hint?: string): Promise<string | undefined> {
    const id = this.store.nextId('p')
    return new Promise((done) => {
      this.pushOverlay({
        kind: 'picker', id, title, options, ...hint === undefined ? {} : { hint },
        resolve: (value) => {
          this.dropOverlay(id)
          done(value)
        },
      })
    })
  }

  // ------------------------------------------------------------ input

  /** Remember a submitted line in the persistent prompt history. */
  private remember(line: string): void {
    if (line.trim() === '' || this.history[this.history.length - 1] === line) return
    this.history.push(line)
    try {
      appendFileSync(this.historyFile, `${JSON.stringify({ line, cwd: this.cwd, at: Date.now() })}\n`)
    } catch (error: unknown) {
      void error
    }
  }

  private loadHistory(): void {
    try {
      const lines = readFileSync(this.historyFile, 'utf8').split('\n').filter(Boolean).slice(-500)
      for (const raw of lines) {
        const entry = JSON.parse(raw) as { line?: unknown; cwd?: unknown }
        if (typeof entry.line === 'string' && entry.cwd === this.cwd) this.history.push(entry.line)
      }
    } catch (error: unknown) {
      void error
    }
  }

  /** Submit one composer line. */
  async submit(raw: string): Promise<void> {
    const line = raw.replace(/\s+$/, '')
    if (line.trim() === '') return
    this.remember(line)
    if (line.startsWith('/')) {
      await this.runSlash(line)
      return
    }
    if (line.startsWith('!')) {
      await this.runShell(line.slice(1).trim())
      return
    }
    if (line.startsWith('#') && !line.startsWith('##')) {
      this.saveMemory(line.slice(1).trim())
      return
    }
    await this.sendPrompt(line)
  }

  private async sendPrompt(text: string): Promise<void> {
    const agent = this.agent
    if (agent === undefined) return
    const expanded = await expandMentions(text, this.cwd)
    const running = this.store.get().running || agent.status === 'running'
    this.store.update((draft) => {
      draft.items.push({
        kind: 'user', id: this.store.nextId('u'), text,
        ...expanded.mentions.length > 0 ? { mentions: expanded.mentions.map(m => `${m.path} (${String(m.lines)} lines)`) } : {},
        ...running ? { steered: true } : {},
      })
      if (running) draft.queued.push(text)
    })
    const message = createUserMessage({ content: [{ type: 'text', text: expanded.text }], source: { kind: 'user' } })
    if (running) agent.steer(message)
    else agent.followup(message)
  }

  /** Esc: interrupt the current turn. */
  interrupt(): boolean {
    const agent = this.agent
    if (agent === undefined || (agent.status !== 'running' && !this.store.get().running)) return false
    agent.cancel({ kind: 'user' })
    return true
  }

  private async runShell(command: string): Promise<void> {
    if (command === '') return
    const id = this.store.nextId('s')
    const output = await new Promise<{ text: string; code: number | null }>((done) => {
      const child = spawn(process.env.SHELL ?? 'bash', ['-lc', command], { cwd: this.cwd, env: process.env })
      let text = ''
      child.stdout.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
      child.stderr.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
      child.on('close', (code) => { done({ text, code }) })
      child.on('error', (error) => { done({ text: error.message, code: 127 }) })
    })
    this.store.push({ kind: 'shell', id, command, output: output.text, code: output.code })
    // The model sees the command and its output on its next request, like a
    // user who pasted it — through the logged inbox, not a hidden channel.
    this.agent?.inject(createUserMessage({
      content: [{
        type: 'text',
        text: `<user-shell-command>\n$ ${command}\n${output.text.slice(0, 20_000)}\n[exit ${String(output.code)}]\n</user-shell-command>`,
      }],
      source: { kind: 'user' },
    }))
  }

  private saveMemory(note: string): void {
    if (note === '') return
    const file = join(this.cwd, 'AGENTS.md')
    const prefix = existsSync(file) && !readFileSync(file, 'utf8').endsWith('\n') ? '\n' : ''
    appendFileSync(file, `${prefix}- ${note}\n`)
    this.store.push({ kind: 'memory', id: this.store.nextId('m'), text: note, file: relative(this.cwd, file) || 'AGENTS.md' })
  }

  // ------------------------------------------------------------ slash

  /** Local and harness commands merged for the completion menu. */
  slashEntries(): SlashEntry[] {
    const harness = this.agent === undefined ? [] : this.ctx.get('commands')?.list(this.agent) ?? []
    const harnessNames = new Set(harness.map(command => command.name))
    const entries: SlashEntry[] = []
    for (const command of LOCAL_COMMANDS) {
      if (harnessNames.has(command.name)) continue
      entries.push({ name: command.name, description: command.description, ...command.hint === undefined ? {} : { hint: command.hint }, source: 'tui' })
    }
    for (const command of harness) {
      entries.push({
        name: command.name, description: command.description,
        ...command.input?.hint === undefined ? {} : { hint: command.input.hint }, source: 'harness',
      })
    }
    return entries.sort((left, right) => left.name.localeCompare(right.name))
  }

  /** Run one slash line. */
  async runSlash(line: string): Promise<void> {
    const match = /^\/([a-z0-9_-]+)(\s[\s\S]*)?$/.exec(line)
    if (match === null) {
      this.commandOutput(line, false, 'Not a command. Commands look like /name [input].')
      return
    }
    const name = match[1] ?? ''
    const input = (match[2] ?? '').trim()
    const agent = this.agent
    const commands = this.ctx.get('commands')
    if (agent !== undefined && commands?.find(agent, name) !== undefined) {
      const controller = new AbortController()
      // The command line shows immediately; events it causes (e.g. a compaction
      // marker) land below it, and the result fills in when it settles.
      const id = this.store.nextId('x')
      this.store.push({ kind: 'command', id, line, ok: true, pending: true })
      const settle = (ok: boolean, output: string, markdown: boolean): void => {
        this.store.patch(id, item => item.kind === 'command' ? { kind: 'command', id, line, ok, output, ...markdown ? { markdown } : {} } : item)
      }
      try {
        const execution = await commands.execute(agent, line, [], controller.signal)
        if (execution === undefined) {
          settle(false, `Unknown command /${name}`, false)
          return
        }
        const result = execution.result
        settle(result.kind === 'success', result.text ?? (result.kind === 'success' ? 'Done' : 'Failed'), true)
        this.refreshModes()
      } catch (error: unknown) {
        settle(false, error instanceof Error ? error.message : String(error), false)
      }
      return
    }
    const local: LocalCommand | undefined = LOCAL_COMMANDS.find(command => command.name === name || command.aliases?.includes(name))
    if (local === undefined) {
      this.commandOutput(line, false, `Unknown command /${name} · type /help for the list`)
      return
    }
    try {
      await local.run(this, input, line)
    } catch (error: unknown) {
      this.commandOutput(line, false, error instanceof Error ? error.message : String(error))
    }
  }

  /** Render a command result block. */
  commandOutput(line: string, ok: boolean, output?: string, markdown = false): void {
    this.store.push({
      kind: 'command', id: this.store.nextId('x'), line, ok,
      ...output === undefined ? {} : { output }, ...markdown ? { markdown } : {},
    })
  }

  /** A one-line transcript notice. */
  notice(tone: 'info' | 'warn' | 'error' | 'success' | 'muted', text: string, detail?: string): void {
    this.store.push({ kind: 'notice', id: this.store.nextId('n'), tone, text, ...detail === undefined ? {} : { detail } })
  }

  /** A transient status-line toast. */
  toast(text: string, tone: 'info' | 'warn' | 'error' | 'success' = 'info'): void {
    this.store.update((draft) => { draft.toast = { text, tone, at: Date.now() } })
  }

  // ------------------------------------------------------------ features used by local commands

  context(): Context {
    return this.ctx
  }

  get logs(): LogCapture {
    return this.options.logs
  }

  exit(): void {
    this.options.requestExit(0)
  }

  /** The theme setting in force and what auto-detection found. */
  themeInfo(): { setting: ThemeSetting; theme: ThemeName; source: string; detected: ThemeName; detectedFrom: string } {
    const choice = this.themeChoice
    return { ...choice, theme: this.store.get().theme }
  }

  /**
   * Switch theme now and persist the choice in `tui.json`.
   * @param setting - auto uses the background detected at startup.
   * @returns the concrete theme applied.
   */
  applyTheme(setting: ThemeSetting): ThemeName {
    const detected = this.themeChoice.detected
    const theme = setting === 'auto' ? detected : setting
    this.themeChoice = { ...this.themeChoice, setting, theme, source: setting === 'auto' ? this.themeChoice.detectedFrom : 'config' }
    try {
      writeSettings(dshHome(), { theme: setting })
    } catch (error: unknown) {
      this.toast(`Could not save theme: ${error instanceof Error ? error.message : String(error)}`, 'warn')
    }
    setTheme(theme)
    this.store.update((draft) => { draft.theme = theme })
    this.reprint(true)
    return theme
  }

  /** Clear the screen and reprint the banner plus the given items. */
  reprint(keepItems: boolean): void {
    if (this.screen !== undefined) {
      // Fullscreen owns the alternate screen: redraw through Ink, never clear behind its back.
      if (!keepItems) this.screen.reset()
      this.screen.repaint()
    } else if (process.stdout.isTTY) {
      // Clear synchronously, in the same tick as the state change, so no React
      // commit of the new epoch can land before the clear and be wiped by it.
      process.stdout.write('\x1b[2J\x1b[3J\x1b[H')
    }
    this.store.update((draft) => {
      if (!keepItems) draft.items = [{ kind: 'banner', id: this.store.nextId('b') }]
      draft.flushed = 0
      draft.epoch += 1
    })
  }

  /** Reload the banner's "Recent activity" list. */
  async refreshRecent(): Promise<void> {
    const recent = await this.listResumable().catch(() => [])
    this.store.update((draft) => {
      draft.recent = recent.filter(session => session.title !== undefined).slice(0, 3)
        .map(session => ({ id: session.id, title: session.title, ago: ago(session.createdAt) }))
    })
  }

  async clearConversation(): Promise<void> {
    if (this.agent?.status === 'running') this.agent.cancel({ kind: 'user' })
    await this.newSession()
    await this.refreshRecent()
    this.reprint(false)
  }

  /** Model catalog across every registered provider. */
  async modelCatalog(): Promise<{ provider: string; providerName: string; id: string; name: string; description?: string }[]> {
    const llm = this.ctx.get('llm')
    if (llm === undefined) return []
    const rows: { provider: string; providerName: string; id: string; name: string; description?: string }[] = []
    for (const provider of llm.listProviders()) {
      const models = await llm.listModels(provider.id).catch(() => [])
      for (const model of models) {
        rows.push({
          provider: provider.id,
          providerName: provider.name,
          id: model.id,
          name: model.name,
          ...model.description === undefined ? {} : { description: model.description },
        })
      }
    }
    return rows
  }

  /** Switch the live session's model route; applies from the next request. */
  async setModel(provider: string, model: string, effort?: string): Promise<void> {
    const llm = this.ctx.get('llm')
    let reasoningEffort = effort as ReasoningEffortId | undefined
    if (reasoningEffort === undefined && llm !== undefined) {
      const info = await llm.resolveModelInfo(provider, model).catch(() => undefined)
      reasoningEffort = info?.reasoning?.defaultEffort
    }
    this.selection.current = { provider, model, ...reasoningEffort === undefined ? {} : { reasoningEffort } }
    this.store.update((draft) => {
      draft.model = { provider, model, ...reasoningEffort === undefined ? {} : { effort: reasoningEffort } }
      draft.demo = provider === DEMO_PROVIDER
    })
    await this.refreshContextWindow()
  }

  /** Reasoning efforts declared by the current model. */
  async efforts(): Promise<{ id: string; name: string; description?: string }[]> {
    const route = this.selection.current
    const llm = this.ctx.get('llm')
    if (route === undefined || llm === undefined) return []
    const info = await llm.resolveModelInfo(route.provider, route.model).catch(() => undefined)
    return (info?.reasoning?.efforts ?? []).map(effort => ({
      id: effort.id,
      name: effort.name,
      ...effort.description === undefined ? {} : { description: effort.description },
    }))
  }

  async setEffort(effort: string): Promise<void> {
    const route = this.selection.current
    if (route === undefined) return
    await this.setModel(route.provider, route.model, effort)
  }

  /** Persist the current route as the default for new sessions. */
  async saveDefaultModel(): Promise<boolean> {
    const route = this.selection.current
    const defaults = this.ctx.get('agentDefaultModel')
    if (route === undefined || defaults === undefined) return false
    await defaults.saveSelection(route)
    return true
  }

  private async refreshContextWindow(): Promise<void> {
    const route = this.selection.current
    const llm = this.ctx.get('llm')
    if (route === undefined || llm === undefined) return
    const info = await llm.resolveModelInfo(route.provider, route.model).catch(() => undefined)
    this.store.update((draft) => { draft.contextWindow = info?.context?.contextWindow })
  }

  /** Permission preset catalog. */
  presets(): { value: string; name: string; description?: string }[] {
    return this.ctx.get('permissionPresets')?.catalog().options ?? []
  }

  setPreset(name: string): boolean {
    const service = this.ctx.get('permissionPresets')
    const agent = this.agent
    if (service === undefined || agent === undefined) return false
    try {
      service.set(agent.session, name)
    } catch (error: unknown) {
      this.toast(error instanceof Error ? error.message : String(error), 'error')
      return false
    }
    this.refreshModes()
    return true
  }

  setPlan(active: boolean): void {
    const service = this.ctx.get('planMode')
    const agent = this.agent
    if (service === undefined || agent === undefined) return
    const outcome = service.set(agent, active)
    this.store.update((draft) => {
      if (outcome === 'committed' || outcome === 'noop') {
        draft.planActive = active
        draft.planPending = false
      } else if (outcome === 'queued') {
        draft.planPending = true
      }
    })
    this.refreshModes()
  }

  /**
   * Shift+Tab: the default preset, then plan mode on top of it, then each
   * wider preset, then back. Plan mode keeps the default preset underneath,
   * so leaving it by approving a plan still asks before escalations.
   */
  cycleMode(): void {
    const state = this.store.get()
    const available = this.presets().map(option => option.value).filter(value => value !== 'auto')
    const preferred = ['workspace-write', 'danger-full-access', 'read-only']
    const order = [...preferred.filter(value => available.includes(value)), ...available.filter(value => !preferred.includes(value))]
    const base = order[0]
    if (base === undefined) {
      this.setPlan(!state.planActive)
      return
    }
    if (state.planActive) {
      this.setPlan(false)
      this.setPreset(order[1] ?? base)
      return
    }
    const index = order.indexOf(state.preset)
    if (index <= 0) {
      if (state.preset !== base) this.setPreset(base)
      this.setPlan(true)
      return
    }
    this.setPreset(order[index + 1] ?? base)
  }

  /** Re-read mode state from the services. */
  refreshModes(): void {
    const agent = this.agent
    if (agent === undefined) return
    const presets = this.ctx.get('permissionPresets')
    const plan = this.ctx.get('planMode')?.get(agent)
    const approval = this.ctx.get('approval')
    const preset = presets?.current(agent.session)
    const option = preset === undefined ? undefined : this.presets().find(entry => entry.value === preset)
    this.store.update((draft) => {
      if (preset !== undefined) draft.preset = preset
      draft.presetLabel = option?.name ?? preset ?? draft.preset
      if (plan !== undefined) {
        draft.planActive = plan.active
        draft.planPending = plan.pending === true
      }
      if (approval !== undefined) draft.approvalPolicy = approval.overrideOf(agent.session) ?? approval.config.policy ?? 'ask'
    })
  }

  /** Token usage, context pressure, goal, jobs. */
  refreshMetrics(): void {
    const agent = this.agent
    const projections = this.ctx.get('sessionProjections')
    if (agent === undefined) return
    const usage = projections?.stateOf(agent.session, 'tokenUsage')
    const pressure = projections?.stateOf(agent.session, 'contextPressure')
    const goal = this.ctx.get('goals')?.get(agent)
    const jobs = this.ctx.get('jobs')?.list(agent.id).filter(job => job.status === 'running').length ?? 0
    this.store.update((draft) => {
      if (usage !== undefined) {
        const t = usage.totals
        draft.usage = { input: t.uncachedInputTokens, output: t.outputTokens, cacheRead: t.cacheReadTokens, cacheWrite: t.cacheWriteTokens }
      }
      draft.pressure = pressure?.pressureTokens ?? pressure?.surfaceTokens ?? draft.pressure
      if (pressure?.contextWindow !== undefined) draft.contextWindow = pressure.contextWindow
      draft.goal = goal === undefined || goal.phase === 'complete' ? undefined : `${goal.phase} · ${goal.objective}`
      draft.jobs = jobs
      draft.problems = this.options.logs.problems()
      if (draft.toast !== undefined && Date.now() - draft.toast.at > 4000) draft.toast = undefined
    })
  }

  /** Context breakdown for /context. */
  contextBreakdown(): { system: number; tools: number; messages: number } | undefined {
    const agent = this.agent
    if (agent === undefined) return undefined
    const breakdown = this.ctx.get('sessionProjections')?.stateOf(agent.session, 'contextBreakdown')
    if (breakdown === undefined) return undefined
    return { system: breakdown.breakdown.systemTokens, tools: breakdown.breakdown.toolsTokens, messages: breakdown.breakdown.messageTokens }
  }

  todos(): readonly TodoEntry[] {
    return this.store.get().todos
  }

  /** Export the visible transcript as Markdown. */
  exportTranscript(target: string | undefined): string {
    const file = target === undefined || target === ''
      ? join(this.cwd, `dsh-transcript-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.md`)
      : isAbsolute(target) ? target : resolve(this.cwd, target)
    writeFileSync(file, renderTranscriptMarkdown(this.store.get()))
    return file
  }

  /** Files touched by tools in this session, for /diff-like summaries. */
  touchedFiles(): string[] {
    const files = new Set<string>()
    for (const item of this.store.get().items) {
      if (item.kind !== 'tool' || !FILE_TOOLS.has(item.name) || item.name === 'read') continue
      const path = item.args.file_path ?? item.args.path
      if (typeof path === 'string') files.add(path)
    }
    return [...files].filter((file) => {
      try {
        return statSync(isAbsolute(file) ? file : join(this.cwd, file)).isFile()
      } catch {
        return false
      }
    })
  }
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${String(Math.round(s / 60))}m ago`
  if (s < 86_400) return `${String(Math.round(s / 3600))}h ago`
  return `${String(Math.round(s / 86_400))}d ago`
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}
