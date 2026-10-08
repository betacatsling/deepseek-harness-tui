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
  const results: Observed[] = []
  let step = 0
  for (const message of after) {
    if (message.role === 'assistant') {
      step += 1
      for (const block of message.content) if (block.type === 'tool-call') names.set(block.id, block.name)
    } else if (message.role === 'tool') {
      const tool = message as Message & { toolCallId: string; isError?: boolean }
      results.push({ name: names.get(tool.toolCallId) ?? '', text: textOf(message), isError: tool.isError === true })
    }
  }
  const runtime = [...messages].reverse().find(message => sourceKind(message) === 'runtime-context')
  const planMode = runtime !== undefined && /plan mode is active|plan:policy|in plan mode/i.test(JSON.stringify((runtime as { source?: unknown }).source ?? '') + textOf(runtime))
  return { prompt, step, results, planMode, ...goal === undefined ? {} : { goal } }
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
    }
  }
  if (turn.step === 1) {
    return { toolCalls: [{ name: 'bash', args: { description: 'Run the test suite', command: 'npm test --silent' } }] }
  }
  if (turn.step === 2) {
    return {
      reasoning: 'The refill test fails: after 500 ms the bucket already allows a request. The refill math in the limiter is the suspect.',
      toolCalls: [todos('completed', 'in_progress'), { name: 'read', args: { file_path: 'src/limiter.js' } }],
    }
  }
  if (!edited && turn.step === 3) {
    return {
      reasoning: 'elapsed = now() - updatedAt is in milliseconds, but refillPerSecond is tokens per second. 500 ms × 1 token/s adds 500 tokens instead of 0.5. Convert to seconds first.',
      text: 'Found it — `elapsed` is measured in **milliseconds**, but `refillPerSecond` is a per-second rate, so every refill is 1000× too large.',
      toolCalls: [todos('completed', 'completed', 'in_progress'), { name: 'edit', args: { file_path: 'src/limiter.js', old_string: LIMITER_OLD, new_string: LIMITER_NEW } }],
    }
  }
  if (lastBash !== undefined && /✖|fail [1-9]|exit code: [1-9]/.test(lastBash.text) && turn.step >= 5) {
    return { text: 'The suite still fails after the change — the output above shows which assertion. I stopped here so you can take a look.' }
  }
  if (turn.step === 4 || (edited && turn.step < 5)) {
    return { toolCalls: [todos('completed', 'completed', 'completed', 'in_progress'), { name: 'bash', args: { description: 'Re-run the tests', command: 'npm test --silent' } }] }
  }
  if (turn.step === 5) return { toolCalls: [todos('completed', 'completed', 'completed', 'completed')] }
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
  if (messages.some(message => sourceKind(message).includes('title'))) return title(messages)
  if ((options.tools?.length ?? 0) === 0) {
    return { text: 'Summary: the user is working on the acme-api rate limiter (token bucket + HTTP middleware) with the scripted demo model.', delayMs: 300 }
  }
  const turn = readTurn(messages)
  const prompt = turn.prompt.toLowerCase()
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
