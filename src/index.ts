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
}

/** Config schema. Volatile fields show up in dsh settings and on the Plugins page. */
export const Config = Schema.object({
  baton: Schema.boolean()
    .default(false)
    .description('Only one agent, the root included, generates at a time.')
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
        waiter.timeout = setTimeout(() => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          signal.removeEventListener('abort', waiter.abort)
          reject(timeoutError)
        }, timeoutMs)
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
 * before the parent resumes. While the owner is inside a tool call it is not
 * generating, so a waiting agent may borrow the baton; this keeps a parent that
 * waits on an untracked child (for example a workflow agent) from deadlocking.
 */
class Baton {
  private owner: string | undefined
  private readonly suspended: string[] = []
  private readonly delegated = new Map<string, string[]>()
  private readonly waiters: BatonWaiter[] = []
  private readonly inTools = new Map<string, number>()
  private closed = false

  async acquire(id: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.closed) throw new Error('subagent baton is disposed')
    if (this.owner === id) return
    if (this.owner === undefined) {
      this.owner = id
      return
    }
    if (this.busyInTools(this.owner) && !this.suspended.includes(id)) {
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
    })
  }

  /** The parent's delegation published a local child: the baton follows it. */
  handoff(parent: string, child: string): void {
    if (parent === child || this.closed) return
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
    this.inTools.set(id, (this.inTools.get(id) ?? 0) + 1)
    if (this.owner === id) this.settle()
  }

  toolEnd(id: string): void {
    const count = (this.inTools.get(id) ?? 0) - 1
    if (count > 0) this.inTools.set(id, count)
    else this.inTools.delete(id)
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
    this.release(id)
  }

  /** Baton mode was switched: forget ownership and let every waiter through. */
  reset(): void {
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
      const borrower = this.waiters.find((waiter) => waiter.id !== owner && !this.suspended.includes(waiter.id))
      if (borrower === undefined) break
      this.suspended.push(owner)
      this.owner = borrower.id
    }
    for (const waiter of [...this.waiters]) {
      if (waiter.id !== this.owner) continue
      this.waiters.splice(this.waiters.indexOf(waiter), 1)
      waiter.signal.removeEventListener('abort', waiter.abort)
      waiter.resolve()
    }
  }
}

/** A delegation call holding a permit until its child run claims it. */
interface Reservation {
  state: 'open' | 'bound' | 'done'
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
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1
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
  let namesSource: readonly string[] | undefined
  let namesSet: ReadonlySet<string> = new Set()
  return {
    limit,
    queueTimeoutMs,
    baton,
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
export function apply(ctx: Context, config: Config = {}): void {
  const settings = resolveConfig(config)
  const gate = new ConcurrencyGate(settings.limit)
  const startContext = new AsyncLocalStorage<Reservation>()
  const startsByRunId = new Map<string, RunState>()
  const activeTurnsByAgentId = new Map<string, object>()
  const pendingByAgentId = new Map<string, Reservation[]>()

  function releaseTurn(agentId: string): void {
    const lease = activeTurnsByAgentId.get(agentId)
    if (lease === undefined) return
    activeTurnsByAgentId.delete(agentId)
    for (const run of startsByRunId.values()) {
      if (run.lease === lease) run.lease = undefined
    }
    gate.release(lease)
  }

  ctx.effect(() => () => gate.close(), 'subagent concurrency limit')

  // The baton tracks tools and releases even while off, so switching it on
  // live starts from correct tool counts; only acquiring and handoff check it.
  const baton = new Baton()
  const toolAgent = new AsyncLocalStorage<string>()
  let batonWasOn = settings.baton()
  function batonOn(): boolean {
    const on = settings.baton()
    if (on !== batonWasOn) {
      batonWasOn = on
      baton.reset()
    }
    return on
  }
  ctx.effect(() => () => baton.close(), 'subagent baton')

  // Prepended so no other step or tool listener runs ahead of the baton.
  ctx.on(
    'agent/pre-step',
    async (info, next) => {
      gate.pump()
      if (batonOn()) await baton.acquire(String(info.agent.id), info.signal)
      return next()
    },
    { prepend: true },
  )

  ctx.on(
    'tools/execute',
    async (exec, next) => {
      gate.pump()
      if (exec.agent === undefined) return next()
      const agentId = String(exec.agent.id)
      baton.toolStart(agentId)
      try {
        return await toolAgent.run(agentId, next)
      } finally {
        baton.toolEnd(agentId)
      }
    },
    { prepend: true },
  )

  ctx.on('tools/execute', async (exec, next) => {
    if (!settings.subagentToolNames().has(exec.name) || exec.agent === undefined) {
      return next()
    }

    const root = delegationDepthOf(exec.agent) === 0
    const reservation: Reservation = { state: 'open' }
    if (root) {
      await gate.enter(reservation, exec.signal, settings.queueTimeoutMs())
    } else if (!gate.tryEnter(reservation, exec.signal)) {
      throw new Error('subagent concurrency limit exhausted for nested delegation')
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

    const parentId = toolAgent.getStore()
    if (info.local && parentId !== undefined && batonOn()) baton.handoff(parentId, String(info.id))

    startsByRunId.set(String(info.runId), {
      agentId: String(info.id),
      local: info.local,
      reservation: ownedReservation,
      ended: false,
    })
  })

  ctx.on('subagent/end', (info) => {
    const runId = String(info.runId)
    const run = startsByRunId.get(runId)
    if (run === undefined) return
    run.ended = true
    startsByRunId.delete(runId)
    if (run.local) baton.release(run.agentId)
    if (run.lease !== undefined) {
      const lease = run.lease
      run.lease = undefined
      if (activeTurnsByAgentId.get(run.agentId) === lease) {
        activeTurnsByAgentId.delete(run.agentId)
      }
      gate.release(lease)
    } else if (run.reservation !== undefined) {
      gate.release(run.reservation)
    }
  })

  ctx.on('agent/pre-step', async (info, next) => {
    const agentId = String(info.agent.id)
    if (delegationDepthOf(info.agent) === 0) return next()
    if (activeTurnsByAgentId.has(agentId)) return next()

    const run = [...startsByRunId.values()].find(
      (candidate) => candidate.local && candidate.agentId === agentId && candidate.lease === undefined,
    )
    const lease = run?.reservation ?? {}
    try {
      if (run?.reservation !== undefined) {
        // A locally published child's reservation must remain active until its first turn.
        if (!gate.tryEnter(lease, info.signal)) {
          throw new Error('subagent concurrency limit reservation was lost')
        }
      } else if (run !== undefined) {
        // Published without a reservation (a jobs publish whose async context
        // lost the tool call's store). Never queue: fail loudly when the pool
        // is full, so the child cannot block the ancestor waiting for it.
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
    releaseTurn(String(info.agent.id))
    baton.release(String(info.agent.id))
  })

  ctx.on('agent/disposed', (info) => {
    const agentId = String(info.agent.id)
    releaseTurn(agentId)
    baton.disposed(agentId)
    for (const [runId, run] of startsByRunId) {
      if (!run.local || run.agentId !== agentId) continue
      run.ended = true
      if (run.lease !== undefined) {
        const lease = run.lease
        run.lease = undefined
        gate.release(lease)
      } else if (run.reservation !== undefined) {
        gate.release(run.reservation)
      }
      startsByRunId.delete(runId)
    }
    const pending = pendingByAgentId.get(agentId)
    if (pending !== undefined) {
      pendingByAgentId.delete(agentId)
      for (const reservation of pending) {
        if (reservation.state !== 'open') continue
        gate.release(reservation)
        reservation.state = 'done'
      }
    }
  })
}
