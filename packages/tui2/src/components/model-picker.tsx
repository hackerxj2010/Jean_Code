import { TextAttributes, type KeyEvent } from '@opentui/core'
import React, { useCallback, useEffect, useMemo, useState } from 'react'

import { saveKey, type ProviderConfig } from '@jean/config'
import { findModel, providerEntry, providerLabel, toggleFavorite } from '@jean/model'

import { MultilineInput } from './multiline-input'
import { SelectableList } from './selectable-list'
import { useSearchableList } from '../hooks/use-searchable-list'
import { useTerminalLayout } from '../hooks/use-terminal-layout'
import { useTheme } from '../hooks/use-theme'
import { usePickerStore } from '../state/picker-store'
import { getCodebuffClient } from '../utils/codebuff-client'
import { matchesQuery, modelRows, providerRows, type PickerRow } from '../utils/model-picker'
import { BORDER_CHARS } from '../utils/ui-constants'

/**
 * The model and provider picker (`/models`, `/connect`), in place of the
 * prompt while it is open.
 *
 *   models     favorites, recent, then every connected provider's models;
 *              Enter uses one, Ctrl+F stars it, Tab lists providers
 *   providers  every provider Jean reaches; Enter on one with a key lists
 *              its models, on one without asks for its key
 *   key        the key, shown as dots; Enter saves it to ~/.jean/auth.json
 */

async function orchestrator() {
  const client = await getCodebuffClient()
  if (!client) throw new Error('The agent is not available.')
  return client.agent()
}

interface Session {
  providers: Record<string, ProviderConfig>
  active: string
}

const MAX_ROWS = 200

export const ModelPicker: React.FC = () => {
  const theme = useTheme()
  const { terminalHeight } = useTerminalLayout()
  const view = usePickerStore((state) => state.view)
  const show = usePickerStore((state) => state.show)
  const close = usePickerStore((state) => state.close)
  const notify = usePickerStore((state) => state.notify)

  const [session, setSession] = useState<Session | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  // Bumped to rebuild the rows after a star or a new key.
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    let live = true
    orchestrator()
      .then((agent) => {
        if (live) setSession({ providers: agent.config.providers, active: `${agent.config.model.provider}:${agent.config.model.modelId}` })
      })
      .catch((error) => setStatus(error instanceof Error ? error.message : String(error)))
    return () => {
      live = false
    }
  }, [view, revision])

  const rows = useMemo<PickerRow[]>(() => {
    if (!session || !view || view.kind === 'key') return []
    return view.kind === 'models' ? modelRows(session.providers, session.active, view.only) : providerRows(session.providers)
    // `revision` rebuilds after a star changed what `favoriteModels()` returns.
  }, [session, view, revision])

  const { searchQuery, setSearchQuery, focusedIndex, setFocusedIndex, filteredItems, handleFocusChange } = useSearchableList({
    items: rows,
    filterFn: matchesQuery,
    resetKey: view ? `${view.kind}:${'only' in view ? view.only ?? '' : ''}` : '',
  })

  const finish = useCallback(
    (text: string) => {
      notify?.(text)
      close()
    },
    [notify, close],
  )

  const choose = useCallback(
    async (row: PickerRow) => {
      if (row.kind === 'action') {
        setSearchQuery('')
        show({ kind: 'providers' })
        return
      }
      if (row.kind === 'model') {
        try {
          const agent = await orchestrator()
          const chosen = agent.setModel(row.id)
          const info = findModel(chosen.modelId, chosen.provider)
          finish(
            `✓ Using **${info?.label ?? chosen.modelId}** from ${providerLabel(chosen.provider)} (\`${row.id}\`) for this session` +
              (info ? ` — ${Math.round(info.contextWindow / 1000)}K context${info.free ? ', free' : info.inputCost !== undefined ? `, $${info.inputCost}/$${info.outputCost} per Mtok` : ''}.` : '.') +
              '\n\nIt is remembered: the next session starts on it unless the config names another.',
          )
        } catch (error) {
          setStatus(error instanceof Error ? error.message : String(error))
        }
        return
      }
      // A provider.
      const entry = session ? providerEntry(row.id, session.providers) : undefined
      if (!entry) return
      setSearchQuery('')
      if (entry.api === undefined) {
        setStatus(`${entry.label} needs its own sign-in, which Jean does not speak yet.`)
      } else if (entry.local || row.icon === '●') {
        show({ kind: 'models', only: entry.id })
      } else {
        show({ kind: 'key', provider: entry.id })
      }
    },
    [finish, session, setSearchQuery, show],
  )

  const onKey = useCallback(
    (key: KeyEvent) => {
      if (key.name === 'escape' || (key.name === 'c' && key.ctrl)) {
        if (searchQuery && key.name === 'escape') setSearchQuery('')
        else close()
        return true
      }
      if (key.name === 'up') {
        setFocusedIndex((index) => Math.max(0, index - 1))
        return true
      }
      if (key.name === 'down') {
        setFocusedIndex((index) => Math.min(Math.min(filteredItems.length, MAX_ROWS) - 1, index + 1))
        return true
      }
      if (key.name === 'pageup' || key.name === 'pagedown') {
        const step = 10 * (key.name === 'pageup' ? -1 : 1)
        setFocusedIndex((index) => Math.max(0, Math.min(Math.min(filteredItems.length, MAX_ROWS) - 1, index + step)))
        return true
      }
      if (key.name === 'tab') {
        setSearchQuery('')
        show(view?.kind === 'providers' ? { kind: 'models' } : { kind: 'providers' })
        return true
      }
      if (key.name === 'f' && key.ctrl) {
        const row = filteredItems[focusedIndex]
        if (row?.kind === 'model') {
          try {
            const starred = toggleFavorite(row.id)
            setStatus(starred ? `★ ${row.id} is a favorite.` : `${row.id} is no longer a favorite.`)
            setRevision((n) => n + 1)
          } catch (error) {
            setStatus(error instanceof Error ? error.message : String(error))
          }
        }
        return true
      }
      if (key.name === 'return' || key.name === 'enter') {
        const row = filteredItems[focusedIndex]
        if (row) void choose(row)
        return true
      }
      return false
    },
    [searchQuery, setSearchQuery, close, setFocusedIndex, filteredItems, focusedIndex, show, view, choose],
  )

  if (!view) return null

  if (view.kind === 'key') {
    return (
      <KeyEntry
        provider={view.provider}
        providers={session?.providers ?? {}}
        onBack={() => show({ kind: 'providers' })}
        onSaved={async (key) => {
          try {
            const path = saveKey(view.provider, key)
            const agent = await orchestrator()
            agent.useProviderKey(view.provider, key)
            setStatus(`✓ Key saved in ${path}. Pick one of ${providerLabel(view.provider)}'s models.`)
            setRevision((n) => n + 1)
            show({ kind: 'models', only: view.provider })
          } catch (error) {
            setStatus(error instanceof Error ? error.message : String(error))
          }
        }}
      />
    )
  }

  const title =
    view.kind === 'providers'
      ? ' Connect a provider '
      : view.only
        ? ` ${providerLabel(view.only)} models `
        : ' Models '
  const hint =
    view.kind === 'providers'
      ? '↑↓ move · Enter connect or list its models · Tab models · Esc close'
      : '↑↓ move · Enter use · Ctrl+F favorite · Tab providers · Esc close'
  const listHeight = Math.max(5, Math.min(18, terminalHeight - 12))

  return (
    <box
      title={title}
      titleAlignment="center"
      style={{ width: '100%', flexDirection: 'column', borderStyle: 'single', borderColor: theme.primary, customBorderChars: BORDER_CHARS }}
    >
      <box style={{ paddingLeft: 1, paddingRight: 1, flexShrink: 0 }}>
        <MultilineInput
          value={searchQuery}
          onChange={({ text }) => setSearchQuery(text)}
          onSubmit={() => {}}
          onPaste={(text) => text && setSearchQuery(searchQuery + text.replace(/\s+/g, ' '))}
          onKeyIntercept={onKey}
          placeholder={view.kind === 'providers' ? 'Search 220+ providers…' : 'Search models — name, provider, "free"…'}
          focused={true}
          maxHeight={1}
          minHeight={1}
          cursorPosition={searchQuery.length}
        />
      </box>
      <SelectableList
        items={filteredItems.slice(0, MAX_ROWS)}
        focusedIndex={focusedIndex}
        maxHeight={listHeight}
        onSelect={(item) => void choose(item as PickerRow)}
        onFocusChange={handleFocusChange}
        emptyMessage={session ? 'Nothing matches.' : 'Loading…'}
      />
      <box style={{ paddingLeft: 1, flexShrink: 0 }}>
        <text style={{ fg: theme.muted }}>
          {status ? `${status}  ·  ` : ''}
          {filteredItems.length > MAX_ROWS ? `${MAX_ROWS} of ${filteredItems.length} shown — type to narrow · ` : ''}
          {hint}
        </text>
      </box>
    </box>
  )
}

/** The key for one provider, never shown: dots as it is typed or pasted. */
const KeyEntry: React.FC<{
  provider: string
  providers: Record<string, ProviderConfig>
  onBack: () => void
  onSaved: (key: string) => void
}> = ({ provider, providers, onBack, onSaved }) => {
  const theme = useTheme()
  const [secret, setSecret] = useState('')
  const entry = providerEntry(provider, providers)

  const onKey = (key: KeyEvent) => {
    if (key.name === 'escape') onBack()
    else if (key.name === 'return' || key.name === 'enter') {
      if (secret.trim()) onSaved(secret.trim())
    } else if (key.name === 'backspace') setSecret((value) => value.slice(0, -1))
    else if (key.name === 'u' && key.ctrl) setSecret('')
    else if (!key.ctrl && !key.meta && key.sequence && key.sequence.length === 1 && key.sequence >= ' ') {
      setSecret((value) => value + key.sequence)
    }
    // Every key is ours: nothing reaches the input, which only shows dots.
    return true
  }

  return (
    <box
      title={` ${entry?.label ?? provider} API key `}
      titleAlignment="center"
      style={{ width: '100%', flexDirection: 'column', borderStyle: 'single', borderColor: theme.primary, customBorderChars: BORDER_CHARS, paddingLeft: 1, paddingRight: 1 }}
    >
      {entry?.doc && <text style={{ fg: theme.muted }}>Keys are made at {entry.doc}</text>}
      <MultilineInput
        value={'•'.repeat(secret.length)}
        onChange={() => {}}
        onSubmit={() => {}}
        onPaste={(text) => text && setSecret((value) => value + text.replace(/\s+/g, ''))}
        onKeyIntercept={onKey}
        placeholder="Paste or type the key"
        focused={true}
        maxHeight={1}
        minHeight={1}
        cursorPosition={secret.length}
      />
      <text style={{ fg: theme.muted, attributes: TextAttributes.DIM }}>
        Enter save to ~/.jean/auth.json · Ctrl+U clear · Esc back{entry?.keyEnv[0] ? ` · or set ${entry.keyEnv[0]}` : ''}
      </text>
    </box>
  )
}
