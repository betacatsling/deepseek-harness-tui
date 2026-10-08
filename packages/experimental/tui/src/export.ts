/**
 * Markdown export of the visible transcript (`/export`).
 * @module @deepseek-ai/dsh-experimental-tui/export
 */

import type { UiState } from './store.ts'
import { toolTitle } from './tool-format.ts'

/**
 * Render the transcript as Markdown.
 * @param state - UI state.
 * @returns the document.
 */
export function renderTranscriptMarkdown(state: UiState): string {
  const lines: string[] = [
    `# ${state.title ?? 'DeepSeek Harness session'}`,
    '',
    `- Session: \`${state.sessionId ?? 'unknown'}\``,
    `- Model: \`${state.model.provider}/${state.model.model}\``,
    `- Directory: \`${state.cwd}\``,
    `- Exported: ${new Date().toISOString()}`,
    '',
  ]
  for (const item of state.items) {
    switch (item.kind) {
      case 'user':
        lines.push(`## > ${item.text.split('\n')[0] ?? ''}`, '', item.text.split('\n').slice(1).join('\n'), '')
        break
      case 'assistant':
        lines.push(item.text, '')
        break
      case 'thinking':
        lines.push('<details><summary>Thinking</summary>', '', item.text, '', '</details>', '')
        break
      case 'tool':
        lines.push(`**${toolTitle(item.name, item.args)}** — ${item.status}`, '')
        if (item.result !== undefined && item.result !== '') lines.push('```', item.result.slice(0, 4000), '```', '')
        break
      case 'command':
        lines.push(`\`${item.line}\``, '', item.output ?? '', '')
        break
      case 'shell':
        lines.push('```console', `$ ${item.command}`, item.output, '```', '')
        break
      case 'notice':
      case 'compacted':
        lines.push(`> ${item.text}`, '')
        break
      case 'memory':
        lines.push(`> Saved to ${item.file}: ${item.text}`, '')
        break
      case 'todos':
        for (const todo of item.todos) lines.push(`- [${todo.status === 'completed' ? 'x' : ' '}] ${todo.content}`)
        lines.push('')
        break
      case 'banner':
        break
    }
  }
  return lines.join('\n')
}
