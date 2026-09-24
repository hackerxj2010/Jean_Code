import { describe, expect, test } from 'bun:test'
import { adaptInput, adaptOutput, renameTool } from '../packages/tui2/src/compat/tool-names.ts'

/**
 * The boundary between Jean's agent and the full-screen interface.
 *
 * The interface picks a component per tool *by name* and then reads fields it
 * expects to find. A mismatch does not throw — the component renders its empty
 * branch, so a command appears with no output, or a read shows no file. These
 * tests pin the translation so that failure mode is caught here rather than on
 * screen.
 */

describe('tool names', () => {
  test('maps Jean tools onto the components written for them', () => {
    expect(renameTool('bash')).toBe('run_terminal_command')
    expect(renameTool('read')).toBe('read_files')
    expect(renameTool('edit')).toBe('str_replace')
    expect(renameTool('grep')).toBe('code_search')
    expect(renameTool('todo')).toBe('write_todos')
  })

  test('passes unknown tools through unchanged', () => {
    expect(renameTool('glob')).toBe('glob')
    expect(renameTool('mcp__github__create_issue')).toBe('mcp__github__create_issue')
  })
})

describe('tool inputs', () => {
  test('converts the bash timeout from milliseconds to seconds', () => {
    expect(adaptInput('bash', { command: 'ls', timeout: 30_000 })).toMatchObject({
      command: 'ls',
      timeout_seconds: 30,
    })
  })

  test('wraps a single read path in the list the file card renders', () => {
    expect(adaptInput('read', { path: 'src/a.ts' })).toMatchObject({ paths: ['src/a.ts'] })
  })

  test('labels a background job by id when it has no command line', () => {
    expect(adaptInput('bash_output', { id: 'job-3' })).toMatchObject({
      command: 'background job job-3',
    })
  })

  test('gives search a pattern even when the model omitted one', () => {
    expect(adaptInput('grep', { path: 'src' })).toMatchObject({ pattern: '', cwd: 'src' })
  })

  test('leaves an absent input absent', () => {
    expect(adaptInput('bash', undefined)).toBeUndefined()
  })
})

describe('tool results', () => {
  test('puts shell output where the terminal card reads it', () => {
    const [part] = adaptOutput('bash', { output: 'hello\n' })
    expect(part).toEqual({ type: 'json', value: { stdout: 'hello\n', stderr: '' } })
  })

  test('marks a failed command so the card shows the error', () => {
    const [part] = adaptOutput('bash', { output: 'boom', isError: true })
    expect(part?.value).toMatchObject({ stdout: 'boom', errorMessage: 'boom' })
  })

  test('prefers a tool’s structured display payload', () => {
    const display = { kind: 'edit', path: 'a.ts' }
    const [part] = adaptOutput('edit', { output: 'Applied 1 hunk', display })
    expect(part?.value).toBe(display)
  })

  test('falls back to the text when there is no display payload', () => {
    const [part] = adaptOutput('glob', { output: 'a.ts\nb.ts' })
    expect(part?.value).toEqual({ output: 'a.ts\nb.ts', isError: false })
  })

  test('survives a result that is not an object', () => {
    expect(() => adaptOutput('bash', undefined)).not.toThrow()
  })
})
