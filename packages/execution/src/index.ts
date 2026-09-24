import { spawn } from 'node:child_process'
import type { DockerSecurityConfig, ExecutionBackend, JeanConfig } from '@jean/config'

/**
 * `@jean/execution` — where commands actually run (architecture §14).
 *
 * The local backend is the default and is fully implemented. The Docker backend
 * is implemented by translating the security config into `docker run` flags,
 * which is where the hardening in §14.2 lives. The remote backends (SSH,
 * Daytona, Modal, Singularity) declare their interface and report honestly that
 * they are not wired up yet, rather than silently falling back to local
 * execution — a sandbox that quietly is not one is worse than no sandbox.
 */

export interface ExecOptions {
  cwd: string
  env?: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
  onOutput?: (chunk: string) => void
}

export interface ExecResult {
  stdout: string
  stderr: string
  /** Combined output in the order it was produced. */
  output: string
  exitCode: number | null
  timedOut: boolean
}

export interface Backend {
  readonly name: ExecutionBackend
  /** Whether this backend can run right now on this machine. */
  available(): Promise<boolean>
  exec(command: string, options: ExecOptions): Promise<ExecResult>
}

/** Runs commands directly on the user's machine. The default. */
export class LocalBackend implements Backend {
  readonly name = 'local' as const

  async available(): Promise<boolean> {
    return true
  }

  async exec(command: string, options: ExecOptions): Promise<ExecResult> {
    const shell = process.platform === 'win32' ? process.env.SHELL ?? 'bash' : '/bin/bash'
    return spawnCollect(shell, ['-c', command], options)
  }
}

/**
 * Runs commands inside a container, with the hardening from §14.2 applied.
 *
 * The project directory is bind-mounted so edits are visible on the host; the
 * container filesystem itself is read-only, which is the point — a command can
 * change the code it was asked to change and nothing else.
 */
export class DockerBackend implements Backend {
  readonly name = 'docker' as const

  constructor(
    private readonly image: string,
    private readonly security: DockerSecurityConfig = {},
  ) {}

  async available(): Promise<boolean> {
    const probe = await spawnCollect('docker', ['version', '--format', '{{.Server.Version}}'], {
      cwd: process.cwd(),
      timeoutMs: 5000,
    })
    return probe.exitCode === 0
  }

  /** Translates the security config into `docker run` flags. */
  flags(cwd: string): string[] {
    const args = ['run', '--rm', '-i', '-v', `${cwd}:/workspace`, '-w', '/workspace']

    if (this.security.readOnlyRoot !== false) {
      args.push('--read-only')
      // A read-only root with no writable temp breaks almost every toolchain,
      // so /tmp is a tmpfs rather than part of the image.
      args.push('--tmpfs', '/tmp:rw,noexec,nosuid,size=512m')
    }
    if (this.security.dropCapabilities !== false) {
      args.push('--cap-drop', 'ALL')
      // Without this a process can still gain privileges through setuid
      // binaries already in the image.
      args.push('--security-opt', 'no-new-privileges')
    }
    if (this.security.pidLimit) {
      args.push('--pids-limit', String(this.security.pidLimit))
    }
    if (this.security.network === false) {
      args.push('--network', 'none')
    }

    return args
  }

  async exec(command: string, options: ExecOptions): Promise<ExecResult> {
    const args = [...this.flags(options.cwd)]
    for (const [key, value] of Object.entries(options.env ?? {})) {
      args.push('-e', `${key}=${value}`)
    }
    args.push(this.image, 'sh', '-c', command)
    return spawnCollect('docker', args, options)
  }
}

/** A backend whose transport is specified but not yet implemented. */
class UnimplementedBackend implements Backend {
  constructor(
    readonly name: ExecutionBackend,
    private readonly reason: string,
  ) {}

  async available(): Promise<boolean> {
    return false
  }

  async exec(): Promise<ExecResult> {
    const message = `The ${this.name} execution backend is not implemented yet (${this.reason}). Commands were not run. Use \`--execution local\` or \`--execution docker\`.`
    return { stdout: '', stderr: message, output: message, exitCode: 1, timedOut: false }
  }
}

/** Builds the backend named by the config. */
export function createBackend(config: JeanConfig): Backend {
  const backend = config.execution.backend ?? 'local'
  switch (backend) {
    case 'local':
      return new LocalBackend()
    case 'docker':
      return new DockerBackend(
        config.execution.docker?.image ?? 'node:20-slim',
        config.execution.docker?.security ?? {},
      )
    case 'ssh':
      return new UnimplementedBackend('ssh', 'needs a persistent SSH multiplexed session')
    case 'daytona':
      return new UnimplementedBackend('daytona', 'needs the Daytona workspace API')
    case 'modal':
      return new UnimplementedBackend('modal', 'needs the Modal sandbox API')
    case 'singularity':
      return new UnimplementedBackend('singularity', 'needs an HPC scheduler integration')
  }
}

/** Spawns a process and collects its output, honouring timeout and abort. */
export function spawnCollect(
  file: string,
  args: string[],
  options: ExecOptions,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false,
    })

    let stdout = ''
    let stderr = ''
    let output = ''
    let settled = false

    const finish = (exitCode: number | null, timedOut: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve({ stdout, stderr, output, exitCode, timedOut })
    }

    const timer = setTimeout(
      () => {
        child.kill('SIGKILL')
        finish(null, true)
      },
      options.timeoutMs ?? 120_000,
    )

    const onAbort = () => {
      child.kill('SIGKILL')
      finish(null, false)
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      stdout += text
      output += text
      options.onOutput?.(text)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      stderr += text
      output += text
      options.onOutput?.(text)
    })

    child.on('error', (err) => {
      stderr += `failed to start ${file}: ${err.message}`
      output += stderr
      finish(127, false)
    })
    child.on('close', (code) => finish(code, false))
  })
}

export type { ExecutionBackend }
