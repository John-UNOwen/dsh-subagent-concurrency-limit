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

export const name = 'subagent-concurrency-limit'
export const inject = ['tools']

const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 2
const DEFAULT_QUEUE_TIMEOUT_MS = 300_000
const DEFAULT_LEND_AFTER_MS = 30_000
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
   * Per-provider lanes. Each listed provider gets its own baton and pool;
   * unset fields inherit the top-level ones. When empty, one global lane
   * covers every agent. When not empty, unlisted providers are not limited.
   */
  providers?: Live<Readonly<Record<string, ProviderConfig>>>
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
  private readonly waiters: Waiter[] = []
  private readonly limit: () => number
  private closed = false

  constructor(limit: () => number) {
    this.limit = limit
  }

  /** Admit waiters a raised limit now has room for. */
  pump(): void {
    while (!this.closed && this.waiters.length > 0 && this.active.size < this.limit()) this.admitNext()
  }

  async enter(key: object, signal: AbortSignal, timeoutMs: number): Promise<void> {
    if (this.active.has(key)) return
    signal.throwIfAborted()
    if (this.closed) throw new Error('subagent concurrency limit is disposed')

    if (this.active.size < this.limit() && this.waiters.length === 0) {
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
    if (this.waiters.length > 0 || this.active.size >= this.limit()) return false
    this.active.add(key)
    return true
  }

  /** Admit over the limit. Baton mode uses it for nested delegation, which cannot add a generator. */
  forceEnter(key: object): void {
    if (this.closed) throw new Error('subagent concurrency limit is disposed')
    this.active.add(key)
  }

  release(key: object): void {
    if (!this.active.delete(key)) return
    this.admitNext()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.active.clear()
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
 */
class Baton {
  private owner: string | undefined
  private readonly suspended: string[] = []
  private readonly delegated = new Map<string, string[]>()
  private readonly waiters: BatonWaiter[] = []
  private readonly inTools = new Map<string, number>()
  private readonly toolSince = new Map<string, number>()
  private readonly depths = new Map<string, number>()
  private readonly parents = new Map<string, string>()
  private readonly lendAfterMs: () => number
  private lendTimer: ReturnType<typeof setTimeout> | undefined
  private closed = false

  constructor(lendAfterMs: () => number) {
    this.lendAfterMs = lendAfterMs
  }

  async acquire(id: string, signal: AbortSignal, depth: number): Promise<void> {
    signal.throwIfAborted()
    if (this.closed) throw new Error('subagent baton is disposed')
    this.depths.set(id, depth)
    // A step runs only after the previous step's tool calls settled, so any
    // tool count left here is a leak; clearing it keeps lending honest.
    this.inTools.delete(id)
    this.toolSince.delete(id)
    if (this.owner === id) return
    if (this.owner === undefined) {
      this.owner = id
      return
    }
    if (this.mayBorrow(id)) {
      this.lendTo(id)
      return
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: BatonWaiter = {
        id,
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
      // The owner may already be in a tool: start the lend clock for this waiter.
      this.scheduleLend()
    })
  }

  /** The parent's delegation published a local child: the baton follows it. */
  handoff(parent: string, child: string): void {
    if (parent === child || this.closed) return
    this.parents.set(child, parent)
    if (this.owner === parent) {
      this.suspended.push(parent)
      this.owner = child
      this.settle()
    } else if (this.suspended.includes(parent)) {
      let queue = this.delegated.get(parent)
      if (queue === undefined) {
        queue = []
        this.delegated.set(parent, queue)
      }
      if (!queue.includes(child)) queue.push(child)
    }
  }

  toolStart(id: string): void {
    const count = this.inTools.get(id) ?? 0
    if (count === 0) this.toolSince.set(id, Date.now())
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
    }
  }

  /** The agent went idle or its run ended: it no longer needs the baton. */
  release(id: string): void {
    const index = this.suspended.indexOf(id)
    if (index >= 0) this.suspended.splice(index, 1)
    if (this.owner !== id) return
    this.owner = undefined
    this.passOn()
  }

  disposed(id: string): void {
    this.delegated.delete(id)
    for (const queue of this.delegated.values()) {
      const index = queue.indexOf(id)
      if (index >= 0) queue.splice(index, 1)
    }
    this.inTools.delete(id)
    this.toolSince.delete(id)
    this.depths.delete(id)
    this.parents.delete(id)
    this.release(id)
  }

  /** Baton mode was switched: forget ownership and let every waiter through. */
  reset(): void {
    this.clearLendTimer()
    this.owner = undefined
    this.suspended.length = 0
    this.delegated.clear()
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
    const error = new Error('subagent baton is disposed')
    for (const waiter of this.waiters.splice(0)) {
      waiter.signal.removeEventListener('abort', waiter.abort)
      waiter.reject(error)
    }
  }

  private busyInTools(id: string): boolean {
    return (this.inTools.get(id) ?? 0) > 0
  }

  /** Whether `id` descends from `ancestor`: by recorded handoffs, else by depth. */
  private descendsFrom(id: string, ancestor: string): boolean {
    let current = id
    for (let hops = 0; hops < 64; hops++) {
      const parent = this.parents.get(current)
      if (parent === ancestor) return true
      if (parent === undefined) break
      current = parent
    }
    const depth = this.depths.get(current)
    const ancestorDepth = this.depths.get(ancestor)
    return depth !== undefined && ancestorDepth !== undefined && depth > ancestorDepth
  }

  /** How long the current owner has been inside tool calls, or undefined when it is not. */
  private ownerToolTime(): number | undefined {
    if (this.owner === undefined || !this.busyInTools(this.owner)) return undefined
    return Date.now() - (this.toolSince.get(this.owner) ?? Date.now())
  }

  private mayBorrow(id: string): boolean {
    const owner = this.owner
    const toolTime = this.ownerToolTime()
    if (owner === undefined || toolTime === undefined || id === owner || this.suspended.includes(id)) return false
    return this.descendsFrom(id, owner) || toolTime >= this.lendAfterMs()
  }

  private clearLendTimer(): void {
    if (this.lendTimer === undefined) return
    clearTimeout(this.lendTimer)
    this.lendTimer = undefined
  }

  /** Re-check lending once the owner's tool time reaches lendAfterMs. */
  private scheduleLend(): void {
    this.clearLendTimer()
    const toolTime = this.ownerToolTime()
    if (this.closed || toolTime === undefined || this.waiters.length === 0) return
    const delay = Math.min(Math.max(this.lendAfterMs() - toolTime, 0), MAX_TIMER_MS)
    this.lendTimer = setTimeout(() => {
      this.lendTimer = undefined
      this.settle()
    }, delay)
  }

  private lendTo(id: string): void {
    if (this.owner !== undefined) this.suspended.push(this.owner)
    this.owner = id
    this.settle()
  }

  /** Pick the next owner: delegated siblings, then the parent, then FIFO. */
  private passOn(): void {
    const top = this.suspended.at(-1)
    if (top !== undefined) {
      const queue = this.delegated.get(top)
      const child = queue?.shift()
      if (queue !== undefined && queue.length === 0) this.delegated.delete(top)
      if (child !== undefined) {
        this.owner = child
      } else {
        this.suspended.pop()
        this.owner = top
      }
    } else {
      this.owner = this.waiters.find((waiter) => !this.suspended.includes(waiter.id))?.id
    }
    this.settle()
  }

  /** Lend an owner busy in tools, then wake whoever now owns the baton. */
  private settle(): void {
    while (this.owner !== undefined && this.busyInTools(this.owner)) {
      const owner = this.owner
      const borrower = this.waiters.find((waiter) => this.mayBorrow(waiter.id))
      if (borrower === undefined) break
      this.suspended.push(owner)
      this.owner = borrower.id
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
  providers(): Readonly<Record<string, ProviderConfig>>
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
  const providers = liveField<Readonly<Record<string, ProviderConfig>>>(
    config.providers,
    {},
    isProviderMap,
    'providers must map provider names to { baton?, maxConcurrentSubagents?, lendAfterMs? }',
  )
  let namesSource: readonly string[] | undefined
  let namesSet: ReadonlySet<string> = new Set()
  return {
    limit,
    queueTimeoutMs,
    baton,
    lendAfterMs,
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

  constructor(key: string, batonSetting: () => boolean, limit: () => number, lendAfterMs: () => number) {
    this.key = key
    this.batonSetting = batonSetting
    this.gate = new ConcurrencyGate(limit)
    this.baton = new Baton(lendAfterMs)
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

/** The key of the single lane used while no providers are listed. */
const GLOBAL_LANE = '*'

export function apply(ctx: Context, config: Config = {}): void {
  const settings = resolveConfig(config)
  const lanes = new Map<string, Lane>()
  /** Gate holding each pool key, so a release reaches the right lane. */
  const gateOf = new WeakMap<object, ConcurrencyGate>()
  /** Provider each agent's last model request used. */
  const observedProvider = new Map<string, string>()
  /** Provider a published child is expected to use until it makes a request. */
  const expectedProvider = new Map<string, string>()
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
      const entry = provider === undefined ? undefined : listed[provider]
      if (entry === undefined) return undefined
      key = `lane:${entry.lane ?? provider}`
    }
    let lane = lanes.get(key)
    if (lane === undefined) {
      const laneKey = key
      // A shared lane takes its settings from the first provider listed for it.
      const own = () =>
        laneKey === GLOBAL_LANE
          ? undefined
          : Object.entries(settings.providers()).find(([name, entry]) => `lane:${entry.lane ?? name}` === laneKey)?.[1]
      lane = new Lane(
        key,
        () => own()?.baton ?? settings.baton(),
        () => own()?.maxConcurrentSubagents ?? settings.limit(),
        () => own()?.lendAfterMs ?? settings.lendAfterMs(),
      )
      lanes.set(key, lane)
    }
    return lane
  }

  function providerOf(agent: { readonly id: unknown; readonly options?: unknown; readonly session?: unknown }) {
    const id = String(agent.id)
    const fromOptions = (agent.options as { provider?: unknown } | undefined)?.provider
    return (
      selectedProvider(agent.session) ??
      observedProvider.get(id) ??
      expectedProvider.get(id) ??
      (typeof fromOptions === 'string' ? fromOptions : undefined)
    )
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

  // Prepended so no other step or tool listener runs ahead of the baton. The
  // lane here is a best guess; `agent/request` corrects it with the real route.
  ctx.on(
    'agent/pre-step',
    async (info, next) => {
      pumpAll()
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
        await takeBaton(agentId, delegationDepthOf(info.agent), lane, info.signal)
      }
      return call
    },
    { prepend: true },
  )

  /** Count `run` as tool time of `agentId`, so the baton can be lent while it waits. */
  async function asToolTime<T>(agentId: string, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
    let done = false
    const counted = [...lanes.values()]
    const end = () => {
      if (done) return
      done = true
      signal?.removeEventListener('abort', end)
      for (const lane of counted) lane.baton.toolEnd(agentId)
    }
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
      return await startContext.run(reservation, next)
    } catch (error) {
      failed = true
      throw error
    } finally {
      // An error publishes no run, so release. On success keep the reservation
      // open: a deferred `subagent/start` (jobs publishes after the tool
      // returns) binds it, and if none ever comes the parent's disposal
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
      } else if (run !== undefined) {
        // A later turn of a run, or a publish whose async context lost the
        // tool call's store. Never queue: fail loudly when the pool is full,
        // so the child cannot block the ancestor waiting for it.
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
    if (info.status !== 'idle') return
    const agentId = String(info.agent.id)
    releaseTurn(agentId)
    releaseUnusedReservations(agentId)
    for (const lane of lanes.values()) lane.baton.release(agentId)
    batonLaneOf.delete(agentId)
  })

  ctx.on('agent/disposed', (info) => {
    const agentId = String(info.agent.id)
    releaseTurn(agentId)
    for (const lane of lanes.values()) lane.baton.disposed(agentId)
    batonLaneOf.delete(agentId)
    observedProvider.delete(agentId)
    expectedProvider.delete(agentId)
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
}
