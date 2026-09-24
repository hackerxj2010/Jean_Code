import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { findBinary } from '../packages/native/src/index.ts'
import { createWorktree } from '../packages/subagents/src/index.ts'

/**
 * Sub-agent write isolation.
 *
 * The bug this guards: `spawnSubagent` used to run every agent in the parent's
 * working directory, so two writing agents launched by `fanOut` edited the same
 * files at the same time. Nothing detected it — the second write simply won,
 * and the first agent reported success for work that no longer existed.
 *
 * These drive the worktree layer directly rather than through a model, because
 * the property being checked is about the filesystem, not about what an agent
 * decides to do.
 */

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'jean-iso-'))

  const run = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, stdio: 'pipe', encoding: 'utf8' })

  run('init', '-q')
  run('config', 'user.email', 'test@example.com')
  run('config', 'user.name', 'Test')
  // Commits must not be signed here: a machine with `commit.gpgsign` set would
  // fail on a key this test has no business needing.
  run('config', 'commit.gpgsign', 'false')
  // Git on Windows rewrites line endings on checkout by default, so a file
  // written with LF reads back with CRLF and an exact comparison fails for a
  // reason that has nothing to do with isolation.
  run('config', 'core.autocrlf', 'false')

  writeFileSync(join(root, 'shared.txt'), 'original\n')
  writeFileSync(join(root, 'a.txt'), 'a\n')
  writeFileSync(join(root, 'b.txt'), 'b\n')
  run('add', '.')
  run('commit', '-q', '-m', 'initial')

  return root
}

const GIT_TIMEOUT_MS = 30_000

describe('worktree isolation', () => {
  test(
    'a worktree starts as a copy of the source',
    async () => {
      const root = repo()
      try {
        const tree = await createWorktree(root, 'explorer')
        expect(tree).toBeDefined()
        expect(readFileSync(join(tree!.path, 'shared.txt'), 'utf8')).toBe('original\n')
        await tree!.discard()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    GIT_TIMEOUT_MS,
  )

  test(
    'an edit in a worktree does not touch the source',
    async () => {
      const root = repo()
      try {
        const tree = await createWorktree(root, 'editor')
        writeFileSync(join(tree!.path, 'shared.txt'), 'changed in the worktree\n')

        // The whole point: the parent's copy is untouched while the agent runs.
        expect(readFileSync(join(root, 'shared.txt'), 'utf8')).toBe('original\n')

        await tree!.discard()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    GIT_TIMEOUT_MS,
  )

  test(
    'two agents editing different files both survive the merge',
    async () => {
      // The case that was broken: `fanOut` running two writers in parallel.
      const root = repo()
      try {
        const first = await createWorktree(root, 'first')
        const second = await createWorktree(root, 'second')

        writeFileSync(join(first!.path, 'a.txt'), 'written by the first agent\n')
        writeFileSync(join(second!.path, 'b.txt'), 'written by the second agent\n')

        const one = await first!.finish({ merge: true })
        const two = await second!.finish({ merge: true })

        expect(one.merged).toBe(true)
        expect(two.merged).toBe(true)

        // Both edits are present. Before isolation the second write clobbered
        // whatever the first had produced in the shared directory.
        expect(readFileSync(join(root, 'a.txt'), 'utf8')).toContain('first agent')
        expect(readFileSync(join(root, 'b.txt'), 'utf8')).toContain('second agent')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    GIT_TIMEOUT_MS,
  )

  test(
    'two agents editing the same file conflict rather than one silently winning',
    async () => {
      const root = repo()
      try {
        const first = await createWorktree(root, 'first')
        const second = await createWorktree(root, 'second')

        writeFileSync(join(first!.path, 'shared.txt'), 'the first agent wrote this\n')
        writeFileSync(join(second!.path, 'shared.txt'), 'the second agent wrote this\n')

        const one = await first!.finish({ merge: true })
        expect(one.merged).toBe(true)

        const two = await second!.finish({ merge: true })

        // Refused, not resolved. Guessing which edit was intended is how a merge
        // quietly discards someone's work, and the parent can only act on a
        // conflict it is told about.
        expect(two.merged).toBe(false)
        expect(two.conflicts.length).toBeGreaterThan(0)
        expect(two.message).toBeTruthy()

        // The first agent's work is intact; the second's is not lost either — it
        // is on its branch, which the message names.
        expect(readFileSync(join(root, 'shared.txt'), 'utf8')).toContain('first agent')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    GIT_TIMEOUT_MS,
  )

  test(
    'discarding leaves the source exactly as it was',
    async () => {
      const root = repo()
      try {
        const tree = await createWorktree(root, 'aborted')
        const path = tree!.path

        writeFileSync(join(path, 'shared.txt'), 'work that will be thrown away\n')
        await tree!.discard()

        expect(readFileSync(join(root, 'shared.txt'), 'utf8')).toBe('original\n')
        // The directory goes too: an abandoned worktree per failed spawn would
        // fill the temp directory over a long session.
        expect(existsSync(path)).toBe(false)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    GIT_TIMEOUT_MS,
  )

  test(
    'a worktree sees uncommitted and untracked work from the main tree',
    async () => {
      // The parent agent's own edits this session are uncommitted. A sub-agent
      // working from HEAD would build on code that no longer exists.
      const root = repo()
      try {
        writeFileSync(join(root, 'shared.txt'), 'edited but not committed\n')
        writeFileSync(join(root, 'new-file.txt'), 'created but never added\n')
        const tree = await createWorktree(root, 'fresh')
        expect(readFileSync(join(tree!.path, 'shared.txt'), 'utf8')).toBe(
          'edited but not committed\n',
        )
        expect(readFileSync(join(tree!.path, 'new-file.txt'), 'utf8')).toBe(
          'created but never added\n',
        )
        await tree!.discard()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    GIT_TIMEOUT_MS,
  )

  test(
    'merged work lands uncommitted, and the user’s branch gains no commits',
    async () => {
      const root = repo()
      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim()
      try {
        const before = git('rev-list', '--count', 'HEAD')
        const tree = await createWorktree(root, 'writer')
        writeFileSync(join(tree!.path, 'a.txt'), 'changed by the sub-agent\n')
        writeFileSync(join(tree!.path, 'added.txt'), 'brand new\n')
        rmSync(join(tree!.path, 'b.txt'))
        const result = await tree!.finish({ merge: true })

        expect(result.merged).toBe(true)
        expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('changed by the sub-agent\n')
        expect(readFileSync(join(root, 'added.txt'), 'utf8')).toBe('brand new\n')
        expect(existsSync(join(root, 'b.txt'))).toBe(false)
        expect(git('rev-list', '--count', 'HEAD')).toBe(before)
        expect(git('branch', '--list', 'jean/*')).toBe('')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    GIT_TIMEOUT_MS,
  )

  test(
    'a sub-agent’s change merges onto the parent’s uncommitted edit of another file',
    async () => {
      const root = repo()
      try {
        const tree = await createWorktree(root, 'child')
        writeFileSync(join(root, 'a.txt'), 'the parent kept working\n')
        writeFileSync(join(tree!.path, 'b.txt'), 'the child wrote this\n')
        const result = await tree!.finish({ merge: true })
        expect(result.merged).toBe(true)
        expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('the parent kept working\n')
        expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('the child wrote this\n')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    GIT_TIMEOUT_MS,
  )

  test(
    'installed dependencies are linked in, and survive the worktree being removed',
    async () => {
      // The dangerous case: deleting a worktree must never follow the link into
      // the user's real node_modules.
      const root = repo()
      try {
        writeFileSync(join(root, '.gitignore'), 'node_modules/\n')
        mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true })
        writeFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')

        const discarded = await createWorktree(root, 'deps')
        expect(existsSync(join(discarded!.path, 'node_modules', 'left-pad', 'index.js'))).toBe(true)
        await discarded!.discard()
        expect(existsSync(join(root, 'node_modules', 'left-pad', 'index.js'))).toBe(true)

        const finished = await createWorktree(root, 'deps2')
        writeFileSync(join(finished!.path, 'a.txt'), 'x\n')
        await finished!.finish({ merge: true })
        expect(existsSync(join(root, 'node_modules', 'left-pad', 'index.js'))).toBe(true)

        const conflicted = await createWorktree(root, 'deps3')
        writeFileSync(join(conflicted!.path, 'shared.txt'), 'child\n')
        writeFileSync(join(root, 'shared.txt'), 'parent\n')
        const refused = await conflicted!.finish({ merge: true })
        expect(refused.merged).toBe(false)
        expect(existsSync(join(root, 'node_modules', 'left-pad', 'index.js'))).toBe(true)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    GIT_TIMEOUT_MS,
  )

  test(
    'a repository with no commits yet gets an isolated copy',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'jean-empty-'))
      try {
        execFileSync('git', ['init', '-q'], { cwd: root })
        writeFileSync(join(root, 'a.txt'), 'a\n')
        const tree = await createWorktree(root, 'x')
        expect(tree).toBeDefined()
        expect(tree!.branch).toContain('isolated copy')
        expect(readFileSync(join(tree!.path, 'a.txt'), 'utf8')).toBe('a\n')
        // The copy leaves `.git` behind: it is a view of the files, not the repository.
        expect(existsSync(join(tree!.path, '.git'))).toBe(false)
        await tree!.discard()
        expect(existsSync(tree!.path)).toBe(false)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    GIT_TIMEOUT_MS,
  )
})

/**
 * Outside git, `pi-iso` does what the worktree does inside it: a private copy
 * per sub-agent, merged back only when nothing collides. Before it was wired
 * in, these ran in place — two writing agents in a plain directory edited the
 * same files at the same time.
 */
describe.skipIf(!findBinary())('isolation outside git (pi-iso)', () => {
  function plain(): string {
    const root = mkdtempSync(join(tmpdir(), 'jean-nogit-'))
    writeFileSync(join(root, 'shared.txt'), 'original\n')
    writeFileSync(join(root, 'a.txt'), 'a\n')
    mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
    return root
  }

  test(
    'an edit stays in the copy until it is merged',
    async () => {
      const root = plain()
      try {
        const tree = await createWorktree(root, 'editor')
        expect(tree).toBeDefined()
        writeFileSync(join(tree!.path, 'a.txt'), 'edited\n')
        writeFileSync(join(tree!.path, 'new.txt'), 'fresh\n')

        // Isolation: the main tree has not moved.
        expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('a\n')
        const pending = await tree!.changes()
        expect(pending.files.sort()).toEqual(['a.txt', 'new.txt'])

        const merged = await tree!.finish()
        expect(merged.merged).toBe(true)
        expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('edited\n')
        expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('fresh\n')
        expect(existsSync(tree!.path)).toBe(false)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    GIT_TIMEOUT_MS,
  )

  test(
    'two copies that change the same file do not both land',
    async () => {
      const root = plain()
      try {
        const first = await createWorktree(root, 'first')
        const second = await createWorktree(root, 'second')
        writeFileSync(join(first!.path, 'shared.txt'), 'from first\n')
        writeFileSync(join(second!.path, 'shared.txt'), 'from second\n')

        expect((await first!.finish()).merged).toBe(true)
        const refused = await second!.finish()
        expect(refused.merged).toBe(false)
        expect(refused.conflicts).toEqual(['shared.txt'])
        // The first merge stands; the second wrote nothing.
        expect(readFileSync(join(root, 'shared.txt'), 'utf8')).toBe('from first\n')
        await second!.discard()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    GIT_TIMEOUT_MS,
  )

  test(
    'dependencies are linked, not copied, and survive the copy being deleted',
    async () => {
      const root = plain()
      try {
        const tree = await createWorktree(root, 'deps')
        expect(readFileSync(join(tree!.path, 'node_modules', 'left-pad', 'index.js'), 'utf8')).toContain(
          'module.exports',
        )
        await tree!.discard()
        // Deleting the copy never followed the link into the real directory.
        expect(existsSync(join(root, 'node_modules', 'left-pad', 'index.js'))).toBe(true)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    GIT_TIMEOUT_MS,
  )
})
