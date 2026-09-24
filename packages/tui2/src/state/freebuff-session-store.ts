/** See `hooks/use-freebuff-session`: there is no hosted session to store. */

export function useFreebuffSessionStore<T>(selector?: (state: unknown) => T): T | undefined {
  return selector?.({})
}
