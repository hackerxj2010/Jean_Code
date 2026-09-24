/**
 * There is no auth service to query.
 *
 * The credential is an environment variable, read synchronously in
 * `utils/auth`. Reporting it as a settled query keeps the call sites, which all
 * branch on `isLoading` and `isError`, on their success path.
 */

import { getAuthTokenDetails } from '../utils/auth'

export const authQueryKeys = { all: ['auth'] as const }

export function useAuthQuery(): {
  data: { authenticated: boolean } | undefined
  isLoading: boolean
  isError: boolean
  error: Error | null
} {
  return {
    data: { authenticated: getAuthTokenDetails().authenticated },
    isLoading: false,
    isError: false,
    error: null,
  }
}
