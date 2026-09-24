/** See `hooks/use-auth-query`. */

import { getAuthTokenDetails } from '../utils/auth'

export function useAuthState(): { isAuthenticated: boolean } {
  return { isAuthenticated: getAuthTokenDetails().authenticated }
}
