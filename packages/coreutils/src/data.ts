import { basename, dirname, extname, isAbsolute, resolve } from 'node:path'
import { fail, fromLines, ok, toLines, type UtilResult } from './text.ts'

/**
 * Data and path utilities (architecture §8.2).
 *
 * `jq` and `bc` are the interesting ones: both are small languages, and both
 * are implemented here rather than shelled out to, because neither ships on
 * Windows and an agent that learns to rely on them would break the moment it
 * ran somewhere else.
 */

// ---- jq -------------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/**
 * A useful subset of `jq`.
 *
 * Supports `.`, `.field`, `.a.b`, `[N]`, `[]`, `|`, `keys`, `length`, `type`,
 * `values`, and `select(...)` with simple comparisons. That covers what
 * pipelines actually do with JSON — reach into it and pull a value out.
 */
export function jq(input: string, filter: string): UtilResult {
  let parsed: Json
  try {
    parsed = JSON.parse(input) as Json
  } catch (err) {
    return fail(`jq: invalid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }

  try {
    const results = applyFilter([parsed], filter.trim())
    return ok(`${results.map((value) => JSON.stringify(value, null, 2)).join('\n')}\n`)
  } catch (err) {
    return fail(`jq: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function applyFilter(values: Json[], filter: string): Json[] {
  // A pipeline threads every value through each stage in turn.
  const stages = splitPipeline(filter)
  let current = values

  for (const stage of stages) {
    const next: Json[] = []
    for (const value of current) next.push(...applyStage(value, stage.trim()))
    current = next
  }
  return current
}

/** Splits on `|`, ignoring pipes inside brackets, parentheses, or strings. */
function splitPipeline(filter: string): string[] {
  const parts: string[] = []
  let depth = 0
  let inString = false
  let current = ''

  for (let i = 0; i < filter.length; i++) {
    const char = filter[i]!
    if (inString) {
      current += char
      if (char === '"' && filter[i - 1] !== '\\') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      current += char
      continue
    }
    if (char === '[' || char === '(') depth++
    if (char === ']' || char === ')') depth--
    if (char === '|' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }

  parts.push(current)
  return parts.filter((p) => p.trim())
}

function applyStage(value: Json, stage: string): Json[] {
  if (stage === '.' || stage === '') return [value]

  if (stage === 'keys') {
    if (value === null || typeof value !== 'object') throw new Error('keys requires an object')
    return [Array.isArray(value) ? value.map((_, i) => i) : Object.keys(value).sort()]
  }

  if (stage === 'length') {
    if (value === null) return [0]
    if (Array.isArray(value)) return [value.length]
    if (typeof value === 'string') return [value.length]
    if (typeof value === 'object') return [Object.keys(value).length]
    return [1]
  }

  if (stage === 'type') {
    if (value === null) return ['null']
    if (Array.isArray(value)) return ['array']
    return [typeof value]
  }

  if (stage === 'values') {
    if (value === null || typeof value !== 'object') return [value]
    return [Array.isArray(value) ? value : Object.values(value)]
  }

  const select = /^select\((.*)\)$/.exec(stage)
  if (select) return evaluateCondition(value, select[1]!) ? [value] : []

  // A path expression: `.a.b[0][]`
  return walkPath(value, stage)
}

function walkPath(value: Json, path: string): Json[] {
  let current: Json[] = [value]
  // Matches `.field`, `.["field"]`, `[N]`, and `[]`.
  const steps = path.match(/\.[A-Za-z_][\w]*|\[\s*"[^"]*"\s*\]|\[\s*-?\d+\s*\]|\[\s*\]/g)

  if (!steps) throw new Error(`unsupported filter: ${path}`)

  for (const step of steps) {
    const next: Json[] = []

    for (const item of current) {
      if (step === '[]') {
        // Iterating a non-collection yields nothing rather than failing, so a
        // heterogeneous array does not abort the whole filter.
        if (Array.isArray(item)) next.push(...item)
        else if (item && typeof item === 'object') next.push(...Object.values(item))
        continue
      }

      const index = /^\[\s*(-?\d+)\s*\]$/.exec(step)
      if (index) {
        if (!Array.isArray(item)) continue
        const position = Number(index[1])
        next.push(item[position < 0 ? item.length + position : position] ?? null)
        continue
      }

      const quoted = /^\[\s*"([^"]*)"\s*\]$/.exec(step)
      const key = quoted ? quoted[1]! : step.slice(1)

      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        next.push(null)
        continue
      }
      next.push(item[key] ?? null)
    }

    current = next
  }

  return current
}

function evaluateCondition(value: Json, condition: string): boolean {
  const match = /^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/.exec(condition.trim())
  if (!match) throw new Error(`unsupported condition: ${condition}`)

  const [, left, operator, right] = match
  const actual = walkPath(value, left!.trim())[0] ?? null
  const expected = parseLiteral(right!.trim())

  switch (operator) {
    case '==':
      return actual === expected
    case '!=':
      return actual !== expected
    case '>':
      return Number(actual) > Number(expected)
    case '<':
      return Number(actual) < Number(expected)
    case '>=':
      return Number(actual) >= Number(expected)
    case '<=':
      return Number(actual) <= Number(expected)
    default:
      return false
  }
}

function parseLiteral(text: string): Json {
  if (text === 'null') return null
  if (text === 'true') return true
  if (text === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text)
  const quoted = /^"(.*)"$/.exec(text)
  return quoted ? quoted[1]! : text
}

// ---- bc -------------------------------------------------------------------

/**
 * A calculator covering `bc`'s expression language.
 *
 * A recursive-descent parser rather than `eval`: the input reaches this from a
 * model, and handing model output to `eval` is arbitrary code execution with
 * extra steps.
 */
export function bc(expression: string, scale = 6): UtilResult {
  try {
    const results = expression
      .split(/[\n;]/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const value = evaluateExpression(line)
        return Number.isInteger(value) ? String(value) : value.toFixed(scale).replace(/\.?0+$/, '')
      })
    return ok(fromLines(results))
  } catch (err) {
    return fail(`bc: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function evaluateExpression(input: string): number {
  let position = 0

  const peek = (): string => {
    while (input[position] === ' ') position++
    return input[position] ?? ''
  }

  const consume = (expected: string): void => {
    if (peek() !== expected) throw new Error(`expected ${expected} at ${position}`)
    position++
  }

  // expression := term (('+' | '-') term)*
  const parseExpression = (): number => {
    let left = parseTerm()
    for (;;) {
      const operator = peek()
      if (operator !== '+' && operator !== '-') return left
      position++
      const right = parseTerm()
      left = operator === '+' ? left + right : left - right
    }
  }

  // term := power (('*' | '/' | '%') power)*
  const parseTerm = (): number => {
    let left = parsePower()
    for (;;) {
      const operator = peek()
      if (operator !== '*' && operator !== '/' && operator !== '%') return left
      position++
      const right = parsePower()
      if ((operator === '/' || operator === '%') && right === 0) {
        throw new Error('division by zero')
      }
      left = operator === '*' ? left * right : operator === '/' ? left / right : left % right
    }
  }

  // power := unary ('^' power)?  — right-associative, as exponentiation is.
  const parsePower = (): number => {
    const base = parseUnary()
    if (peek() !== '^') return base
    position++
    return base ** parsePower()
  }

  const parseUnary = (): number => {
    if (peek() === '-') {
      position++
      return -parseUnary()
    }
    if (peek() === '+') {
      position++
      return parseUnary()
    }
    return parsePrimary()
  }

  const parsePrimary = (): number => {
    if (peek() === '(') {
      consume('(')
      const value = parseExpression()
      consume(')')
      return value
    }

    // A named function: sqrt(x), abs(x), and the rest.
    const name = /^[a-z]+/.exec(input.slice(position))
    if (name) {
      position += name[0].length
      consume('(')
      const argument = parseExpression()
      consume(')')

      const functions: Record<string, (n: number) => number> = {
        sqrt: Math.sqrt,
        abs: Math.abs,
        floor: Math.floor,
        ceil: Math.ceil,
        round: Math.round,
        log: Math.log,
        exp: Math.exp,
        sin: Math.sin,
        cos: Math.cos,
        tan: Math.tan,
      }
      const fn = functions[name[0]]
      if (!fn) throw new Error(`unknown function ${name[0]}`)
      return fn(argument)
    }

    const number = /^\d+(\.\d+)?/.exec(input.slice(position))
    if (!number) throw new Error(`unexpected character at ${position}: ${input[position] ?? 'end'}`)
    position += number[0].length
    return Number.parseFloat(number[0])
  }

  const result = parseExpression()
  if (peek() !== '') throw new Error(`unexpected trailing input at ${position}`)
  return result
}

// ---- path utilities -------------------------------------------------------

export function baseName(path: string, suffix?: string): UtilResult {
  let name = basename(path)
  if (suffix && name.endsWith(suffix) && name !== suffix) {
    name = name.slice(0, -suffix.length)
  }
  return ok(`${name}\n`)
}

export function dirName(path: string): UtilResult {
  return ok(`${dirname(path)}\n`)
}

export function realPath(path: string, cwd = process.cwd()): UtilResult {
  return ok(`${isAbsolute(path) ? path : resolve(cwd, path)}\n`)
}

export function extName(path: string): UtilResult {
  return ok(`${extname(path)}\n`)
}

// ---- misc -----------------------------------------------------------------

/** `tee`: passes input through while capturing it. */
export function tee(text: string): { stdout: string; captured: string } {
  return { stdout: text, captured: text }
}

/**
 * `xargs`: builds command lines from input.
 *
 * Returns the argument batches rather than running anything — execution belongs
 * to the shell tool, where it is gated and audited.
 */
export function xargs(
  text: string,
  options: { maxArgs?: number; delimiter?: string | RegExp } = {},
): string[][] {
  const delimiter = options.delimiter ?? /\s+/
  const items = text.split(delimiter).filter(Boolean)
  const size = options.maxArgs ?? items.length

  const batches: string[][] = []
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size))
  }
  return batches.length > 0 ? batches : [[]]
}

/** `date`: formats a timestamp with strftime-style specifiers. */
export function date(format = '%Y-%m-%d %H:%M:%S', when = new Date()): UtilResult {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')

  const replacements: Record<string, string> = {
    '%Y': String(when.getFullYear()),
    '%m': pad(when.getMonth() + 1),
    '%d': pad(when.getDate()),
    '%H': pad(when.getHours()),
    '%M': pad(when.getMinutes()),
    '%S': pad(when.getSeconds()),
    '%s': String(Math.floor(when.getTime() / 1000)),
    '%F': `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`,
    '%T': `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`,
    '%j': pad(
      Math.ceil((when.getTime() - new Date(when.getFullYear(), 0, 0).getTime()) / 86_400_000),
      3,
    ),
  }

  return ok(`${format.replace(/%[A-Za-z]/g, (token) => replacements[token] ?? token)}\n`)
}

/** `env` / `printenv`. */
export function env(name?: string, source: NodeJS.ProcessEnv = process.env): UtilResult {
  if (name) {
    const value = source[name]
    return value === undefined ? fail(`printenv: ${name} is not set`) : ok(`${value}\n`)
  }
  return ok(
    fromLines(
      Object.entries(source)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${value}`)
        .sort(),
    ),
  )
}

/** `diff`, unified format. */
export function diff(left: string, right: string, context = 3): UtilResult {
  const a = toLines(left)
  const b = toLines(right)

  const common = longestCommonSubsequence(a, b)
  const changes: { type: '-' | '+' | ' '; text: string; aIndex: number; bIndex: number }[] = []

  let i = 0
  let j = 0
  for (const point of [...common, { ai: a.length, bi: b.length }]) {
    while (i < point.ai) changes.push({ type: '-', text: a[i]!, aIndex: i++, bIndex: j })
    while (j < point.bi) changes.push({ type: '+', text: b[j]!, aIndex: i, bIndex: j++ })
    if (point.ai < a.length) {
      changes.push({ type: ' ', text: a[i]!, aIndex: i++, bIndex: j++ })
    }
  }

  if (!changes.some((c) => c.type !== ' ')) return ok('')

  // Emit hunks: runs of changes plus `context` unchanged lines around them.
  const out: string[] = []
  let index = 0
  while (index < changes.length) {
    if (changes[index]!.type === ' ') {
      index++
      continue
    }

    const start = Math.max(0, index - context)
    let end = index
    while (end < changes.length) {
      if (changes[end]!.type !== ' ') {
        end++
        continue
      }
      // Extend past a short unchanged run so nearby edits share one hunk.
      let run = 0
      while (end + run < changes.length && changes[end + run]!.type === ' ') run++
      if (run > context * 2 || end + run >= changes.length) break
      end += run
    }
    const stop = Math.min(changes.length, end + context)

    const slice = changes.slice(start, stop)
    const aStart = slice[0]!.aIndex + 1
    const bStart = slice[0]!.bIndex + 1
    const aCount = slice.filter((c) => c.type !== '+').length
    const bCount = slice.filter((c) => c.type !== '-').length

    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`)
    for (const change of slice) out.push(`${change.type}${change.text}`)
    index = stop
  }

  return ok(fromLines(out))
}

function longestCommonSubsequence(a: string[], b: string[]): { ai: number; bi: number }[] {
  if (a.length > 5000 || b.length > 5000) return []

  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  )
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] =
        a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }

  const out: { ai: number; bi: number }[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ ai: i, bi: j })
      i++
      j++
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      i++
    } else {
      j++
    }
  }
  return out
}
