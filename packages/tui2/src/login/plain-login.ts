/**
 * There is no login.
 *
 * Jean authenticates to a provider with an API key from the environment. This
 * exists so the entry point's import resolves, and tells the user where the
 * credential actually comes from.
 */

export async function runPlainLogin(): Promise<void> {
  process.stdout.write(
    'Jean Code has no account to log into.\n' +
      'Set OPENROUTER_API_KEY (one key reaches every provider) in your environment\n' +
      'or in a .env file at the project root, then run `jean` again.\n',
  )
}
