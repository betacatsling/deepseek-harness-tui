/**
 * Syntax highlighting for fenced code: highlight.js tokenizes, and its HTML
 * spans are translated into truecolor ANSI from the TUI palette.
 * @module @deepseek-ai/dsh-experimental-tui/highlight
 */

import hljs from 'highlight.js/lib/common'
import { ansi, palette, themed } from './theme.ts'

type Painter = (text: string) => string

const scopeColor: Record<string, Painter> = themed(() => ({
  keyword: ansi.hex(palette.synKeyword),
  built_in: ansi.hex(palette.synType),
  type: ansi.hex(palette.synType),
  literal: ansi.hex(palette.synNumber),
  number: ansi.hex(palette.synNumber),
  string: ansi.hex(palette.synString),
  regexp: ansi.hex(palette.synString),
  subst: ansi.hex(palette.synVariable),
  symbol: ansi.hex(palette.synNumber),
  class: ansi.hex(palette.synType),
  function: ansi.hex(palette.synFunction),
  title: ansi.hex(palette.synFunction),
  params: ansi.hex(palette.synVariable),
  comment: ansi.hex(palette.synComment).italic,
  doctag: ansi.hex(palette.synComment),
  meta: ansi.hex(palette.synMeta),
  'meta-keyword': ansi.hex(palette.synMeta),
  attr: ansi.hex(palette.synAttr),
  attribute: ansi.hex(palette.synAttr),
  property: ansi.hex(palette.synFunction),
  variable: ansi.hex(palette.synVariable),
  'template-variable': ansi.hex(palette.synVariable),
  tag: ansi.hex(palette.synKeyword),
  name: ansi.hex(palette.synKeyword),
  'selector-tag': ansi.hex(palette.synKeyword),
  'selector-class': ansi.hex(palette.synType),
  'selector-id': ansi.hex(palette.synType),
  section: ansi.hex(palette.synFunction).bold,
  bullet: ansi.hex(palette.synMeta),
  addition: ansi.hex(palette.diffAddFg),
  deletion: ansi.hex(palette.diffDelFg),
  operator: ansi.hex(palette.synMeta),
  punctuation: ansi.hex(palette.muted),
}))

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'" }

function decode(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#x27|#39);/g, entity => ENTITIES[entity] ?? entity)
}

function painterFor(classes: string): Painter | undefined {
  for (const raw of classes.split(/\s+/)) {
    const name = raw.replace(/^hljs-/, '').replace(/_$/, '')
    const direct = scopeColor[name]
    if (direct !== undefined) return direct
    const head = name.split('.')[0]
    if (head !== undefined && scopeColor[head] !== undefined) return scopeColor[head]
  }
  return undefined
}

/** Translate highlight.js HTML into ANSI, keeping nested scopes. */
export function htmlToAnsi(html: string, base: Painter = text => text): string {
  const stack: Painter[] = [base]
  let out = ''
  const pattern = /<span class="([^"]*)">|<\/span>|([^<]+)/g
  for (const match of html.matchAll(pattern)) {
    if (match[1] !== undefined) {
      stack.push(painterFor(match[1]) ?? stack[stack.length - 1] ?? base)
    } else if (match[0] === '</span>') {
      if (stack.length > 1) stack.pop()
    } else if (match[2] !== undefined) {
      const paint = stack[stack.length - 1] ?? base
      // Paint per line so a wrapped or split line never leaks colour state.
      out += decode(match[2]).split('\n').map(part => part === '' ? '' : paint(part)).join('\n')
    }
  }
  return out
}

const ALIASES: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', py: 'python', yml: 'yaml', md: 'markdown', rs: 'rust', golang: 'go' }

/** Resolve a fence info string or file extension to a highlight.js language. */
export function resolveLanguage(lang: string | undefined): string | undefined {
  if (lang === undefined || lang === '') return undefined
  const key = lang.toLowerCase().trim().split(/\s+/)[0] ?? ''
  const name = ALIASES[key] ?? key
  return hljs.getLanguage(name) === undefined ? undefined : name
}

/** Language from a file path's extension. */
export function languageForPath(path: string): string | undefined {
  const ext = path.slice(path.lastIndexOf('.') + 1)
  return resolveLanguage(ext)
}

/**
 * Highlight code to ANSI lines.
 * @param code - source text.
 * @param lang - fence language or alias.
 * @returns one ANSI string per source line.
 */
export function highlightCode(code: string, lang: string | undefined): string[] {
  const language = resolveLanguage(lang)
  const plain = ansi.hex(palette.synVariable)
  if (language === undefined) return code.split('\n').map(line => plain(line))
  try {
    const html = hljs.highlight(code, { language, ignoreIllegals: true }).value
    return htmlToAnsi(html, plain).split('\n')
  } catch {
    return code.split('\n').map(line => plain(line))
  }
}
