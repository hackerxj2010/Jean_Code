import { spawn } from 'node:child_process'

/**
 * Remote files over SSH: `read ssh://deploy@web-1/etc/nginx/nginx.conf`, or
 * the scp form `deploy@web-1:/var/log/app.log`.
 *
 * Through the system `ssh`, so the user's keys, agent, `~/.ssh/config`
 * aliases, and jump hosts all apply exactly as they do in their terminal. In
 * batch mode: a host that would ask for a password or a host-key decision
 * fails at once instead of hanging on a prompt nobody can answer.
 */

export interface SshTarget {
  host: string
  user?: string
  port?: number
  /** The remote path; `~/x` is relative to the remote home. */
  path: string
}

export interface SshRead {
  text: string
  directory: boolean
  /** The file was longer than the limit and was cut. */
  truncated: boolean
}

/**
 * The target a `read` path names, or `undefined` for a local path. Only the
 * two explicit forms count: `C:\x` and `./a:b` are local, and a scp-style
 * path needs its `user@` so a local file with a colon is never sent away.
 */
export function parseSshPath(path: string): SshTarget | undefined {
  const url = /^ssh:\/\/(?:([^@/]+)@)?([^/:[\]]+|\[[^\]]+\])(?::(\d+))?(\/.*)?$/.exec(path)
  if (url) {
    const rest = url[4] ?? '/'
    return {
      user: url[1],
      host: url[2]!.replace(/^\[|\]$/g, ''),
      port: url[3] ? Number(url[3]) : undefined,
      // `ssh://host/~/x` is the home directory's `x`.
      path: rest.startsWith('/~') ? rest.slice(1) : rest,
    }
  }
  const scp = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):(.*)$/.exec(path)
  if (scp && !scp[3]!.startsWith('//')) {
    return { user: scp[1], host: scp[2]!, path: scp[3] || '.' }
  }
  return undefined
}

/** A single-quoted word for the remote POSIX shell, `~/` kept expandable. */
function remoteWord(path: string): string {
  const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`
  if (path === '~') return '"$HOME"'
  if (path.startsWith('~/')) return `"$HOME"/${quote(path.slice(2))}`
  return quote(path)
}

/** The `ssh` arguments that read `target`, at most `maxBytes` of it. */
export function sshCommand(target: SshTarget, maxBytes: number): string[] {
  const destination = target.user ? `${target.user}@${target.host}` : target.host
  const p = remoteWord(target.path)
  // One round trip: a directory is listed, a file sent up to the limit, and
  // the marker line says which it was and how long the file really is.
  const script = `p=${p}; if [ -d "$p" ]; then echo __JEAN_DIR__; ls -la "$p"; elif [ -r "$p" ]; then echo "__JEAN_FILE__ $(wc -c < "$p")"; head -c ${maxBytes} "$p"; else echo "no such readable file: $p" >&2; exit 2; fi`
  return [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    ...(target.port ? ['-p', String(target.port)] : []),
    destination,
    '--',
    script,
  ]
}

export function readSsh(
  target: SshTarget,
  options: { maxBytes?: number; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<SshRead> {
  const maxBytes = options.maxBytes ?? 512 * 1024
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', sshCommand(target, maxBytes), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let err = ''
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 30_000)
    const abort = () => child.kill()
    options.signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`ssh could not start: ${error.message}. Install OpenSSH to read remote files.`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      const raw = Buffer.concat(out).toString('utf8')
      if (code !== 0) {
        reject(new Error(err.trim().split('\n').slice(-3).join(' ') || `ssh exited with ${code}`))
        return
      }
      const newline = raw.indexOf('\n')
      const marker = newline < 0 ? raw : raw.slice(0, newline)
      const body = newline < 0 ? '' : raw.slice(newline + 1)
      if (marker === '__JEAN_DIR__') {
        resolve({ text: body, directory: true, truncated: false })
        return
      }
      const size = Number(/^__JEAN_FILE__\s+(\d+)/.exec(marker)?.[1] ?? Number.NaN)
      resolve({ text: body, directory: false, truncated: Number.isFinite(size) && size > maxBytes })
    })
  })
}
