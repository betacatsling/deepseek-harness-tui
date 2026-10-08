import { mkdtempSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { expandMentions, fuzzyScore, mentionAt, rankPaths } from '../src/files.ts'

describe('file mentions', () => {
  const paths = ['README.md', 'src/', 'src/limiter.js', 'src/middleware.js', 'test/limiter.test.js', 'package.json']

  it('prefers basename prefixes, then substrings, then subsequences', () => {
    expect(rankPaths(paths, 'lim', 3)).toEqual(['src/limiter.js', 'test/limiter.test.js'])
    expect(fuzzyScore('src/middleware.js', 'mdw')).toBeGreaterThan(0)
    expect(fuzzyScore('src/middleware.js', 'zzz')).toBe(0)
  })

  it('lists top-level entries for an empty query', () => {
    expect(rankPaths(paths, '', 10)).toEqual(['README.md', 'src/', 'package.json'])
  })

  it('finds the @token under the cursor', () => {
    expect(mentionAt('fix @src/li', 11)).toEqual({ start: 4, query: 'src/li' })
    expect(mentionAt('email me@example.com', 20)).toBeUndefined()
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' })
  })

  it('attaches workspace files and ignores paths outside it', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-tui-')))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'a.js'), 'one\ntwo\n')
    const { text, mentions } = await expandMentions('look at @src/a.js, and @../etc/passwd', root)
    expect(mentions).toEqual([{ path: 'src/a.js', lines: 2 }])
    expect(text).toContain('<attached-file')
    expect(text).toContain('one\ntwo')
    expect(text).not.toContain('passwd"')
  })
})
