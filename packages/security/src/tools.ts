import { readFile } from 'node:fs/promises'
import { displayPath, resolveInWorkspace, type Tool, type ToolResult } from '@jean/tools'
import { listRules } from './patterns.ts'
import { renderReport, scanDirectory, scanText } from './scanner.ts'

/**
 * The security scan tools.
 *
 * Worth running before committing, and after writing anything that touches
 * credentials, builds a query, or spawns a subprocess — the three places an
 * agent is most likely to introduce a real problem.
 */
export function createSecurityTools(): Tool[] {
  const scanTool: Tool<{
    path?: string
    certainOnly?: boolean
    minSeverity?: 'high' | 'medium' | 'low'
  }> = {
    name: 'security_scan',
    risk: 'read',
    description: [
      'Scan for leaked secrets and dangerous code patterns.',
      '',
      'Run this before committing, and after writing code that handles credentials,',
      'builds a database query, or spawns a subprocess. It finds hardcoded keys,',
      'string-built SQL, shell commands assembled from variables, and disabled',
      'certificate verification.',
      '',
      'Every finding names the safe alternative. Secret values are masked, so the',
      'report never contains the secret itself.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File or directory. Defaults to the project.' },
        certainOnly: {
          type: 'boolean',
          description: 'Only report secrets matching a known key format.',
        },
        minSeverity: { type: 'string', enum: ['high', 'medium', 'low'] },
      },
    },
    summarize: (args) => `security scan${args.path ? ` ${args.path}` : ''}`,

    async execute(args, context): Promise<ToolResult> {
      const target = args.path ? resolveInWorkspace(args.path, context) : context.cwd
      const shown = displayPath(target, context)

      const text = args.path ? await readFile(target, 'utf8').catch(() => undefined) : undefined

      const report = text
        ? scanText(text, shown)
        : await scanDirectory(target, {
            certainOnly: args.certainOnly,
            minSeverity: args.minSeverity,
            signal: context.signal,
          })

      const total = report.secrets.length + report.code.length

      return {
        output: renderReport(report),
        // A certain secret is a failure, not information: the turn should not
        // continue as though the scan passed.
        isError: report.secrets.some((finding) => finding.confidence === 'certain'),
        display: { kind: 'security', findings: total, files: report.filesScanned },
      }
    },
  }

  const rulesTool: Tool<Record<string, never>> = {
    name: 'security_rules',
    risk: 'read',
    description: 'List what `security_scan` checks for.',
    parameters: { type: 'object', properties: {} },
    summarize: () => 'security rules',

    async execute(): Promise<ToolResult> {
      const lines = listRules().map(
        (rule) => `  ${rule.severity.padEnd(6)} ${rule.id.padEnd(24)} ${rule.message}`,
      )
      return {
        output: `${lines.length} code rules, plus secret detection:\n\n${lines.join('\n')}`,
      }
    },
  }

  return [scanTool as Tool, rulesTool as Tool]
}
