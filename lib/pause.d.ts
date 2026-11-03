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
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
export declare const name = "subagent-concurrency-pause";
/** The profile entry id the bundle patch gives this row; the settings namespace. */
export declare const ENTRY_ID = "subagent-concurrency-pause";
/** The service the main plugin reads the pause list from. */
export declare const SERVICE = "subagentConcurrencyPause";
/** What the main plugin reads. */
export interface PauseSource {
    /** The paused workspace folders as configured, read live. */
    pausedPaths(): readonly string[];
}
export interface Config {
    pausedWorkspaces?: readonly string[] | {
        get(): readonly string[];
    };
}
export declare const Config: Schema<Schemastery.ObjectS<NoInfer<{
    pausedWorkspaces: Schema<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    pausedWorkspaces: Schema<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
}>>, "plain">;
export declare function apply(ctx: Context, config?: Config): void;
//# sourceMappingURL=pause.d.ts.map