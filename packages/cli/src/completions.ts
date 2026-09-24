import { COMMANDS, FLAGS } from './flags.ts'

/**
 * Completion scripts (architecture §25.3).
 *
 * Generated from the same `FLAGS` and `COMMANDS` tables the parser and `--help`
 * read, so completions cannot drift from the actual CLI. Adding a flag updates
 * all three.
 */

export function completionScript(shell: 'bash' | 'zsh' | 'fish'): string {
  switch (shell) {
    case 'bash':
      return bash()
    case 'zsh':
      return zsh()
    case 'fish':
      return fish()
  }
}

const commandNames = () => COMMANDS.map((c) => c.name).join(' ')
const longFlags = () => FLAGS.map((f) => `--${f.long}`).join(' ')

function bash(): string {
  const valueFlags = FLAGS.filter((f) => f.values)
    .map((f) => `    --${f.long}) COMPREPLY=($(compgen -W "${f.values!.join(' ')}" -- "$cur")); return;;`)
    .join('\n')

  return `# jean completions for bash — eval "$(jean completions bash)"
_jean_complete() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  case "$prev" in
${valueFlags}
    --config) COMPREPLY=($(compgen -f -- "$cur")); return;;
  esac

  if [[ "$cur" == -* ]]; then
    COMPREPLY=($(compgen -W "${longFlags()}" -- "$cur"))
  elif [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=($(compgen -W "${commandNames()}" -- "$cur"))
  fi
}
complete -F _jean_complete jean
`
}

function zsh(): string {
  const flagSpecs = FLAGS.map((f) => {
    const short = f.short ? `'-${f.short}' ` : ''
    const values = f.values ? `:value:(${f.values.join(' ')})` : f.type === 'boolean' ? '' : ':value:_files'
    return `    ${short}'--${f.long}[${f.description.replace(/'/g, '')}]${values}'`
  }).join(' \\\n')

  const commandSpecs = COMMANDS.map(
    (c) => `        '${c.name}:${c.description.replace(/'/g, '')}'`,
  ).join('\n')

  return `#compdef jean
# jean completions for zsh — eval "$(jean completions zsh)"
_jean() {
  local -a commands
  commands=(
${commandSpecs}
  )

  _arguments -C \\
${flagSpecs} \\
    '1: :->command' \\
    '*: :_files'

  case $state in
    command) _describe 'command' commands ;;
  esac
}
compdef _jean jean
`
}

function fish(): string {
  const lines: string[] = ['# jean completions for fish — jean completions fish | source', '']

  for (const command of COMMANDS) {
    lines.push(
      `complete -c jean -n __fish_use_subcommand -a ${command.name} -d '${command.description.replace(/'/g, '')}'`,
    )
  }
  lines.push('')

  for (const flag of FLAGS) {
    const short = flag.short ? ` -s ${flag.short}` : ''
    const arg = flag.type === 'boolean' ? '' : ' -r'
    const values = flag.values ? ` -a '${flag.values.join(' ')}'` : ''
    lines.push(
      `complete -c jean${short} -l ${flag.long}${arg}${values} -d '${flag.description.replace(/'/g, '')}'`,
    )
  }

  return lines.join('\n')
}
