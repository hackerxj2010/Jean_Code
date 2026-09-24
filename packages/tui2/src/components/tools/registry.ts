import { CodeSearchComponent } from './code-search'
import { GlobComponent } from './glob'
import { ReadFilesComponent } from './read-files'
import { ReadURLComponent } from './read-url'
import { WebSearchComponent } from './web-search'
import { RunTerminalCommandComponent } from './run-terminal-command'
import { SkillComponent } from './skill'
import { StrReplaceComponent } from './str-replace'
import { WriteFileComponent } from './write-file'
import { WriteTodosComponent } from './write-todos'

import type {
  ToolComponent,
  ToolRenderConfig,
  ToolRenderOptions,
  ToolBlock,
} from './types'
import type { ChatTheme } from '../../types/theme-system'
import type { ToolName } from '@codebuff/sdk'

/**
 * Registry of all tool-specific UI components.
 * Add new tool components here to make them available in the CLI.
 */
// Only tools Jean has, under the names `compat/tool-names.ts` gives them;
// any other tool gets the generic card.
const toolComponentRegistry = new Map<ToolName, ToolComponent>([
  [CodeSearchComponent.toolName, CodeSearchComponent],
  [GlobComponent.toolName, GlobComponent],
  [RunTerminalCommandComponent.toolName, RunTerminalCommandComponent],
  [ReadFilesComponent.toolName, ReadFilesComponent],
  [ReadURLComponent.toolName, ReadURLComponent],
  [WebSearchComponent.toolName, WebSearchComponent],
  [WriteTodosComponent.toolName, WriteTodosComponent],
  [StrReplaceComponent.toolName, StrReplaceComponent],
  [WriteFileComponent.toolName, WriteFileComponent],
  [SkillComponent.toolName, SkillComponent],
])

/**
 * Register a new tool component.
 * This allows plugins or extensions to add custom tool renderers.
 *
 * @param component - The tool component to register
 */
export function registerToolComponent(component: ToolComponent): void {
  toolComponentRegistry.set(component.toolName, component)
}

/**
 * Get the registered component for a specific tool name.
 *
 * @param toolName - The name of the tool
 * @returns The tool component, or undefined if not registered
 */
export function getToolComponent(
  toolName: ToolName,
): ToolComponent | undefined {
  return toolComponentRegistry.get(toolName)
}

/**
 * Render a tool using its registered component, or return null for default rendering.
 * This is the main entry point for the tool rendering system.
 *
 * @param toolBlock - The tool block to render
 * @param theme - The current chat theme
 * @param options - Rendering options
 * @returns Render configuration, or null to use default rendering
 */
export function renderToolComponent(
  toolBlock: ToolBlock,
  theme: ChatTheme,
  options: ToolRenderOptions,
): ToolRenderConfig | undefined {
  const component = getToolComponent(toolBlock.toolName)

  if (component === undefined) {
    return undefined
  }

  try {
    return component.render(toolBlock as any, theme, options)
  } catch (error) {
    console.error(
      `Error rendering tool component for ${toolBlock.toolName}:`,
      error,
    )
    return undefined
  }
}

/**
 * Get all registered tool names.
 * Useful for debugging or listing available tool renderers.
 */
export function getRegisteredToolNames(): ToolName[] {
  return Array.from(toolComponentRegistry.keys())
}
