/**
 * Process-local FIFO limit for DeepSeek Harness subagent turns.
 *
 * @module dsh-subagent-concurrency-limit
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'

export const name = 'subagent-concurrency-limit'
export const inject = ['tools']

const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 2
const DEFAULT_QUEUE_TIMEOUT_MS = 300_000

/** Plugin configuration. */
export interface Config {
  /** Maximum local non-root turns and observable remote runs at once. */
  maxConcurrentSubagents?: number
  /** How long a pool wait may stay queued before failing loudly, in milliseconds. */
  queueTimeoutMs?: number
  /** Delegation tool names whose calls are limited. */
  subagentToolNames?: string[]
}

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
  private readonly limit: number
  private closed = false

  constructor(limit: number) {
    this.limit = limit
  }

  async enter(key: object, signal: AbortSignal, timeoutMs: number): Promise<void> {
    if (this.active.has(key)) return
    signal.throwIfAborted()
    if (this.closed) throw new Error('subagent concurrency limit is disposed')

    if (this.active.size < this.limit && this.waiters.length === 0) {
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
    if (this.waiters.length > 0 || this.active.size >= this.limit) return false
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

function resolveConfig(config: Config): {
  limit: number
  queueTimeoutMs: number
  subagentToolNames: ReadonlySet<string>
} {
  const limit = config.maxConcurrentSubagents ?? DEFAULT_MAX_CONCURRENT_SUBAGENTS
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError('maxConcurrentSubagents must be a positive safe integer')
  }
  const queueTimeoutMs = config.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS
  if (!Number.isSafeInteger(queueTimeoutMs) || queueTimeoutMs < 1) {
    throw new TypeError('queueTimeoutMs must be a positive safe integer')
  }
  const names = config.subagentToolNames ?? ['subagent']
  if (
    !Array.isArray(names) ||
    names.length === 0 ||
    names.some((value) => typeof value !== 'string' || value.length === 0)
  ) {
    throw new TypeError('subagentToolNames must contain at least one non-empty string')
  }
  return { limit, queueTimeoutMs, subagentToolNames: new Set(names) }
}

/**
 * Install the process-local delegation and child-turn gate.
 *
 * Root delegation calls wait in FIFO order. A nested configured delegation
 * call never waits when the pool is full, because its parent may be waiting
 * for that child. Local child turns use the same pool; root turns do not.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const { limit, queueTimeoutMs, subagentToolNames } = resolveConfig(config)
  const gate = new ConcurrencyGate(limit)
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

  ctx.on('tools/execute', async (exec, next) => {
    if (!subagentToolNames.has(exec.name) || exec.agent === undefined) {
      return next()
    }

    const root = delegationDepthOf(exec.agent) === 0
    const reservation: Reservation = { state: 'open' }
    if (root) {
      await gate.enter(reservation, exec.signal, queueTimeoutMs)
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
        await gate.enter(lease, info.signal, queueTimeoutMs)
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
    if (info.status === 'idle') releaseTurn(String(info.agent.id))
  })

  ctx.on('agent/disposed', (info) => {
    const agentId = String(info.agent.id)
    releaseTurn(agentId)
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
