/**
 * The plugin ships its own settings page: ask dsh not to generate one from
 * the schema (dsh-settings `configure({ auto: false }, fiber)`), when present.
 */
export function ownSettingsPage(ctx) {
    const fiber = ctx.fiber;
    ctx.inject(['settings'], (scope) => {
        const service = scope
            .settings;
        if (typeof service?.configure !== 'function')
            return;
        scope.effect(() => service.configure?.({ auto: false }, fiber) ?? (() => { }), 'subagent concurrency: own settings page');
    });
}
//# sourceMappingURL=own-page.js.map