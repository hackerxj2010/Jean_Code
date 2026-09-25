import { describe, expect, test } from 'bun:test'

import { parseArgs } from '../packages/cli/src/flags.ts'

describe('command aliases', () => {
  test('`jean dap …` is the debug command, not a prompt for the model', () => {
    expect(parseArgs(['dap', 'status'])).toMatchObject({ command: 'debug', positional: ['status'] })
  })

  test('`jean codemap` is the index command', () => {
    expect(parseArgs(['codemap']).command).toBe('index')
  })

  test('other words are left alone, so a prompt still reaches the model', () => {
    expect(parseArgs(['fix', 'the', 'bug']).command).toBe('fix')
  })
})
