import type { Context } from '@deepseek-ai/cordis'

/**
 * The plugin ships its own settings page: ask dsh not to generate one from
 * the schema (dsh-settings `configure({ auto: false }, fiber)`), when present.
 */
export function ownSettingsPage(ctx: Context): void {
  const fiber = (ctx as unknown as { fiber?: unknown }).fiber
  ctx.inject(['settings'], (scope) => {
    const service = (scope as unknown as { settings?: { configure?: (policy: object, owner?: unknown) => () => void } })
      .settings
    if (typeof service?.configure !== 'function') return
    scope.effect(
      () => service.configure?.({ auto: false }, fiber) ?? (() => {}),
      'subagent concurrency: own settings page',
    )
  })
}
