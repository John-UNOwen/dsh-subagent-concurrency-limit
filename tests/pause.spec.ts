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

  it('does not park an owner that took a free baton while it still generates', async () => {
    const ctx = new Context()
    const paused = live<readonly string[]>([])
    apply(ctx, { baton: true, pausedWorkspaces: paused, pausePollMs: 5 })
    const a = agent('a', 0, { cwd: ALPHA })
    const c = agent('c', 0, { cwd: BETA })
    const d = agent('d', 0, { cwd: GAMMA })
    const entered: string[] = []

    // a takes the free baton and is mid-request; c queues behind it.
    await step(ctx, a, entered)
    const cStep = step(ctx, c, entered)
    await flush()
    paused.set([ALPHA])
    // Another agent queuing re-checks the baton while a still generates.
    const dStep = step(ctx, d, entered)
    await sleep(30)
    // a is still generating: nobody else may run on the same slot.
    assert.deepStrictEqual(entered, ['a'])

    // At a's next rest the pause takes effect and c runs, then d.
    const aNext = step(ctx, a, entered)
    await cStep
    assert.deepStrictEqual(entered, ['a', 'c'])
    status(ctx, c, 'idle')
    await dStep
    assert.deepStrictEqual(entered, ['a', 'c', 'd'])
    paused.set([])
    status(ctx, d, 'idle')
    await aNext
    assert.deepStrictEqual(entered, ['a', 'c', 'd', 'a'])
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

describe('bundle patch', () => {
  it('names every row by the package or an exported subpath, never a file path', async () => {
    const { readFileSync, existsSync } = await import('node:fs')
    const root = new URL('../', import.meta.url)
    const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
    const names = [...readFileSync(new URL('cordis.patch.yml', root), 'utf8').matchAll(/^\s+name:\s*(\S+)\s*$/gm)].map(
      (match) => match[1]?.replace(/^['"]|['"]$/g, '') ?? '',
    )
    assert.deepStrictEqual(names, [pkg.name, `${pkg.name}/pause`])
    // dsh's client loader keys a package's sources by row name; a second
    // file-resolved name for this package stops dsh from starting.
    for (const name of names) {
      const subpath = name === pkg.name ? '.' : `./${name.slice(pkg.name.length + 1)}`
      const target = pkg.exports[subpath]
      assert.ok(target, `${subpath} is exported`)
      assert.ok(existsSync(new URL(target.default, root)), `${target.default} exists`)
    }
  })
})

/** A tool call that stays open; `onStart` runs inside it, in its async context. */
function openTool(ctx: Context, a: Agent, name: string, onStart: () => void | Promise<void>) {
  let finish = () => {}
  const done = tool(
    ctx,
    a,
    async () => {
      await onStart()
      return new Promise<ToolExecutionResult>((resolve) => (finish = () => resolve(result())))
    },
    name,
  )
  return { done, finish: () => finish() }
}

const publish = (ctx: Context, runId: string, id: string) =>
  ctx.emit(ctx as never, 'subagent/start', { runId, provider: 'spawn', id, local: true })

describe('checkup fixes', () => {
  it('queues a child published while its parent is parked ahead of the parent (#1)', async () => {
    const ctx = new Context()
    const paused = live<readonly string[]>([])
    apply(ctx, {
      baton: true,
      maxConcurrentSubagents: 8,
      pausedWorkspaces: paused,
      pausePollMs: 5,
      projectPriorityMs: 0,
    })
    const root = agent('root', 0, { cwd: ALPHA })
    const c1 = agent('c1', 1, { cwd: ALPHA })
    const c2 = agent('c2', 1, { cwd: ALPHA })
    const other = agent('other', 0, { cwd: BETA })
    const entered: string[] = []
    await step(ctx, root, entered)
    const t1 = openTool(ctx, root, 'subagent', () => publish(ctx, 'r1', 'c1'))
    await flush()
    await step(ctx, c1, entered)
    let release2 = () => {}
    const gate2 = new Promise<void>((resolve) => (release2 = resolve))
    const t2 = tool(
      ctx,
      root,
      async () => {
        await gate2
        publish(ctx, 'r2', 'c2')
        return result()
      },
      'subagent',
    )
    await flush()
    const otherStep = step(ctx, other, entered)
    paused.set([ALPHA])
    const c1Tool = longTool(ctx, c1)
    await otherStep
    // The second child is published while the tree is parked.
    release2()
    await t2
    t1.finish()
    await t1.done
    const rootNext = step(ctx, root, entered)
    c1Tool.finish()
    await c1Tool.done
    const c1Next = step(ctx, c1, entered)
    const c2Step = step(ctx, c2, entered)
    await sleep(20)
    paused.set([])
    status(ctx, other, 'idle')
    await c1Next
    status(ctx, c1, 'idle')
    endRun(ctx, 'r1', 'c1')
    await c2Step
    assert.deepStrictEqual(entered.slice(-2), ['c1', 'c2'])
    status(ctx, c2, 'idle')
    endRun(ctx, 'r2', 'c2')
    await rootNext
    assert.deepStrictEqual(entered.slice(-1), ['root'])
    status(ctx, root, 'idle')
  })

  it('frees the permit of a delegation that publishes no run (#4)', async () => {
    const ctx = new Context()
    apply(ctx, {
      maxConcurrentSubagents: 1,
      queueTimeoutMs: 2_000,
      subagentToolNames: ['subagent', 'workflow'],
      pendingReservationMs: 30,
    })
    const a = agent('a', 0, { cwd: ALPHA })
    await tool(ctx, a, () => Promise.resolve(result()), 'workflow')
    status(ctx, a, 'idle')
    const started = Date.now()
    await tool(ctx, a, () => Promise.resolve(result()), 'subagent')
    assert.ok(Date.now() - started < 1_000)
  })

  it('re-checks at the poll interval once the owner is past lendAfterMs (#5)', async () => {
    const ctx = new Context()
    apply(ctx, { baton: true, lendAfterMs: 20, pausePollMs: 1_000 })
    const root = agent('root', 0, { cwd: ALPHA })
    const child = agent('child', 1, { cwd: ALPHA })
    const entered: string[] = []
    await step(ctx, root, entered)
    const t = openTool(ctx, root, 'subagent', () => publish(ctx, 'r', 'child'))
    await flush()
    await step(ctx, child, entered)
    const childTool = longTool(ctx, child)
    t.finish()
    await t.done
    // The parent queues and may not borrow from its own child.
    const rootNext = step(ctx, root, entered)
    const real = globalThis.setTimeout
    let short = 0
    globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if ((ms ?? 0) < 5) short++
      return real(fn, ms, ...rest)
    }) as typeof setTimeout
    try {
      await sleep(200)
    } finally {
      globalThis.setTimeout = real
    }
    assert.ok(short <= 2, `${short} near-zero re-checks`)
    childTool.finish()
    await childTool.done
    status(ctx, child, 'idle')
    endRun(ctx, 'r', 'child')
    await rootNext
    status(ctx, root, 'idle')
  })
})

/** One model step whose request reports `provider`. */
function modelStep(ctx: Context, a: Agent, entered: string[], provider: string): Promise<PreStepDecision> {
  status(ctx, a, 'running')
  return agentEvents(ctx, a).waterfall(
    'agent/pre-step',
    { messages: [], turn: 1, step: 1, signal: new AbortController().signal },
    async () => {
      await agentEvents(ctx, a).waterfall(
        'agent/request',
        { turn: 1, step: 1, signal: new AbortController().signal },
        () => Promise.resolve({ provider, model: 'm' } as never),
      )
      entered.push(String(a.id))
      return { kind: 'enter', messages: [] }
    },
  )
}

describe('live settings edits', () => {
  it('applies a providers edit once no lane holds work, never splitting a lane (#2)', async () => {
    const ctx = new Context()
    const providers = live<Record<string, unknown>>({})
    apply(ctx, {
      maxConcurrentSubagents: 1,
      queueTimeoutMs: 5_000,
      pendingReservationMs: 1,
      providers: providers as never,
    })
    const a = agent('a', 0, { cwd: ALPHA, provider: 'pa' })
    const entered: string[] = []
    const first = openTool(ctx, a, 'subagent', () => {
      entered.push('first')
    })
    await flush()
    providers.set({ pa: { maxConcurrentSubagents: 1 } })
    const second = openTool(ctx, a, 'subagent', () => {
      entered.push('second')
    })
    await sleep(20)
    assert.deepStrictEqual(entered, ['first'])
    first.finish()
    await first.done
    await sleep(5)
    assert.deepStrictEqual(entered, ['first', 'second'])
    second.finish()
    await second.done
    status(ctx, a, 'idle')
    // Quiet now: the edit applies, and provider pa gets its own lane with limit 1.
    const third = openTool(ctx, a, 'subagent', () => {
      entered.push('third')
    })
    await flush()
    const fourth = openTool(ctx, a, 'subagent', () => {
      entered.push('fourth')
    })
    await sleep(20)
    assert.deepStrictEqual(entered.slice(2), ['third'])
    third.finish()
    await third.done
    await sleep(5)
    fourth.finish()
    await fourth.done
  })

  it('does not flip a busy lane when a providers edit re-derives its baton (#3)', async () => {
    const ctx = new Context()
    const providers = live<Record<string, unknown>>({ a: { baton: true }, b: { lane: 'a', baton: false } })
    apply(ctx, { baton: true, lendAfterMs: 3_600_000, providers: providers as never })
    const x = agent('x', 0, { cwd: ALPHA, provider: 'a' })
    const y = agent('y', 0, { cwd: BETA, provider: 'b' })
    const z = agent('z', 0, { cwd: GAMMA, provider: 'b' })
    const entered: string[] = []
    await step(ctx, x, entered)
    const xTool = longTool(ctx, x)
    const yStep = step(ctx, y, entered)
    const zStep = step(ctx, z, entered)
    await flush()
    providers.set({ b: { lane: 'a', baton: false } })
    xTool.finish()
    await xTool.done
    const xNext = step(ctx, x, entered)
    await xNext
    await sleep(10)
    assert.deepStrictEqual(entered, ['x', 'x'])
    status(ctx, x, 'idle')
    await yStep
    await sleep(10)
    assert.deepStrictEqual(entered, ['x', 'x', 'y'])
    status(ctx, y, 'idle')
    await zStep
    status(ctx, z, 'idle')
  })

  it('admits a queued delegation when the limit is raised, with no other activity (#6)', async () => {
    const ctx = new Context()
    const limit = live(1)
    apply(ctx, { maxConcurrentSubagents: limit as never, queueTimeoutMs: 5_000 })
    const a = agent('a', 0, { cwd: ALPHA })
    const b = agent('b', 0, { cwd: BETA })
    const entered: string[] = []
    const first = openTool(ctx, a, 'subagent', () => {
      entered.push('first')
    })
    await flush()
    const second = openTool(ctx, b, 'subagent', () => {
      entered.push('second')
    })
    await flush()
    limit.set(4)
    await sleep(1_300)
    assert.deepStrictEqual(entered, ['first', 'second'])
    first.finish()
    second.finish()
    await Promise.all([first.done, second.done])
  })

  it('moves a child turn permit to the lane of the provider it switched to (#7)', async () => {
    const ctx = new Context()
    const providers = { pa: { maxConcurrentSubagents: 1 }, pb: { maxConcurrentSubagents: 1 } }
    apply(ctx, { maxConcurrentSubagents: 4, queueTimeoutMs: 5_000, providers })
    const root = agent('root', 0, { cwd: ALPHA, provider: 'pa' })
    const child = agent('child', 1, { cwd: ALPHA, provider: 'pa' })
    const entered: string[] = []
    await delegate(ctx, root, 'r', 'child', entered)
    await modelStep(ctx, child, entered, 'pb')
    // The next step of the same turn moves the permit from pa to pb.
    await modelStep(ctx, child, entered, 'pb')
    const onA = openTool(ctx, agent('pa-user', 0, { cwd: BETA, provider: 'pa' }), 'subagent', () => {
      entered.push('a-probe')
    })
    const onB = openTool(ctx, agent('pb-user', 0, { cwd: GAMMA, provider: 'pb' }), 'subagent', () => {
      entered.push('b-probe')
    })
    await sleep(20)
    assert.deepStrictEqual(entered.slice(-1), ['a-probe'])
    status(ctx, child, 'idle')
    endRun(ctx, 'r', 'child')
    await sleep(5)
    assert.deepStrictEqual(entered.slice(-2), ['a-probe', 'b-probe'])
    onA.finish()
    onB.finish()
    await Promise.all([onA.done, onB.done])
  })

  it("gives a lane with no entry of its own the strictest of its providers' settings (#16)", async () => {
    const ctx = new Context()
    const providers = {
      // The first by name states the looser limit: the stricter one must win.
      'gpu-alt': { lane: 'shared', maxConcurrentSubagents: 4 },
      'gpu-alt2': { lane: 'shared', maxConcurrentSubagents: 1 },
      // A chain: gpu-chain follows gpu-alt, which follows shared.
      'gpu-chain': { lane: 'gpu-alt' },
    }
    apply(ctx, { maxConcurrentSubagents: 8, queueTimeoutMs: 5_000, pendingReservationMs: 1, providers })
    const entered: string[] = []
    const one = openTool(ctx, agent('u1', 0, { cwd: ALPHA, provider: 'gpu-alt2' }), 'subagent', () => {
      entered.push('one')
    })
    await flush()
    const two = openTool(ctx, agent('u2', 0, { cwd: BETA, provider: 'gpu-chain' }), 'subagent', () => {
      entered.push('two')
    })
    await sleep(20)
    assert.deepStrictEqual(entered, ['one'])
    one.finish()
    await one.done
    await sleep(5)
    assert.deepStrictEqual(entered, ['one', 'two'])
    two.finish()
    await two.done
  })
})

describe('housekeeping fixes', () => {
  it('parks a paused child that was handed the baton before its first step (#13)', async () => {
    const ctx = new Context()
    const paused = live<readonly string[]>([])
    apply(ctx, { baton: true, lendAfterMs: 3_600_000, pausedWorkspaces: paused, pausePollMs: 5 })
    const root = agent('root', 0, { cwd: ALPHA })
    const other = agent('other', 0, { cwd: BETA })
    const entered: string[] = []
    await step(ctx, root, entered)
    const t = openTool(ctx, root, 'subagent', () => publish(ctx, 'r', 'c1'))
    await flush()
    // The baton now sits with c1, which has not stepped yet.
    paused.set([ALPHA])
    const otherStep = step(ctx, other, entered)
    await sleep(20)
    assert.deepStrictEqual(entered, ['root', 'other'])
    await otherStep
    status(ctx, other, 'idle')
    paused.set([])
    t.finish()
    await t.done
    endRun(ctx, 'r', 'c1')
    status(ctx, root, 'idle')
  })

  it('cancels the queued pool wait of a disposed child (#15)', async () => {
    const ctx = new Context()
    apply(ctx, { maxConcurrentSubagents: 1, queueTimeoutMs: 5_000 })
    const root = agent('root', 0, { cwd: ALPHA })
    const child = agent('child', 1, { cwd: ALPHA })
    const entered: string[] = []
    const holder = openTool(ctx, root, 'subagent', () => {
      entered.push('holder')
    })
    await flush()
    // A child published outside any delegation queues for its first turn.
    publish(ctx, 'loose', 'child')
    const childStep = step(ctx, child, entered).then(
      () => 'ran',
      (error: Error) => error.message,
    )
    await flush()
    ctx.emit(ctx as never, 'agent/disposed', { agent: child })
    assert.match(await childStep, /disposed/)
    holder.finish()
    await holder.done
    await sleep(5)
    assert.deepStrictEqual(entered, ['holder'])
  })

  it('opts both entries out of a generated settings page (#18)', async () => {
    const { Service } = await import('@deepseek-ai/cordis')
    const policies: unknown[] = []
    class FakeSettings extends Service {
      constructor(ctx: Context) {
        super(ctx, 'settings')
      }
      configure(policy: unknown, owner?: unknown) {
        policies.push({ policy, owned: owner !== undefined })
        return () => {}
      }
    }
    const ctx = new Context()
    await ctx.plugin(FakeSettings)
    await ctx.plugin({ name: 'main', apply: (scope: Context) => apply(scope, {}) })
    await ctx.plugin({ name: 'pause', apply: (scope: Context) => pauseRow.apply(scope, {}) })
    await flush()
    assert.deepStrictEqual(policies, [
      { policy: { auto: false }, owned: true },
      { policy: { auto: false }, owned: true },
    ])
  })

  it('reads no session log while no provider is listed (#27)', async () => {
    const ctx = new Context()
    apply(ctx, { baton: true })
    let reads = 0
    const a = {
      ...agent('a', 0, { cwd: ALPHA }),
      session: {
        header: { cwd: ALPHA },
        seq: 20_000,
        eventAt: () => {
          reads++
          return undefined
        },
      },
    } as unknown as Agent
    const entered: string[] = []
    await step(ctx, a, entered)
    assert.strictEqual(reads, 0)
    status(ctx, a, 'idle')
  })

  it('keeps internal options out of the published types (#17)', async () => {
    const { readFileSync } = await import('node:fs')
    const types = readFileSync(new URL('../lib/index.d.ts', import.meta.url), 'utf8')
    for (const name of ['pausedWorkspaces', 'pausePollMs', 'pendingReservationMs'])
      assert.ok(!types.includes(name), name)
  })
})

describe('pause on an unanswered question', () => {
  /** An ask_user_question call that waits until `answer` is called. */
  function question(ctx: Context, a: Agent) {
    let answer = () => {}
    const done = tool(
      ctx,
      a,
      () => new Promise<ToolExecutionResult>((resolve) => (answer = () => resolve(result()))),
      'ask_user_question',
    )
    return { done, answer: () => answer() }
  }

  function approval(ctx: Context, a: Agent) {
    let answer = () => {}
    const done = ctx.waterfall(
      ctx as never,
      'approval/request' as never,
      { agent: a, signal: new AbortController().signal } as never,
      () => new Promise((resolve) => (answer = () => resolve({ decision: 'approve' }))),
    )
    return { done, answer: () => answer() }
  }

  it('pauses the workspace once the question waits too long, and the answer requeues it', async () => {
    const ctx = new Context()
    apply(ctx, {
      baton: true,
      lendAfterMs: 3_600_000,
      pauseUnansweredAfterMs: 30,
      pausePollMs: 5,
      projectPriorityMs: 0,
    })
    const a = agent('a', 0, { cwd: ALPHA })
    const b = agent('b', 0, { cwd: BETA })
    const c = agent('c', 0, { cwd: GAMMA })
    const entered: string[] = []
    await step(ctx, a, entered)
    const asked = question(ctx, a)
    const bStep = step(ctx, b, entered)
    await sleep(10)
    // Still inside the limit: the asker keeps the baton.
    assert.deepStrictEqual(entered, ['a'])
    await bStep
    assert.deepStrictEqual(entered, ['a', 'b'])
    const cStep = step(ctx, c, entered)
    // The answer lifts the pause; a queues behind c, who was waiting already.
    asked.answer()
    await asked.done
    const aNext = step(ctx, a, entered)
    status(ctx, b, 'idle')
    await cStep
    await sleep(10)
    assert.deepStrictEqual(entered, ['a', 'b', 'c'])
    status(ctx, c, 'idle')
    await aNext
    assert.deepStrictEqual(entered, ['a', 'b', 'c', 'a'])
    status(ctx, a, 'idle')
  })

  it('does nothing for a question answered in time, or with the limit at 0', async () => {
    for (const limit of [200, 0]) {
      const ctx = new Context()
      apply(ctx, { baton: true, lendAfterMs: 3_600_000, pauseUnansweredAfterMs: limit, pausePollMs: 5 })
      const a = agent('a', 0, { cwd: ALPHA })
      const b = agent('b', 0, { cwd: BETA })
      const entered: string[] = []
      await step(ctx, a, entered)
      const asked = question(ctx, a)
      const bStep = step(ctx, b, entered)
      await sleep(60)
      assert.deepStrictEqual(entered, ['a'], `limit ${limit}`)
      asked.answer()
      await asked.done
      status(ctx, a, 'idle')
      await bStep
      status(ctx, b, 'idle')
    }
  })

  it('counts approval prompts only when asked to', async () => {
    for (const on of ['questions', 'questions-and-approvals'] as const) {
      const ctx = new Context()
      apply(ctx, {
        baton: true,
        lendAfterMs: 3_600_000,
        pauseUnansweredAfterMs: 20,
        pauseUnansweredOn: on,
        pausePollMs: 5,
      })
      const a = agent('a', 0, { cwd: ALPHA })
      const b = agent('b', 0, { cwd: BETA })
      const entered: string[] = []
      await step(ctx, a, entered)
      const prompt = approval(ctx, a)
      const bStep = step(ctx, b, entered)
      await sleep(60)
      assert.deepStrictEqual(entered, on === 'questions' ? ['a'] : ['a', 'b'], on)
      prompt.answer()
      await prompt.done
      status(ctx, a, 'idle')
      await bStep
      status(ctx, b, 'idle')
    }
  })

  it('rejects an unknown pauseUnansweredOn', () => {
    assert.throws(() => apply(new Context(), { pauseUnansweredOn: 'always' as never }), /pauseUnansweredOn/)
  })
})
