// Regression tests for the review findings fixed on the baton branch.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.ts'

function agent(id: string, depth = 0, extra: { cwd?: string; provider?: string; session?: object } = {}): Agent {
  return {
    id,
    options: { subagentDepth: depth, ...(extra.provider === undefined ? {} : { provider: extra.provider }) },
    session: extra.session ?? { header: extra.cwd === undefined ? {} : { cwd: extra.cwd } },
    status: 'running',
  } as unknown as Agent
}

function status(ctx: Context, a: Agent, value: 'idle' | 'running'): void {
  ctx.emit(ctx as never, 'agent/status', { agent: a, status: value })
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

function step(
  ctx: Context,
  a: Agent,
  entered: string[],
  next: () => Promise<PreStepDecision> = () => {
    entered.push(String(a.id))
    return Promise.resolve({ kind: 'enter', messages: [] })
  },
): Promise<PreStepDecision> {
  status(ctx, a, 'running')
  return agentEvents(ctx, a).waterfall(
    'agent/pre-step',
    { messages: [], turn: 1, step: 1, signal: new AbortController().signal },
    next,
  )
}

const result = (isError = false) => ({ isError, value: {}, content: [] }) as unknown as ToolExecutionResult

/** One `tools/execute` dispatch, shaped like the host: the body is the waterfall's last step. */
function tool(
  ctx: Context,
  a: Agent,
  body: () => Promise<ToolExecutionResult>,
  options: { name?: string; args?: Record<string, unknown> } = {},
): Promise<ToolExecutionResult> {
  const exec = {
    name: options.name ?? 'subagent',
    agent: a,
    arguments: options.args ?? {},
    signal: new AbortController().signal,
  } as unknown as ToolDispatchExecution
  return ctx.waterfall(ctx as never, 'tools/execute', exec, body)
}

function start(ctx: Context, runId: string, childId: string): void {
  ctx.emit(ctx as never, 'subagent/start', { runId, provider: 'spawn', id: childId, local: true })
}

function end(ctx: Context, runId: string, childId: string): void {
  ctx.emit(ctx as never, 'subagent/end', {
    runId,
    provider: 'spawn',
    id: childId,
    local: true,
    stopReason: 'completed',
  })
}

/** A delegation that publishes `childId` inside the call and records `label`. */
function delegate(ctx: Context, a: Agent, label: string, childId: string, entered: string[], name = 'subagent') {
  return tool(
    ctx,
    a,
    () => {
      entered.push(label)
      start(ctx, label, childId)
      return Promise.resolve(result())
    },
    { name },
  )
}

describe('review findings', () => {
  it('#1 keeps the baton with a generating parent when a background child publishes late', async () => {
    const ctx = new Context()
    apply(ctx, { baton: true, lendAfterMs: 3_600_000 })
    const root = agent('root')
    const child = agent('child', 1)
    const entered: string[] = []

    await step(ctx, root, entered)
    // A background delegation: the publish lands later, from the tool call's context.
    let publish = () => {}
    await tool(ctx, root, async () => {
      const gate = new Promise<void>((resolve) => (publish = resolve))
      void gate.then(() => start(ctx, 'job', child.id))
      return result()
    })

    let childStep: Promise<PreStepDecision> | undefined
    await step(ctx, root, entered, async () => {
      entered.push('root')
      publish()
      await flush()
      childStep = step(ctx, child, entered)
      await flush()
      // The parent is still generating: the child must not start alongside it.
      assert.deepStrictEqual(entered, ['root', 'root'])
      return { kind: 'enter', messages: [] }
    })
    status(ctx, root, 'idle')
    await childStep
    assert.deepStrictEqual(entered, ['root', 'root', 'child'])
    status(ctx, child, 'idle')
    end(ctx, 'job', child.id)
  })

  it('#2 frees the permit of a delegation that returns an isError result', async () => {
    const ctx = new Context()
    apply(ctx, { maxConcurrentSubagents: 1, queueTimeoutMs: 100 })
    const root = agent('root')
    const entered: string[] = []

    // dsh-tools turns a failed or cancelled body into an isError result.
    for (let i = 0; i < 3; i++) {
      const outcome = await tool(ctx, root, () => Promise.resolve(result(true)))
      assert.strictEqual((outcome as { isError?: boolean }).isError, true)
    }
    await delegate(ctx, root, 'next', 'child-next', entered)
    assert.deepStrictEqual(entered, ['next'])
    end(ctx, 'next', 'child-next')
  })

  for (const cwd of ['C:/work/alpha', 'C:/work/beta']) {
    it(`#3 does not lend at once to an older deeper agent with no parent edge (${cwd})`, async () => {
      const ctx = new Context()
      apply(ctx, { baton: true, lendAfterMs: 3_600_000 })
      const root = agent('root', 0, { cwd: 'C:/work/alpha' })
      const resumed = agent('resumed', 1, { cwd })
      const entered: string[] = []

      await step(ctx, resumed, entered)
      status(ctx, resumed, 'idle')
      await step(ctx, root, entered)
      const resumedStep = step(ctx, resumed, entered)
      let finish = () => {}
      const running = tool(
        ctx,
        root,
        async () => {
          await new Promise<void>((resolve) => (finish = resolve))
          return result()
        },
        { name: 'pwsh' },
      )
      await flush()
      await flush()
      assert.deepStrictEqual(entered, ['resumed', 'root'])
      finish()
      await running
      status(ctx, root, 'idle')
      await resumedStep
      assert.deepStrictEqual(entered, ['resumed', 'root', 'resumed'])
      status(ctx, resumed, 'idle')
    })
  }

  it('#3 still lends at once to a deeper agent that appears during the tool call', async () => {
    const ctx = new Context()
    apply(ctx, { baton: true, lendAfterMs: 3_600_000 })
    const root = agent('root', 0, { cwd: 'C:/work/alpha' })
    const worker = agent('worker', 1, { cwd: 'C:/work/alpha' })
    const entered: string[] = []

    await step(ctx, root, entered)
    let finish = () => {}
    const running = tool(
      ctx,
      root,
      async () => {
        await new Promise<void>((resolve) => (finish = resolve))
        return result()
      },
      { name: 'workflow' },
    )
    await step(ctx, worker, entered)
    assert.deepStrictEqual(entered, ['root', 'worker'])
    status(ctx, worker, 'idle')
    finish()
    await running
    status(ctx, root, 'idle')
  })

  it('#4 does not let nested children admitted over the limit starve a root delegation', async () => {
    const ctx = new Context()
    apply(ctx, { baton: true, maxConcurrentSubagents: 1, queueTimeoutMs: 100 })
    const root = agent('root')
    const c1 = agent('c1', 1)
    const entered: string[] = []

    await delegate(ctx, root, 'r1', c1.id, entered)
    await step(ctx, c1, entered)
    // c1 fans out a background grandchild: admitted over the full pool.
    await delegate(ctx, c1, 'nested', 'n', entered)
    status(ctx, c1, 'idle')
    await flush()
    await delegate(ctx, root, 'r2', 'c2', entered)
    assert.deepStrictEqual(entered, ['r1', 'c1', 'nested', 'r2'])
  })

  it('#5 queues a child of a root tool outside subagentToolNames instead of failing', async () => {
    const ctx = new Context()
    apply(ctx, { maxConcurrentSubagents: 1, queueTimeoutMs: 5_000 })
    const root = agent('root')
    const wf = agent('wf-child', 1)
    const entered: string[] = []

    await delegate(ctx, root, 'w1', 'child-w1', entered)
    await delegate(ctx, root, 'wf', wf.id, entered, 'workflow')
    const wfStep = step(ctx, wf, entered)
    await flush()
    assert.deepStrictEqual(entered, ['w1', 'wf'])
    end(ctx, 'w1', 'child-w1')
    await wfStep
    assert.deepStrictEqual(entered, ['w1', 'wf', 'wf-child'])
    status(ctx, wf, 'idle')
  })

  it("#6 gates a fresh child on its delegated provider, not its parent's seeded log", async () => {
    const ctx = new Context()
    apply(ctx, { baton: true, providers: { a: {}, b: {} } })
    const holder = agent('holder', 0, { provider: 'a' })
    const root = agent('root', 0, { provider: 'a' })
    // The child's session log is seeded from its parent, whose requests used provider a.
    const child = agent('child', 1, {
      session: {
        header: {},
        seq: 1,
        eventAt: () => ({ type: 'request/header', data: { header: { config: { provider: 'a' } } } }),
      },
    })
    const entered: string[] = []

    await step(ctx, holder, entered)
    await tool(
      ctx,
      root,
      () => {
        start(ctx, 'to-b', child.id)
        return Promise.resolve(result())
      },
      { args: { provider: 'b' } },
    )
    // Lane a is busy; the child runs on lane b and must not wait for it.
    await step(ctx, child, entered)
    assert.deepStrictEqual(entered, ['holder', 'child'])
    status(ctx, child, 'idle')
    status(ctx, holder, 'idle')
  })

  for (const providers of [
    { b: { lane: 'a' }, a: { maxConcurrentSubagents: 1 } },
    { a: { maxConcurrentSubagents: 1 }, b: { lane: 'a' } },
    { b: { lane: 'a', maxConcurrentSubagents: 1 } },
  ]) {
    it(`#7 #8 limits lane a by its own settings: ${JSON.stringify(providers)}`, async () => {
      const ctx = new Context()
      apply(ctx, { maxConcurrentSubagents: 4, queueTimeoutMs: 50, providers })
      const root = agent('root', 0, { provider: 'a' })
      const entered: string[] = []

      await delegate(ctx, root, 'first', 'child-first', entered)
      await assert.rejects(delegate(ctx, root, 'second', 'child-second', entered), /queue timeout after 50ms/)
      end(ctx, 'first', 'child-first')
    })
  }
})
