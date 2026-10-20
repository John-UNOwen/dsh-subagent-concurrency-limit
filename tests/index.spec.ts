import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { apply, Config } from '../src/index.ts'

function mockAgent(id: string, subagentDepth = 0): Agent {
  return {
    id,
    options: { subagentDepth },
    session: { header: {} },
    status: 'running',
  } as unknown as Agent
}

function status(ctx: Context, agent: Agent, value: 'idle' | 'running'): void {
  ctx.emit(ctx as never, 'agent/status', { agent, status: value })
}

function step(
  ctx: Context,
  agent: Agent,
  entered: string[],
  signal = new AbortController().signal,
  next: () => Promise<PreStepDecision> = () => {
    entered.push(String(agent.id))
    return Promise.resolve({ kind: 'enter', messages: [] })
  },
): Promise<PreStepDecision> {
  status(ctx, agent, 'running')
  return agentEvents(ctx, agent).waterfall('agent/pre-step', { messages: [], turn: 1, step: 1, signal }, next)
}

function finishTurn(ctx: Context, agent: Agent): void {
  status(ctx, agent, 'idle')
}

interface ToolCallOptions {
  name?: string
  signal?: AbortSignal
  start?: boolean
  deferStart?: boolean
  error?: Error
  local?: boolean
  childId?: string
}

function toolCall(
  ctx: Context,
  agent: Agent,
  runId: string,
  entered: string[],
  options: ToolCallOptions = {},
): Promise<ToolExecutionResult> {
  const exec = {
    name: options.name ?? 'subagent',
    agent,
    signal: options.signal ?? new AbortController().signal,
  } as ToolDispatchExecution
  return ctx.waterfall(ctx as never, 'tools/execute', exec, () => {
    entered.push(runId)
    if (options.start !== false) {
      // `deferStart` schedules the publish after the tool returns, like a
      // background job, while keeping the tool call's async context alive.
      const emitStart = () => {
        ctx.emit(ctx as never, 'subagent/start', {
          runId,
          provider: options.local === false ? 'remote' : 'spawn',
          id: options.childId ?? `child-${runId}`,
          local: options.local !== false,
        })
      }
      if (options.deferStart) setTimeout(emitStart, 0)
      else emitStart()
    }
    if (options.error !== undefined) return Promise.reject(options.error)
    return Promise.resolve({ isError: false, value: {}, content: [] })
  })
}

function startLocalRun(ctx: Context, runId: string, agentId: string): void {
  ctx.emit(ctx as never, 'subagent/start', {
    runId,
    provider: 'spawn',
    id: agentId,
    local: true,
  })
}

function endRun(ctx: Context, runId: string, local = true): void {
  ctx.emit(ctx as never, 'subagent/end', {
    runId,
    provider: local ? 'spawn' : 'remote',
    id: `child-${runId}`,
    local,
    stopReason: 'completed',
  })
}

describe('subagent concurrency limit', () => {
  it('queues root direct calls before child creation in FIFO order', async () => {
    const ctx = new Context()
    apply(ctx, { maxConcurrentSubagents: 2 })
    const root = mockAgent('root')
    const entered: string[] = []

    await Promise.all([toolCall(ctx, root, 'first', entered), toolCall(ctx, root, 'second', entered)])
    const third = toolCall(ctx, root, 'third', entered)
    const fourth = toolCall(ctx, root, 'fourth', entered)
    await Promise.resolve()
    assert.deepStrictEqual(entered, ['first', 'second'])

    endRun(ctx, 'first')
    await third
    assert.deepStrictEqual(entered, ['first', 'second', 'third'])

    endRun(ctx, 'second')
    await fourth
    assert.deepStrictEqual(entered, ['first', 'second', 'third', 'fourth'])
  })

  it('rejects a saturated nested foreground delegation and makes progress after release', async () => {
    const ctx = new Context()
    apply(ctx, { maxConcurrentSubagents: 1 })
    const root = mockAgent('root')
    const child = mockAgent('child', 1)
    const entered: string[] = []

    await toolCall(ctx, root, 'root-run', entered, { childId: child.id })
    await step(ctx, child, entered)
    await assert.rejects(toolCall(ctx, child, 'grandchild', entered), /exhausted for nested delegation/)

    finishTurn(ctx, child)
    endRun(ctx, 'root-run')
    await toolCall(ctx, root, 'after', entered)
    assert.deepStrictEqual(entered, ['root-run', 'child', 'after'])
  })

  it('shares one pool across children and grandchildren without double counting', async () => {
    const ctx = new Context()
    apply(ctx, { maxConcurrentSubagents: 2 })
    const root = mockAgent('root')
    const childOne = mockAgent('child-one', 1)
    const childTwo = mockAgent('child-two', 1)
    const grandchild = mockAgent('grandchild', 2)
    const entered: string[] = []

    await toolCall(ctx, root, 'child-one-run', entered, { childId: childOne.id })
    await toolCall(ctx, root, 'child-two-run', entered, { childId: childTwo.id })
    await step(ctx, childOne, entered)
    await step(ctx, childTwo, entered)
    await assert.rejects(toolCall(ctx, childOne, 'blocked-grandchild', entered), /exhausted for nested delegation/)

    finishTurn(ctx, childTwo)
    endRun(ctx, 'child-two-run')
    await toolCall(ctx, childOne, 'grandchild-run', entered, { childId: grandchild.id })
    await step(ctx, grandchild, entered)

    const waitingRoot = toolCall(ctx, root, 'waiting-root', entered)
    await Promise.resolve()
    assert.ok(!entered.includes('waiting-root'))

    finishTurn(ctx, grandchild)
    endRun(ctx, 'grandchild-run')
    finishTurn(ctx, childOne)
    endRun(ctx, 'child-one-run')
    await waitingRoot
    endRun(ctx, 'waiting-root')
  })

  it('limits resumed local non-root turns through the same pool', async () => {
    const ctx = new Context()
    apply(ctx, { maxConcurrentSubagents: 1 })
    const root = mockAgent('root')
    const child = mockAgent('child', 1)
    const other = mockAgent('other', 1)
    const entered: string[] = []

    await toolCall(ctx, root, 'initial', entered, { childId: child.id })
    await step(ctx, child, entered)
    finishTurn(ctx, child)
    endRun(ctx, 'initial')

    startLocalRun(ctx, 'resumed', child.id)
    const resumed = step(ctx, child, entered)
    await Promise.resolve()
    const waiting = step(ctx, other, entered)
    await Promise.resolve()
    assert.deepStrictEqual(entered, ['initial', 'child', 'child'])

    finishTurn(ctx, child)
    await resumed
    await waiting
    assert.deepStrictEqual(entered, ['initial', 'child', 'child', 'other'])
    finishTurn(ctx, other)
    endRun(ctx, 'resumed')
  })

  it('limits remote runs at their observable lifecycle boundary', async () => {
    const ctx = new Context()
    apply(ctx, { maxConcurrentSubagents: 1 })
    const root = mockAgent('root')
    const entered: string[] = []

    await toolCall(ctx, root, 'remote', entered, { local: false })
    const waiting = toolCall(ctx, root, 'next', entered)
    await Promise.resolve()
    assert.deepStrictEqual(entered, ['remote'])

    endRun(ctx, 'remote', false)
    await waiting
    assert.deepStrictEqual(entered, ['remote', 'next'])
    endRun(ctx, 'next')
  })

  it('does not count the root agent turn', async () => {
    const ctx = new Context()
    apply(ctx, { maxConcurrentSubagents: 1 })
    const root = mockAgent('root')
    const child = mockAgent('child', 1)
    const entered: string[] = []

    await Promise.all([step(ctx, root, entered), step(ctx, child, entered)])
    assert.ok(entered.includes('root'))
    assert.ok(entered.includes('child'))
    finishTurn(ctx, child)
  })

  it('releases a permit when a direct call ends without starting a run', async () => {
    const ctx = new Context()
    apply(ctx, { maxConcurrentSubagents: 1 })
    const root = mockAgent('root')
    const entered: string[] = []
    const error = new Error('delegation failed before start')

    await assert.rejects(toolCall(ctx, root, 'failed', entered, { start: false, error }), (thrown) => thrown === error)
    await toolCall(ctx, root, 'next', entered)
    assert.deepStrictEqual(entered, ['failed', 'next'])
    endRun(ctx, 'next')
  })

  it('removes an aborted root-call waiter without consuming a permit', async () => {
    const ctx = new Context()
    apply(ctx, { maxConcurrentSubagents: 1 })
    const root = mockAgent('root')
    const entered: string[] = []
    const abort = new AbortController()

    await toolCall(ctx, root, 'active', entered)
    const rejected = toolCall(ctx, root, 'cancelled', entered, { signal: abort.signal })
    await Promise.resolve()
    const reason = new Error('cancelled while waiting')
    abort.abort(reason)
    await assert.rejects(rejected, (thrown) => thrown === reason)

    const next = toolCall(ctx, root, 'next', entered)
    endRun(ctx, 'active')
    await next
    assert.deepStrictEqual(entered, ['active', 'next'])
    endRun(ctx, 'next')
  })

  it('releases a permit when a waiter is aborted immediately after admission', async () => {
    const ctx = new Context()
    apply(ctx, { maxConcurrentSubagents: 1 })
    const root = mockAgent('root')
    const entered: string[] = []
    const abort = new AbortController()

    await toolCall(ctx, root, 'active', entered)
    const admittedThenCancelled = toolCall(ctx, root, 'admitted-then-cancelled', entered, {
      signal: abort.signal,
    })
    endRun(ctx, 'active')
    abort.abort(new Error('cancelled after admission'))
    await assert.rejects(admittedThenCancelled, /cancelled after admission/)

    await toolCall(ctx, root, 'after', entered)
    endRun(ctx, 'after')
    assert.deepStrictEqual(entered, ['active', 'after'])
  })

  it('releases a local child permit on disposal', async () => {
    const ctx = new Context()
    apply(ctx, { maxConcurrentSubagents: 1 })
    const root = mockAgent('root')
    const child = mockAgent('child', 1)
    const entered: string[] = []

    await toolCall(ctx, root, 'child', entered, { childId: child.id })
    await step(ctx, child, entered)
    const waiting = toolCall(ctx, root, 'next', entered)
    await Promise.resolve()
    ctx.emit(ctx as never, 'agent/disposed', { agent: child })
    await waiting
    endRun(ctx, 'next')
    assert.deepStrictEqual(entered, ['child', 'child', 'next'])
  })

  it('releases a permit when a local pre-step fails', async () => {
    const ctx = new Context()
    apply(ctx, { maxConcurrentSubagents: 1 })
    const child = mockAgent('child', 1)
    const other = mockAgent('other', 1)
    const entered: string[] = []
    const error = new Error('pre-step failed')

    await assert.rejects(
      step(ctx, child, entered, new AbortController().signal, () => Promise.reject(error)),
      (thrown) => thrown === error,
    )
    await step(ctx, other, entered)
    finishTurn(ctx, other)
    assert.deepStrictEqual(entered, ['other'])
  })

  it('re-admits a root-reserved local child after its first pre-step fails', async () => {
    const ctx = new Context()
    apply(ctx, { maxConcurrentSubagents: 1 })
    const root = mockAgent('root')
    const child = mockAgent('child', 1)
    const entered: string[] = []
    const error = new Error('first child step failed')

    await toolCall(ctx, root, 'initial', entered, { childId: child.id })
    await assert.rejects(
      step(ctx, child, entered, new AbortController().signal, () => Promise.reject(error)),
      (thrown) => thrown === error,
    )
    await step(ctx, child, entered)

    const waiting = toolCall(ctx, root, 'waiting', entered)
    await Promise.resolve()
    assert.deepStrictEqual(entered, ['initial', 'child'])
    finishTurn(ctx, child)
    endRun(ctx, 'initial')
    await waiting
    endRun(ctx, 'waiting')
  })

  it('only gates configured delegation tool names', async () => {
    const ctx = new Context()
    apply(ctx, { maxConcurrentSubagents: 1, subagentToolNames: ['delegate'] })
    const root = mockAgent('root')
    const entered: string[] = []

    await toolCall(ctx, root, 'active', entered, { name: 'delegate' })
    await toolCall(ctx, root, 'other', entered, { name: 'other' })
    assert.deepStrictEqual(entered, ['active', 'other'])
    endRun(ctx, 'active')
    endRun(ctx, 'other')
  })

  it('rejects a root-call queue wait after queueTimeoutMs', async () => {
    const ctx = new Context()
    apply(ctx, { maxConcurrentSubagents: 1, queueTimeoutMs: 50 })
    const root = mockAgent('root')
    const entered: string[] = []

    await toolCall(ctx, root, 'active', entered)
    await assert.rejects(toolCall(ctx, root, 'queued', entered), /queue timeout after 50ms/)

    // The timed-out waiter consumes no permit: the next call enters immediately.
    endRun(ctx, 'active')
    await toolCall(ctx, root, 'next', entered)
    assert.deepStrictEqual(entered, ['active', 'next'])
    endRun(ctx, 'next')
  })

  it('rejects a resumed child turn queue wait after queueTimeoutMs', async () => {
    const ctx = new Context()
    apply(ctx, { maxConcurrentSubagents: 1, queueTimeoutMs: 50 })
    const root = mockAgent('root')
    const child = mockAgent('child', 1)
    const entered: string[] = []

    await toolCall(ctx, root, 'initial', entered, { childId: child.id })
    await step(ctx, child, entered)
    finishTurn(ctx, child)
    endRun(ctx, 'initial')
    await toolCall(ctx, root, 'holder', entered)
    await assert.rejects(step(ctx, child, entered), /queue timeout after 50ms/)

    endRun(ctx, 'holder')
    await step(ctx, child, entered)
    finishTurn(ctx, child)
    assert.deepStrictEqual(entered, ['initial', 'child', 'holder', 'child'])
  })

  it('keeps the reservation for a deferred job publish and admits the child first turn', async () => {
    const ctx = new Context()
    apply(ctx, { maxConcurrentSubagents: 1 })
    const root = mockAgent('root')
    const child = mockAgent('child', 1)
    const entered: string[] = []

    await toolCall(ctx, root, 'job-run', entered, { deferStart: true, childId: child.id })
    const queued = toolCall(ctx, root, 'queued', entered)
    // The tool has already returned; the deferred publish fires on the next timer.
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepStrictEqual(entered, ['job-run'])

    // The publish bound the retained reservation, so the child's first pre-step
    // passes even though the pool is full and a root call is queued.
    await step(ctx, child, entered)
    assert.deepStrictEqual(entered, ['job-run', 'child'])

    finishTurn(ctx, child)
    endRun(ctx, 'job-run')
    await queued
    assert.deepStrictEqual(entered, ['job-run', 'child', 'queued'])
    endRun(ctx, 'queued')
  })

  it('fails loudly for a reservation-less local run when the pool is full', async () => {
    const ctx = new Context()
    apply(ctx, { maxConcurrentSubagents: 1 })
    const root = mockAgent('root')
    const child = mockAgent('child', 1)
    const entered: string[] = []

    await toolCall(ctx, root, 'active', entered)
    // No tool call at all: the publish lost the reservation (lost ALS store).
    startLocalRun(ctx, 'orphan', child.id)
    await assert.rejects(step(ctx, child, entered), /exhausted for reservation-less local child turn/)

    endRun(ctx, 'active')
    await step(ctx, child, entered)
    finishTurn(ctx, child)
    endRun(ctx, 'orphan')
    assert.deepStrictEqual(entered, ['active', 'child'])
  })

  it('releases an unbound reservation when the delegating parent is disposed', async () => {
    const ctx = new Context()
    apply(ctx, { maxConcurrentSubagents: 1 })
    const root = mockAgent('root')
    const entered: string[] = []

    await toolCall(ctx, root, 'held', entered, { start: false })
    const queued = toolCall(ctx, root, 'queued', entered)
    await Promise.resolve()
    assert.deepStrictEqual(entered, ['held'])

    ctx.emit(ctx as never, 'agent/disposed', { agent: root })
    await queued
    assert.deepStrictEqual(entered, ['held', 'queued'])
    endRun(ctx, 'queued')
  })

  for (const maxConcurrentSubagents of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    it(`rejects invalid maxConcurrentSubagents ${maxConcurrentSubagents}`, () => {
      assert.throws(() => {
        apply(new Context(), { maxConcurrentSubagents })
      }, /maxConcurrentSubagents must be a positive safe integer/)
    })
  }

  for (const queueTimeoutMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    it(`rejects invalid queueTimeoutMs ${queueTimeoutMs}`, () => {
      assert.throws(() => {
        apply(new Context(), { queueTimeoutMs })
      }, /queueTimeoutMs must be a positive safe integer/)
    })
  }

  for (const subagentToolNames of [[], [''], ['subagent', '']]) {
    it(`rejects invalid subagentToolNames ${JSON.stringify(subagentToolNames)}`, () => {
      assert.throws(() => {
        apply(new Context(), { subagentToolNames })
      }, /subagentToolNames must contain at least one non-empty string/)
    })
  }
})

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function runTool(ctx: Context, agent: Agent, name: string, body: () => Promise<void>): Promise<ToolExecutionResult> {
  const exec = { name, agent, signal: new AbortController().signal } as ToolDispatchExecution
  return ctx.waterfall(ctx as never, 'tools/execute', exec, async () => {
    await body()
    return { isError: false, value: {}, content: [] }
  })
}

/** A foreground delegation: the tool call stays open until `finish` is called. */
function foregroundCall(ctx: Context, agent: Agent, runId: string, childId: string) {
  let finish = () => {}
  const done = new Promise<void>((resolve) => (finish = resolve))
  const result = runTool(ctx, agent, 'subagent', async () => {
    ctx.emit(ctx as never, 'subagent/start', { runId, provider: 'spawn', id: childId, local: true })
    await done
  })
  return { result, finish }
}

describe('baton', () => {
  it('pauses the parent while its handed-off child runs', async () => {
    const ctx = new Context()
    apply(ctx, { maxConcurrentSubagents: 1, baton: true })
    const root = mockAgent('root')
    const child = mockAgent('child', 1)
    const entered: string[] = []

    await step(ctx, root, entered)
    await toolCall(ctx, root, 'run', entered, { childId: child.id })
    const rootNext = step(ctx, root, entered)
    await flush()
    await step(ctx, child, entered)
    await step(ctx, child, entered)
    assert.deepStrictEqual(entered, ['root', 'run', 'child', 'child'])

    finishTurn(ctx, child)
    endRun(ctx, 'run')
    await rootNext
    assert.deepStrictEqual(entered, ['root', 'run', 'child', 'child', 'root'])
    finishTurn(ctx, root)
  })

  it('runs delegated siblings in order before the parent resumes', async () => {
    const ctx = new Context()
    apply(ctx, { maxConcurrentSubagents: 2, baton: true })
    const root = mockAgent('root')
    const a = mockAgent('a', 1)
    const b = mockAgent('b', 1)
    const entered: string[] = []

    await step(ctx, root, entered)
    await Promise.all([
      toolCall(ctx, root, 'run-a', entered, { childId: a.id }),
      toolCall(ctx, root, 'run-b', entered, { childId: b.id }),
    ])
    const rootNext = step(ctx, root, entered)
    const bStep = step(ctx, b, entered)
    await flush()
    await step(ctx, a, entered)
    assert.deepStrictEqual(entered, ['root', 'run-a', 'run-b', 'a'])

    finishTurn(ctx, a)
    await bStep
    await flush()
    assert.deepStrictEqual(entered, ['root', 'run-a', 'run-b', 'a', 'b'])

    finishTurn(ctx, b)
    await rootNext
    assert.deepStrictEqual(entered, ['root', 'run-a', 'run-b', 'a', 'b', 'root'])
    endRun(ctx, 'run-a')
    endRun(ctx, 'run-b')
  })

  it('lets a deeper delegation run first, then unwinds', async () => {
    const ctx = new Context()
    apply(ctx, { maxConcurrentSubagents: 2, baton: true })
    const root = mockAgent('root')
    const child = mockAgent('child', 1)
    const grandchild = mockAgent('grandchild', 2)
    const entered: string[] = []

    await step(ctx, root, entered)
    await toolCall(ctx, root, 'child-run', entered, { childId: child.id })
    const rootNext = step(ctx, root, entered)
    await step(ctx, child, entered)
    await toolCall(ctx, child, 'grandchild-run', entered, { childId: grandchild.id })
    const childNext = step(ctx, child, entered)
    await flush()
    await step(ctx, grandchild, entered)
    assert.deepStrictEqual(entered, ['root', 'child-run', 'child', 'grandchild-run', 'grandchild'])

    finishTurn(ctx, grandchild)
    endRun(ctx, 'grandchild-run')
    await childNext
    await flush()
    assert.deepStrictEqual(entered.slice(-1), ['child'])

    finishTurn(ctx, child)
    endRun(ctx, 'child-run')
    await rootNext
    assert.deepStrictEqual(entered.slice(-1), ['root'])
    finishTurn(ctx, root)
  })

  it('lends the baton while the owner waits inside a tool', async () => {
    const ctx = new Context()
    apply(ctx, { maxConcurrentSubagents: 1, baton: true })
    const root = mockAgent('root')
    const worker = mockAgent('worker', 1)
    const entered: string[] = []

    await step(ctx, root, entered)
    const workerStep = step(ctx, worker, entered)
    await flush()
    assert.deepStrictEqual(entered, ['root'])

    // The root waits in a tool for the untracked worker: the worker borrows the baton.
    let finishTool = () => {}
    const tool = runTool(ctx, root, 'wait', () => new Promise<void>((resolve) => (finishTool = resolve)))
    await workerStep
    assert.deepStrictEqual(entered, ['root', 'worker'])

    finishTool()
    await tool
    const rootNext = step(ctx, root, entered)
    await flush()
    assert.deepStrictEqual(entered, ['root', 'worker'])

    finishTurn(ctx, worker)
    await rootNext
    assert.deepStrictEqual(entered, ['root', 'worker', 'root'])
    finishTurn(ctx, root)
  })

  it('passes the baton to the next waiter when its owner goes idle', async () => {
    const ctx = new Context()
    apply(ctx, { baton: true })
    const root = mockAgent('root')
    const mate = mockAgent('mate')
    const entered: string[] = []

    await step(ctx, root, entered)
    const mateStep = step(ctx, mate, entered)
    await flush()
    assert.deepStrictEqual(entered, ['root'])
    finishTurn(ctx, root)
    await mateStep
    assert.deepStrictEqual(entered, ['root', 'mate'])
    finishTurn(ctx, mate)
  })

  it('removes an aborted waiter and returns the baton on disposal', async () => {
    const ctx = new Context()
    apply(ctx, { baton: true })
    const root = mockAgent('root')
    const child = mockAgent('child', 1)
    const other = mockAgent('other', 1)
    const entered: string[] = []
    const abort = new AbortController()

    await step(ctx, child, entered)
    const cancelled = step(ctx, root, entered, abort.signal)
    await flush()
    abort.abort(new Error('cancelled while waiting'))
    await assert.rejects(cancelled, /cancelled while waiting/)

    const otherStep = step(ctx, other, entered)
    await flush()
    ctx.emit(ctx as never, 'agent/disposed', { agent: child })
    await otherStep
    assert.deepStrictEqual(entered, ['child', 'other'])
    finishTurn(ctx, other)
  })

  it('runs foreground nested delegations depth first and unwinds in order', async () => {
    const ctx = new Context()
    apply(ctx, { maxConcurrentSubagents: 4, baton: true })
    const root = mockAgent('root')
    const child = mockAgent('child', 1)
    const grandchild = mockAgent('grandchild', 2)
    const entered: string[] = []

    await step(ctx, root, entered)
    const toChild = foregroundCall(ctx, root, 'child-run', child.id)
    await flush()
    await step(ctx, child, entered)
    const toGrandchild = foregroundCall(ctx, child, 'grandchild-run', grandchild.id)
    await flush()
    await step(ctx, grandchild, entered)
    await step(ctx, grandchild, entered)
    assert.deepStrictEqual(entered, ['root', 'child', 'grandchild', 'grandchild'])

    finishTurn(ctx, grandchild)
    endRun(ctx, 'grandchild-run')
    toGrandchild.finish()
    await toGrandchild.result
    await step(ctx, child, entered)
    finishTurn(ctx, child)
    endRun(ctx, 'child-run')
    toChild.finish()
    await toChild.result
    await step(ctx, root, entered)
    assert.deepStrictEqual(entered, ['root', 'child', 'grandchild', 'grandchild', 'child', 'root'])
    finishTurn(ctx, root)
  })

  it('keeps ancestors paused while the deepest agent waits in a tool', async () => {
    const ctx = new Context()
    apply(ctx, { maxConcurrentSubagents: 4, baton: true })
    const root = mockAgent('root')
    const child = mockAgent('child', 1)
    const grandchild = mockAgent('grandchild', 2)
    const entered: string[] = []

    await step(ctx, root, entered)
    await toolCall(ctx, root, 'child-run', entered, { childId: child.id })
    await step(ctx, child, entered)
    await toolCall(ctx, child, 'grandchild-run', entered, { childId: grandchild.id })
    await step(ctx, grandchild, entered)

    let finishTool = () => {}
    const tool = runTool(ctx, grandchild, 'bash', () => new Promise<void>((resolve) => (finishTool = resolve)))
    const rootNext = step(ctx, root, entered)
    const childNext = step(ctx, child, entered)
    await flush()
    // Suspended ancestors never borrow the baton from a descendant.
    assert.deepStrictEqual(entered, ['root', 'child-run', 'child', 'grandchild-run', 'grandchild'])

    finishTool()
    await tool
    await step(ctx, grandchild, entered)
    finishTurn(ctx, grandchild)
    endRun(ctx, 'grandchild-run')
    await childNext
    await flush()
    assert.deepStrictEqual(entered.slice(-2), ['grandchild', 'child'])
    finishTurn(ctx, child)
    endRun(ctx, 'child-run')
    await rootNext
    assert.deepStrictEqual(entered.slice(-1), ['root'])
    finishTurn(ctx, root)
  })

  it('runs nested siblings in order before their parent and the root', async () => {
    const ctx = new Context()
    apply(ctx, { maxConcurrentSubagents: 4, baton: true })
    const root = mockAgent('root')
    const child = mockAgent('child', 1)
    const g1 = mockAgent('g1', 2)
    const g2 = mockAgent('g2', 2)
    const entered: string[] = []

    await step(ctx, root, entered)
    await toolCall(ctx, root, 'child-run', entered, { childId: child.id })
    await step(ctx, child, entered)
    await Promise.all([
      toolCall(ctx, child, 'g1-run', entered, { childId: g1.id }),
      toolCall(ctx, child, 'g2-run', entered, { childId: g2.id }),
    ])
    const rootNext = step(ctx, root, entered)
    const childNext = step(ctx, child, entered)
    const g2Step = step(ctx, g2, entered)
    await flush()
    await step(ctx, g1, entered)
    finishTurn(ctx, g1)
    await g2Step
    finishTurn(ctx, g2)
    await childNext
    finishTurn(ctx, child)
    await rootNext
    assert.deepStrictEqual(entered, ['root', 'child-run', 'child', 'g1-run', 'g2-run', 'g1', 'g2', 'child', 'root'])
    finishTurn(ctx, root)
  })

  it('admits a nested delegation over a full pool when the baton is on', async () => {
    const ctx = new Context()
    apply(ctx, { maxConcurrentSubagents: 1, baton: true })
    const root = mockAgent('root')
    const child = mockAgent('child', 1)
    const grandchild = mockAgent('grandchild', 2)
    const entered: string[] = []

    await step(ctx, root, entered)
    await toolCall(ctx, root, 'child-run', entered, { childId: child.id })
    await step(ctx, child, entered)
    await toolCall(ctx, child, 'grandchild-run', entered, { childId: grandchild.id })
    const childNext = step(ctx, child, entered)
    await step(ctx, grandchild, entered)
    await flush()
    assert.deepStrictEqual(entered, ['root', 'child-run', 'child', 'grandchild-run', 'grandchild'])
    finishTurn(ctx, grandchild)
    endRun(ctx, 'grandchild-run')
    await childNext
    finishTurn(ctx, child)
    endRun(ctx, 'child-run')
    finishTurn(ctx, root)
  })

  it('still fails a nested delegation fast at a full pool with the baton off', async () => {
    const ctx = new Context()
    apply(ctx, { maxConcurrentSubagents: 1 })
    const root = mockAgent('root')
    const child = mockAgent('child', 1)
    const entered: string[] = []

    await toolCall(ctx, root, 'child-run', entered, { childId: child.id })
    await step(ctx, child, entered)
    await assert.rejects(toolCall(ctx, child, 'grandchild-run', entered), /exhausted for nested delegation/)
    finishTurn(ctx, child)
    endRun(ctx, 'child-run')
  })

  it('keeps the baton with a sibling through short tool calls', async () => {
    const ctx = new Context()
    apply(ctx, { maxConcurrentSubagents: 4, baton: true, lendAfterMs: 60 })
    const root = mockAgent('root')
    const a = mockAgent('a', 1)
    const b = mockAgent('b', 1)
    const entered: string[] = []

    await step(ctx, root, entered)
    await Promise.all([
      toolCall(ctx, root, 'run-a', entered, { childId: a.id }),
      toolCall(ctx, root, 'run-b', entered, { childId: b.id }),
    ])
    await step(ctx, a, entered)
    const bStep = step(ctx, b, entered)

    // A short tool call: B must not take the baton, so A's next step follows directly.
    await runTool(ctx, a, 'pwsh', () => new Promise<void>((resolve) => setTimeout(resolve, 10)))
    await step(ctx, a, entered)
    assert.deepStrictEqual(entered.slice(-2), ['a', 'a'])
    assert.ok(!entered.includes('b'))

    // A long tool call: after lendAfterMs, B borrows the idle slot.
    let finishTool = () => {}
    const longTool = runTool(ctx, a, 'pwsh', () => new Promise<void>((resolve) => (finishTool = resolve)))
    await flush()
    assert.ok(!entered.includes('b'))
    await bStep
    assert.deepStrictEqual(entered.slice(-1), ['b'])

    finishTool()
    await longTool
    const aNext = step(ctx, a, entered)
    await flush()
    assert.deepStrictEqual(entered.slice(-1), ['b'])
    finishTurn(ctx, b)
    await aNext
    assert.deepStrictEqual(entered.slice(-1), ['a'])
    finishTurn(ctx, a)
    endRun(ctx, 'run-a')
    endRun(ctx, 'run-b')
    finishTurn(ctx, root)
  })

  it('lends at once to a waiting descendant even with a long lendAfterMs', async () => {
    const ctx = new Context()
    apply(ctx, { baton: true, lendAfterMs: 3_600_000 })
    const root = mockAgent('root')
    const worker = mockAgent('worker', 1)
    const entered: string[] = []

    await step(ctx, root, entered)
    const workerStep = step(ctx, worker, entered)
    let finishTool = () => {}
    const tool = runTool(ctx, root, 'workflow', () => new Promise<void>((resolve) => (finishTool = resolve)))
    await workerStep
    assert.deepStrictEqual(entered, ['root', 'worker'])
    finishTurn(ctx, worker)
    finishTool()
    await tool
    finishTurn(ctx, root)
  })

  it('rejects a non-boolean baton option', () => {
    assert.throws(() => {
      apply(new Context(), { baton: 'yes' as never })
    }, /baton must be a boolean/)
  })
})

/** A stand-in for the Loader's volatile reference, which dsh settings update in place. */
function live<T>(value: T): { get(): T; set(next: T): void } {
  let current = value
  return {
    get: () => current,
    set: (next) => {
      current = next
    },
  }
}

describe('live settings', () => {
  it('exports a volatile Config schema with the defaults', () => {
    const resolved = Config({}) as unknown as Record<string, { get(): unknown }>
    assert.strictEqual(resolved.baton.get(), false)
    assert.strictEqual(resolved.maxConcurrentSubagents.get(), 2)
    assert.strictEqual(resolved.queueTimeoutMs.get(), 300_000)
    assert.deepStrictEqual(resolved.subagentToolNames.get(), ['subagent'])
    assert.throws(() => Config({ maxConcurrentSubagents: 0 }))
    assert.throws(() => Config({ subagentToolNames: [] }))
  })

  it('runs from a schema-resolved config', async () => {
    const ctx = new Context()
    apply(ctx, Config({ baton: true, maxConcurrentSubagents: 1 }) as never)
    const root = mockAgent('root')
    const child = mockAgent('child', 1)
    const entered: string[] = []

    await step(ctx, root, entered)
    await toolCall(ctx, root, 'run', entered, { childId: child.id })
    const rootNext = step(ctx, root, entered)
    await step(ctx, child, entered)
    await flush()
    assert.deepStrictEqual(entered, ['root', 'run', 'child'])
    finishTurn(ctx, child)
    endRun(ctx, 'run')
    await rootNext
    finishTurn(ctx, root)
  })

  it('admits queued calls when the limit is raised live', async () => {
    const ctx = new Context()
    const limit = live(1)
    apply(ctx, { maxConcurrentSubagents: limit })
    const root = mockAgent('root')
    const entered: string[] = []

    await toolCall(ctx, root, 'first', entered)
    const second = toolCall(ctx, root, 'second', entered)
    await flush()
    assert.deepStrictEqual(entered, ['first'])

    limit.set(2)
    // The next agent activity picks the new limit up.
    await toolCall(ctx, root, 'other', entered, { name: 'other' })
    await second
    assert.deepStrictEqual(entered, ['first', 'other', 'second'])
    endRun(ctx, 'first')
    endRun(ctx, 'second')
  })

  it('releases baton waiters when the baton is switched off live', async () => {
    const ctx = new Context()
    const on = live(true)
    apply(ctx, { baton: on })
    const root = mockAgent('root')
    const child = mockAgent('child', 1)
    const other = mockAgent('other', 1)
    const entered: string[] = []

    await step(ctx, root, entered)
    const childStep = step(ctx, child, entered)
    await flush()
    assert.deepStrictEqual(entered, ['root'])

    on.set(false)
    await step(ctx, other, entered)
    await childStep
    assert.deepStrictEqual(entered.sort(), ['child', 'other', 'root'])

    // Switched back on, the baton starts fresh.
    on.set(true)
    finishTurn(ctx, root)
    finishTurn(ctx, child)
    finishTurn(ctx, other)
    await step(ctx, root, entered)
    const otherStep = step(ctx, other, entered)
    await flush()
    assert.strictEqual(entered.filter((id) => id === 'other').length, 1)
    finishTurn(ctx, root)
    await otherStep
    finishTurn(ctx, other)
  })

  it('follows delegation tool names edited live', async () => {
    const ctx = new Context()
    const names = live<readonly string[]>(['subagent'])
    apply(ctx, { maxConcurrentSubagents: 1, subagentToolNames: names })
    const root = mockAgent('root')
    const entered: string[] = []

    await toolCall(ctx, root, 'a', entered, { name: 'delegate' })
    await toolCall(ctx, root, 'b', entered, { name: 'delegate' })
    names.set(['delegate'])
    const queued = toolCall(ctx, root, 'c', entered, { name: 'delegate' })
    const blocking = toolCall(ctx, root, 'd', entered, { name: 'delegate' })
    await flush()
    assert.deepStrictEqual(entered, ['a', 'b', 'c'])
    endRun(ctx, 'c')
    await queued
    await blocking
    endRun(ctx, 'd')
  })

  it('keeps the last valid value when a live value turns invalid', async () => {
    const ctx = new Context()
    const limit = live(1)
    apply(ctx, { maxConcurrentSubagents: limit })
    const root = mockAgent('root')
    const entered: string[] = []

    await toolCall(ctx, root, 'first', entered)
    limit.set(0)
    const second = toolCall(ctx, root, 'second', entered)
    await flush()
    assert.deepStrictEqual(entered, ['first'])
    endRun(ctx, 'first')
    await second
    endRun(ctx, 'second')
  })
})

describe('timer limits', () => {
  it('clamps a queue timeout beyond the Node timer range instead of failing at once', async () => {
    const ctx = new Context()
    apply(ctx, { maxConcurrentSubagents: 1, queueTimeoutMs: 300_000_000_000 })
    const root = mockAgent('root')
    const entered: string[] = []

    await toolCall(ctx, root, 'first', entered)
    let settled = false
    const queued = toolCall(ctx, root, 'queued', entered).finally(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.strictEqual(settled, false)
    endRun(ctx, 'first')
    await queued
    assert.deepStrictEqual(entered, ['first', 'queued'])
    endRun(ctx, 'queued')
  })
})

describe('permit leaks seen in a live fan-out', () => {
  for (const baton of [false, true]) {
    it(`frees the slot of a child that goes idle before its first step (baton ${baton})`, async () => {
      const ctx = new Context()
      apply(ctx, { maxConcurrentSubagents: 1, baton })
      const root = mockAgent('root')
      const child = mockAgent('child', 1)
      const entered: string[] = []

      // The child is published, then aborted while still waiting: it never steps.
      await toolCall(ctx, root, 'never-stepped', entered, { childId: child.id })
      status(ctx, child, 'running')
      finishTurn(ctx, child)

      // A later root delegation must not queue behind the unused slot.
      let settled = false
      const next = toolCall(ctx, root, 'next', entered).finally(() => {
        settled = true
      })
      await flush()
      assert.strictEqual(settled, true)
      await next
      assert.deepStrictEqual(entered, ['never-stepped', 'next'])
      endRun(ctx, 'next')
    })
  }

  it('admits a resumed continuable child turn on a full pool with the baton on', async () => {
    const ctx = new Context()
    apply(ctx, { maxConcurrentSubagents: 1, baton: true })
    const root = mockAgent('root')
    const child = mockAgent('child', 1)
    const entered: string[] = []

    await toolCall(ctx, root, 'child-run', entered, { childId: child.id })
    await step(ctx, child, entered)
    finishTurn(ctx, child)
    // Another root delegation now holds the only permit.
    await toolCall(ctx, root, 'holder', entered)

    // The same run continues with a new message: no new subagent/start.
    await step(ctx, child, entered)
    assert.deepStrictEqual(entered, ['child-run', 'child', 'holder', 'child'])
    finishTurn(ctx, child)
    endRun(ctx, 'child-run')
    endRun(ctx, 'holder')
  })

  it('reports a resumed child turn on a full pool clearly with the baton off', async () => {
    const ctx = new Context()
    apply(ctx, { maxConcurrentSubagents: 1 })
    const root = mockAgent('root')
    const child = mockAgent('child', 1)
    const entered: string[] = []

    await toolCall(ctx, root, 'child-run', entered, { childId: child.id })
    await step(ctx, child, entered)
    finishTurn(ctx, child)
    await toolCall(ctx, root, 'holder', entered)
    await assert.rejects(step(ctx, child, entered), /exhausted for reservation-less local child turn/)
    endRun(ctx, 'holder')
    await step(ctx, child, entered)
    finishTurn(ctx, child)
    endRun(ctx, 'child-run')
  })
})

/** dsh-user-approval's answerer waterfall: runs before `tools/execute`, around the whole answer. */
function approval(
  ctx: Context,
  agent: Agent,
  answer: () => Promise<string>,
  signal = new AbortController().signal,
): Promise<string> {
  return ctx.waterfall(ctx as never, 'approval/request' as never, { agent, toolName: 'pwsh', signal } as never, answer)
}

describe('approvals', () => {
  it('lets an AI reviewer subagent run while the asking agent waits for it', async () => {
    const ctx = new Context()
    apply(ctx, { baton: true, lendAfterMs: 3_600_000 })
    const root = mockAgent('root')
    const reviewer = mockAgent('reviewer', 1)
    const entered: string[] = []

    await step(ctx, root, entered)
    // The reviewer is published and runs from inside the approval answerer.
    const outcome = approval(ctx, root, async () => {
      startLocalRun(ctx, 'review', reviewer.id)
      await step(ctx, reviewer, entered)
      finishTurn(ctx, reviewer)
      endRun(ctx, 'review')
      return 'approved'
    })
    assert.strictEqual(await outcome, 'approved')
    await step(ctx, root, entered)
    assert.deepStrictEqual(entered, ['root', 'reviewer', 'root'])
    finishTurn(ctx, root)
  })

  it('lends the baton after lendAfterMs while a human decides, even to a later waiter', async () => {
    const ctx = new Context()
    apply(ctx, { baton: true, lendAfterMs: 40 })
    const a = mockAgent('a')
    const b = mockAgent('b')
    const entered: string[] = []

    await step(ctx, a, entered)
    let decide = (_outcome: string) => {}
    const outcome = approval(ctx, a, () => new Promise<string>((resolve) => (decide = resolve)))
    // B starts waiting only after the approval is already pending.
    const bStep = step(ctx, b, entered)
    await flush()
    assert.deepStrictEqual(entered, ['a'])
    await bStep
    assert.deepStrictEqual(entered, ['a', 'b'])
    decide('approved')
    await outcome
    finishTurn(ctx, b)
    finishTurn(ctx, a)
  })

  it('stops counting a cancelled approval whose answerer never settles', async () => {
    const ctx = new Context()
    apply(ctx, { baton: true, lendAfterMs: 40 })
    const a = mockAgent('a')
    const b = mockAgent('b')
    const entered: string[] = []
    const cancel = new AbortController()

    await step(ctx, a, entered)
    void approval(ctx, a, () => new Promise<string>(() => {}), cancel.signal)
    cancel.abort()
    // A generates its next step; B must not borrow mid-generation after lendAfterMs.
    await step(ctx, a, entered)
    const bStep = step(ctx, b, entered)
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.deepStrictEqual(entered, ['a', 'a'])
    finishTurn(ctx, a)
    await bStep
    assert.deepStrictEqual(entered, ['a', 'a', 'b'])
    finishTurn(ctx, b)
  })
})

function providerAgent(id: string, provider: string, subagentDepth = 0): Agent {
  return {
    id,
    options: { subagentDepth, provider },
    session: { header: {} },
    status: 'running',
  } as unknown as Agent
}

/** One model step: pre-step, then the request whose route names the provider dsh actually used. */
async function modelStep(ctx: Context, agent: Agent, entered: string[], provider: string): Promise<void> {
  await step(ctx, agent, entered, new AbortController().signal, async () => {
    await agentEvents(ctx, agent).waterfall(
      'agent/request',
      { turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ provider, model: 'm' } as never),
    )
    entered.push(String(agent.id))
    return { kind: 'enter', messages: [] }
  })
}

describe('provider lanes', () => {
  const lanes = { 'local-a': {}, 'local-b': { maxConcurrentSubagents: 1 } }

  it('runs agents on different listed providers in parallel and serializes each provider', async () => {
    const ctx = new Context()
    apply(ctx, { baton: true, providers: lanes })
    const a1 = providerAgent('a1', 'local-a')
    const a2 = providerAgent('a2', 'local-a')
    const b1 = providerAgent('b1', 'local-b')
    const entered: string[] = []

    await modelStep(ctx, a1, entered, 'local-a')
    await modelStep(ctx, b1, entered, 'local-b')
    const a2Step = modelStep(ctx, a2, entered, 'local-a')
    await flush()
    assert.deepStrictEqual(entered, ['a1', 'b1'])
    finishTurn(ctx, a1)
    await a2Step
    assert.deepStrictEqual(entered, ['a1', 'b1', 'a2'])
    finishTurn(ctx, a2)
    finishTurn(ctx, b1)
  })

  it('does not limit an unlisted provider', async () => {
    const ctx = new Context()
    apply(ctx, { baton: true, maxConcurrentSubagents: 1, providers: lanes })
    const local = providerAgent('local', 'local-a')
    const cloud = providerAgent('cloud', 'deepseek-official')
    const entered: string[] = []

    await modelStep(ctx, local, entered, 'local-a')
    await modelStep(ctx, cloud, entered, 'deepseek-official')
    await modelStep(ctx, cloud, entered, 'deepseek-official')
    // The cloud root fans out past every limit.
    await Promise.all(['c1', 'c2', 'c3'].map((run) => toolCall(ctx, cloud, run, entered)))
    assert.deepStrictEqual(entered, ['local', 'cloud', 'cloud', 'c1', 'c2', 'c3'])
    finishTurn(ctx, local)
    finishTurn(ctx, cloud)
  })

  it('keeps a separate pool limit per provider, following the call arguments', async () => {
    const ctx = new Context()
    apply(ctx, { maxConcurrentSubagents: 1, providers: lanes })
    const root = providerAgent('root', 'local-a')
    const entered: string[] = []
    const call = (runId: string, provider?: string) =>
      ctx.waterfall(
        ctx as never,
        'tools/execute',
        {
          name: 'subagent',
          agent: root,
          arguments: provider === undefined ? {} : { provider, model: 'm' },
          signal: new AbortController().signal,
        } as never,
        () => {
          entered.push(runId)
          ctx.emit(ctx as never, 'subagent/start', { runId, provider: 'spawn', id: `child-${runId}`, local: true })
          return Promise.resolve({ isError: false, value: {}, content: [] })
        },
      )

    await modelStep(ctx, root, entered, 'local-a')
    await call('a-1')
    const aQueued = call('a-2')
    // A different provider in the arguments uses that provider's own pool.
    await call('b-1', 'local-b')
    const bQueued = call('b-2', 'local-b')
    await flush()
    assert.deepStrictEqual(entered, ['root', 'a-1', 'b-1'])
    endRun(ctx, 'b-1')
    await bQueued
    endRun(ctx, 'a-1')
    await aQueued
    assert.deepStrictEqual(entered, ['root', 'a-1', 'b-1', 'b-2', 'a-2'])
    endRun(ctx, 'a-2')
    endRun(ctx, 'b-2')
    finishTurn(ctx, root)
  })

  it('moves an agent to the lane of the provider its request actually used', async () => {
    const ctx = new Context()
    apply(ctx, { baton: true, providers: lanes })
    const switcher = providerAgent('switcher', 'local-a')
    const a = providerAgent('a', 'local-a')
    const b = providerAgent('b', 'local-b')
    const entered: string[] = []

    await modelStep(ctx, b, entered, 'local-b')
    // Guessed local-a at pre-step, but the request goes to local-b: it gives
    // local-a back and waits for local-b, which b holds.
    const switched = modelStep(ctx, switcher, entered, 'local-b')
    await flush()
    await modelStep(ctx, a, entered, 'local-a')
    assert.deepStrictEqual(entered, ['b', 'a'])
    finishTurn(ctx, b)
    await switched
    assert.deepStrictEqual(entered, ['b', 'a', 'switcher'])
    finishTurn(ctx, a)
    finishTurn(ctx, switcher)
  })

  it('pauses a parent only for children on its own provider', async () => {
    const ctx = new Context()
    apply(ctx, { baton: true, maxConcurrentSubagents: 4, providers: lanes })
    const root = providerAgent('root', 'local-a')
    const same = providerAgent('same', 'local-a', 1)
    const other = providerAgent('other', 'local-b', 1)
    const entered: string[] = []
    const spawn = (runId: string, childId: string, provider?: string) =>
      ctx.waterfall(
        ctx as never,
        'tools/execute',
        {
          name: 'subagent',
          agent: root,
          arguments: provider === undefined ? {} : { provider, model: 'm' },
          signal: new AbortController().signal,
        } as never,
        () => {
          ctx.emit(ctx as never, 'subagent/start', { runId, provider: 'spawn', id: childId, local: true })
          return Promise.resolve({ isError: false, value: {}, content: [] })
        },
      )

    await modelStep(ctx, root, entered, 'local-a')
    // A child on another provider: the parent keeps going.
    await spawn('other-run', other.id, 'local-b')
    await modelStep(ctx, root, entered, 'local-a')
    await modelStep(ctx, other, entered, 'local-b')
    assert.deepStrictEqual(entered, ['root', 'root', 'other'])

    // A child on its own provider: the parent pauses until it finishes.
    await spawn('same-run', same.id)
    const rootNext = modelStep(ctx, root, entered, 'local-a')
    await modelStep(ctx, same, entered, 'local-a')
    await flush()
    assert.deepStrictEqual(entered, ['root', 'root', 'other', 'same'])
    finishTurn(ctx, same)
    await rootNext
    assert.deepStrictEqual(entered.slice(-1), ['root'])
    finishTurn(ctx, root)
    finishTurn(ctx, other)
  })

  it('serializes providers that share a lane', async () => {
    const ctx = new Context()
    apply(ctx, { baton: true, providers: { 'gpu-a': {}, 'gpu-a-alt': { lane: 'gpu-a' }, 'gpu-b': {} } })
    const one = providerAgent('one', 'gpu-a')
    const two = providerAgent('two', 'gpu-a-alt')
    const three = providerAgent('three', 'gpu-b')
    const entered: string[] = []

    await modelStep(ctx, one, entered, 'gpu-a')
    const twoStep = modelStep(ctx, two, entered, 'gpu-a-alt')
    await modelStep(ctx, three, entered, 'gpu-b')
    await flush()
    assert.deepStrictEqual(entered, ['one', 'three'])
    finishTurn(ctx, one)
    await twoStep
    assert.deepStrictEqual(entered, ['one', 'three', 'two'])
    finishTurn(ctx, two)
    finishTurn(ctx, three)
  })

  it('follows a model switch before the next step instead of the last request', async () => {
    const ctx = new Context()
    apply(ctx, { baton: true, providers: { 'local-a': {} } })
    const holder = providerAgent('holder', 'local-a')
    const events: { type: string; data: unknown }[] = []
    const switcher = {
      id: 'switcher',
      options: { subagentDepth: 0, provider: 'local-a' },
      session: {
        header: {},
        get seq() {
          return events.length
        },
        eventAt: (seq: number) => events[seq],
      },
      status: 'running',
    } as unknown as Agent
    const entered: string[] = []

    // The switcher last ran on local-a, then the holder took local-a's baton.
    events.push({ type: 'request/header', data: { header: { config: { provider: 'local-a' } } } })
    await modelStep(ctx, switcher, entered, 'local-a')
    finishTurn(ctx, switcher)
    await modelStep(ctx, holder, entered, 'local-a')

    // The user switches the session to an unlisted cloud model: it must not wait for local-a.
    events.push({ type: 'model/selection', data: { provider: 'deepseek-official', model: 'deepseek-flash' } })
    let settled = false
    const next = modelStep(ctx, switcher, entered, 'deepseek-official').finally(() => {
      settled = true
    })
    await flush()
    assert.strictEqual(settled, true)
    await next
    assert.deepStrictEqual(entered, ['switcher', 'holder', 'switcher'])
    finishTurn(ctx, holder)
    finishTurn(ctx, switcher)
  })

  it('rejects a malformed providers map', () => {
    assert.throws(() => {
      apply(new Context(), { providers: { 'local-a': { maxConcurrentSubagents: 0 } } })
    }, /providers must map provider names/)
  })
})
