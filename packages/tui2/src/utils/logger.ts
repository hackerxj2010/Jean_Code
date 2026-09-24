import { appendFileSync, existsSync, mkdirSync, unlinkSync } from 'fs'
import path, { dirname } from 'path'
import { format as stringFormat } from 'util'

import { IS_DEV, IS_TEST, IS_CI } from '@codebuff/common/env'
import { destination, pino, type LogFn, type Logger } from 'pino'

import { getCurrentChatDir, getProjectRoot } from '../project-files'

/**
 * The interface's log: a file, never the terminal.
 *
 * Writing to stdout would land in the middle of the frame the renderer is
 * drawing. Nothing is sent anywhere — Jean has no telemetry — so a log line is
 * only ever read by someone looking at the file.
 */

export interface LoggerContext {
  userId?: string
  userEmail?: string
  clientSessionId?: string
  fingerprintId?: string
  clientRequestId?: string
  [key: string]: unknown
}

export const loggerContext: LoggerContext = {}

let logPath: string | undefined = undefined
let pinoLogger: Logger | undefined = undefined

const loggingLevels = ['info', 'debug', 'warn', 'error', 'fatal'] as const
type LogLevel = (typeof loggingLevels)[number]

/**
 * Safely stringify an object, handling circular references.
 * Replaces circular references with '[Circular]' placeholder.
 */
function safeStringify(obj: unknown): string {
  const seen = new WeakSet()
  return JSON.stringify(obj, (_key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return '[Circular]'
      }
      seen.add(value)
    }
    return value
  })
}

function isEmptyObject(value: unknown): boolean {
  return value != null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0
}

function setLogPath(p: string): void {
  if (p === logPath) return // nothing to do

  logPath = p
  mkdirSync(dirname(p), { recursive: true })

  // destination(..) is a SonicBoom stream: no worker thread.
  const fileStream = destination({
    dest: p,
    mkdir: true,
    sync: true,
  })

  pinoLogger = pino(
    {
      level: 'debug',
      formatters: {
        level: (label) => ({ level: label.toUpperCase() }),
      },
      timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    },
    fileStream,
  )
}

export function clearLogFile(): void {
  const projectRoot = getProjectRoot()
  const defaultLog = path.join(projectRoot, 'debug', 'cli.jsonl')
  const targets = new Set<string>()

  if (logPath) {
    targets.add(logPath)
  }
  targets.add(defaultLog)

  for (const target of targets) {
    try {
      if (existsSync(target)) {
        unlinkSync(target)
      }
    } catch {
      // Ignore errors when clearing logs
    }
  }

  logPath = undefined
  pinoLogger = undefined
}

function writeLog(level: LogLevel, data: unknown, msg?: string, ...args: unknown[]): void {
  if (!IS_CI && !IS_TEST) {
    let projectRoot: string | undefined
    try {
      projectRoot = getProjectRoot()
    } catch {
      projectRoot = undefined
    }
    if (projectRoot) {
      setLogPath(IS_DEV ? path.join(projectRoot, 'debug', 'cli.jsonl') : path.join(getCurrentChatDir(), 'log.jsonl'))
    }
  }

  const isStringOnly = typeof data === 'string' && msg === undefined
  const normalizedData = isStringOnly ? undefined : data
  const normalizedMsg = isStringOnly ? (data as string) : msg
  const includeData = normalizedData != null && !isEmptyObject(normalizedData)

  // In dev mode, append directly for real-time logs (Bun has issues with
  // pino's sync mode); otherwise pino.
  if (IS_DEV && logPath) {
    const logEntry = safeStringify({
      level: level.toUpperCase(),
      timestamp: new Date().toISOString(),
      ...loggerContext,
      ...(includeData ? { data: normalizedData } : {}),
      msg: stringFormat(normalizedMsg ?? '', ...args),
    })
    try {
      appendFileSync(logPath, logEntry + '\n')
    } catch {
      // Ignore write errors
    }
  } else if (pinoLogger !== undefined) {
    const base = { ...loggerContext }
    const obj = includeData ? { ...base, data: normalizedData } : base
    pinoLogger[level](obj, normalizedMsg, ...args)
  }
}

/** Structured-first: `logger.error({ error }, 'message')`, as every call site reads. */
export const logger: Record<LogLevel, LogFn> = Object.fromEntries(
  loggingLevels.map((level) => [level, (data: unknown, msg?: string, ...args: unknown[]) => writeLog(level, data, msg, ...args)]),
) as Record<LogLevel, LogFn>
