import { create } from 'zustand'

/**
 * The `/models` and `/connect` picker: which view is open, if any. While
 * one is, it takes the place of the prompt, as a question from the agent
 * does.
 */

export type PickerView =
  | { kind: 'models'; only?: string }
  | { kind: 'providers' }
  | { kind: 'key'; provider: string }

interface PickerStore {
  view: PickerView | null
  /** Posts the outcome to the conversation; set by whoever opened the picker. */
  notify?: (text: string) => void
  open: (view: PickerView, notify?: (text: string) => void) => void
  show: (view: PickerView) => void
  close: () => void
}

export const usePickerStore = create<PickerStore>()((set) => ({
  view: null,
  notify: undefined,
  open: (view, notify) => set({ view, notify }),
  show: (view) => set({ view }),
  close: () => set({ view: null, notify: undefined }),
}))
