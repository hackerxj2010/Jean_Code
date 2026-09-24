/**
 * Whether the agent can reach a model.
 *
 * The version this replaces polled a hosted backend for health, with a backoff
 * and a reconnection banner. Jean has no backend: it talks straight to a model
 * provider with a key from the environment. There is nothing to be connected
 * *to* between requests, so a health check would be either a lie or a paid API
 * call every few seconds.
 *
 * What actually blocks the user is a missing key, and that is answerable
 * locally and instantly. So "connected" here means "a provider key is set" —
 * which is the thing the status line was really trying to tell them.
 *
 * A request can still fail for reasons no poll would have predicted (an expired
 * key, a 402, a provider outage). Those surface on the request itself, next to
 * the message that failed, where they can be acted on.
 */

import { useEffect, useState } from 'react'

import { getAuthTokenDetails } from '../utils/auth'

/**
 * Kept for the callers that import it. The intervals no longer drive polling;
 * only the re-check below uses one.
 */
export const HEALTH_CHECK_CONFIG = {
  INITIAL_INTERVAL: 5_000,
  MAX_INTERVAL: 60_000,
  BACKOFF_MULTIPLIER: 2,
} as const

export function getNextInterval(consecutiveSuccesses: number): number {
  const interval =
    HEALTH_CHECK_CONFIG.INITIAL_INTERVAL *
    HEALTH_CHECK_CONFIG.BACKOFF_MULTIPLIER ** consecutiveSuccesses
  return Math.min(interval, HEALTH_CHECK_CONFIG.MAX_INTERVAL)
}

/** How often the key is re-read, so exporting one mid-session is noticed. */
const RECHECK_MS = 10_000

export const useConnectionStatus = (
  onReconnect?: (isInitialConnection: boolean) => void,
): boolean => {
  const [isConnected, setIsConnected] = useState(() => getAuthTokenDetails().authenticated)

  useEffect(() => {
    let mounted = true
    let previous = isConnected

    const check = () => {
      if (!mounted) return
      const now = getAuthTokenDetails().authenticated

      if (now !== previous) {
        setIsConnected(now)
        // Only a transition into a working state is a reconnection; firing on
        // the way down would replay whatever the caller does on recovery.
        if (now) onReconnect?.(previous === false ? false : true)
        previous = now
      }
    }

    // Cheap enough to poll — it reads a variable — and it means a user who
    // exports a key in another pane is not stuck until they restart.
    const timer = setInterval(check, RECHECK_MS)

    return () => {
      mounted = false
      clearInterval(timer)
    }
    // Deliberately once: re-running on every `isConnected` change would reset
    // the interval each time and defeat the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return isConnected
}
