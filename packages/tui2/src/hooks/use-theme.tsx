/**
 * Theme Hooks
 *
 * Simple hooks for accessing theme from zustand store
 */

import { loadConfig } from '@jean/config'
import { create } from 'zustand'

import { isThemeName } from '../types/theme-system'
import { getCliEnv } from '../utils/env'
import { themeConfig, buildTheme } from '../utils/theme-config'
import {
  chatThemes,
  cloneChatTheme,
  detectIDETheme,
  detectPlatformTheme,
  detectTerminalOverrides,
  getOscDetectedTheme,
  initializeThemeWatcher,
  setThemeResolver,
  setLastDetectedTheme,
  setupFileWatchers,
} from '../utils/theme-system'

import type { ChatTheme, ThemeMode, ThemeName } from '../types/theme-system'
import type { StoreApi, UseBoundStore } from 'zustand'

type ThemeStore = {
  theme: ChatTheme
  /** Follows the system; ignored once the user has picked a theme. */
  setThemeName: (name: ThemeName) => void
  /** The user's own choice, which system changes no longer override. */
  selectTheme: (name: ThemeName) => void
}

export let useThemeStore: UseBoundStore<StoreApi<ThemeStore>> = (() => {
  throw new Error('useThemeStore not initialized')
}) as any
let themeStoreInitialized = false

type ThemeDetector = {
  description: string
  detect: () => ThemeMode | null
}

const THEME_PRIORITY: ThemeDetector[] = [
  {
    description: 'Terminal override (e.g., OPENAI_THEME)',
    detect: detectTerminalOverrides,
  },
  {
    description: 'IDE configuration (VS Code, JetBrains, Zed)',
    detect: detectIDETheme,
  },
  {
    description: 'OSC terminal colors',
    detect: () => getOscDetectedTheme(),
  },
  {
    description: 'Operating system theme',
    detect: detectPlatformTheme,
  },
]

/**
 * A theme the user named: `OPEN_TUI_THEME` first, then `ui.theme` in the
 * config. Null means follow the system.
 */
const explicitTheme = (): ThemeName | null => {
  const env = getCliEnv()
  const fromEnv = (env.OPEN_TUI_THEME ?? env.OPENTUI_THEME)?.trim().toLowerCase()
  if (fromEnv && isThemeName(fromEnv)) return fromEnv

  try {
    const fromConfig = loadConfig().config.ui.theme.trim().toLowerCase()
    if (isThemeName(fromConfig)) return fromConfig
  } catch {
    // An unreadable config already reports itself elsewhere; detect instead.
  }
  return null
}

export const detectSystemTheme = (): ThemeMode => {
  const env = getCliEnv()
  const envPreference = env.OPEN_TUI_THEME ?? env.OPENTUI_THEME
  const normalizedEnv = envPreference?.toLowerCase()

  if (normalizedEnv === 'dark' || normalizedEnv === 'light') {
    return normalizedEnv
  }

  const preferredTheme = (): ThemeMode => {
    for (const detector of THEME_PRIORITY) {
      const result = detector.detect()
      if (result) {
        return result
      }
    }
    return 'dark'
  }

  const resolved = preferredTheme()

  if (normalizedEnv === 'opposite') {
    return resolved === 'dark' ? 'light' : 'dark'
  }

  return resolved
}

export function initializeThemeStore() {
  if (themeStoreInitialized) {
    return
  }
  themeStoreInitialized = true

  setThemeResolver(detectSystemTheme)
  setupFileWatchers()

  const detected = detectSystemTheme()
  setLastDetectedTheme(detected)
  const chosen = explicitTheme()
  // A named theme stays put when the system flips between light and dark.
  let pinned = chosen !== null

  const themeFor = (name: ThemeName): ChatTheme => {
    const baseTheme = cloneChatTheme(chatThemes[name])
    return buildTheme(
      baseTheme,
      baseTheme.mode,
      themeConfig.customColors,
      themeConfig.plugins,
    )
  }

  useThemeStore = create<ThemeStore>((set, get) => ({
    theme: themeFor(chosen ?? detected),

    setThemeName: (name: ThemeName) => {
      if (pinned || get().theme.name === name) return
      set({ theme: themeFor(name) })
    },

    selectTheme: (name: ThemeName) => {
      pinned = true
      if (get().theme.name === name) return
      set({ theme: themeFor(name) })
    },
  }))

  // Set up the theme watcher for reactive updates when system theme changes
  initializeThemeWatcher((name: ThemeMode) => {
    useThemeStore.getState().setThemeName(name)
  })

  // Note: OSC detection is done earlier in index.tsx before OpenTUI starts,
  // so the result is already available via getOscDetectedTheme()
}

export const useTheme = (): ChatTheme => {
  return useThemeStore((state) => state.theme)
}
