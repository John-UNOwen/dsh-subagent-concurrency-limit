/**
 * Process-local FIFO limit for DeepSeek Harness subagent turns.
 *
 * @module dsh-subagent-concurrency-limit
 */
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
export declare const name = "subagent-concurrency-limit";
export declare const inject: string[];
/** The read-only status route the settings page and the composer button call. */
export declare const CHANNEL = "/subagent-concurrency-limit";
/** A config value as written, or the live reference the Loader passes for a volatile field. */
export type Live<T> = T | {
    get(): T;
};
/** Plugin configuration. Every field is volatile: edits apply live, without a restart. */
export interface Config {
    /** Maximum local non-root turns and observable remote runs at once. */
    maxConcurrentSubagents?: Live<number>;
    /** How long a pool wait may stay queued before failing loudly, in milliseconds. */
    queueTimeoutMs?: Live<number>;
    /** Delegation tool names whose calls are limited. */
    subagentToolNames?: Live<readonly string[]>;
    /** Let only one agent (root included) generate at a time; a parent pauses while its child runs. */
    baton?: Live<boolean>;
    /** In baton mode, how long the holder may sit in tool calls before a non-descendant may borrow the baton. */
    lendAfterMs?: Live<number>;
    /**
     * In baton mode, hand the baton to a waiting agent of the same project
     * (session working folder) first, unless another project's agent has waited
     * this long. 0 turns the preference off (plain first come, first served).
     */
    projectPriorityMs?: Live<number>;
    /**
     * Pause a workspace whose agent has waited this long for the user's answer,
     * so other workspaces use the model meanwhile; the answer resumes it. 0
     * turns this off.
     */
    pauseUnansweredAfterMs?: Live<number>;
    /** What counts as waiting for the user: `questions` (ask_user_question) or also tool approvals. */
    pauseUnansweredOn?: Live<'questions' | 'questions-and-approvals'>;
    /**
     * Per-provider lanes. Each listed provider gets its own baton and pool;
     * unset fields inherit the top-level ones. When empty, one global lane
     * covers every agent. When not empty, unlisted providers are not limited.
     */
    providers?: Live<Readonly<Record<string, ProviderConfig>>>;
}
/** One provider lane's overrides. */
export interface ProviderConfig {
    /** Share a lane with other providers that name the same lane (one server, several provider ids). */
    lane?: string;
    baton?: boolean;
    maxConcurrentSubagents?: number;
    lendAfterMs?: number;
}
/** Config schema. Volatile fields show up in dsh settings and on the Plugins page. */
export declare const Config: Schema<Schemastery.ObjectS<NoInfer<{
    baton: Schema<boolean, boolean, "volatile-defined">;
    projectPriorityMs: Schema<number, number, "volatile-defined">;
    lendAfterMs: Schema<number, number, "volatile-defined">;
    pauseUnansweredAfterMs: Schema<number, number, "volatile-defined">;
    pauseUnansweredOn: Schema<"questions" | "questions-and-approvals", "questions" | "questions-and-approvals", "volatile-defined">;
    maxConcurrentSubagents: Schema<number, number, "volatile-defined">;
    queueTimeoutMs: Schema<number, number, "volatile-defined">;
    providers: Schema<NoInfer<Record<string, ProviderConfig>>, NoInfer<Record<string, ProviderConfig>>, "volatile-defined">;
    subagentToolNames: Schema<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    baton: Schema<boolean, boolean, "volatile-defined">;
    projectPriorityMs: Schema<number, number, "volatile-defined">;
    lendAfterMs: Schema<number, number, "volatile-defined">;
    pauseUnansweredAfterMs: Schema<number, number, "volatile-defined">;
    pauseUnansweredOn: Schema<"questions" | "questions-and-approvals", "questions" | "questions-and-approvals", "volatile-defined">;
    maxConcurrentSubagents: Schema<number, number, "volatile-defined">;
    queueTimeoutMs: Schema<number, number, "volatile-defined">;
    providers: Schema<NoInfer<Record<string, ProviderConfig>>, NoInfer<Record<string, ProviderConfig>>, "volatile-defined">;
    subagentToolNames: Schema<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
}>>, "plain">;
export declare function apply(ctx: Context, config?: Config): void;
//# sourceMappingURL=index.d.ts.map