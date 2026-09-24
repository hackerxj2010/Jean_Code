import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { walk } from './search.ts'
import type { Tool, ToolResult } from './types.ts'
import { ToolError } from './types.ts'

/**
 * Workspace checkpoints.
 *
 * A snapshot the agent can roll back to. This exists because the alternative
 * recovery paths are all worse: `git stash` fights the user's own staging area,
 * `git reset` destroys work the user did outside the session, and asking a
 * model to undo its own edits by writing more edits compounds the problem it
 * is trying to fix.
 *
 * Content-addressed: files are stored by hash, so a checkpoint of an unchanged
 * tree costs nothing and ten checkpoints of a large repository cost one copy of
 * each distinct version.
 */

export interface Checkpoint {
  id: string
  label: string
  createdAt: number
  /** Relative path to content hash. */
  files: Record<string, string>
  fileCount: number
  bytes: number
}

/** Files above this are not snapshotted; a checkpoint should not clone a binary. */
const MAX_FILE_BYTES = 2 * 1024 * 1024

export class CheckpointStore {
  private readonly root: string
  private readonly cwd: string
  private checkpoints: Checkpoint[] = []
  private loaded = false

  constructor(cwd: string, storeRoot: string) {
    this.cwd = cwd
    this.root = storeRoot
  }

  private get indexPath(): string {
    return join(this.root, 'index.json')
  }

  private get objectsDir(): string {
    return join(this.root, 'objects')
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true

    if (!existsSync(this.indexPath)) return
    try {
      const parsed = JSON.parse(await readFile(this.indexPath, 'utf8')) as {
        checkpoints?: Checkpoint[]
      }
      this.checkpoints = parsed.checkpoints ?? []
    } catch {
      // A corrupt index loses history, not work: the objects are still on disk,
      // and refusing to start would block the session over a recovery feature.
      this.checkpoints = []
    }
  }

  private async save(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    await writeFile(
      this.indexPath,
      `${JSON.stringify({ checkpoints: this.checkpoints }, null, 2)}\n`,
      'utf8',
    )
  }

  /** Snapshots the working tree. */
  async create(label: string): Promise<Checkpoint> {
    await this.load()
    await mkdir(this.objectsDir, { recursive: true })

    const files: Record<string, string> = {}
    let bytes = 0

    for await (const entry of walk(this.cwd)) {
      if (entry.isDir || entry.size > MAX_FILE_BYTES) continue

      const content = await readFile(entry.absPath).catch(() => undefined)
      if (!content) continue

      const hash = createHash('sha256').update(content).digest('hex')
      files[entry.relPath] = hash
      bytes += content.length

      // Content-addressed, so an unchanged file across ten checkpoints is
      // stored once.
      const objectPath = join(this.objectsDir, hash.slice(0, 2), hash.slice(2))
      if (!existsSync(objectPath)) {
        await mkdir(dirname(objectPath), { recursive: true })
        await writeFile(objectPath, content)
      }
    }

    const checkpoint: Checkpoint = {
      id: `ckpt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      label,
      createdAt: Date.now(),
      files,
      fileCount: Object.keys(files).length,
      bytes,
    }

    this.checkpoints.push(checkpoint)
    // Capped: an agent checkpointing every turn would otherwise fill the disk.
    if (this.checkpoints.length > 50) this.checkpoints = this.checkpoints.slice(-50)
    await this.save()

    return checkpoint
  }

  /**
   * What changed since a checkpoint.
   *
   * Reported before restoring, because a restore that silently discards work
   * the user did outside the session is the failure this whole feature exists
   * to avoid.
   */
  async diff(id: string): Promise<{ modified: string[]; added: string[]; deleted: string[] }> {
    await this.load()
    const checkpoint = this.checkpoints.find((c) => c.id === id)
    if (!checkpoint) throw new Error(`no checkpoint ${id}`)

    const modified: string[] = []
    const added: string[] = []
    const seen = new Set<string>()

    for await (const entry of walk(this.cwd)) {
      if (entry.isDir || entry.size > MAX_FILE_BYTES) continue
      seen.add(entry.relPath)

      const recorded = checkpoint.files[entry.relPath]
      if (!recorded) {
        added.push(entry.relPath)
        continue
      }

      const content = await readFile(entry.absPath).catch(() => undefined)
      if (!content) continue
      if (createHash('sha256').update(content).digest('hex') !== recorded) {
        modified.push(entry.relPath)
      }
    }

    const deleted = Object.keys(checkpoint.files).filter((path) => !seen.has(path))
    return { modified: modified.sort(), added: added.sort(), deleted: deleted.sort() }
  }

  /**
   * Restores the tree to a checkpoint.
   *
   * Files added since are removed, matching what "roll back" means. Files the
   * checkpoint never recorded — anything ignored, or over the size cap — are
   * untouched, so a restore does not delete `node_modules`.
   */
  async restore(id: string): Promise<{ restored: number; removed: number }> {
    await this.load()
    const checkpoint = this.checkpoints.find((c) => c.id === id)
    if (!checkpoint) throw new Error(`no checkpoint ${id}`)

    let restored = 0
    let removed = 0

    for (const [relPath, hash] of Object.entries(checkpoint.files)) {
      const objectPath = join(this.objectsDir, hash.slice(0, 2), hash.slice(2))
      const content = await readFile(objectPath).catch(() => undefined)
      if (!content) continue

      const target = join(this.cwd, relPath.split('/').join(sep))
      const current = await readFile(target).catch(() => undefined)
      if (current && current.equals(content)) continue

      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content)
      restored++
    }

    const { added } = await this.diff(id)
    for (const relPath of added) {
      await rm(join(this.cwd, relPath.split('/').join(sep)), { force: true })
      removed++
    }

    return { restored, removed }
  }

  async list(): Promise<Checkpoint[]> {
    await this.load()
    return [...this.checkpoints].reverse()
  }

  async remove(id: string): Promise<boolean> {
    await this.load()
    const before = this.checkpoints.length
    this.checkpoints = this.checkpoints.filter((c) => c.id !== id)
    if (this.checkpoints.length === before) return false
    await this.save()
    return true
  }

  /** Deletes objects no checkpoint references. */
  async prune(): Promise<number> {
    await this.load()
    const live = new Set(this.checkpoints.flatMap((c) => Object.values(c.files)))
    if (!existsSync(this.objectsDir)) return 0

    let removed = 0
    for (const prefix of await readdir(this.objectsDir)) {
      const dir = join(this.objectsDir, prefix)
      if (!(await stat(dir).catch(() => undefined))?.isDirectory()) continue

      for (const name of await readdir(dir)) {
        if (live.has(prefix + name)) continue
        await rm(join(dir, name), { force: true })
        removed++
      }
    }
    return removed
  }
}

/** Builds the checkpoint tool bound to a store. */
export function createCheckpointTool(store: CheckpointStore): Tool<{
  action: 'create' | 'list' | 'restore' | 'diff'
  id?: string
  label?: string
}> {
  return {
    name: 'checkpoint',
    risk: 'write',
    description: [
      'Snapshot the working tree, or roll back to a snapshot.',
      '',
      'Take one before a change you are unsure about — a broad refactor, a risky',
      'migration — so it can be undone in one step. Rolling back is far more',
      'reliable than writing more edits to undo earlier ones.',
      '',
      'Always run `diff` before `restore`: restoring discards everything changed',
      'since, including work done outside this session.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'restore', 'diff'] },
        id: { type: 'string', description: 'Checkpoint id, for `restore` and `diff`.' },
        label: { type: 'string', description: 'What this snapshot is for.' },
      },
      required: ['action'],
    },
    summarize: (args) => `checkpoint ${args.action}${args.id ? ` ${args.id}` : ''}`,

    async execute(args, context): Promise<ToolResult> {
      switch (args.action) {
        case 'create': {
          const checkpoint = await store.create(args.label ?? 'unlabelled')
          return {
            output: `Checkpoint ${checkpoint.id} — ${checkpoint.fileCount} files. Restore with \`checkpoint restore ${checkpoint.id}\`.`,
            display: { kind: 'checkpoint', id: checkpoint.id, files: checkpoint.fileCount },
          }
        }

        case 'list': {
          const all = await store.list()
          if (all.length === 0) return { output: 'No checkpoints.' }

          const lines = all.map(
            (c) =>
              `  ${c.id}  ${new Date(c.createdAt).toLocaleString()}  ${c.fileCount} files\n      ${c.label}`,
          )
          return { output: `${all.length} checkpoints:\n\n${lines.join('\n')}` }
        }

        case 'diff': {
          if (!args.id) throw new ToolError('`diff` needs a checkpoint `id`.')
          const changes = await store.diff(args.id)
          const total =
            changes.modified.length + changes.added.length + changes.deleted.length

          if (total === 0) return { output: 'The tree matches that checkpoint exactly.' }

          const sections: string[] = [`${total} differences from ${args.id}:`]
          if (changes.modified.length) {
            sections.push('', 'Modified:', ...changes.modified.map((p) => `  ${p}`))
          }
          if (changes.added.length) {
            sections.push('', 'Added since (would be removed):', ...changes.added.map((p) => `  ${p}`))
          }
          if (changes.deleted.length) {
            sections.push('', 'Deleted since (would return):', ...changes.deleted.map((p) => `  ${p}`))
          }
          return { output: sections.join('\n') }
        }

        case 'restore': {
          if (!args.id) throw new ToolError('`restore` needs a checkpoint `id`.')

          const changes = await store.diff(args.id)
          const losing = changes.modified.length + changes.added.length

          // Confirmed with the count of what is about to be lost: "restore a
          // checkpoint" and "discard 14 files of work" are the same action, and
          // the user should see the second description.
          if (losing > 0 && context.confirm) {
            const approved = await context.confirm({
              tool: 'checkpoint',
              risk: 'write',
              summary: `Roll back to ${args.id}, discarding changes to ${losing} files`,
              detail: [...changes.modified, ...changes.added].slice(0, 20).join('\n'),
            })
            if (!approved) throw new ToolError('The user declined the rollback.')
          }

          const result = await store.restore(args.id)
          return {
            output: `Restored ${result.restored} files and removed ${result.removed} added since ${args.id}.`,
          }
        }

        default:
          throw new ToolError(`Unknown action "${args.action}".`)
      }
    },
  }
}

/** Resolves a path for the checkpoint store, kept next to the session data. */
export function checkpointRoot(jeanHome: string, cwd: string): string {
  const key = createHash('sha256').update(cwd).digest('hex').slice(0, 12)
  return join(jeanHome, 'checkpoints', key)
}
