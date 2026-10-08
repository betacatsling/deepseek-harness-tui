/**
 * Workspace file index for `@` mentions: a gitignore-aware listing (git when
 * available, otherwise a bounded walk), fuzzy ranking for the completion menu,
 * and expansion of mentions into attached file content on submit.
 * @module @deepseek-ai/dsh-experimental-tui/files
 */

import { execFile } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'lib', 'build', '.next', '.venv', '__pycache__', 'target', 'coverage'])
const MAX_FILES = 20_000
const MAX_ATTACH_BYTES = 256 * 1024

function gitFiles(cwd: string): Promise<string[] | undefined> {
  return new Promise((done) => {
    execFile('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 4000 }, (error, stdout) => {
      if (error !== null) {
        done(undefined)
        return
      }
      done(stdout.split('\n').filter(Boolean).slice(0, MAX_FILES))
    })
  })
}

async function walk(cwd: string): Promise<string[]> {
  const out: string[] = []
  const queue: string[] = ['']
  while (queue.length > 0 && out.length < MAX_FILES) {
    const dir = queue.shift() ?? ''
    let entries
    try {
      entries = await readdir(join(cwd, dir), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.github') continue
      const path = dir === '' ? entry.name : `${dir}/${entry.name}`
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) queue.push(path)
      } else if (entry.isFile()) {
        out.push(path)
      }
    }
  }
  return out
}

/** Lazily built, periodically refreshed file list. */
export class FileIndex {
  private files: string[] = []
  private dirs: string[] = []
  private loadedAt = 0
  private loading: Promise<void> | undefined

  constructor(private readonly cwd: string) {}

  /** Refresh at most every 15 seconds. */
  async ensure(): Promise<void> {
    if (Date.now() - this.loadedAt < 15_000) return
    this.loading ??= (async () => {
      const files = (await gitFiles(this.cwd)) ?? (await walk(this.cwd))
      const dirs = new Set<string>()
      for (const file of files) {
        const parts = file.split('/')
        for (let i = 1; i < parts.length; i += 1) dirs.add(`${parts.slice(0, i).join('/')}/`)
      }
      this.files = files
      this.dirs = [...dirs]
      this.loadedAt = Date.now()
      this.loading = undefined
    })()
    await this.loading
  }

  /** Synchronous snapshot for rendering. */
  search(query: string, limit = 8): string[] {
    return rankPaths([...this.dirs, ...this.files], query, limit)
  }
}

/**
 * Fuzzy-rank paths: subsequence match with bonuses for basename hits,
 * contiguous runs, and segment starts; shorter paths win ties.
 * @param paths - candidates.
 * @param query - typed text after `@`.
 * @param limit - result cap.
 * @returns best matches.
 */
export function rankPaths(paths: readonly string[], query: string, limit: number): string[] {
  const q = query.toLowerCase()
  if (q === '') return paths.filter(path => !path.includes('/') || (path.endsWith('/') && path.split('/').length === 2)).slice(0, limit)
  const scored: { path: string; score: number }[] = []
  for (const path of paths) {
    const score = fuzzyScore(path, q)
    if (score > 0) scored.push({ path, score })
  }
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path))
  return scored.slice(0, limit).map(entry => entry.path)
}

/** Score one candidate; 0 means no match. */
export function fuzzyScore(path: string, query: string): number {
  const lower = path.toLowerCase()
  const base = lower.slice(lower.lastIndexOf('/', lower.length - 2) + 1)
  if (base.startsWith(query)) return 1000 - path.length
  if (lower.includes(query)) return 700 - path.length + (base.includes(query) ? 100 : 0)
  let score = 0
  let qi = 0
  let run = 0
  for (let i = 0; i < lower.length && qi < query.length; i += 1) {
    if (lower[i] === query[qi]) {
      qi += 1
      run += 1
      score += 10 + run * 5 + (i === 0 || lower[i - 1] === '/' || lower[i - 1] === '-' || lower[i - 1] === '_' || lower[i - 1] === '.' ? 15 : 0)
    } else {
      run = 0
    }
  }
  return qi === query.length ? score : 0
}

/** One expanded mention. */
export interface ExpandedMention {
  readonly path: string
  readonly lines: number
}

/** The `@token` under the cursor, if any. */
export function mentionAt(text: string, cursor: number): { start: number; query: string } | undefined {
  const before = text.slice(0, cursor)
  const match = /(^|\s)@([^\s@]*)$/.exec(before)
  if (match === null) return undefined
  const query = match[2] ?? ''
  return { start: cursor - query.length - 1, query }
}

/**
 * Attach the content of every `@path` that names a readable workspace file.
 * The typed prompt is kept verbatim; files are appended in wrappers the
 * transcript projector strips again on replay.
 * @param text - submitted prompt.
 * @param cwd - workspace root.
 * @returns the model-facing text plus the attached files.
 */
export async function expandMentions(text: string, cwd: string): Promise<{ text: string; mentions: ExpandedMention[] }> {
  const mentions: ExpandedMention[] = []
  const attachments: string[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(/(^|\s)@([^\s@]+)/g)) {
    const raw = (match[2] ?? '').replace(/[,.;:!?)]+$/, '')
    if (raw === '' || seen.has(raw)) continue
    seen.add(raw)
    const absolute = isAbsolute(raw) ? raw : resolve(cwd, raw)
    if (!absolute.startsWith(cwd + sep) && absolute !== cwd) continue
    try {
      const info = await stat(absolute)
      if (!info.isFile() || info.size > MAX_ATTACH_BYTES) continue
      const content = await readFile(absolute, 'utf8')
      if (content.includes('\u0000')) continue
      const path = relative(cwd, absolute)
      const lines = content === '' ? 0 : content.replace(/\n$/, '').split('\n').length
      mentions.push({ path, lines })
      attachments.push(`<attached-file path="${path}" lines="${String(lines)}">\n${content}\n</attached-file>`)
    } catch {
      continue
    }
  }
  return { text: attachments.length === 0 ? text : `${text}\n\n${attachments.join('\n\n')}`, mentions }
}
