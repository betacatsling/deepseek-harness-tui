/**
 * The scripted demo model's "brain". Without an API key the TUI still drives
 * the real harness: these scripts emit genuine tool calls (glob, read, bash,
 * edit, todo_write, ask_user_question, exit_plan_mode, subagent) that the
 * harness executes, sandboxes, and gates with approvals. Each reply is chosen
 * from the latest human prompt and the tool results since it, so the model
 * reacts to what actually happened (a still-failing test, a declined
 * approval, the answers to a question, plan feedback).
 * @module @deepseek-ai/dsh-experimental-tui/demo/brain
 */

import type { GenerateOptions, RequestMessage as Message } from '@deepseek-ai/dsh-llm'
import { ptcProgram, splitProgramResult, toolSurface, type ToolSurface } from './surface.ts'

/** One scripted tool call. */
export interface DemoToolCall {
  readonly name: string
  readonly args: Record<string, unknown>
}

/** One scripted model reply. */
export interface DemoReply {
  readonly reasoning?: string
  readonly text?: string
  readonly toolCalls?: readonly DemoToolCall[]
  readonly delayMs?: number
  /** UI label when PTC mode wraps this step's calls into one `run_code` program. */
  readonly program?: string
}

/** A tool result observed since the last human prompt. */
interface Observed {
  readonly name: string
  readonly text: string
  readonly isError: boolean
}

/** Context handed to a scenario. */
export interface Turn {
  /** The latest human prompt (attachments stripped). */
  readonly prompt: string
  /** Assistant replies already produced since that prompt. */
  readonly step: number
  /** Tool results since that prompt, oldest first. */
  readonly results: readonly Observed[]
  /** Whether the runtime context says plan mode is active. */
  readonly planMode: boolean
  /** Set when the turn was started by an automatic goal round instead of a human. */
  readonly goal?: { readonly id: string; readonly revision: number; readonly round: number }
}

function textOf(message: Message): string {
  return message.content.map(block => (block.type === 'text' ? block.text : '')).join('')
}

function sourceKind(message: Message): string {
  const source = (message as { source?: { kind?: unknown } }).source
  return typeof source?.kind === 'string' ? source.kind : ''
}

/**
 * Reconstruct the turn from an assembled request.
 * @param messages - request messages.
 * @returns the turn view scenarios read.
 */
export function readTurn(messages: readonly Message[]): Turn {
  let last = -1
  messages.forEach((message, index) => {
    const kind = sourceKind(message)
    if (message.role === 'user' && (kind === 'user' || kind === 'goal') && !textOf(message).startsWith('<user-shell-command>')) last = index
  })
  type Opener = Message & { source?: { kind?: string; goalId?: unknown; revision?: unknown; round?: unknown } }
  const opener = last < 0 ? undefined : (messages[last] as Opener).source
  const goal = opener?.kind === 'goal' && typeof opener.goalId === 'string' && typeof opener.revision === 'number' && typeof opener.round === 'number' && opener.round > 0
    ? { id: opener.goalId, revision: opener.revision, round: opener.round }
    : undefined
  const prompt = last < 0 ? '' : textOf(messages[last] as Message).replace(/\n*<attached-file[\s\S]*?<\/attached-file>/g, '').trim()
  const after = last < 0 ? [] : messages.slice(last + 1)
  const names = new Map<string, string>()
  const programs = new Map<string, string>()
  const results: Observed[] = []
  let step = 0
  for (const message of after) {
    if (message.role === 'assistant') {
      step += 1
      for (const block of message.content) {
        if (block.type !== 'tool-call') continue
        names.set(block.id, block.name)
        if (block.name === 'run_code') programs.set(block.id, programCode(block.arguments))
      }
    } else if (message.role === 'tool') {
      const tool = message as Message & { toolCallId: string; isError?: boolean }
      const observed = { name: names.get(tool.toolCallId) ?? '', text: textOf(message), isError: tool.isError === true }
      results.push(observed)
      // A PTC program stands for the calls inside it: expose them by tool name too.
      const code = programs.get(tool.toolCallId)
      if (code !== undefined) results.push(...splitProgramResult(code, observed.text, observed.isError) ?? [])
    }
  }
  const runtime = [...messages].reverse().find(message => sourceKind(message) === 'runtime-context')
  const planMode = runtime !== undefined && /plan mode is active|plan:policy|in plan mode/i.test(JSON.stringify((runtime as { source?: unknown }).source ?? '') + textOf(runtime))
  return { prompt, step, results, planMode, ...goal === undefined ? {} : { goal } }
}

function programCode(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { code?: unknown }
    return typeof parsed.code === 'string' ? parsed.code : ''
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------- scenarios

const LIMITER_OLD = '    const elapsed = now() - bucket.updatedAt\n    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerSecond)'
const LIMITER_NEW = '    const elapsedSeconds = (now() - bucket.updatedAt) / 1000\n    bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSeconds * refillPerSecond)'

function todos(...states: ('pending' | 'in_progress' | 'completed')[]): DemoToolCall {
  const items = ['Run the test suite', 'Find the root cause', 'Fix the refill math', 'Verify all tests pass']
  return { name: 'todo_write', args: { todos: items.map((content, index) => ({ content, status: states[index] ?? 'pending' })) } }
}

function explain(turn: Turn): DemoReply {
  switch (turn.step) {
    case 0:
      return {
        reasoning: 'The user wants an overview of the repository. I should look at the layout and the package manifest before reading any source.',
        toolCalls: [
          { name: 'glob', args: { pattern: '**/*.{js,md,json}' } },
          { name: 'read', args: { file_path: 'package.json' } },
        ],
      }
    case 1:
      return {
        reasoning: 'Two modules under src/: the limiter itself and an HTTP middleware. Reading both gives the whole picture.',
        toolCalls: [
          { name: 'read', args: { file_path: 'src/limiter.js' } },
          { name: 'read', args: { file_path: 'src/middleware.js' } },
        ],
      }
    default:
      return {
        reasoning: 'refill() computes elapsed with Date.now() differences, which are milliseconds, but multiplies by refillPerSecond. That is a 1000x unit bug worth flagging.',
        text: [
          '**acme-api** is a small, dependency-free rate limiter for the Acme public API.',
          '',
          '## How it works',
          '',
          '- `src/limiter.js` — a **token bucket** per client key. Each bucket holds up to `capacity` tokens and refills continuously at `refillPerSecond`.',
          '- `src/middleware.js` — wraps a limiter as HTTP middleware; an empty bucket becomes `429 Too Many Requests` with a `Retry-After` header.',
          '- `test/` — `node:test` specs driven by an injected fake clock.',
          '',
          '```js',
          'const limiter = createLimiter({ capacity: 60, refillPerSecond: 1 })',
          "limiter.take('client-42') // → { allowed: true, remaining: 59 }",
          '```',
          '',
          '| Module | Exports | Role |',
          '|---|---|---|',
          '| `limiter.js` | `createLimiter` | bucket state + refill |',
          '| `middleware.js` | `rateLimit` | HTTP 429 + headers |',
          '',
          'One thing stands out: `refill()` multiplies **milliseconds** by a per-second rate, so buckets refill 1000× too fast.',
        ].join('\n'),
      }
  }
}

function fix(turn: Turn): DemoReply {
  const lastBash = [...turn.results].reverse().find(result => result.name === 'bash')
  const edited = turn.results.some(result => result.name === 'edit' && !result.isError)
  if (turn.step === 0) {
    return {
      reasoning: 'A failing test. I will track this as a short checklist: reproduce, diagnose, fix, verify.',
      toolCalls: [todos('in_progress')],
      program: 'Track the fix as a checklist',
    }
  }
  if (turn.step === 1) {
    return { toolCalls: [{ name: 'bash', args: { description: 'Run the test suite', command: 'npm test --silent' } }], program: 'Run the test suite' }
  }
  if (turn.step === 2) {
    return {
      reasoning: 'The refill test fails: after 500 ms the bucket already allows a request. The refill math in the limiter is the suspect.',
      toolCalls: [todos('completed', 'in_progress'), { name: 'read', args: { file_path: 'src/limiter.js' } }],
      program: 'Update the checklist and read the limiter',
    }
  }
  if (!edited && turn.step === 3) {
    return {
      reasoning: 'elapsed = now() - updatedAt is in milliseconds, but refillPerSecond is tokens per second. 500 ms × 1 token/s adds 500 tokens instead of 0.5. Convert to seconds first.',
      text: 'Found it — `elapsed` is measured in **milliseconds**, but `refillPerSecond` is a per-second rate, so every refill is 1000× too large.',
      toolCalls: [todos('completed', 'completed', 'in_progress'), { name: 'edit', args: { file_path: 'src/limiter.js', old_string: LIMITER_OLD, new_string: LIMITER_NEW } }],
      program: 'Convert elapsed time to seconds',
    }
  }
  if (lastBash !== undefined && /✖|fail [1-9]|exit code: [1-9]/.test(lastBash.text) && turn.step >= 5) {
    return { text: 'The suite still fails after the change — the output above shows which assertion. I stopped here so you can take a look.' }
  }
  if (turn.step === 4 || (edited && turn.step < 5)) {
    return { toolCalls: [todos('completed', 'completed', 'completed', 'in_progress'), { name: 'bash', args: { description: 'Re-run the tests', command: 'npm test --silent' } }], program: 'Re-run the tests' }
  }
  if (turn.step === 5) return { toolCalls: [todos('completed', 'completed', 'completed', 'completed')], program: 'Close the checklist' }
  return {
    text: [
      'Fixed. `refill()` treated milliseconds as seconds, so a bucket refilled **1000× faster** than configured — after 500 ms it was already full again.',
      '',
      '- `src/limiter.js`: convert elapsed time to seconds before applying `refillPerSecond`',
      '- All **3 tests** pass now',
    ].join('\n'),
  }
}

function answersFrom(results: readonly Observed[]): string[] {
  const result = results.find(entry => entry.name === 'ask_user_question')
  if (result === undefined) return []
  try {
    const parsed = JSON.parse(result.text) as { answers?: { selected?: string[]; custom?: string }[] }
    return (parsed.answers ?? []).map(answer => [...answer.selected ?? [], ...answer.custom === undefined ? [] : [answer.custom]].join(', '))
  } catch {
    return [result.text]
  }
}

function redisPlan(turn: Turn): DemoReply {
  const asked = turn.results.some(result => result.name === 'ask_user_question')
  const searched = turn.results.some(result => result.name === 'grep')
  const review = [...turn.results].reverse().find(result => result.name === 'exit_plan_mode')
  const npm = turn.results.find(result => result.name === 'bash')
  if (!asked) {
    return {
      reasoning: 'Sharing limits across instances means moving bucket state out of process. Two decisions belong to the user: which Redis client, and what happens when Redis is down.',
      toolCalls: [{
        name: 'ask_user_question',
        args: {
          questions: [
            {
              id: 'client', header: 'Redis client', question: 'Which Redis client should the store use?',
              options: [
                { label: 'ioredis (Recommended)', description: 'Mature, cluster-aware, built-in Lua scripting.' },
                { label: 'node-redis', description: 'Official client with a promise-first API.' },
              ],
            },
            {
              id: 'outage', header: 'Redis outage', question: 'If Redis is unreachable, what should requests do?',
              options: [
                { label: 'Fail open (Recommended)', description: 'Allow traffic and log a warning.' },
                { label: 'Fail closed', description: 'Reject with 503 until Redis recovers.' },
              ],
            },
          ],
        },
      }],
    }
  }
  if (!searched) {
    return {
      reasoning: 'Find every place that touches bucket state so the store interface covers all of it.',
      toolCalls: [{ name: 'grep', args: { pattern: 'buckets|updatedAt', path: 'src' } }],
    }
  }
  const [client = 'ioredis', outage = 'Fail open'] = answersFrom(turn.results)
  const clientName = client.replace(/\s*\(Recommended\)/, '')
  const outageName = outage.replace(/\s*\(Recommended\)/, '').toLowerCase()
  const approved = review !== undefined && !review.isError
  // A program can only call tools its mode offers, and exit_plan_mode is
  // plan-mode-only — so in PTC the plan is delivered as the program's value.
  if (turn.results.some(result => result.name === 'run_code')) {
    return {
      text: [
        '# Redis-backed rate limit store',
        '',
        `Share token buckets across instances through **${clientName}**; ${outageName} when Redis is unavailable.`,
        '',
        '1. Extract a `Store` interface (`get`, `set`) from the in-memory `Map` in `src/limiter.js`',
        `2. Add \`src/stores/redis.js\`: refill and take atomically in one Lua script via ${clientName}`,
        `3. Wrap store calls so a Redis error ${outageName === 'fail open' ? 'allows the request and logs a warning' : 'returns 503'}`,
        '4. Tests: run the existing suite against both stores; add an outage test',
        '',
        'In PTC mode `exit_plan_mode` is plan-mode-only, so the plan comes back as the program result instead of the review card. Switch to `/mode standard` for the full plan-mode review.',
      ].join('\n'),
    }
  }
  if (review === undefined || (review.isError && /keep planning/i.test(review.text) && turn.step < 6)) {
    const feedback = review === undefined ? '' : /feedback: ([\s\S]*)$/.exec(review.text)?.[1] ?? ''
    return {
      reasoning: feedback === '' ? 'I have what I need for a plan.' : `Revise the plan with the feedback: ${feedback}`,
      toolCalls: [{
        name: 'exit_plan_mode',
        args: {
          plan: [
            '# Redis-backed rate limit store',
            '',
            `Share token buckets across instances through **${clientName}**; ${outageName} when Redis is unavailable.`,
            '',
            '1. Extract a `Store` interface (`get`, `set`) from the in-memory `Map` in `src/limiter.js`',
            `2. Add \`src/stores/redis.js\`: refill and take atomically in one Lua script via ${clientName}`,
            `3. Wrap store calls so a Redis error ${outageName === 'fail open' ? 'allows the request and logs a warning' : 'returns 503'}`,
            '4. Tests: run the existing suite against both stores; add an outage test',
            ...feedback === '' ? [] : ['', `> Revised: ${feedback}`],
          ].join('\n'),
        },
      }],
    }
  }
  if (approved && npm === undefined) {
    return {
      text: 'Plan approved — out of plan mode. First, checking the current client release:',
      toolCalls: [{
        name: 'bash',
        args: {
          description: `Look up the latest ${clientName} release`,
          command: `npm view ${clientName === 'node-redis' ? 'redis' : 'ioredis'} version`,
          sandbox_permissions: 'danger-full-access',
          justification: `Queries the npm registry for the current ${clientName} version, which needs network access.`,
        },
      }],
    }
  }
  if (npm !== undefined) {
    const version = /\d+\.\d+\.\d+/.exec(npm.text)?.[0]
    const declined = npm.isError && /declin|reject|denied|not approved/i.test(npm.text)
    return {
      text: declined || version === undefined
        ? `No problem — I'll pin \`${clientName}\` to the version already in your lockfile instead and start with the \`Store\` interface.`
        : `\`${clientName}@${version}\` is current. Next I'll extract the \`Store\` interface from \`src/limiter.js\`, then add the Redis store behind it.`,
    }
  }
  return { text: 'Staying in plan mode. Tell me what to change and I will revise the plan.' }
}

function review(turn: Turn): DemoReply {
  const done = turn.results.find(result => result.name === 'subagent')
  if (done === undefined) {
    return {
      reasoning: 'A focused review is a good fit for a subagent with its own context.',
      toolCalls: [{
        name: 'subagent',
        args: {
          description: 'Review middleware security',
          prompt: 'Review src/middleware.js in this repository for security issues (key spoofing, header handling, unbounded memory). Report findings as a short list.',
          run_in_background: false,
        },
      }],
    }
  }
  return {
    text: [
      'The subagent found two issues worth fixing:',
      '',
      '| Severity | Finding |',
      '|---|---|',
      '| High | `x-api-key` is trusted as-is — any client can rotate keys to dodge limits |',
      '| Medium | `buckets` never evicts idle keys, so memory grows with unique clients |',
      '',
      'Want me to add key validation and an LRU cap?',
    ].join('\n'),
  }
}

/**
 * An automatic goal round: check the objective against the repo, then close
 * the goal through the real `update_goal` tool so the round driver stops.
 */
function goalRound(turn: Turn, goal: { readonly id: string; readonly revision: number; readonly round: number }): DemoReply {
  if (turn.step === 0) {
    return {
      reasoning: `Goal round ${String(goal.round)}. Where does limiter state live today, and is anything still process-local?`,
      toolCalls: [{ name: 'grep', args: { pattern: 'new Map|buckets', path: 'src' } }],
    }
  }
  if (turn.step === 1) {
    return {
      text: 'All limiter state is in the `buckets` map in `src/limiter.js` — the approved Redis plan moves exactly that behind a shared store, so the objective is covered. Marking the goal complete.',
      toolCalls: [{ name: 'update_goal', args: { goal_id: goal.id, revision: goal.revision, action: 'complete' } }],
    }
  }
  const failed = turn.results.some(result => result.name === 'update_goal' && result.isError)
  return { text: failed ? 'I could not close the goal automatically; use `/goal clear` to stop it.' : 'Goal complete ✔' }
}

function reviewWorker(turn: Turn): DemoReply {
  if (turn.step === 0) {
    return {
      toolCalls: [
        { name: 'read', args: { file_path: 'src/middleware.js' } },
        { name: 'grep', args: { pattern: 'x-api-key|buckets', path: '.' } },
      ],
    }
  }
  return {
    text: '- HIGH: rate-limit key comes straight from the `x-api-key` header; unauthenticated clients can mint keys.\n- MEDIUM: the in-memory `buckets` map has no eviction.\n- LOW: `Retry-After` is fine; no header injection risk.',
  }
}

// ---------------------------------------------------------------- auto review

/**
 * Stand-in reviewer for the experimental Auto review layer: it answers with
 * the layer's exact decision objects. Project-local work is low risk;
 * network lookups are medium and allowed (the user asked for them);
 * destructive or publishing commands are denied so the approval fallback
 * can be shown.
 */
export function autoReview(request: string): string {
  const action = request.slice(request.lastIndexOf('PENDING_ACTION'))
  if (/rm -rf|git push|--force|drop table|curl [^|]*\| *(sh|bash)/i.test(action)) {
    return '{"risk":"medium","decision":"deny","reason":"Destructive or publishing command without explicit authorization in this session."}'
  }
  if (/npm view|npm install|curl |wget |danger-full-access/i.test(action)) return '{"risk":"medium","decision":"allow"}'
  return '{"risk":"low","decision":"allow"}'
}

// ---------------------------------------------------------------- mode showcases

const SURVEY_PATTERN = '{src,test}/**/*.js'

/** The PTC program for the survey: one glob, every read in parallel, numbers only. */
const SURVEY_PROGRAM = [
  '// Read every source and test file at once; return only the numbers',
  `const { paths } = await tools.glob({ pattern: '${SURVEY_PATTERN}' })`,
  'const files = await Promise.all(paths.map(file_path => tools.read({ file_path })))',
  'return files.map((file, i) => ({',
  '  file: paths[i],',
  '  lines: file.totalLines,',
  '  exports: file.lines.filter(line => /^export /.test(line.text)).length,',
  '  tests: file.lines.filter(line => /\\btest\\(/.test(line.text)).length,',
  '}))',
].join('\n')

interface SurveyRow { readonly file: string; readonly lines: number; readonly exports: number; readonly tests: number }

function surveyTable(rows: readonly SurveyRow[], footer: string): DemoReply {
  const total = rows.reduce(
    (sum, row) => ({ lines: sum.lines + row.lines, exports: sum.exports + row.exports, tests: sum.tests + row.tests }),
    { lines: 0, exports: 0, tests: 0 },
  )
  return {
    text: [
      `${String(rows.length)} files, ${String(total.lines)} lines:`,
      '',
      '| File | Lines | Exports | Tests |',
      '|---|--:|--:|--:|',
      ...rows.map(row => `| \`${row.file}\` | ${String(row.lines)} | ${String(row.exports)} | ${String(row.tests)} |`),
      `| **Total** | **${String(total.lines)}** | **${String(total.exports)}** | **${String(total.tests)}** |`,
      '',
      footer,
    ].join('\n'),
  }
}

/** Parse `read` output (`12: text` lines) into the survey numbers. */
function surveyRow(file: string, text: string): SurveyRow {
  const lines = text.split('\n').map(line => /^\s*\d+(?:: |:$|\t)(.*)$/.exec(line)?.[1] ?? (/^\s*\d+:$/.test(line) ? '' : undefined)).filter((line): line is string => line !== undefined)
  return {
    file,
    lines: lines.length,
    exports: lines.filter(line => /^export /.test(line)).length,
    tests: lines.filter(line => /\btest\(/.test(line)).length,
  }
}

/**
 * Codebase survey. Natively it takes a glob step and a read step whose full
 * file contents all land in the context; in PTC mode one program does the
 * whole fan-out and returns only the table's numbers.
 */
function survey(turn: Turn, surface: ToolSurface): DemoReply {
  if (surface === 'ptc') {
    const program = turn.results.find(result => result.name === 'run_code')
    if (program === undefined) {
      return {
        reasoning: 'One program can glob, read every file concurrently, and hand back just the counts, so the file bodies never enter my context.',
        toolCalls: [{ name: 'run_code', args: { description: 'Count lines, exports and tests per file', code: SURVEY_PROGRAM } }],
      }
    }
    try {
      const rows = (JSON.parse(program.text.slice(program.text.indexOf('['))) as SurveyRow[]).sort((a, b) => a.file.localeCompare(b.file))
      return surveyTable(rows, `One \`run_code\` program ran the glob and all ${String(rows.length)} reads in its own Node process; only these numbers came back into my context.`)
    } catch {
      return { text: `The survey program did not return the table I expected:\n\n\`\`\`\n${program.text.slice(0, 600)}\n\`\`\`` }
    }
  }
  const listing = turn.results.find(result => result.name === 'glob')
  if (listing === undefined) {
    return {
      reasoning: 'List the source and test files first, then read them all.',
      toolCalls: [{ name: 'glob', args: { pattern: SURVEY_PATTERN } }],
    }
  }
  const reads = turn.results.filter(result => result.name === 'read')
  const files = listing.text.split('\n').map(line => line.trim()).filter(line => /\.js$/.test(line))
  if (reads.length === 0) {
    return { toolCalls: files.map(file => ({ name: 'read', args: { file_path: file } })) }
  }
  return surveyTable(files.map((file, index) => surveyRow(file, reads[index]?.text ?? '')).sort((a, b) => a.file.localeCompare(b.file)),
    'Tip: in **PTC mode** (`/mode ptc`) one program does this fan-out and returns only the numbers.')
}

/** Creator mode: load the authoring skill, inspect the live composition, propose a mode. */
function creator(turn: Turn): DemoReply {
  const loaded = turn.results.some(result => result.name === 'skill')
  const inspected = turn.results.some(result => result.name === 'cordis_inspect_list')
  if (!loaded) {
    return {
      reasoning: 'A new mode is an agent preset. The editing-cordis-compositions skill has the rules for writing one, so load it before proposing anything.',
      toolCalls: [{ name: 'skill', args: { name: 'editing-cordis-compositions' } }],
    }
  }
  if (!inspected) {
    return {
      reasoning: 'Check what this profile already installs and which inspect providers the host exposes, so the proposal only uses rows that exist.',
      toolCalls: [
        { name: 'plugin_manager', args: { action: 'list_bundles' } },
        { name: 'cordis_inspect_list', args: {} },
      ],
    }
  }
  return {
    text: [
      'Here is a **reviewer** mode as an agent preset: it reads and searches files, keeps a checklist, and has no shell.',
      '',
      '```yaml',
      '- insert:',
      '    - id: preset-reviewer',
      "      name: '@deepseek-ai/dsh-agent-preset'",
      '      config:',
      '        id: reviewer',
      '        plugins:',
      '          - id: persona',
      "            name: '@deepseek-ai/dsh-persona'",
      '            config:',
      '              prefix: You review code. Read and search; report findings, never edit.',
      '          - id: agent-instructions',
      "            name: '@deepseek-ai/dsh-agent-instructions'",
      '          - id: tool-fs',
      "            name: '@deepseek-ai/dsh-tool-fs'",
      '          - id: tool-fs-search',
      "            name: '@deepseek-ai/dsh-tool-fs-search'",
      '          - id: tool-todo',
      "            name: '@deepseek-ai/dsh-tool-todo'",
      '```',
      '',
      '`tool-fs` also registers `write` and `edit`, so pair the mode with the **read-only** permission preset (`/permissions`) to block edits by policy, not just by the prompt.',
      '',
      'Say **install it** and I will package this as a bundle and add it to your profile with `plugin_manager` (you approve the install); it then appears in `/mode` as a custom mode.',
    ].join('\n'),
  }
}

const LIMITER_EDIT_SCRIPT = [
  "node --input-type=module - <<'EOF'",
  "import { readFileSync, writeFileSync } from 'node:fs'",
  "const file = 'src/limiter.js'",
  'const source = readFileSync(file, \'utf8\')',
  "const fixed = source.replace('const elapsed = now() - bucket.updatedAt', 'const elapsedSeconds = (now() - bucket.updatedAt) / 1000')",
  "  .replace('bucket.tokens + elapsed * refillPerSecond', 'bucket.tokens + elapsedSeconds * refillPerSecond')",
  'writeFileSync(file, fixed)',
  "console.log(fixed === source ? 'no change' : 'patched ' + file)",
  'EOF',
].join('\n')

/** Minimal mode: one persistent shell, so every step is a command. */
function minimal(turn: Turn, prompt: string): DemoReply {
  const shell = turn.results.filter(result => result.name === 'bash')
  if (/fail|fix|broken|bug/.test(prompt)) {
    switch (turn.step) {
      case 0: return { reasoning: 'Only a shell here. Reproduce first.', toolCalls: [{ name: 'bash', args: { command: 'npm test --silent' } }] }
      case 1: return { reasoning: 'The refill test fails. Look at the refill math.', toolCalls: [{ name: 'bash', args: { command: "grep -n 'elapsed' src/limiter.js" } }] }
      case 2: return {
        reasoning: 'elapsed is in milliseconds but refillPerSecond is per second. Patch it with a small node script, since there is no edit tool.',
        toolCalls: [{ name: 'bash', args: { command: LIMITER_EDIT_SCRIPT } }],
      }
      case 3: return { toolCalls: [{ name: 'bash', args: { command: 'npm test --silent && git diff --stat' } }] }
      default: {
        const last = shell.at(-1)?.text ?? ''
        return {
          text: /fail [1-9]|✖/.test(last)
            ? 'The tests still fail after the patch; the output above shows the assertion.'
            : 'Fixed with nothing but the shell: `elapsed` was milliseconds, so the bucket refilled 1000× too fast. All tests pass.',
        }
      }
    }
  }
  if (/what does|explain|overview|walk me through/.test(prompt)) {
    if (turn.step === 0) return { toolCalls: [{ name: 'bash', args: { command: 'ls src test && sed -n 1,20p README.md' } }] }
    return { text: '**acme-api** is a small token-bucket rate limiter: `src/limiter.js` holds the buckets, `src/middleware.js` turns an empty bucket into a 429, and `test/` drives it with a fake clock.' }
  }
  if (turn.step > 0) return { text: 'Done.' }
  return {
    text: [
      "**Minimal mode** — I only have one persistent shell and a one-line system prompt; it is for comparing a model's raw behavior.",
      '',
      'Try `@test/limiter.test.js is failing, please fix it` or `What does this project do?`, or switch with `/mode standard`.',
    ].join('\n'),
  }
}

const DESIGN_DOC = [
  '# Design: adaptive rate limits',
  '',
  'Static limits punish bursty-but-honest clients and under-protect the API during incidents. This proposal makes `capacity` and `refillPerSecond` respond to **live error rates**.',
  '',
  '## Goals',
  '',
  '- Keep p99 latency under 120 ms during traffic spikes',
  '- Never drop a client below its contracted floor',
  '- Make every adjustment observable and reversible',
  '',
  '## Approach',
  '',
  'Each instance samples 5xx rate over a 10 s window. When it crosses 2%, refill rates shrink multiplicatively (×0.8 per window) toward the contract floor; they recover additively once errors subside. This AIMD loop is the same idea TCP uses for congestion control, and it converges without coordination.',
  '',
  '```js',
  'function adjust(rate, errorRatio, floor, ceiling) {',
  '  if (errorRatio > 0.02) return Math.max(floor, rate * 0.8)',
  '  return Math.min(ceiling, rate + 0.5)',
  '}',
  '```',
  '',
  '## Rollout',
  '',
  '1. Ship behind `ADAPTIVE_LIMITS=shadow` — compute, log, do not enforce',
  '2. Compare shadow decisions against incident timelines for two weeks',
  '3. Enforce for free-tier keys, then for everyone',
  '',
  '## Risks',
  '',
  'Feedback loops can oscillate when many instances react to the same signal at once. Jittering the window start per instance keeps them out of phase.',
].join('\n')

function fallback(): DemoReply {
  return {
    reasoning: 'This prompt does not match one of my rehearsed scripts, so I should explain what the demo can do.',
    text: [
      "I'm the **scripted demo model** — no DeepSeek API key is configured, so I can only follow a few rehearsed scripts. Everything around me is real: tools run in your workspace, approvals and plan mode are enforced by the harness, and sessions are saved.",
      '',
      'Try one of these in the `acme-api` sample project:',
      '',
      '- `What does this project do?`',
      '- `@test/limiter.test.js is failing, please fix it`',
      '- **Shift+Tab** into plan mode, then `Add a Redis-backed store`',
      '- `Review the middleware in a subagent`',
      '- `Write a design doc for adaptive limits` (press **Esc** to interrupt)',
      '- `Survey the codebase` — then try it again in `/mode ptc`',
      '',
      'Or set `DEEPSEEK_API_KEY` and pick a real model with `/model`.',
    ].join('\n'),
  }
}

function title(messages: readonly Message[]): DemoReply {
  const text = messages.map(textOf).join(' ').toLowerCase()
  const pick = /redis/.test(text) ? 'Redis-backed rate limit store'
    : /fail|fix|test/.test(text) ? 'Fix limiter refill test'
      : /review|subagent|security/.test(text) ? 'Middleware security review'
        : /design doc|adaptive/.test(text) ? 'Adaptive rate limits design'
          : /what does|explain|overview/.test(text) ? 'Explain acme-api'
            : 'Demo session'
  return { text: pick, delayMs: 60 }
}

/**
 * Decide the next reply from the assembled request.
 * @param options - the request.
 * @returns the scripted reply.
 */
export function planReply(options: GenerateOptions): DemoReply {
  const messages = options.messages
  if (options.system?.startsWith('REVIEW_POLICY') === true) {
    const last = messages.at(-1)
    return { text: autoReview(last === undefined ? '' : textOf(last)), delayMs: 250 }
  }
  if (messages.some(message => sourceKind(message).includes('title'))) return title(messages)
  if ((options.tools?.length ?? 0) === 0) {
    return { text: 'Summary: the user is working on the acme-api rate limiter (token bucket + HTTP middleware) with the scripted demo model.', delayMs: 300 }
  }
  const surface = toolSurface(options)
  const turn = readTurn(messages)
  const reply = chooseReply(turn, surface, new Set((options.tools ?? []).map(tool => tool.name)))
  return surface === 'ptc' ? asProgram(reply) : reply
}

/**
 * PTC mode: one `run_code` program per scripted step, calling the same tools
 * through the SDK. Steps that already are programs pass through.
 */
function asProgram(reply: DemoReply): DemoReply {
  const calls = reply.toolCalls ?? []
  if (calls.length === 0 || calls.every(call => call.name === 'run_code')) return reply
  // Bookkeeping (the checklist) goes last so the program reads as the work.
  const ordered = [...calls.filter(call => call.name !== 'todo_write'), ...calls.filter(call => call.name === 'todo_write')]
  const label = reply.program ?? ordered.map(call => programLabel(call)).join(', then ')
  return { ...reply, toolCalls: [{ name: 'run_code', args: ptcProgram(ordered, label) }] }
}

function programLabel(call: DemoToolCall): string {
  const description = call.args.description
  if (typeof description === 'string' && description !== '') return description
  switch (call.name) {
    case 'ask_user_question': return 'Ask which Redis client and outage policy to use'
    case 'exit_plan_mode': return 'Present the plan for review'
    case 'grep': return `Search for ${String(call.args.pattern)}`
    case 'glob': return `List ${String(call.args.pattern)}`
    case 'read': return `Read ${String(call.args.file_path)}`
    case 'update_goal': return 'Mark the goal complete'
    default: return call.name.replace(/_/g, ' ')
  }
}

function chooseReply(turn: Turn, surface: ToolSurface, tools: ReadonlySet<string>): DemoReply {
  const prompt = turn.prompt.toLowerCase()
  if (surface === 'minimal') return minimal(turn, prompt)
  if (tools.has('cordis_inspect_list') && /\b(mode|preset|plugin|extend|customi[sz]e|creat)/.test(prompt)) return creator(turn)
  if (/survey|stats|statistics|per file|how big|count (the )?(lines|tests|exports)/.test(prompt)) return survey(turn, surface)
  if (turn.goal !== undefined) return goalRound(turn, turn.goal)
  if (prompt.startsWith('review src/middleware.js')) return reviewWorker(turn)
  if (/what does|explain|overview|walk me through/.test(prompt)) return explain(turn)
  if (/fail|fix|broken|bug/.test(prompt)) return fix(turn)
  if (/redis|shared store|across instances/.test(prompt)) return redisPlan(turn)
  if (/review|audit|subagent|security/.test(prompt)) return review(turn)
  if (/design doc|write a doc|adaptive/.test(prompt)) {
    return turn.step === 0 ? { reasoning: 'A short design doc: goals, approach, rollout, risks.', text: DESIGN_DOC } : { text: 'Done.' }
  }
  return turn.step === 0 ? fallback() : { text: 'Done.' }
}
