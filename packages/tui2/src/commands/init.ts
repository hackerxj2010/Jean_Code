/**
 * `/init` — creates the project's knowledge file.
 *
 * The version this was ported from also scaffolded a `.agents/` directory of
 * TypeScript stubs, so a user could author agents as files the tool would load
 * at runtime. Jean's agents are code in the repository, so there is nothing to
 * scaffold — and writing a directory of type declarations that nothing reads
 * would be worse than writing nothing.
 *
 * What remains is the part that earns its keep: `JEAN.md`, the file the agent
 * reads at the start of every session. Its value is entirely in what the user
 * writes there, so the template is short and asks concrete questions rather
 * than shipping headings nobody fills in.
 */

import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { PRIMARY_KNOWLEDGE_FILE_NAME } from '../compat/common'
import { getProjectRoot } from '../project-files'
import { getSystemMessage } from '../utils/message-history'

import type { PostUserMessageFn } from '../types/contracts/send-message'

const TEMPLATE = `# Project notes for Jean Code

Read at the start of every session. Keep it short — anything here costs context
on every turn, so it should be what the agent could not work out by reading the
code.

## What this project is

<one or two sentences>

## Commands

- Build:
- Test:
- Lint / typecheck:

## Conventions worth knowing

Things a newcomer would get wrong: an unusual naming rule, a directory whose
contents are generated, a test that must be run a particular way.

## Do not touch

Generated files, vendored code, anything with a reason to be left alone.
`

export function handleInitializationFlowLocally(): {
  postUserMessage: PostUserMessageFn
} {
  const projectRoot = getProjectRoot()
  const knowledgePath = path.join(projectRoot, PRIMARY_KNOWLEDGE_FILE_NAME)
  const messages: string[] = []

  if (existsSync(knowledgePath)) {
    // Never overwritten. Whatever the user wrote there is worth more than the
    // template, and silently replacing it would lose work.
    messages.push(`\`${PRIMARY_KNOWLEDGE_FILE_NAME}\` already exists — leaving it alone.`)
  } else {
    try {
      writeFileSync(knowledgePath, TEMPLATE)
      messages.push(
        `Created \`${PRIMARY_KNOWLEDGE_FILE_NAME}\`. Fill in the sections that apply and delete the rest.`,
      )
    } catch (error) {
      messages.push(
        `Could not write \`${PRIMARY_KNOWLEDGE_FILE_NAME}\`: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  // Appends to the transcript rather than replacing it: the user ran this
  // mid-conversation and the history above it still matters.
  const postUserMessage: PostUserMessageFn = (previous) => [
    ...previous,
    ...messages.map((message) => getSystemMessage(message)),
  ]

  return { postUserMessage }
}
