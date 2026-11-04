/**
 * Process-local FIFO limit for DeepSeek Harness subagent turns.
 *
 * @module dsh-subagent-concurrency-limit
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import { type PauseSource, SERVICE as PAUSE_SERVICE } from './pause.ts'
import { mountRpcChannel, type RpcChannelResult } from './rpc-channel.ts'

export const name = 'subagent-concurrency-limit'
export const inject = ['tools']

const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 2
const DEFAULT_QUEUE_TIMEOUT_MS = 300_000
const DEFAULT_LEND_AFTER_MS = 30_000
const DEFAULT_PROJECT_PRIORITY_MS = 600_000
/** The read-only status route the settings page and the composer button call. */
export const CHANNEL = '/subagent-concurrency-limit'
/** How often a held agent, or a waiter behind a holder in a tool, re-checks the pause list. */
const DEFAULT_PAUSE_POLL_MS = 1_000
/** How long a successful delegation may wait for its run to be published. */
const DEFAULT_PENDING_RESERVATION_MS = 10_000
/** Node fires any longer timer after 1 ms, so every wait is clamped to this. */
const MAX_TIMER_MS = 2_147_483_647

/** A config value as written, or the live reference the Loader passes for a volatile field. */
export type Live<T> = T | { get(): T }

/** Plugin configuration. Every field is volatile: edits apply live, without a restart. */
export interface Config {
  /** Maximum local non-root turns and observable remote runs at once. */
  maxConcurrentSubagents?: Live<number>
  /** How long a pool wait may stay queued before failing loudly, in milliseconds. */
  queueTimeoutMs?: Live<number>
  /** Delegation tool names whose calls are limited. */
  subagentToolNames?: Live<readonly string[]>
  /** Let only one agent (root included) generate at a time; a parent pauses while its child runs. */
  baton?: Live<boolean>
  /** In baton mode, how long the holder may sit in tool calls before a non-descendant may borrow the baton. */
  lendAfterMs?: Live<number>
  /**
   * In baton mode, hand the baton to a waiting agent of the same project
   * (session working folder) first, unless another project's agent has waited
   * this long. 0 turns the preference off (plain first come, first served).
   */
  projectPriorityMs?: Live<number>
  /**
   * Per-provider lanes. Each listed provider gets its own baton and pool;
   * unset fields inherit the top-level ones. When empty, one global lane
   * covers every agent. When not empty, unlisted providers are not limited.
   */
  providers?: Live<Readonly<Record<string, ProviderConfig>>>
  /**
   * Paused workspaces (session working folders). An agent of a paused
   * workspace finishes its current model call and tool calls, then waits
   * before its next model request; with the baton on it gives the baton up.
   * Paths match case- and slash-insensitively; subagents belong to their
   * parent's workspace. Removing a path puts the workspace back in the queue.
   *
   * Normally set on the separate pause row (`subagent-concurrency-pause`,
   * inserted by the bundle patch), which the settings page and the composer
   * button write; this option is used only when that row is not mounted.
   */
  pausedWorkspaces?: Live<readonly string[]>
  /** Internal: how often pause changes are re-checked, in milliseconds. */
  pausePollMs?: Live<number>
  /** Internal: how long an unpublished delegation keeps its permit, in milliseconds. */
  pendingReservationMs?: Live<number>
}

/** One provider lane's overrides. */
export interface ProviderConfig {
  /** Share a lane with other providers that name the same lane (one server, several provider ids). */
  lane?: string
  baton?: boolean
  maxConcurrentSubagents?: number
  lendAfterMs?: number
}

const providerLanes: Schema<Record<string, ProviderConfig>> = Schema.dict(
  Schema.object({
    lane: Schema.string().min(1),
    baton: Schema.boolean(),
    maxConcurrentSubagents: Schema.natural().min(1).max(Number.MAX_SAFE_INTEGER),
    lendAfterMs: Schema.natural().max(Number.MAX_SAFE_INTEGER),
  }),
)

/** Config schema. Volatile fields show up in dsh settings and on the Plugins page. */
export const Config = Schema.object({
  baton: Schema.boolean()
    .default(false)
    .description('Only one agent, the root included, generates at a time.')
    .volatile(),
  projectPriorityMs: Schema.natural()
    .max(Number.MAX_SAFE_INTEGER)
    .default(DEFAULT_PROJECT_PRIORITY_MS)
    .description(
      'Baton mode: prefer the same project when handing the baton on, for up to this many milliseconds per waiting agent of another project; 0 turns it off.',
    )
    .volatile(),
  lendAfterMs: Schema.natural()
    .max(Number.MAX_SAFE_INTEGER)
    .default(DEFAULT_LEND_AFTER_MS)
    .description('Baton mode: milliseconds the holder may spend in tools before another agent may borrow the baton.')
    .volatile(),
  maxConcurrentSubagents: Schema.natural()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .default(DEFAULT_MAX_CONCURRENT_SUBAGENTS)
    .description('Maximum live child runs and turns at once.')
    .volatile(),
  queueTimeoutMs: Schema.natural()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .default(DEFAULT_QUEUE_TIMEOUT_MS)
    .description('How long a pool wait may stay queued, in milliseconds.')
    .volatile(),
  providers: providerLanes
    .default({})
    .description(
      'Per-provider lanes: each listed provider gets its own baton and limit; unlisted providers run freely.',
    )
    .volatile(),
  subagentToolNames: Schema.array(Schema.string().min(1))
    .min(1)
    .default(['subagent'])
    .description('Delegation tool names whose calls are limited.')
    .volatile(),
})

interface Waiter {
  readonly key: object
  readonly signal: AbortSignal
  readonly resolve: () => void
  readonly reject: (reason?: unknown) => void
  readonly abort: () => void
  timeout?: ReturnType<typeof setTimeout>
}

class ConcurrencyGate {
  private readonly active = new Set<object>()
  /**
   * Keys admitted over the limit (baton mode, nested delegation). The baton
   * already keeps them from generating alongside anyone, so they do not count
   * against the limit: counting them would starve queued root delegations.
   */
  private readonly forced = new Set<object>()
  private readonly waiters: Waiter[] = []
  private readonly limit: () => number
  private closed = false

  constructor(limit: () => number) {
    this.limit = limit
  }

  /** Admit waiters a raised limit now has room for. */
  pump(): void {
    while (!this.closed && this.waiters.length > 0 && this.hasRoom()) this.admitNext()
  }

  /** Whether one more key fits under the limit, not counting forced keys. */
  private hasRoom(): boolean {
    return this.active.size - this.forced.size < this.limit()
  }

  async enter(key: object, signal: AbortSignal, timeoutMs: number): Promise<void> {
    if (this.active.has(key)) return
    signal.throwIfAborted()
    if (this.closed) throw new Error('subagent concurrency limit is disposed')

    if (this.hasRoom() && this.waiters.length === 0) {
      this.active.add(key)
      return
    }

    const timeoutError = new Error(`subagent concurrency limit queue timeout after ${timeoutMs}ms`)
    try {
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          key,
          signal,
          resolve,
          reject,
          abort: () => {
            const index = this.waiters.indexOf(waiter)
            if (index >= 0) this.waiters.splice(index, 1)
            this.clearWaiterTimeout(waiter)
            reject(signal.reason)
          },
        }
        const delay = Math.min(timeoutMs, MAX_TIMER_MS)
        waiter.timeout = setTimeout(() => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          signal.removeEventListener('abort', waiter.abort)
          reject(timeoutError)
        }, delay)
        signal.addEventListener('abort', waiter.abort, { once: true })
        this.waiters.push(waiter)
      })
      signal.throwIfAborted()
    } catch (error) {
      // The listener is removed at admission, so abort can race this continuation.
      this.release(key)
      throw error
    }
  }

  /** Admit without queueing. Used by nested delegation to avoid deadlock. */
  tryEnter(key: object, signal: AbortSignal): boolean {
    if (this.active.has(key)) return true
    signal.throwIfAborted()
    if (this.closed) throw new Error('subagent concurrency limit is disposed')
    if (this.waiters.length > 0 || !this.hasRoom()) return false
    this.active.add(key)
    return true
  }

  /** Admit over the limit. Baton mode uses it for nested delegation, which cannot add a generator. */
  forceEnter(key: object): void {
    if (this.closed) throw new Error('subagent concurrency limit is disposed')
    if (this.active.has(key)) return
    this.active.add(key)
    this.forced.add(key)
  }

  release(key: object): void {
    if (!this.active.delete(key)) return
    this.forced.delete(key)
    // Only admit while under the limit: forced admissions or a lowered limit
    // can leave the pool above it.
    this.pump()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.active.clear()
    this.forced.clear()
    const error = new Error('subagent concurrency limit is disposed')
    for (const waiter of this.waiters.splice(0)) {
      waiter.signal.removeEventListener('abort', waiter.abort)
      this.clearWaiterTimeout(waiter)
      waiter.reject(error)
    }
  }

  private admitNext(): void {
    const waiter = this.waiters.shift()
    if (waiter === undefined) return
    waiter.signal.removeEventListener('abort', waiter.abort)
    this.clearWaiterTimeout(waiter)
    this.active.add(waiter.key)
    waiter.resolve()
  }

  private clearWaiterTimeout(waiter: Waiter): void {
    if (waiter.timeout === undefined) return
    clearTimeout(waiter.timeout)
    waiter.timeout = undefined
  }
}

interface BatonWaiter {
  readonly id: string
  readonly signal: AbortSignal
  readonly resolve: () => void
  readonly reject: (reason?: unknown) => void
  readonly abort: () => void
  /** When the agent started waiting, or rejoined the queue after an unpause, for project priority. */
  since: number
  /** Queue order; renewed when the agent's workspace is unpaused. */
  seq: number
  /** Whether the agent's workspace was paused when last checked. */
  paused: boolean
}

/**
 * A paused workspace's share of the baton's order, set aside until it is
 * unpaused. Parents and children keep their relative order inside it, but it
 * holds no place among other workspaces: once unpaused it queues like a waiter
 * that arrived then, and is put back as a unit when its turn comes.
 */
interface ParkedFrame {
  readonly project: string
  /** Its suspended-stack entries, bottom to top; a parked owner is on top. */
  readonly stack: string[]
  readonly lenders: Set<string>
  readonly delegated: Map<string, string[]>
  paused: boolean
  since: number
  seq: number
}

type Candidate =
  | { readonly kind: 'waiter'; readonly waiter: BatonWaiter }
  | { readonly kind: 'frame'; readonly frame: ParkedFrame }

interface BatonOptions {
  lendAfterMs: () => number
  projectOf?: (id: string) => string | undefined
  projectPriorityMs?: () => number
  /** Whether a workspace (normalized project key) is paused right now. */
  isPaused?: (project: string) => boolean
  /** How often to re-check while someone waits on a holder in a tool, or on a pause. */
  pollMs?: () => number
}

/**
 * One global generation permit. Exactly one agent may enter a step at a time.
 *
 * The owner keeps the baton across its steps until it goes idle, so agents do
 * not interleave on a single-slot server. A delegation hands the baton to the
 * child and suspends the parent; siblings delegated by a suspended parent run
 * before the parent resumes.
 *
 * While the owner is inside a tool call it is not generating, so a waiting
 * agent may borrow the baton: a descendant at once (the owner may be waiting on
 * it, for example a workflow agent, so this avoids deadlock), anyone else only
 * after the owner has spent `lendAfterMs` in tools. Short tool calls therefore
 * keep the baton, and the prompt cache, with the agent that made them.
 *
 * A paused workspace never receives the baton. Its share of the order is
 * parked (see ParkedFrame) as soon as none of its agents is generating: an
 * owner in a tool or held at the pause gate gives the baton up at once.
 */
class Baton {
  private owner: string | undefined
  private readonly suspended: string[] = []
  /** Suspended agents that lent the baton out (rather than handing it to their child). */
  private readonly lenders = new Set<string>()
  private readonly delegated = new Map<string, string[]>()
  private readonly waiters: BatonWaiter[] = []
  private readonly inTools = new Map<string, number>()
  private readonly toolSince = new Map<string, number>()
  private readonly depths = new Map<string, number>()
  private readonly parents = new Map<string, string>()
  /** Order in which each agent first asked for the baton (see `clock`). */
  private readonly firstSeen = new Map<string, number>()
  /** Order in which each agent's current run of tool calls began. */
  private readonly toolOrder = new Map<string, number>()
  /** Agents held at the pause gate: not generating, like an agent in a tool. */
  private readonly held = new Set<string>()
  /** Parked order of paused workspaces, by project. */
  private readonly frames = new Map<string, ParkedFrame>()
  /** A counter ordering first asks, tool starts and queue places; clock times can tie. */
  private clock = 0
  private readonly lendAfterMs: () => number
  private readonly projectOf: (id: string) => string | undefined
  private readonly projectPriorityMs: () => number
  private readonly isPaused: (project: string) => boolean
  private readonly pollMs: () => number
  /** Project of the agent that last gave the baton up. */
  private lastProject: string | undefined
  private lendTimer: ReturnType<typeof setTimeout> | undefined
  private closed = false

  constructor(options: BatonOptions) {
    this.lendAfterMs = options.lendAfterMs
    this.projectOf = options.projectOf ?? (() => undefined)
    this.projectPriorityMs = options.projectPriorityMs ?? (() => 0)
    this.isPaused = options.isPaused ?? (() => false)
    this.pollMs = options.pollMs ?? (() => DEFAULT_PAUSE_POLL_MS)
  }

  async acquire(id: string, signal: AbortSignal, depth: number): Promise<void> {
    signal.throwIfAborted()
    if (this.closed) throw new Error('subagent baton is disposed')
    this.depths.set(id, depth)
    if (!this.firstSeen.has(id)) this.firstSeen.set(id, ++this.clock)
    // A step runs only after the previous step's tool calls settled, so any
    // tool count left here is a leak; clearing it keeps lending honest.
    this.inTools.delete(id)
    this.toolSince.delete(id)
    this.toolOrder.delete(id)
    if (this.owner === id) return
    if (this.owner === undefined && this.eligible(id) && !this.hasUnpausedFrame()) {
      this.owner = id
      return
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: BatonWaiter = {
        id,
        since: Date.now(),
        seq: ++this.clock,
        paused: this.pausedId(id),
        signal,
        resolve,
        reject,
        abort: () => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          reject(signal.reason)
        },
      }
      signal.addEventListener('abort', waiter.abort, { once: true })
      this.waiters.push(waiter)
      // Hands over a free baton, lets this agent borrow at once if it may, and
      // starts the lend clock if the owner is already in a tool.
      this.settle()
    })
  }

  /**
   * The parent's delegation published a local child: the baton follows it.
   * A publish can land after the delegating call returned (background jobs),
   * while the parent generates its next step. The baton then stays with the
   * parent; the child, now a known descendant, borrows it as soon as the
   * parent enters a tool, or takes it when the parent goes idle.
   */
  handoff(parent: string, child: string): void {
    if (parent === child || this.closed) return
    this.parents.set(child, parent)
    if (this.owner === parent && this.busyInTools(parent)) {
      this.suspended.push(parent)
      this.lenders.delete(parent)
      this.owner = child
      this.settle()
    } else if (this.suspended.includes(parent)) {
      this.queueChild(this.delegated, parent, child)
    } else {
      // The parent's place is parked with its paused workspace: the child
      // joins it there, so it still runs before its parent after unpause.
      for (const frame of this.frames.values()) {
        if (frame.stack.includes(parent)) this.queueChild(frame.delegated, parent, child)
      }
    }
  }

  private queueChild(delegated: Map<string, string[]>, parent: string, child: string): void {
    let queue = delegated.get(parent)
    if (queue === undefined) {
      queue = []
      delegated.set(parent, queue)
    }
    if (!queue.includes(child)) queue.push(child)
  }

  toolStart(id: string): void {
    const count = this.inTools.get(id) ?? 0
    if (count === 0) {
      this.toolSince.set(id, Date.now())
      this.toolOrder.set(id, ++this.clock)
    }
    this.inTools.set(id, count + 1)
    if (this.owner === id) this.settle()
  }

  toolEnd(id: string): void {
    const count = (this.inTools.get(id) ?? 0) - 1
    if (count > 0) {
      this.inTools.set(id, count)
    } else {
      this.inTools.delete(id)
      this.toolSince.delete(id)
      this.toolOrder.delete(id)
    }
  }

  /** The agent is held at the pause gate: an owner gives the baton up. */
  hold(id: string): void {
    this.held.add(id)
    this.settle()
  }

  unhold(id: string): void {
    this.held.delete(id)
  }

  /** Re-read pause state now, instead of at the next event or poll. */
  refresh(): void {
    if (!this.closed) this.settle()
  }

  /** The agent went idle or its run ended: it no longer needs the baton. */
  release(id: string): void {
    const index = this.suspended.indexOf(id)
    if (index >= 0) this.suspended.splice(index, 1)
    this.lenders.delete(id)
    // An idle agent is owed nothing: a queued child that already ran (by
    // borrowing) would otherwise be handed the baton and never step.
    for (const [parent, queue] of this.delegated) {
      const queued = queue.indexOf(id)
      if (queued >= 0) queue.splice(queued, 1)
      if (queue.length === 0) this.delegated.delete(parent)
    }
    this.removeFromFrames(id)
    if (this.owner !== id) return
    this.lastProject = this.projectOf(id)
    this.owner = undefined
    this.settle()
  }

  disposed(id: string): void {
    this.delegated.delete(id)
    for (const queue of this.delegated.values()) {
      const index = queue.indexOf(id)
      if (index >= 0) queue.splice(index, 1)
    }
    this.inTools.delete(id)
    this.toolSince.delete(id)
    this.toolOrder.delete(id)
    this.depths.delete(id)
    this.firstSeen.delete(id)
    this.parents.delete(id)
    this.held.delete(id)
    this.release(id)
  }

  /** Baton mode was switched: forget ownership and let every waiter through. */
  reset(): void {
    this.clearLendTimer()
    this.owner = undefined
    this.suspended.length = 0
    this.lenders.clear()
    this.delegated.clear()
    this.frames.clear()
    for (const waiter of this.waiters.splice(0)) {
      waiter.signal.removeEventListener('abort', waiter.abort)
      waiter.resolve()
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.clearLendTimer()
    this.owner = undefined
    this.frames.clear()
    const error = new Error('subagent baton is disposed')
    for (const waiter of this.waiters.splice(0)) {
      waiter.signal.removeEventListener('abort', waiter.abort)
      waiter.reject(error)
    }
  }

  /** Read-only view for the workspaces route. */
  snapshot(): { owner: string | undefined; waiting: readonly string[]; parked: readonly string[] } {
    return {
      owner: this.owner,
      waiting: this.waiters.map((waiter) => waiter.id),
      parked: [...this.frames.values()].flatMap((frame) => frame.stack),
    }
  }

  private busyInTools(id: string): boolean {
    return (this.inTools.get(id) ?? 0) > 0
  }

  /** Not generating: inside a tool call or held at the pause gate. */
  private atRest(id: string): boolean {
    return this.busyInTools(id) || this.held.has(id)
  }

  private pausedId(id: string): boolean {
    const project = this.projectOf(id)
    return project !== undefined && this.isPaused(project)
  }

  /** While its workspace has a parked frame, an agent queues only as part of it. */
  private subsumed(id: string): boolean {
    const project = this.projectOf(id)
    return project !== undefined && this.frames.has(project)
  }

  private eligible(id: string): boolean {
    return !this.pausedId(id) && !this.subsumed(id)
  }

  private hasUnpausedFrame(): boolean {
    for (const frame of this.frames.values()) if (!this.isPaused(frame.project)) return true
    return false
  }

  /**
   * Walk `id`'s recorded parents. Returns true when `ancestor` is on the
   * chain, else the topmost agent reached (one with no recorded parent).
   */
  private chainTop(id: string, ancestor: string): true | string {
    let current = id
    for (let hops = 0; hops < 64; hops++) {
      const parent = this.parents.get(current)
      if (parent === ancestor) return true
      if (parent === undefined) break
      current = parent
    }
    return current
  }

  /** Whether `id` descends from `ancestor`: by recorded handoffs, else by depth. */
  private descendsFrom(id: string, ancestor: string): boolean {
    const top = this.chainTop(id, ancestor)
    if (top === true) return true
    const depth = this.depths.get(top)
    const ancestorDepth = this.depths.get(ancestor)
    return depth !== undefined && ancestorDepth !== undefined && depth > ancestorDepth
  }

  /**
   * Whether the owner may be waiting on `id`, so `id` borrows at once. A
   * recorded handoff chain counts. Without one (a child published outside the
   * delegating call's context, such as a workflow agent), a deeper agent counts
   * only if it is not of another project and first showed up during the
   * owner's current tool call: an older or unrelated deeper agent (a resumed
   * session, a continuable child woken later) waits for lendAfterMs like anyone.
   */
  private awaitedBy(id: string, owner: string): boolean {
    const top = this.chainTop(id, owner)
    if (top === true) return true
    const depth = this.depths.get(top)
    const ownerDepth = this.depths.get(owner)
    if (depth === undefined || ownerDepth === undefined || depth <= ownerDepth) return false
    const project = this.projectOf(id)
    const ownerProject = this.projectOf(owner)
    if (project !== undefined && ownerProject !== undefined && project !== ownerProject) return false
    const since = this.toolOrder.get(owner)
    const seen = this.firstSeen.get(id)
    return since !== undefined && seen !== undefined && seen > since
  }

  /** How long the current owner has been inside tool calls, or undefined when it is not. */
  private ownerToolTime(): number | undefined {
    if (this.owner === undefined || !this.busyInTools(this.owner)) return undefined
    return Date.now() - (this.toolSince.get(this.owner) ?? Date.now())
  }

  private mayBorrow(waiter: BatonWaiter): boolean {
    const id = waiter.id
    const owner = this.owner
    const toolTime = this.ownerToolTime()
    if (owner === undefined || toolTime === undefined || id === owner) return false
    if (waiter.paused || this.subsumed(id)) return false
    // A parent that handed the baton to its child waits for it. A lender may
    // take the baton back like anyone else, unless it is the owner's ancestor.
    if (this.suspended.includes(id) && (!this.lenders.has(id) || this.isAncestorOf(id, owner))) return false
    return this.awaitedBy(id, owner) || toolTime >= this.lendAfterMs()
  }

  /** Whether `id` is an ancestor of `agent`. Agents of different projects never are. */
  private isAncestorOf(id: string, agent: string): boolean {
    const project = this.projectOf(id)
    const other = this.projectOf(agent)
    if (project !== undefined && other !== undefined && project !== other) return false
    return this.descendsFrom(agent, id)
  }

  private clearLendTimer(): void {
    if (this.lendTimer === undefined) return
    clearTimeout(this.lendTimer)
    this.lendTimer = undefined
  }

  /**
   * Re-check while someone waits: when the owner's tool time reaches
   * lendAfterMs, and every pollMs so a pause or unpause is noticed while the
   * owner sits in a tool or while only paused agents wait for a free baton.
   */
  private scheduleLend(): void {
    this.clearLendTimer()
    if (this.closed || this.waiters.length === 0) return
    const toolTime = this.ownerToolTime()
    let delay: number
    // Past lendAfterMs every allowed borrower has borrowed already; only a
    // pause change can alter that, so re-check at the poll interval.
    if (toolTime !== undefined) {
      const untilLend = this.lendAfterMs() - toolTime
      delay = untilLend > 0 ? Math.min(untilLend, this.pollMs()) : this.pollMs()
    } else if (this.owner === undefined) delay = this.pollMs()
    else return
    this.lendTimer = setTimeout(
      () => {
        this.lendTimer = undefined
        this.settle()
      },
      Math.min(delay, MAX_TIMER_MS),
    )
  }

  /** The owner lends the baton to `id`; a lender taking it back leaves the stack. */
  private lend(id: string): void {
    const owner = this.owner
    const index = this.suspended.indexOf(id)
    if (index >= 0) this.suspended.splice(index, 1)
    this.lenders.delete(id)
    if (owner !== undefined) {
      this.suspended.push(owner)
      this.lenders.add(owner)
    }
    this.owner = id
  }

  /** The owner lends the baton to an unpaused frame: the frame goes back on the stack above it. */
  private lendToFrame(frame: ParkedFrame): void {
    const owner = this.owner
    if (owner !== undefined) {
      this.suspended.push(owner)
      this.lenders.add(owner)
    }
    this.owner = undefined
    this.restore(frame)
    this.chooseOwner()
  }

  private projectOfCandidate(candidate: Candidate): string | undefined {
    return candidate.kind === 'frame' ? candidate.frame.project : this.projectOf(candidate.waiter.id)
  }

  private sinceOf(candidate: Candidate): number {
    return candidate.kind === 'frame' ? candidate.frame.since : candidate.waiter.since
  }

  private seqOf(candidate: Candidate): number {
    return candidate.kind === 'frame' ? candidate.frame.seq : candidate.waiter.seq
  }

  /**
   * Choose among candidates, oldest first: one from `project` goes ahead of
   * other projects, unless another project's agent has waited projectPriorityMs.
   */
  private pick(candidates: readonly Candidate[], project: string | undefined): Candidate | undefined {
    const sorted = [...candidates].sort((a, b) => this.seqOf(a) - this.seqOf(b))
    const limit = this.projectPriorityMs()
    if (project === undefined || limit <= 0) return sorted[0]
    const now = Date.now()
    const overdue = sorted.find(
      (candidate) => this.projectOfCandidate(candidate) !== project && now - this.sinceOf(candidate) >= limit,
    )
    return overdue ?? sorted.find((candidate) => this.projectOfCandidate(candidate) === project) ?? sorted[0]
  }

  /** Who may take a free baton: unpaused waiters not owed a place on the stack, and unpaused frames. */
  private freeCandidates(): Candidate[] {
    const list: Candidate[] = []
    for (const waiter of this.waiters) {
      if (waiter.paused || this.subsumed(waiter.id) || this.suspended.includes(waiter.id)) continue
      list.push({ kind: 'waiter', waiter })
    }
    for (const frame of this.frames.values()) if (!frame.paused) list.push({ kind: 'frame', frame })
    return list
  }

  /** Who may borrow from an owner in a tool. A frame borrows only when its next agent waits to generate. */
  private borrowers(): Candidate[] {
    const list: Candidate[] = []
    for (const waiter of this.waiters) if (this.mayBorrow(waiter)) list.push({ kind: 'waiter', waiter })
    const toolTime = this.ownerToolTime()
    if (toolTime === undefined || toolTime < this.lendAfterMs()) return list
    for (const frame of this.frames.values()) {
      if (frame.paused) continue
      const head = this.frameHead(frame)
      if (head !== undefined && this.waiters.some((waiter) => waiter.id === head)) list.push({ kind: 'frame', frame })
    }
    return list
  }

  /** The agent a frame's order gives the baton to first. */
  private frameHead(frame: ParkedFrame): string | undefined {
    const top = frame.stack.at(-1)
    if (top === undefined) return undefined
    return frame.delegated.get(top)?.find((id) => !this.pausedId(id)) ?? top
  }

  /** Mark pause changes: an unpaused waiter or frame rejoins the queue now, behind earlier waiters. */
  private refreshPauses(): void {
    const now = Date.now()
    for (const waiter of this.waiters) {
      const paused = this.pausedId(waiter.id)
      if (waiter.paused && !paused) {
        waiter.seq = ++this.clock
        waiter.since = now
      }
      waiter.paused = paused
    }
    for (const frame of this.frames.values()) {
      const paused = this.isPaused(frame.project)
      if (frame.paused && !paused) {
        frame.seq = ++this.clock
        frame.since = now
      }
      frame.paused = paused
    }
  }

  /** Park the order of every paused workspace that has a place in it. An owner is parked only at rest. */
  private parkPaused(): void {
    const projects = new Set<string>()
    const note = (id: string) => {
      const project = this.projectOf(id)
      if (project !== undefined && this.isPaused(project)) projects.add(project)
    }
    for (const id of this.suspended) note(id)
    const owner = this.owner
    const ownerAtRest = owner !== undefined && this.atRest(owner)
    if (owner !== undefined && ownerAtRest) note(owner)
    const ownerProject = owner === undefined ? undefined : this.projectOf(owner)
    for (const project of projects) {
      // A workspace whose agent still generates parks as a whole at its next
      // rest; a pause lifted before then costs the workspace nothing.
      if (project === ownerProject && !ownerAtRest) continue
      this.park(project, ownerAtRest)
    }
  }

  private park(project: string, ownerAtRest: boolean): void {
    let frame = this.frames.get(project)
    if (frame === undefined) {
      frame = {
        project,
        stack: [],
        lenders: new Set(),
        delegated: new Map(),
        paused: true,
        since: Date.now(),
        seq: ++this.clock,
      }
      this.frames.set(project, frame)
    }
    frame.paused = true
    const kept: string[] = []
    for (const id of this.suspended) {
      if (this.projectOf(id) !== project) {
        kept.push(id)
        continue
      }
      frame.stack.push(id)
      if (this.lenders.delete(id)) frame.lenders.add(id)
    }
    this.suspended.splice(0, this.suspended.length, ...kept)
    for (const [parent, queue] of this.delegated) {
      if (this.projectOf(parent) !== project) continue
      frame.delegated.set(parent, [...(frame.delegated.get(parent) ?? []), ...queue])
      this.delegated.delete(parent)
    }
    const owner = this.owner
    if (ownerAtRest && owner !== undefined && this.projectOf(owner) === project) {
      frame.stack.push(owner)
      frame.lenders.add(owner)
      this.lastProject = project
      this.owner = undefined
    }
    if (frame.stack.length === 0) {
      for (const [parent, queue] of frame.delegated) this.delegated.set(parent, queue)
      this.frames.delete(project)
    }
  }

  /** Put an unpaused frame's order back on top of the stack. */
  private restore(frame: ParkedFrame): void {
    this.frames.delete(frame.project)
    for (const id of frame.stack) {
      const index = this.suspended.indexOf(id)
      if (index >= 0) this.suspended.splice(index, 1)
      this.suspended.push(id)
      if (frame.lenders.has(id)) this.lenders.add(id)
    }
    for (const [parent, queue] of frame.delegated) {
      this.delegated.set(parent, [...(this.delegated.get(parent) ?? []), ...queue])
    }
  }

  private removeFromFrames(id: string): void {
    for (const [project, frame] of this.frames) {
      const index = frame.stack.indexOf(id)
      if (index >= 0) frame.stack.splice(index, 1)
      frame.lenders.delete(id)
      frame.delegated.delete(id)
      for (const [parent, queue] of frame.delegated) {
        const queued = queue.indexOf(id)
        if (queued >= 0) queue.splice(queued, 1)
        if (queue.length === 0) frame.delegated.delete(parent)
      }
      if (frame.stack.length === 0) this.frames.delete(project)
    }
  }

  /** Pick the next owner of a free baton: delegated siblings, then the parent, then the queue. */
  private chooseOwner(): void {
    for (let guard = 0; this.owner === undefined && guard < 1_000; guard++) {
      const top = this.suspended.at(-1)
      if (top !== undefined) {
        const queue = this.delegated.get(top)
        const index = queue?.findIndex((id) => !this.pausedId(id)) ?? -1
        if (queue !== undefined && index >= 0) {
          this.owner = queue.splice(index, 1)[0]
          if (queue.length === 0) this.delegated.delete(top)
          return
        }
        this.suspended.pop()
        this.lenders.delete(top)
        this.owner = top
        return
      }
      const next = this.pick(this.freeCandidates(), this.lastProject)
      if (next === undefined) return
      if (next.kind === 'frame') this.restore(next.frame)
      else this.owner = next.waiter.id
    }
  }

  /** Apply pauses, hand over a free baton, lend an owner busy in tools, then wake the new owner. */
  private settle(): void {
    this.refreshPauses()
    this.parkPaused()
    if (this.owner === undefined) this.chooseOwner()
    for (let guard = 0; guard < 1_000 && this.owner !== undefined && this.busyInTools(this.owner); guard++) {
      const borrower = this.pick(this.borrowers(), this.projectOf(this.owner))
      if (borrower === undefined) break
      if (borrower.kind === 'frame') this.lendToFrame(borrower.frame)
      else this.lend(borrower.waiter.id)
    }
    this.scheduleLend()
    for (const waiter of [...this.waiters]) {
      if (waiter.id !== this.owner) continue
      this.waiters.splice(this.waiters.indexOf(waiter), 1)
      waiter.signal.removeEventListener('abort', waiter.abort)
      waiter.resolve()
    }
  }
}

/** The part of dsh-user-approval's `approval/request` payload this plugin reads. */
interface ApprovalRequest {
  readonly agent?: { readonly id: unknown }
  readonly signal?: AbortSignal
}

/** A delegation call holding a permit until its child run claims it. */
interface Reservation {
  state: 'open' | 'bound' | 'done'
  readonly lane: Lane
  /** Provider the child is expected to use. */
  readonly provider: string | undefined
}

interface RunState {
  readonly agentId: string
  readonly local: boolean
  readonly reservation?: Reservation
  lease?: object
  ended: boolean
}

interface Settings {
  limit(): number
  queueTimeoutMs(): number
  subagentToolNames(): ReadonlySet<string>
  baton(): boolean
  lendAfterMs(): number
  projectPriorityMs(): number
  providers(): Readonly<Record<string, ProviderConfig>>
  /** Normalized project keys of the paused workspaces. */
  pausedProjects(): ReadonlySet<string>
  /** The paused folders as configured. */
  pausedPaths(): readonly string[]
  /** Read the pause list from the pause row's service while it is mounted. */
  usePauseRow(source: PauseSource | undefined): void
  pausePollMs(): number
  pendingReservationMs(): number
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1
}

function isProviderMap(value: unknown): value is Readonly<Record<string, ProviderConfig>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.entries(value).every(([name, lane]) => {
    if (name.length === 0 || typeof lane !== 'object' || lane === null || Array.isArray(lane)) return false
    const { lane: shared, baton, maxConcurrentSubagents, lendAfterMs } = lane as Record<string, unknown>
    return (
      (shared === undefined || (typeof shared === 'string' && shared.length > 0)) &&
      (baton === undefined || typeof baton === 'boolean') &&
      (maxConcurrentSubagents === undefined || isPositiveInteger(maxConcurrentSubagents)) &&
      (lendAfterMs === undefined || (Number.isSafeInteger(lendAfterMs) && (lendAfterMs as number) >= 0))
    )
  })
}

function isPathList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((path) => typeof path === 'string' && path.length > 0)
}

function isToolNames(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.every((name) => typeof name === 'string' && name.length > 0)
}

/**
 * Read one field on every use, so edits from dsh settings apply live. The
 * first read must be valid; a later invalid value keeps the last valid one.
 */
function liveField<T>(raw: Live<T> | undefined, fallback: T, valid: (value: unknown) => value is T, error: string) {
  const read = (): unknown => {
    const value =
      typeof raw === 'object' && raw !== null && 'get' in raw && typeof raw.get === 'function' ? raw.get() : raw
    return value ?? fallback
  }
  const first = read()
  if (!valid(first)) throw new TypeError(error)
  let last: T = first
  return (): T => {
    const value = read()
    if (valid(value)) last = value
    return last
  }
}

function resolveConfig(config: Config): Settings {
  const limit = liveField(
    config.maxConcurrentSubagents,
    DEFAULT_MAX_CONCURRENT_SUBAGENTS,
    isPositiveInteger,
    'maxConcurrentSubagents must be a positive safe integer',
  )
  const queueTimeoutMs = liveField(
    config.queueTimeoutMs,
    DEFAULT_QUEUE_TIMEOUT_MS,
    isPositiveInteger,
    'queueTimeoutMs must be a positive safe integer',
  )
  const names = liveField<readonly string[]>(
    config.subagentToolNames,
    ['subagent'],
    isToolNames,
    'subagentToolNames must contain at least one non-empty string',
  )
  const baton = liveField(
    config.baton,
    false,
    (value): value is boolean => typeof value === 'boolean',
    'baton must be a boolean',
  )
  const lendAfterMs = liveField(
    config.lendAfterMs,
    DEFAULT_LEND_AFTER_MS,
    (value): value is number => Number.isSafeInteger(value) && (value as number) >= 0,
    'lendAfterMs must be a non-negative safe integer',
  )
  const projectPriorityMs = liveField(
    config.projectPriorityMs,
    DEFAULT_PROJECT_PRIORITY_MS,
    (value): value is number => Number.isSafeInteger(value) && (value as number) >= 0,
    'projectPriorityMs must be a non-negative safe integer',
  )
  const providers = liveField<Readonly<Record<string, ProviderConfig>>>(
    config.providers,
    {},
    isProviderMap,
    'providers must map provider names to { baton?, maxConcurrentSubagents?, lendAfterMs? }',
  )
  const paused = liveField<readonly string[]>(
    config.pausedWorkspaces,
    [],
    isPathList,
    'pausedWorkspaces must be a list of non-empty folder paths',
  )
  const pausePollMs = liveField(
    config.pausePollMs,
    DEFAULT_PAUSE_POLL_MS,
    isPositiveInteger,
    'pausePollMs must be positive',
  )
  const pendingReservationMs = liveField(
    config.pendingReservationMs,
    DEFAULT_PENDING_RESERVATION_MS,
    isPositiveInteger,
    'pendingReservationMs must be positive',
  )
  let pauseRow: PauseSource | undefined
  /** The pause row's list when it is mounted, else this plugin's own option. */
  const pausedPaths = (): readonly string[] => {
    if (pauseRow === undefined) return paused()
    try {
      return pauseRow.pausedPaths()
    } catch {
      return paused()
    }
  }
  let pausedSource: readonly string[] | undefined
  let pausedSet: ReadonlySet<string> = new Set()
  let namesSource: readonly string[] | undefined
  let namesSet: ReadonlySet<string> = new Set()
  return {
    pausePollMs,
    pendingReservationMs,
    pausedPaths,
    usePauseRow(source: PauseSource | undefined) {
      pauseRow = source
    },
    pausedProjects() {
      const current = pausedPaths()
      if (current !== pausedSource) {
        pausedSource = current
        pausedSet = new Set(current.map(projectKey))
      }
      return pausedSet
    },
    limit,
    queueTimeoutMs,
    baton,
    lendAfterMs,
    projectPriorityMs,
    providers,
    subagentToolNames() {
      const current = names()
      if (current !== namesSource) {
        namesSource = current
        namesSet = new Set(current)
      }
      return namesSet
    },
  }
}

/**
 * Install the process-local delegation and child-turn gate.
 *
 * Root delegation calls wait in FIFO order. A nested configured delegation
 * call never waits when the pool is full, because its parent may be waiting
 * for that child. Local child turns use the same pool; root turns do not.
 */
/** One provider's pool and baton. */
class Lane {
  readonly key: string
  readonly gate: ConcurrencyGate
  readonly baton: Baton
  private readonly batonSetting: () => boolean
  private batonWasOn: boolean

  constructor(key: string, batonSetting: () => boolean, limit: () => number, baton: BatonOptions) {
    this.key = key
    this.batonSetting = batonSetting
    this.gate = new ConcurrencyGate(limit)
    this.baton = new Baton(baton)
    this.batonWasOn = batonSetting()
  }

  /** Whether this lane's baton is on; a live switch resets it. */
  batonOn(): boolean {
    const on = this.batonSetting()
    if (on !== this.batonWasOn) {
      this.batonWasOn = on
      this.baton.reset()
    }
    return on
  }

  close(): void {
    this.gate.close()
    this.baton.close()
  }
}

/** How far back a step looks in the session log for the current model. */
const SELECTION_SCAN_LIMIT = 5_000

interface SessionLog {
  readonly seq: number
  eventAt(seq: number): { readonly type?: string; readonly data?: unknown } | undefined
}

/**
 * The provider the agent's next request will use: the latest `model/selection`
 * (a model switch) or request header in its session log. A switch is logged
 * before the next step, so this beats the provider of the last request.
 */
function selectedProvider(session: unknown): string | undefined {
  const log = session as Partial<SessionLog> | undefined
  if (typeof log?.seq !== 'number' || typeof log.eventAt !== 'function') return undefined
  const stop = Math.max(0, log.seq - SELECTION_SCAN_LIMIT)
  for (let seq = log.seq - 1; seq >= stop; seq--) {
    let event: ReturnType<SessionLog['eventAt']>
    try {
      event = log.eventAt(seq)
    } catch {
      return undefined
    }
    if (event?.type === 'model/selection') {
      const provider = (event.data as { provider?: unknown } | undefined)?.provider
      if (typeof provider === 'string') return provider
    } else if (event?.type === 'request/header') {
      const header = (event.data as { header?: { config?: { provider?: unknown } } } | undefined)?.header
      if (typeof header?.config?.provider === 'string') return header.config.provider
    }
  }
  return undefined
}

/** Compare working folders the way Windows does: case and slash insensitive. */
function projectKey(cwd: string): string {
  return cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * The settings that govern a lane: the lane root's own entry (the provider the
 * lane is named for, which the settings page edits) when it is listed, else
 * the first follower by name, so the result never depends on key order.
 */
function laneSettings(listed: Readonly<Record<string, ProviderConfig>>, lane: string): ProviderConfig | undefined {
  if (Object.hasOwn(listed, lane)) {
    const root = listed[lane]
    if (root.lane === undefined || root.lane === lane) return root
  }
  const followers = Object.keys(listed)
    .filter((name) => (listed[name].lane ?? name) === lane)
    .sort()
  return followers.length > 0 ? listed[followers[0]] : undefined
}

/** The part of dsh's session store the status route reads. */
interface SessionStoreFace {
  get(id: string): { readonly header?: { readonly cwd?: unknown } } | undefined
  list(): readonly { readonly header?: { readonly cwd?: unknown } }[]
}

/** One workspace as the status route reports it. */
interface WorkspaceRow {
  /** Normalized folder key, as `pausedWorkspaces` entries are matched. */
  readonly key: string
  /** The folder as dsh wrote it. */
  readonly path: string
  readonly paused: boolean
  /** Agents of this workspace whose status is running. */
  running: number
  /** Agents waiting at the pause gate. */
  held: number
  /** Running agents inside a tool call or approval, not held. */
  inTool: number
  /** Agents queued for a baton. */
  waiting: number
  /** Whether one of its agents holds a baton now. */
  holdsBaton: boolean
}

/** The key of the single lane used while no providers are listed. */
const GLOBAL_LANE = '*'

export function apply(ctx: Context, config: Config = {}): void {
  const settings = resolveConfig(config)
  ctx.inject([PAUSE_SERVICE], (scope) => {
    settings.usePauseRow((scope as unknown as Record<string, PauseSource>)[PAUSE_SERVICE])
    scope.effect(() => () => settings.usePauseRow(undefined), 'subagent concurrency: pause row')
  })
  const lanes = new Map<string, Lane>()
  /** Gate holding each pool key, so a release reaches the right lane. */
  const gateOf = new WeakMap<object, ConcurrencyGate>()
  /** Provider each agent's last model request used. */
  const observedProvider = new Map<string, string>()
  /** Provider a published child is expected to use until it makes a request. */
  const expectedProvider = new Map<string, string>()
  /** Project (session working folder) of each agent; children inherit their parent's. */
  const projectByAgent = new Map<string, string>()
  /** Each workspace's folder as dsh wrote it, for display. */
  const projectPath = new Map<string, string>()
  function noteProject(agent: { readonly id: unknown; readonly session?: unknown }): void {
    const cwd = (agent.session as { header?: { cwd?: unknown } } | undefined)?.header?.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) return
    const key = projectKey(cwd)
    projectByAgent.set(String(agent.id), key)
    if (!projectPath.has(key)) projectPath.set(key, cwd)
  }
  /** Agents whose status is running. */
  const runningAgents = new Set<string>()
  /** Lane whose baton an agent took for its current step. */
  const batonLaneOf = new Map<string, Lane>()

  const startContext = new AsyncLocalStorage<Reservation>()
  const startsByRunId = new Map<string, RunState>()
  const activeTurnsByAgentId = new Map<string, object>()
  const pendingByAgentId = new Map<string, Reservation[]>()
  const toolAgent = new AsyncLocalStorage<string>()

  function laneFor(provider: string | undefined): Lane | undefined {
    const listed = settings.providers()
    let key: string | undefined = GLOBAL_LANE
    if (Object.keys(listed).length > 0) {
      if (provider === undefined) return undefined
      const entry = Object.hasOwn(listed, provider) ? listed[provider] : undefined
      // A provider another entry names as its lane runs on that lane even
      // when it is not listed itself: it is the server the lane stands for.
      if (entry === undefined && !Object.values(listed).some((other) => other.lane === provider)) return undefined
      key = `lane:${entry?.lane ?? provider}`
    }
    let lane = lanes.get(key)
    if (lane === undefined) {
      const laneName = key.slice('lane:'.length)
      const own = () => (key === GLOBAL_LANE ? undefined : laneSettings(settings.providers(), laneName))
      lane = new Lane(
        key,
        () => own()?.baton ?? settings.baton(),
        () => own()?.maxConcurrentSubagents ?? settings.limit(),
        {
          lendAfterMs: () => own()?.lendAfterMs ?? settings.lendAfterMs(),
          projectOf: (id) => projectByAgent.get(id),
          projectPriorityMs: settings.projectPriorityMs,
          isPaused: (project) => settings.pausedProjects().has(project),
          pollMs: settings.pausePollMs,
        },
      )
      lanes.set(key, lane)
    }
    return lane
  }

  function providerOf(agent: { readonly id: unknown; readonly options?: unknown; readonly session?: unknown }) {
    const id = String(agent.id)
    const raw = (agent.options as { provider?: unknown } | undefined)?.provider
    const fromOptions = typeof raw === 'string' && raw.length > 0 ? raw : undefined
    // A fresh child's session log is seeded from its parent, so before the
    // child's own first request the log names the parent's provider. Trust
    // the delegation's provider until then.
    if (!observedProvider.has(id)) {
      const expected = expectedProvider.get(id)
      if (expected !== undefined) return expected
      if (fromOptions !== undefined && delegationDepthOf(agent as never) > 0) return fromOptions
    }
    return selectedProvider(agent.session) ?? observedProvider.get(id) ?? fromOptions
  }

  function enterKey(gate: ConcurrencyGate, key: object): void {
    gateOf.set(key, gate)
  }

  function release(key: object): void {
    gateOf.get(key)?.release(key)
  }

  function releaseTurn(agentId: string): void {
    const lease = activeTurnsByAgentId.get(agentId)
    if (lease === undefined) return
    activeTurnsByAgentId.delete(agentId)
    for (const run of startsByRunId.values()) {
      if (run.lease !== lease) continue
      run.lease = undefined
      // The reservation covered the first turn only; later turns take a fresh permit.
      if (run.reservation === lease) run.reservation.state = 'done'
    }
    release(lease)
  }

  /**
   * A successful delegation that publishes no run (a workflow call, a
   * background job whose start failed) would otherwise hold its permit until
   * the delegating agent is disposed. Give a deferred publish a grace period,
   * then free the permit.
   */
  const reservationTimers = new Set<ReturnType<typeof setTimeout>>()
  function expireReservation(agentId: string, reservation: Reservation): void {
    const timer = setTimeout(() => {
      reservationTimers.delete(timer)
      if (reservation.state !== 'open') return
      reservation.state = 'done'
      release(reservation)
      const pending = pendingByAgentId.get(agentId)
      const index = pending?.indexOf(reservation) ?? -1
      if (pending !== undefined && index >= 0) pending.splice(index, 1)
      if (pending?.length === 0) pendingByAgentId.delete(agentId)
    }, settings.pendingReservationMs())
    timer.unref?.()
    reservationTimers.add(timer)
  }
  ctx.effect(
    () => () => {
      for (const timer of reservationTimers) clearTimeout(timer)
      reservationTimers.clear()
    },
    'subagent concurrency reservation timers',
  )

  /** A child that goes idle before its first step never uses its reservation: free it. */
  function releaseUnusedReservations(agentId: string): void {
    for (const run of startsByRunId.values()) {
      if (run.agentId !== agentId || run.lease !== undefined || run.reservation?.state !== 'bound') continue
      run.reservation.state = 'done'
      release(run.reservation)
    }
  }

  function pumpAll(): void {
    for (const lane of lanes.values()) lane.gate.pump()
  }

  ctx.effect(
    () => () => {
      for (const lane of lanes.values()) lane.close()
    },
    'subagent concurrency lanes',
  )

  /** Take the baton of `lane` for this agent's step, dropping one held in another lane. */
  async function takeBaton(agentId: string, depth: number, lane: Lane | undefined, signal: AbortSignal) {
    const held = batonLaneOf.get(agentId)
    if (held !== undefined && held !== lane) {
      held.baton.release(agentId)
      batonLaneOf.delete(agentId)
    }
    if (lane === undefined || !lane.batonOn()) return
    await lane.baton.acquire(agentId, signal, depth)
    batonLaneOf.set(agentId, lane)
  }

  /** Agents waiting at the pause gate, by agent id. */
  const heldAgents = new Map<
    string,
    { readonly project: string; readonly since: number; cancel(reason: unknown): void }
  >()

  function workspacePaused(project: string | undefined): boolean {
    return project !== undefined && settings.pausedProjects().has(project)
  }

  /**
   * Hold an agent of a paused workspace before its next model request, until
   * the workspace is unpaused, the turn is aborted, or the agent is disposed.
   * Nothing in flight is cut off: the agent's model call and tool calls have
   * finished, and the model never sees the wait. With the baton on, the agent
   * gives the baton up while it waits but keeps its place in its tree's order.
   */
  function holdWhilePaused(agentId: string, signal: AbortSignal): Promise<void> | undefined {
    // No promise when not paused, so an unpaused step costs no extra tick.
    const project = projectByAgent.get(agentId)
    if (!workspacePaused(project)) return undefined
    return holdPaused(agentId, project as string, signal)
  }

  async function holdPaused(agentId: string, project: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    for (const lane of lanes.values()) lane.baton.hold(agentId)
    try {
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const finish = (settle: () => void) => {
          if (timer !== undefined) clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          heldAgents.delete(agentId)
          settle()
        }
        const check = () => {
          if (!workspacePaused(projectByAgent.get(agentId))) finish(resolve)
          else timer = setTimeout(check, settings.pausePollMs())
        }
        const onAbort = () => finish(() => reject(signal.reason))
        signal.addEventListener('abort', onAbort, { once: true })
        heldAgents.set(agentId, {
          project,
          since: Date.now(),
          cancel: (reason) => finish(() => reject(reason)),
        })
        timer = setTimeout(check, settings.pausePollMs())
      })
    } finally {
      for (const lane of lanes.values()) lane.baton.unhold(agentId)
    }
  }

  ctx.effect(
    () => () => {
      for (const held of [...heldAgents.values()]) held.cancel(new Error('subagent concurrency limit is disposed'))
    },
    'subagent concurrency pause gate',
  )

  // Prepended so no other step or tool listener runs ahead of the pause gate
  // and the baton. The lane here is a best guess; `agent/request` corrects it
  // with the real route.
  ctx.on(
    'agent/pre-step',
    async (info, next) => {
      pumpAll()
      noteProject(info.agent)
      const held = holdWhilePaused(String(info.agent.id), info.signal)
      if (held !== undefined) await held
      await takeBaton(
        String(info.agent.id),
        delegationDepthOf(info.agent),
        laneFor(providerOf(info.agent)),
        info.signal,
      )
      return next()
    },
    { prepend: true },
  )

  ctx.on(
    'agent/request',
    async (info, next) => {
      const call = await next()
      const agentId = String(info.agent.id)
      const provider = typeof call?.provider === 'string' ? call.provider : undefined
      if (provider !== undefined) {
        observedProvider.set(agentId, provider)
        expectedProvider.delete(agentId)
      }
      const lane = laneFor(provider ?? providerOf(info.agent))
      if (batonLaneOf.get(agentId) !== lane || (lane?.batonOn() && !batonLaneOf.has(agentId))) {
        noteProject(info.agent)
        await takeBaton(agentId, delegationDepthOf(info.agent), lane, info.signal)
      }
      return call
    },
    { prepend: true },
  )

  /** Open tool calls and approvals per agent, for the workspaces route. */
  const toolDepth = new Map<string, number>()

  /** Count `run` as tool time of `agentId`, so the baton can be lent while it waits. */
  async function asToolTime<T>(agentId: string, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
    let done = false
    const counted = [...lanes.values()]
    const end = () => {
      if (done) return
      done = true
      signal?.removeEventListener('abort', end)
      const depth = (toolDepth.get(agentId) ?? 1) - 1
      if (depth > 0) toolDepth.set(agentId, depth)
      else toolDepth.delete(agentId)
      for (const lane of counted) lane.baton.toolEnd(agentId)
    }
    toolDepth.set(agentId, (toolDepth.get(agentId) ?? 0) + 1)
    for (const lane of counted) lane.baton.toolStart(agentId)
    // A cancelled approval resolves without waiting for its answerer.
    signal?.addEventListener('abort', end, { once: true })
    try {
      return await toolAgent.run(agentId, run)
    } finally {
      end()
    }
  }

  // Tool approval is asked before `tools/execute`, so without this an agent
  // waiting on a human (or on an AI reviewer subagent) would hold the baton
  // with no tool time: nobody could borrow, and a reviewer would deadlock.
  // Registered by name because dsh-user-approval is an optional peer.
  const onApproval = ctx.on as unknown as (
    name: string,
    listener: (req: ApprovalRequest, next: () => Promise<unknown>) => Promise<unknown>,
    options: { prepend: boolean },
  ) => () => void
  onApproval.call(
    ctx,
    'approval/request',
    (req, next) => (req?.agent === undefined ? next() : asToolTime(String(req.agent.id), req.signal, next)),
    { prepend: true },
  )

  ctx.on(
    'tools/execute',
    async (exec, next) => {
      pumpAll()
      if (exec.agent === undefined) return next()
      return asToolTime(String(exec.agent.id), undefined, next)
    },
    { prepend: true },
  )

  ctx.on('tools/execute', async (exec, next) => {
    if (!settings.subagentToolNames().has(exec.name) || exec.agent === undefined) {
      return next()
    }

    const requested = (exec.arguments as { provider?: unknown } | undefined)?.provider
    const provider = typeof requested === 'string' && requested.length > 0 ? requested : providerOf(exec.agent)
    const lane = laneFor(provider)
    // A provider with no lane is not limited.
    if (lane === undefined) return next()
    const gate = lane.gate
    const root = delegationDepthOf(exec.agent) === 0
    const reservation: Reservation = { state: 'open', lane, provider }
    enterKey(gate, reservation)
    if (root) {
      await gate.enter(reservation, exec.signal, settings.queueTimeoutMs())
    } else if (!gate.tryEnter(reservation, exec.signal)) {
      // With the baton on, a nested child cannot generate alongside anyone,
      // so it is admitted over the limit instead of failing.
      if (!lane.batonOn()) throw new Error('subagent concurrency limit exhausted for nested delegation')
      gate.forceEnter(reservation)
    }

    let failed = false
    try {
      const result = await startContext.run(reservation, next)
      // dsh-tools turns a failed or cancelled tool body into an `isError`
      // result instead of throwing, so check the result too.
      if ((result as { isError?: unknown } | undefined)?.isError === true) failed = true
      return result
    } catch (error) {
      failed = true
      throw error
    } finally {
      // A failed call publishes no run, so release. On success keep the
      // reservation open: a deferred `subagent/start` (jobs publishes after the
      // tool returns) binds it, and if none ever comes the parent's disposal
      // releases it below.
      if (failed && reservation.state === 'open') {
        gate.release(reservation)
        reservation.state = 'done'
      } else if (reservation.state === 'open') {
        const agentId = String(exec.agent.id)
        let pending = pendingByAgentId.get(agentId)
        if (pending === undefined) {
          pending = []
          pendingByAgentId.set(agentId, pending)
        }
        pending.push(reservation)
        expireReservation(agentId, reservation)
      }
    }
  })

  ctx.on('subagent/start', (info) => {
    const reservation = startContext.getStore()
    let ownedReservation: Reservation | undefined
    if (reservation?.state === 'open') {
      reservation.state = 'bound'
      ownedReservation = reservation
    }
    const childId = String(info.id)
    const parentId = toolAgent.getStore()
    const parentProject = parentId === undefined ? undefined : projectByAgent.get(parentId)
    if (parentProject !== undefined && !projectByAgent.has(childId)) projectByAgent.set(childId, parentProject)
    const expected = reservation?.provider ?? (parentId === undefined ? undefined : observedProvider.get(parentId))
    if (info.local && expected !== undefined && !observedProvider.has(childId)) expectedProvider.set(childId, expected)

    // The baton follows the child only within one lane: a child on another
    // provider does not compete with its parent for a slot.
    const lane = reservation?.lane ?? laneFor(expected)
    if (info.local && parentId !== undefined && lane?.batonOn()) {
      if (lane === laneFor(parentId === undefined ? undefined : providerForId(parentId)))
        lane.baton.handoff(parentId, childId)
    }

    startsByRunId.set(String(info.runId), {
      agentId: childId,
      local: info.local,
      reservation: ownedReservation,
      ended: false,
    })
  })

  function providerForId(agentId: string): string | undefined {
    return observedProvider.get(agentId) ?? expectedProvider.get(agentId)
  }

  ctx.on('subagent/end', (info) => {
    const runId = String(info.runId)
    const run = startsByRunId.get(runId)
    if (run === undefined) return
    run.ended = true
    startsByRunId.delete(runId)
    if (run.local) for (const lane of lanes.values()) lane.baton.release(run.agentId)
    if (run.local) batonLaneOf.delete(run.agentId)
    if (run.lease !== undefined) {
      const lease = run.lease
      run.lease = undefined
      if (activeTurnsByAgentId.get(run.agentId) === lease) {
        activeTurnsByAgentId.delete(run.agentId)
      }
      release(lease)
    } else if (run.reservation !== undefined) {
      release(run.reservation)
    }
  })

  ctx.on('agent/pre-step', async (info, next) => {
    const agentId = String(info.agent.id)
    if (delegationDepthOf(info.agent) === 0) return next()
    if (activeTurnsByAgentId.has(agentId)) return next()

    const run = [...startsByRunId.values()].find(
      (candidate) => candidate.local && candidate.agentId === agentId && candidate.lease === undefined,
    )
    const reserved = run?.reservation?.state === 'bound' ? run.reservation : undefined
    const lane = reserved?.lane ?? laneFor(providerOf(info.agent))
    // A provider with no lane is not limited.
    if (lane === undefined) return next()
    const gate = lane.gate
    const lease = reserved ?? {}
    enterKey(gate, lease)
    try {
      if (lane.batonOn()) {
        // The baton already lets only one agent generate, so a child turn is
        // never refused or queued here: refusing it fails work for no gain,
        // and queueing it can deadlock with an ancestor waiting for it.
        if (!gate.tryEnter(lease, info.signal)) gate.forceEnter(lease)
      } else if (reserved !== undefined) {
        // A locally published child's reservation must remain active until its first turn.
        if (!gate.tryEnter(lease, info.signal)) {
          throw new Error('subagent concurrency limit reservation was lost')
        }
      } else if (run !== undefined && delegationDepthOf(info.agent) === 1) {
        // A root agent's child with no reservation: a later turn, or a child
        // of a tool outside subagentToolNames (subagent_fork, workflow). Its
        // parent holds no permit, so it queues like a root delegation would.
        await gate.enter(lease, info.signal, settings.queueTimeoutMs())
      } else if (run !== undefined) {
        // A deeper child with no reservation. Never queue: fail loudly when the
        // pool is full, so the child cannot block the ancestor waiting for it.
        if (!gate.tryEnter(lease, info.signal)) {
          throw new Error('subagent concurrency limit exhausted for reservation-less local child turn')
        }
      } else {
        await gate.enter(lease, info.signal, settings.queueTimeoutMs())
      }
      if (run?.ended) {
        gate.release(lease)
        return next()
      }
      if (run !== undefined) run.lease = lease
      activeTurnsByAgentId.set(agentId, lease)
      try {
        const decision = await next()
        if (decision?.kind === 'reject') releaseTurn(agentId)
        return decision
      } catch (error) {
        releaseTurn(agentId)
        throw error
      }
    } catch (error) {
      if (activeTurnsByAgentId.get(agentId) !== lease) gate.release(lease)
      throw error
    }
  })

  ctx.on('agent/status', (info) => {
    if (info.status !== 'idle') {
      runningAgents.add(String(info.agent.id))
      return
    }
    const agentId = String(info.agent.id)
    runningAgents.delete(agentId)
    releaseTurn(agentId)
    releaseUnusedReservations(agentId)
    for (const lane of lanes.values()) lane.baton.release(agentId)
    batonLaneOf.delete(agentId)
  })

  ctx.on('agent/disposed', (info) => {
    const agentId = String(info.agent.id)
    heldAgents.get(agentId)?.cancel(new Error('agent was disposed while its workspace was paused'))
    runningAgents.delete(agentId)
    releaseTurn(agentId)
    for (const lane of lanes.values()) lane.baton.disposed(agentId)
    batonLaneOf.delete(agentId)
    observedProvider.delete(agentId)
    expectedProvider.delete(agentId)
    projectByAgent.delete(agentId)
    for (const [runId, run] of startsByRunId) {
      if (!run.local || run.agentId !== agentId) continue
      run.ended = true
      if (run.lease !== undefined) {
        const lease = run.lease
        run.lease = undefined
        release(lease)
      } else if (run.reservation !== undefined) {
        release(run.reservation)
      }
      startsByRunId.delete(runId)
    }
    const pending = pendingByAgentId.get(agentId)
    if (pending !== undefined) {
      pendingByAgentId.delete(agentId)
      for (const reservation of pending) {
        if (reservation.state !== 'open') continue
        release(reservation)
        reservation.state = 'done'
      }
    }
  })

  // dsh's session store, when present: it knows the folder of a chat that has
  // not stepped since dsh started.
  let sessions: SessionStoreFace | undefined
  ctx.inject(['sessions'], (scope) => {
    sessions = (scope as unknown as { sessions: SessionStoreFace }).sessions
    scope.effect(
      () => () => {
        sessions = undefined
      },
      'subagent concurrency: session store',
    )
  })

  function sessionFolder(sessionId: string): string | undefined {
    try {
      const cwd = sessions?.get(sessionId)?.header?.cwd
      return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
    } catch {
      return undefined
    }
  }

  function workspaceRows(): WorkspaceRow[] {
    const rows = new Map<string, WorkspaceRow>()
    const row = (key: string, path: string): WorkspaceRow => {
      let entry = rows.get(key)
      if (entry === undefined) {
        entry = {
          key,
          path: projectPath.get(key) ?? path,
          paused: workspacePaused(key),
          running: 0,
          held: 0,
          inTool: 0,
          waiting: 0,
          holdsBaton: false,
        }
        rows.set(key, entry)
      }
      return entry
    }
    for (const [agentId, key] of projectByAgent) {
      const entry = row(key, key)
      if (!runningAgents.has(agentId)) continue
      entry.running++
      if ((toolDepth.get(agentId) ?? 0) > 0 && !heldAgents.has(agentId)) entry.inTool++
    }
    try {
      for (const session of sessions?.list() ?? []) {
        const cwd = session.header?.cwd
        if (typeof cwd === 'string' && cwd.length > 0) row(projectKey(cwd), cwd)
      }
    } catch {
      // A store that cannot list leaves the agents seen so far.
    }
    for (const path of settings.pausedPaths()) row(projectKey(path), path)
    for (const held of heldAgents.values()) row(held.project, held.project).held++
    for (const lane of lanes.values()) {
      if (!lane.batonOn()) continue
      const view = lane.baton.snapshot()
      const ownerKey = view.owner === undefined ? undefined : projectByAgent.get(view.owner)
      if (ownerKey !== undefined) row(ownerKey, ownerKey).holdsBaton = true
      for (const id of view.waiting) {
        const key = projectByAgent.get(id)
        if (key !== undefined && !heldAgents.has(id)) row(key, key).waiting++
      }
    }
    return [...rows.values()].sort((a, b) => a.path.localeCompare(b.path))
  }

  function workspaceOf(sessionId: string): { key: string; path: string; paused: boolean } | null {
    const folder = sessionFolder(sessionId)
    const key = projectByAgent.get(sessionId) ?? (folder === undefined ? undefined : projectKey(folder))
    if (key === undefined) return null
    return { key, path: projectPath.get(key) ?? folder ?? key, paused: workspacePaused(key) }
  }

  const failure = (code: string, message: string): RpcChannelResult => ({
    ok: false,
    error: { code, message, details: {} },
  })

  // Read-only: pausing and unpausing write `pausedWorkspaces` through dsh's
  // settings service, like every other setting.
  mountRpcChannel(ctx, CHANNEL, async (endpoint, payload) => {
    switch (endpoint) {
      case 'workspaces':
        return {
          ok: true,
          value: {
            paused: settings.pausedPaths().map((path) => ({ path, key: projectKey(path) })),
            workspaces: workspaceRows(),
          },
        }
      case 'workspaceOf': {
        const sessionId = (payload as { sessionId?: unknown } | null)?.sessionId
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          return failure('bad-request', 'workspaceOf needs a sessionId')
        }
        return { ok: true, value: workspaceOf(sessionId) }
      }
      default:
        return failure('not-found', 'unknown endpoint')
    }
  })
}
