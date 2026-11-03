// Workspace pause: agents of a paused workspace stop before their next model request.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.ts'
import * as pauseRow from '../src/pause.ts'

const ALPHA = 'C:\\work\\alpha'
const BETA = 'C:\\work\\beta'
const GAMMA = 'C:\\work\\gamma'

function agent(id: string, depth = 0, extra: { cwd?: string; provider?: string } = {}): Agent {
  return {
    id,
    options: { subagentDepth: depth, ...(extra.provider === undefined ? {} : { provider: extra.provider }) },
    session: { header: extra.cwd === undefined ? {} : { cwd: extra.cwd } },
    status: 'running',
  } as unknown as Agent
}

function live<T>(value: T): { get(): T; set(next: T): void } {
  let current = value
  return {
    get: () => current,
    set: (next) => {
      current = next
    },
  }
}

function status(ctx: Context, a: Agent, value: 'idle' | 'running'): void {
  ctx.emit(ctx as never, 'agent/status', { agent: a, status: value })
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function step(
  ctx: Context,
  a: Agent,
  entered: string[],
  signal = new AbortController().signal,
): Promise<PreStepDecision> {
  status(ctx, a, 'running')
  return agentEvents(ctx, a).waterfall('agent/pre-step', { messages: [], turn: 1, step: 1, signal }, () => {
    entered.push(String(a.id))
    return Promise.resolve({ kind: 'enter', messages: [] })
  })
}

const result = () => ({ isError: false, value: {}, content: [] }) as unknown as ToolExecutionResult

function tool(
  ctx: Context,
  a: Agent,
  body: () => Promise<ToolExecutionResult>,
  name = 'pwsh',
): Promise<ToolExecutionResult> {
  const exec = {
    name,
    agent: a,
    arguments: {},
    signal: new AbortController().signal,
  } as unknown as ToolDispatchExecution
  return ctx.waterfall(ctx as never, 'tools/execute', exec, body)
}

/** A tool call that stays open until `finish` is called. */
function longTool(ctx: Context, a: Agent) {
  let finish = () => {}
  const done = tool(ctx, a, () => new Promise<ToolExecutionResult>((resolve) => (finish = () => resolve(result()))))
  return { done, finish: () => finish() }
}

function delegate(ctx: Context, a: Agent, runId: string, childId: string, entered: string[]) {
  return tool(
    ctx,
    a,
    () => {
      entered.push(runId)
      ctx.emit(ctx as never, 'subagent/start', { runId, provider: 'spawn', id: childId, local: true })
      return Promise.resolve(result())
    },
    'subagent',
  )
}

function endRun(ctx: Context, runId: string, childId: string): void {
  ctx.emit(ctx as never, 'subagent/end', {
    runId,
    provider: 'spawn',
    id: childId,
    local: true,
    stopReason: 'completed',
  })
}

describe('workspace pause', () => {
  it("hands the baton to another workspace at the holder's next step", async () => {
    const ctx = new Context()
    const paused = live<readonly string[]>([])
    apply(ctx, { baton: true, pausedWorkspaces: paused, pausePollMs: 5 })
    const a = agent('a', 0, { cwd: ALPHA })
    const b = agent('b', 0, { cwd: BETA })
    const entered: string[] = []

    await step(ctx, a, entered)
    const bStep = step(ctx, b, entered)
    await flush()
    assert.deepStrictEqual(entered, ['a'])

    paused.set([ALPHA])
    const aNext = step(ctx, a, entered)
    await bStep
    assert.deepStrictEqual(entered, ['a', 'b'])
    await sleep(30)
    assert.deepStrictEqual(entered, ['a', 'b'])

    // Unpaused, alpha queues again: b keeps the baton until it goes idle.
    paused.set([])
    await sleep(30)
    assert.deepStrictEqual(entered, ['a', 'b'])
    status(ctx, b, 'idle')
    await aNext
    assert.deepStrictEqual(entered, ['a', 'b', 'a'])
    status(ctx, a, 'idle')
  })

  it('keeps a paused child before its paused parent after unpause', async () => {
    const ctx = new Context()
    const paused = live<readonly string[]>([])
    apply(ctx, { baton: true, maxConcurrentSubagents: 4, pausedWorkspaces: paused, pausePollMs: 5 })
    const root = agent('root', 0, { cwd: ALPHA })
    const child = agent('child', 1, { cwd: ALPHA })
    const x = agent('x', 0, { cwd: BETA })
    const entered: string[] = []

    await step(ctx, root, entered)
    await delegate(ctx, root, 'child-run', child.id, entered)
    const rootNext = step(ctx, root, entered)
    await step(ctx, child, entered)
    const xStep = step(ctx, x, entered)
    await flush()
    assert.deepStrictEqual(entered, ['root', 'child-run', 'child'])

    // Written differently from the session folder on purpose.
    paused.set(['c:/WORK/Alpha/'])
    const childNext = step(ctx, child, entered)
    await xStep
    assert.deepStrictEqual(entered, ['root', 'child-run', 'child', 'x'])
    await sleep(30)
    assert.deepStrictEqual(entered, ['root', 'child-run', 'child', 'x'])

    // Unpause and free the baton in the same instant, before the child's own
    // re-check: the waiting parent must still not jump ahead of its child.
    paused.set([])
    status(ctx, x, 'idle')
    await childNext
    assert.deepStrictEqual(entered.slice(-1), ['child'])
    await sleep(20)
    assert.deepStrictEqual(entered.slice(-1), ['child'])

    status(ctx, child, 'idle')
    endRun(ctx, 'child-run', child.id)
    await rootNext
    assert.deepStrictEqual(entered.slice(-1), ['root'])
    status(ctx, root, 'idle')
  })

  it('costs nothing when a pause is lifted before it took effect', async () => {
    const ctx = new Context()
    const paused = live<readonly string[]>([])
    // Same-project priority off, so only the parent's place can put it first.
    apply(ctx, {
      baton: true,
      maxConcurrentSubagents: 4,
      projectPriorityMs: 0,
      pausedWorkspaces: paused,
      pausePollMs: 5,
    })
    const root = agent('root', 0, { cwd: ALPHA })
    const child = agent('child', 1, { cwd: ALPHA })
    const x = agent('x', 0, { cwd: BETA })
    const y = agent('y', 0, { cwd: GAMMA })
    const entered: string[] = []

    await step(ctx, root, entered)
    await delegate(ctx, root, 'child-run', child.id, entered)
    const rootNext = step(ctx, root, entered)
    // The child is generating while alpha is paused and unpaused again.
    await step(ctx, child, entered, new AbortController().signal)
    const xStep = step(ctx, x, entered)
    paused.set([ALPHA])
    const yStep = step(ctx, y, entered)
    await flush()
    paused.set([])
    await flush()

    // The child never stopped, so its parent keeps its place ahead of x and y.
    status(ctx, child, 'idle')
    endRun(ctx, 'child-run', child.id)
    await rootNext
    assert.deepStrictEqual(entered, ['root', 'child-run', 'child', 'root'])
    status(ctx, root, 'idle')
    await xStep
    status(ctx, x, 'idle')
    await yStep
    status(ctx, y, 'idle')
  })

  it('unpauses only the workspace taken off the list', async () => {
    const ctx = new Context()
    const paused = live<readonly string[]>([])
    apply(ctx, { baton: true, pausedWorkspaces: paused, pausePollMs: 5 })
    const a = agent('a', 0, { cwd: ALPHA })
    const b = agent('b', 0, { cwd: BETA })
    const c = agent('c', 0, { cwd: GAMMA })
    const entered: string[] = []

    await step(ctx, a, entered)
    const bStep = step(ctx, b, entered)
    const cStep = step(ctx, c, entered)
    await flush()
    paused.set([ALPHA, BETA])
    const aNext = step(ctx, a, entered)
    await cStep
    assert.deepStrictEqual(entered, ['a', 'c'])

    paused.set([ALPHA])
    status(ctx, c, 'idle')
    await bStep
    assert.deepStrictEqual(entered, ['a', 'c', 'b'])
    status(ctx, b, 'idle')
    await sleep(30)
    assert.deepStrictEqual(entered, ['a', 'c', 'b'])

    paused.set([])
    await aNext
    assert.deepStrictEqual(entered, ['a', 'c', 'b', 'a'])
    status(ctx, a, 'idle')
  })

  it('puts an unpaused workspace behind agents that were already waiting', async () => {
    const ctx = new Context()
    const paused = live<readonly string[]>([])
    apply(ctx, { baton: true, lendAfterMs: 20, pausedWorkspaces: paused, pausePollMs: 5 })
    const a = agent('a', 0, { cwd: ALPHA })
    const b = agent('b', 0, { cwd: BETA })
    const c = agent('c', 0, { cwd: GAMMA })
    const entered: string[] = []

    await step(ctx, a, entered)
    const bStep = step(ctx, b, entered)
    // a sits in a long tool: b borrows, and a waits on the stack to take it back.
    const aTool = longTool(ctx, a)
    await bStep
    assert.deepStrictEqual(entered, ['a', 'b'])

    paused.set([ALPHA])
    const cStep = step(ctx, c, entered)
    await flush()
    paused.set([])
    aTool.finish()
    await aTool.done
    const aNext = step(ctx, a, entered)
    await flush()

    // Without the pause, a would take the baton back first. Now c was queued earlier.
    status(ctx, b, 'idle')
    await cStep
    assert.deepStrictEqual(entered, ['a', 'b', 'c'])
    await flush()
    assert.deepStrictEqual(entered, ['a', 'b', 'c'])
    status(ctx, c, 'idle')
    await aNext
    assert.deepStrictEqual(entered, ['a', 'b', 'c', 'a'])
    status(ctx, a, 'idle')
  })

  it('does not give the baton to a waiter whose workspace was paused while it waited', async () => {
    const ctx = new Context()
    const paused = live<readonly string[]>([])
    apply(ctx, { baton: true, pausedWorkspaces: paused, pausePollMs: 5 })
    const a = agent('a', 0, { cwd: ALPHA })
    const b = agent('b', 0, { cwd: BETA })
    const c = agent('c', 0, { cwd: GAMMA })
    const entered: string[] = []

    await step(ctx, b, entered)
    const aStep = step(ctx, a, entered)
    await flush()
    paused.set([ALPHA])
    const cStep = step(ctx, c, entered)
    await flush()
    status(ctx, b, 'idle')
    await cStep
    assert.deepStrictEqual(entered, ['b', 'c'])
    status(ctx, c, 'idle')
    await sleep(30)
    assert.deepStrictEqual(entered, ['b', 'c'])

    paused.set([])
    await aStep
    assert.deepStrictEqual(entered, ['b', 'c', 'a'])
    status(ctx, a, 'idle')
  })

  it('puts an unpaused waiter behind agents that queued while it was paused', async () => {
    const ctx = new Context()
    const paused = live<readonly string[]>([])
    apply(ctx, { baton: true, pausedWorkspaces: paused, pausePollMs: 5 })
    const a = agent('a', 0, { cwd: ALPHA })
    const b = agent('b', 0, { cwd: BETA })
    const c = agent('c', 0, { cwd: GAMMA })
    const entered: string[] = []

    await step(ctx, b, entered)
    const aStep = step(ctx, a, entered)
    await flush()
    paused.set([ALPHA])
    await sleep(20)
    const cStep = step(ctx, c, entered)
    await flush()
    // Unpaused while b still holds the baton: a rejoins now, behind c.
    paused.set([])
    await sleep(20)
    status(ctx, b, 'idle')
    await cStep
    assert.deepStrictEqual(entered, ['b', 'c'])
    status(ctx, c, 'idle')
    await aStep
    assert.deepStrictEqual(entered, ['b', 'c', 'a'])
    status(ctx, a, 'idle')
  })

  it('lets an unpaused workspace borrow from a holder that sits in a long tool', async () => {
    const ctx = new Context()
    const paused = live<readonly string[]>([])
    apply(ctx, { baton: true, lendAfterMs: 20, pausedWorkspaces: paused, pausePollMs: 5 })
    const a = agent('a', 0, { cwd: ALPHA })
    const b = agent('b', 0, { cwd: BETA })
    const entered: string[] = []

    await step(ctx, a, entered)
    const bStep = step(ctx, b, entered)
    await flush()
    paused.set([ALPHA])
    const aNext = step(ctx, a, entered)
    await bStep
    // b now sits in a tool for a long time; alpha is unpaused meanwhile.
    const bTool = longTool(ctx, b)
    paused.set([])
    await aNext
    assert.deepStrictEqual(entered, ['a', 'b', 'a'])
    status(ctx, a, 'idle')
    bTool.finish()
    await bTool.done
    await step(ctx, b, entered)
    assert.deepStrictEqual(entered, ['a', 'b', 'a', 'b'])
    status(ctx, b, 'idle')
  })

  it('lends at once when a paused holder sits in a long tool', async () => {
    const ctx = new Context()
    const paused = live<readonly string[]>([])
    apply(ctx, { baton: true, lendAfterMs: 3_600_000, pausedWorkspaces: paused, pausePollMs: 5 })
    const a = agent('a', 0, { cwd: ALPHA })
    const b = agent('b', 0, { cwd: BETA })
    const entered: string[] = []

    await step(ctx, a, entered)
    const bStep = step(ctx, b, entered)
    const aTool = longTool(ctx, a)
    await sleep(30)
    assert.deepStrictEqual(entered, ['a'])

    paused.set([ALPHA])
    await bStep
    assert.deepStrictEqual(entered, ['a', 'b'])

    aTool.finish()
    await aTool.done
    const aNext = step(ctx, a, entered)
    await sleep(30)
    assert.deepStrictEqual(entered, ['a', 'b'])
    paused.set([])
    status(ctx, b, 'idle')
    await aNext
    assert.deepStrictEqual(entered, ['a', 'b', 'a'])
    status(ctx, a, 'idle')
  })

  it('ends a paused wait when the turn is aborted, and leaves nothing behind', async () => {
    const ctx = new Context()
    const paused = live<readonly string[]>([ALPHA])
    apply(ctx, { baton: true, pausedWorkspaces: paused, pausePollMs: 5 })
    const a = agent('a', 0, { cwd: ALPHA })
    const b = agent('b', 0, { cwd: BETA })
    const entered: string[] = []
    const abort = new AbortController()

    const aStep = step(ctx, a, entered, abort.signal)
    await sleep(20)
    abort.abort(new Error('stopped by the user'))
    await assert.rejects(aStep, /stopped by the user/)
    status(ctx, a, 'idle')

    await step(ctx, b, entered)
    status(ctx, b, 'idle')
    paused.set([])
    await step(ctx, a, entered)
    assert.deepStrictEqual(entered, ['b', 'a'])
    status(ctx, a, 'idle')
  })

  it('ends a paused wait when the agent is disposed', async () => {
    const ctx = new Context()
    apply(ctx, { baton: true, pausedWorkspaces: [ALPHA], pausePollMs: 5 })
    const a = agent('a', 0, { cwd: ALPHA })
    const b = agent('b', 0, { cwd: BETA })
    const entered: string[] = []

    const aStep = step(ctx, a, entered)
    await sleep(20)
    ctx.emit(ctx as never, 'agent/disposed', { agent: a })
    await assert.rejects(aStep, /disposed while its workspace was paused/)
    await step(ctx, b, entered)
    assert.deepStrictEqual(entered, ['b'])
    status(ctx, b, 'idle')
  })

  it('keeps agents held when the baton is switched off, and runs them after unpause', async () => {
    const ctx = new Context()
    const paused = live<readonly string[]>([ALPHA])
    const baton = live(true)
    apply(ctx, { baton, pausedWorkspaces: paused, pausePollMs: 5 })
    const a = agent('a', 0, { cwd: ALPHA })
    const b = agent('b', 0, { cwd: BETA })
    const entered: string[] = []

    const aStep = step(ctx, a, entered)
    await step(ctx, b, entered)
    baton.set(false)
    await step(ctx, b, entered)
    await sleep(30)
    assert.deepStrictEqual(entered, ['b', 'b'])

    // With the baton off, a no longer waits for b once unpaused.
    paused.set([])
    await aStep
    assert.deepStrictEqual(entered, ['b', 'b', 'a'])
    status(ctx, a, 'idle')
    status(ctx, b, 'idle')
  })

  it('pauses with the baton off', async () => {
    const ctx = new Context()
    const paused = live<readonly string[]>([ALPHA])
    apply(ctx, { pausedWorkspaces: paused, pausePollMs: 5 })
    const a = agent('a', 0, { cwd: ALPHA })
    const b = agent('b', 0, { cwd: BETA })
    const entered: string[] = []

    const aStep = step(ctx, a, entered)
    await step(ctx, b, entered)
    await sleep(30)
    assert.deepStrictEqual(entered, ['b'])
    paused.set([])
    await aStep
    assert.deepStrictEqual(entered, ['b', 'a'])
  })

  it('pauses agents on providers that have no lane', async () => {
    const ctx = new Context()
    const paused = live<readonly string[]>([ALPHA])
    apply(ctx, { baton: true, providers: { 'local-a': {} }, pausedWorkspaces: paused, pausePollMs: 5 })
    const cloud = agent('cloud', 0, { cwd: ALPHA, provider: 'deepseek-official' })
    const entered: string[] = []

    const cloudStep = step(ctx, cloud, entered)
    await sleep(30)
    assert.deepStrictEqual(entered, [])
    paused.set([])
    await cloudStep
    assert.deepStrictEqual(entered, ['cloud'])
  })

  it('matches workspace paths regardless of case, slashes and a trailing separator', async () => {
    const ctx = new Context()
    const paused = live<readonly string[]>(['c:/WORK/Alpha/'])
    apply(ctx, { pausedWorkspaces: paused, pausePollMs: 5 })
    const a = agent('a', 0, { cwd: ALPHA })
    const sibling = agent('sibling', 0, { cwd: 'C:\\work\\alpha2' })
    const entered: string[] = []

    const aStep = step(ctx, a, entered)
    await step(ctx, sibling, entered)
    await sleep(30)
    assert.deepStrictEqual(entered, ['sibling'])
    paused.set([])
    await aStep
    assert.deepStrictEqual(entered, ['sibling', 'a'])
  })

  it("pauses a subagent that inherits its parent's workspace", async () => {
    const ctx = new Context()
    const paused = live<readonly string[]>([])
    apply(ctx, { baton: true, pausedWorkspaces: paused, pausePollMs: 5 })
    const root = agent('root', 0, { cwd: ALPHA })
    // A subagent session with no folder of its own.
    const child = agent('child', 1)
    const entered: string[] = []

    await step(ctx, root, entered)
    await delegate(ctx, root, 'run', child.id, entered)
    paused.set([ALPHA])
    const childStep = step(ctx, child, entered)
    await sleep(30)
    assert.deepStrictEqual(entered, ['root', 'run'])
    paused.set([])
    await childStep
    assert.deepStrictEqual(entered, ['root', 'run', 'child'])
    status(ctx, child, 'idle')
    endRun(ctx, 'run', child.id)
    status(ctx, root, 'idle')
  })

  it('rejects a malformed pausedWorkspaces list', () => {
    assert.throws(() => {
      apply(new Context(), { pausedWorkspaces: [''] })
    }, /pausedWorkspaces must be a list of non-empty folder paths/)
  })
})

describe('pause row', () => {
  it('follows the pause row instead of its own option while the row is mounted', async () => {
    const ctx = new Context()
    const rowList = live<readonly string[]>([ALPHA])
    pauseRow.apply(ctx, { pausedWorkspaces: rowList })
    // The main plugin's own option says nothing is paused; the row wins.
    apply(ctx, { baton: true, pausedWorkspaces: [], pausePollMs: 5 })
    await flush()
    const a = agent('a', 0, { cwd: ALPHA })
    const b = agent('b', 0, { cwd: BETA })
    const entered: string[] = []

    const aStep = step(ctx, a, entered)
    await step(ctx, b, entered)
    await sleep(30)
    assert.deepStrictEqual(entered, ['b'])
    status(ctx, b, 'idle')
    rowList.set([])
    await aStep
    assert.deepStrictEqual(entered, ['b', 'a'])
    status(ctx, a, 'idle')
  })

  it('exports a volatile pausedWorkspaces schema on the row, not on the main entry', async () => {
    const resolved = pauseRow.Config({}) as unknown as { pausedWorkspaces: { get(): unknown } }
    assert.deepStrictEqual(resolved.pausedWorkspaces.get(), [])
    assert.throws(() => pauseRow.Config({ pausedWorkspaces: [''] }))
    const { Config } = await import('../src/index.ts')
    const main = Config({}) as unknown as Record<string, unknown>
    assert.strictEqual('pausedWorkspaces' in main, false)
  })
})
