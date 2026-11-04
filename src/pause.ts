/**
 * The pause row: holds the list of paused workspaces in its own settings
 * entry and provides it to the main plugin as a service.
 *
 * Pausing is runtime state that the settings page and the composer button
 * write instantly. Keeping it in a separate entry means those writes never
 * move the main entry's settings revision, so they cannot invalidate unsaved
 * edits on the main settings form.
 *
 * @module dsh-subagent-concurrency-limit/pause
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { ownSettingsPage } from './own-page.ts'

export const name = 'subagent-concurrency-pause'
/** The profile entry id the bundle patch gives this row; the settings namespace. */
export const ENTRY_ID = 'subagent-concurrency-pause'
/** The service the main plugin reads the pause list from. */
export const SERVICE = 'subagentConcurrencyPause'

/** What the main plugin reads. */
export interface PauseSource {
  /** The paused workspace folders as configured, read live. */
  pausedPaths(): readonly string[]
}

export interface Config {
  pausedWorkspaces?: readonly string[] | { get(): readonly string[] }
}

export const Config = Schema.object({
  pausedWorkspaces: Schema.array(Schema.string().min(1))
    .default([])
    .description('Paused workspaces (working folders): their agents stop before their next model request.')
    .volatile(),
})

function read(value: Config['pausedWorkspaces']): readonly string[] {
  const list = typeof value === 'object' && value !== null && 'get' in value ? value.get() : value
  return Array.isArray(list) ? list.filter((path): path is string => typeof path === 'string' && path.length > 0) : []
}

export function apply(ctx: Context, config: Config = {}): void {
  // The plugin's settings page and the composer button edit this list.
  ownSettingsPage(ctx)
  let last: readonly string[] = read(config.pausedWorkspaces)
  const source: PauseSource = Object.freeze({
    pausedPaths(): readonly string[] {
      const current = config.pausedWorkspaces
      const raw = typeof current === 'object' && current !== null && 'get' in current ? current.get() : current
      // Keep the same array while nothing changed, so readers can cache by identity.
      if (raw !== undefined && !Array.isArray(raw)) return last
      const next = read(current)
      if (next.length !== last.length || next.some((path, index) => path !== last[index])) last = next
      return last
    },
  })
  ;(ctx as unknown as { provide(name: string, value: unknown): void }).provide(SERVICE, source)
}
