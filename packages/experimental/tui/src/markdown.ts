/**
 * Terminal Markdown: `marked` lexes, and this module renders tokens into
 * pre-wrapped ANSI lines for a given width. Code blocks get a quiet gutter and
 * syntax colour, lists keep hanging indents, and tables are boxed.
 * @module @deepseek-ai/dsh-experimental-tui/markdown
 */

import { marked, type Token, type Tokens } from 'marked'
import stringWidth from './width.ts'
import wrapAnsi from 'wrap-ansi'
import { highlightCode } from './highlight.ts'
import { ansi, palette, themed } from './theme.ts'

const c = themed(() => ({
  text: ansi.hex(palette.text),
  muted: ansi.hex(palette.muted),
  faint: ansi.hex(palette.faint),
  accent: ansi.hex(palette.accent),
  code: ansi.hex(palette.inlineCode),
  heading: ansi.hex(palette.text).bold,
  link: ansi.hex(palette.accent).underline,
  quote: ansi.hex(palette.muted).italic,
  border: ansi.hex(palette.border),
}))

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
}

/** Render inline tokens to an ANSI string. */
export function renderInline(tokens: readonly Token[] | undefined, base: (s: string) => string = c.text): string {
  if (tokens === undefined) return ''
  let out = ''
  for (const token of tokens) {
    switch (token.type) {
      case 'text': {
        const t = token as Tokens.Text
        out += t.tokens !== undefined && t.tokens.length > 0 ? renderInline(t.tokens, base) : base(decodeEntities(t.text))
        break
      }
      case 'escape':
        out += base(decodeEntities((token as Tokens.Escape).text))
        break
      case 'strong':
        out += ansi.bold(renderInline((token as Tokens.Strong).tokens, base))
        break
      case 'em':
        out += ansi.italic(renderInline((token as Tokens.Em).tokens, base))
        break
      case 'del':
        out += ansi.strikethrough(renderInline((token as Tokens.Del).tokens, base))
        break
      case 'codespan':
        out += c.code(decodeEntities((token as Tokens.Codespan).text))
        break
      case 'link': {
        const link = token as Tokens.Link
        const label = renderInline(link.tokens, c.link)
        out += link.href === link.text ? c.link(link.href) : `${label}${c.faint(` (${link.href})`)}`
        break
      }
      case 'image':
        out += c.muted(`[image: ${(token as Tokens.Image).text}]`)
        break
      case 'br':
        out += '\n'
        break
      case 'html':
        out += base(decodeEntities((token as Tokens.HTML).text))
        break
      default:
        out += base(decodeEntities('raw' in token ? token.raw : ''))
    }
  }
  return out
}

function wrap(text: string, width: number): string[] {
  return wrapAnsi(text, Math.max(8, width), { hard: true, trim: false }).split('\n')
}

/** Prose wrap: a break never leaves a stray leading space on the next line. */
function wrapProse(text: string, width: number): string[] {
  return wrapAnsi(text, Math.max(8, width), { hard: true, trim: true }).split('\n')
}

function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - stringWidth(text)))
}

function renderCode(code: string, lang: string | undefined, width: number): string[] {
  const lines = highlightCode(code.replace(/\n$/, ''), lang)
  const label = lang !== undefined && lang !== '' ? ` ${c.faint(lang)}` : ''
  const out: string[] = [c.border('╭─') + label]
  for (const line of lines) {
    for (const piece of wrap(line, width - 4)) out.push(`${c.border('│')} ${piece}`)
  }
  out.push(c.border('╰─'))
  return out
}

function renderTable(token: Tokens.Table, width: number): string[] {
  const header = token.header.map(cell => renderInline(cell.tokens))
  const rows = token.rows.map(row => row.map(cell => renderInline(cell.tokens)))
  const cols = header.length
  const widths = new Array<number>(cols).fill(3)
  for (const row of [header, ...rows]) row.forEach((cell, i) => { widths[i] = Math.max(widths[i] ?? 3, stringWidth(cell)) })
  const total = widths.reduce((a, b) => a + b, 0) + cols * 3 + 1
  if (total > width) {
    const scale = (width - cols * 3 - 1) / (total - cols * 3 - 1)
    for (let i = 0; i < cols; i += 1) widths[i] = Math.max(3, Math.floor((widths[i] ?? 3) * scale))
  }
  const line = (l: string, m: string, r: string): string => c.border(l + widths.map(w => '─'.repeat(w + 2)).join(m) + r)
  const row = (cells: string[], bold: boolean): string[] => {
    const wrapped = cells.map((cell, i) => wrap(cell, widths[i] ?? 3))
    const height = Math.max(...wrapped.map(lines => lines.length))
    const out: string[] = []
    for (let h = 0; h < height; h += 1) {
      out.push(c.border('│') + wrapped.map((lines, i) => {
        const text = lines[h] ?? ''
        const cell = bold ? ansi.bold(text) : text
        const room = Math.max(0, (widths[i] ?? 3) - stringWidth(cell))
        return token.align[i] === 'right' ? ` ${' '.repeat(room)}${cell} ` : ` ${pad(cell, widths[i] ?? 3)} `
      }).join(c.border('│')) + c.border('│'))
    }
    return out
  }
  return [line('┌', '┬', '┐'), ...row(header, true), line('├', '┼', '┤'), ...rows.flatMap(r => row(r, false)), line('└', '┴', '┘')]
}

function renderList(token: Tokens.List, width: number, depth: number): string[] {
  const out: string[] = []
  const start = typeof token.start === 'number' ? token.start : 1
  token.items.forEach((item, index) => {
    const marker = token.ordered
      ? c.muted(`${String(start + index)}.`)
      : item.task ? (item.checked === true ? c.accent('☒') : c.muted('☐')) : c.muted(depth % 2 === 0 ? '•' : '◦')
    const markerWidth = stringWidth(marker) + 1
    const body = renderBlocks(item.tokens, width - markerWidth, depth + 1, true)
    body.forEach((line, i) => {
      out.push(i === 0 ? `${marker} ${line}` : `${' '.repeat(markerWidth)}${line}`)
    })
  })
  return out
}

function renderBlocks(tokens: readonly Token[], width: number, depth: number, tight = false): string[] {
  const out: string[] = []
  const gap = (): void => {
    if (!tight && out.length > 0 && out[out.length - 1] !== '') out.push('')
  }
  for (const token of tokens) {
    switch (token.type) {
      case 'space':
        break
      case 'paragraph':
        gap()
        out.push(...wrapProse(renderInline((token as Tokens.Paragraph).tokens), width))
        break
      case 'text': {
        const t = token as Tokens.Text
        out.push(...wrapProse(t.tokens !== undefined ? renderInline(t.tokens) : c.text(decodeEntities(t.text)), width))
        break
      }
      case 'heading': {
        gap()
        const h = token as Tokens.Heading
        const base = h.depth === 1 ? ansi.hex(palette.accent).bold : h.depth === 2 ? c.heading : ansi.hex(palette.text).bold
        out.push(...wrapProse(renderInline(h.tokens, base), width))
        break
      }
      case 'code': {
        gap()
        const code = token as Tokens.Code
        out.push(...renderCode(code.text, code.lang, width))
        break
      }
      case 'blockquote': {
        gap()
        const inner = renderBlocks((token as Tokens.Blockquote).tokens, width - 2, depth)
        out.push(...inner.map(line => `${c.faint('▎')} ${c.quote(line)}`))
        break
      }
      case 'list':
        gap()
        out.push(...renderList(token as Tokens.List, width, depth))
        break
      case 'table':
        gap()
        out.push(...renderTable(token as Tokens.Table, width))
        break
      case 'hr':
        gap()
        out.push(c.border('─'.repeat(Math.min(width, 48))))
        break
      case 'html':
        out.push(...wrap(c.muted((token as Tokens.HTML).text.trim()), width))
        break
      default:
        if ('raw' in token) out.push(...wrap(c.text(token.raw.trim()), width))
    }
  }
  return out
}

/**
 * Render Markdown into ANSI lines.
 * @param source - Markdown text.
 * @param width - available columns.
 * @returns wrapped ANSI lines.
 */
export function renderMarkdown(source: string, width: number): string[] {
  const tokens = marked.lexer(source, { gfm: true })
  const lines = renderBlocks(tokens, width, 0)
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Render Markdown that is still streaming: an unterminated fence is closed
 * provisionally so the partial block highlights instead of flashing raw.
 * @param source - partial Markdown.
 * @param width - available columns.
 * @returns wrapped ANSI lines.
 */
export function renderStreamingMarkdown(source: string, width: number): string[] {
  const fences = source.match(/^```/gm)?.length ?? 0
  return renderMarkdown(fences % 2 === 1 ? `${source}\n\`\`\`` : source, width)
}
