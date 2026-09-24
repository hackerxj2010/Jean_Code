import type { ModelRole } from '@jean/config'
import { MODEL_ROLES } from '@jean/config'

/**
 * The ten model roles (architecture §9.2).
 *
 * A role is a *job description*, not a model. Agents request the job; the
 * client resolves it. That is what makes "route editors to Flash and reviewers
 * to Opus" a one-line config change rather than a code change.
 */

export interface RoleDescriptor {
  role: ModelRole
  purpose: string
  /** What the role optimizes for, which is what a user needs to pick a model. */
  wants: 'quality' | 'speed' | 'cost' | 'reasoning' | 'vision'
}

export const ROLES: RoleDescriptor[] = [
  { role: 'default', purpose: 'Main agent turns', wants: 'quality' },
  { role: 'smol', purpose: 'Fast, cheap, high-volume calls', wants: 'speed' },
  { role: 'slow', purpose: 'Deep reasoning on hard problems', wants: 'reasoning' },
  { role: 'plan', purpose: 'Planning and architecture', wants: 'reasoning' },
  { role: 'commit', purpose: 'Commit messages', wants: 'cost' },
  { role: 'vision', purpose: 'Image and screenshot analysis', wants: 'vision' },
  { role: 'designer', purpose: 'UI and UX work', wants: 'quality' },
  { role: 'task', purpose: 'Background and scheduled work', wants: 'cost' },
  { role: 'advisor', purpose: 'Watching the main agent and blocking mistakes', wants: 'reasoning' },
  { role: 'tiny', purpose: 'Trivial classification and extraction', wants: 'cost' },
]

export function isRole(value: string): value is ModelRole {
  return (MODEL_ROLES as readonly string[]).includes(value)
}

export function describeRole(role: ModelRole): RoleDescriptor {
  return ROLES.find((r) => r.role === role) ?? ROLES[0]!
}

export { MODEL_ROLES }
export type { ModelRole }
