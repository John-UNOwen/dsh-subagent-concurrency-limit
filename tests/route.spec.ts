// The read-only workspaces route: authentication, envelope and the status it reports.
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { describe, it } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import * as connection from '@deepseek-ai/dsh-client-connection'
import { agentEvents, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import { apply, CHANNEL } from '../src/index.ts'

interface Route {
  kind: 'prefix'
  path: string
  handler: (req: unknown, res: unknown) => void | Promise<void>
}

class FakeWebServer extends Service {
  readonly routes: Route[] = []
  constructor(ctx: Context) {
    super(ctx, 'webServer')
  }
  register(route: Route): () => void {
    this.routes.push(route)
    return () => {
      this.routes.splice(this.routes.indexOf(route), 1)
    }
  }
}

/** A connection that admits every request, so the endpoints themselves can be tested. */
class OpenConnection extends Service {
  constructor(ctx: Context) {
    super(ctx, 'connection')
  }
  requestRejection(): undefined {
    return undefined
  }
}

class FakeCredentials extends Service {
  constructor(ctx: Context) {
    super(ctx, 'credentials')
  }
  async modifyRecord(_key: string, update: (current: unknown) => Promise<unknown>): Promise<unknown> {
    return update(undefined)
  }
}

const SESSION_FOLDERS: Record<string, string> = { 'session-cold': 'D:\\Projects\\Cold' }
class FakeSessions extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sessions')
  }
  get(id: string) {
    const cwd = SESSION_FOLDERS[id]
    return cwd === undefined ? undefined : { header: { cwd } }
  }
  list() {
    return Object.values(SESSION_FOLDERS).map((cwd) => ({ header: { cwd } }))
  }
}

const wait = (ms = 30) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function routeOf(ctx: Context): Route {
  const route = (ctx as unknown as { webServer: FakeWebServer }).webServer.routes.find((r) => r.path === CHANNEL)
  assert.ok(route, 'route mounted')
  return route
}

interface Reply {
  status: number
  body: string
}

/** Drive the route like node:http would. */
async function request(
  route: Route,
  path: string,
  body: unknown,
  options: { method?: string; contentType?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  const req = Readable.from([Buffer.from(raw)]) as Readable & Record<string, unknown>
  req.method = options.method ?? 'POST'
  req.url = path
  req.headers = {
    host: 'localhost:3080',
    'content-type': options.contentType ?? 'application/json',
    ...options.headers,
  }
  let status = 0
  let text = ''
  const res = {
    writeHead(code: number) {
      status = code
      return res
    },
    end(chunk?: string) {
      text = chunk ?? ''
    },
    on() {},
    off() {},
  }
  await route.handler(req, res)
  return { status, body: text }
}

function call(route: Route, endpoint: string, payload: unknown) {
  return request(route, `${CHANNEL}/${endpoint}`, { type: 'client-request', rpcId: 'r1', method: endpoint, payload })
}

function agent(id: string, cwd: string, depth = 0): Agent {
  return { id, options: { subagentDepth: depth }, session: { header: { cwd } }, status: 'running' } as unknown as Agent
}

function step(ctx: Context, a: Agent): Promise<PreStepDecision> {
  ctx.emit(ctx as never, 'agent/status', { agent: a, status: 'running' })
  return agentEvents(ctx, a).waterfall(
    'agent/pre-step',
    { messages: [], turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter', messages: [] }),
  )
}

describe('workspaces route', () => {
  it('refuses a request without dsh browser authentication (real connection service)', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeCredentials)
    await ctx.plugin(FakeWebServer)
    await ctx.plugin(connection)
    apply(ctx, {})
    await wait()
    const route = routeOf(ctx)
    const reply = await call(route, 'workspaces', {})
    assert.ok(reply.status === 401 || reply.status === 403, `status ${reply.status}`)
    assert.ok(!reply.body.includes('server-response'))
  })

  it('mounts nothing without the web services, and the plugin still works', async () => {
    const ctx = new Context()
    apply(ctx, { baton: true })
    await wait()
    await step(ctx, agent('a', 'C:\\work\\alpha'))
  })

  it('reports workspaces, held agents and the baton holder', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeWebServer)
    await ctx.plugin(OpenConnection)
    await ctx.plugin(FakeSessions)
    const paused: { value: readonly string[]; get(): readonly string[] } = {
      value: [],
      get() {
        return this.value
      },
    }
    apply(ctx, { baton: true, pausedWorkspaces: paused, pausePollMs: 5 })
    await wait()
    const route = routeOf(ctx)

    const a = agent('session-a', 'C:\\Work\\Alpha')
    const b = agent('session-b', 'C:\\Work\\Beta')
    await step(ctx, a)
    paused.value = ['c:/work/alpha']
    const held = step(ctx, a)
    await step(ctx, b)
    await wait(20)

    const reply = await call(route, 'workspaces', {})
    assert.strictEqual(reply.status, 200)
    const envelope = JSON.parse(reply.body)
    assert.strictEqual(envelope.type, 'server-response')
    assert.strictEqual(envelope.rpcId, 'r1')
    assert.strictEqual(envelope.result.ok, true)
    const rows = Object.fromEntries(
      envelope.result.value.workspaces.map((row: { key: string }) => [row.key, row]),
    ) as Record<string, Record<string, unknown>>
    assert.deepStrictEqual(Object.keys(rows).sort(), ['c:/work/alpha', 'c:/work/beta', 'd:/projects/cold'])
    assert.strictEqual(rows['c:/work/alpha']?.path, 'C:\\Work\\Alpha')
    assert.strictEqual(rows['c:/work/alpha']?.paused, true)
    assert.strictEqual(rows['c:/work/alpha']?.held, 1)
    assert.strictEqual(rows['c:/work/alpha']?.holdsBaton, false)
    assert.strictEqual(rows['c:/work/beta']?.holdsBaton, true)
    assert.strictEqual(rows['c:/work/beta']?.paused, false)
    assert.deepStrictEqual(envelope.result.value.paused, [{ path: 'c:/work/alpha', key: 'c:/work/alpha' }])

    paused.value = []
    ctx.emit(ctx as never, 'agent/status', { agent: b, status: 'idle' })
    await held
  })

  it('counts agents inside a tool apart from held ones', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeWebServer)
    await ctx.plugin(OpenConnection)
    const paused = { value: [] as readonly string[], get: () => paused.value }
    apply(ctx, { baton: true, pausedWorkspaces: paused, pausePollMs: 5 })
    await wait()
    const route = routeOf(ctx)
    // A parent waiting on its subagent sits in a tool for the whole pause.
    const parent = agent('session-a', 'C:\\Work\\Alpha')
    await step(ctx, parent)
    paused.value = ['c:/work/alpha']
    let finish: () => void = () => {}
    const tool = ctx.waterfall(
      ctx as never,
      'tools/execute',
      { name: 'bash', agent: parent, signal: new AbortController().signal } as never,
      () => new Promise((resolve) => (finish = () => resolve({ content: [] }))),
    )
    await wait()
    const rowOf = async () => {
      const reply = JSON.parse((await call(route, 'workspaces', {})).body)
      return reply.result.value.workspaces.find((row: { key: string }) => row.key === 'c:/work/alpha')
    }
    let row = await rowOf()
    assert.strictEqual(row?.running, 1)
    assert.strictEqual(row?.inTool, 1)
    assert.strictEqual(row?.held, 0)
    finish()
    await tool
    row = await rowOf()
    assert.strictEqual(row?.inTool, 0)
  })

  it('finds the workspace of a chat, also before it has stepped', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeWebServer)
    await ctx.plugin(OpenConnection)
    await ctx.plugin(FakeSessions)
    apply(ctx, { pausedWorkspaces: ['D:/projects/cold'] })
    await wait()
    const route = routeOf(ctx)
    await step(ctx, agent('session-a', 'C:\\Work\\Alpha'))

    const seen = JSON.parse((await call(route, 'workspaceOf', { sessionId: 'session-a' })).body).result
    assert.deepStrictEqual(seen, { ok: true, value: { key: 'c:/work/alpha', path: 'C:\\Work\\Alpha', paused: false } })
    const cold = JSON.parse((await call(route, 'workspaceOf', { sessionId: 'session-cold' })).body).result
    assert.deepStrictEqual(cold, {
      ok: true,
      value: { key: 'd:/projects/cold', path: 'D:\\Projects\\Cold', paused: true },
    })
    const unknown = JSON.parse((await call(route, 'workspaceOf', { sessionId: 'nobody' })).body).result
    assert.deepStrictEqual(unknown, { ok: true, value: null })
    const bad = JSON.parse((await call(route, 'workspaceOf', {})).body).result
    assert.strictEqual(bad.ok, false)
  })

  it('rejects malformed requests', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeWebServer)
    await ctx.plugin(OpenConnection)
    apply(ctx, {})
    await wait()
    const route = routeOf(ctx)

    assert.strictEqual((await request(route, `${CHANNEL}/workspaces`, '', { method: 'GET' })).status, 404)
    assert.strictEqual((await request(route, `${CHANNEL}/../x`, {})).status, 404)
    assert.strictEqual((await request(route, `${CHANNEL}/workspaces`, {}, { contentType: 'text/plain' })).status, 415)
    assert.strictEqual((await request(route, `${CHANNEL}/workspaces`, 'not json')).status, 400)
    const tooBig = await request(route, `${CHANNEL}/workspaces`, 'x'.repeat(70 * 1024))
    assert.strictEqual(tooBig.status, 413)
    const mismatch = JSON.parse(
      (await request(route, `${CHANNEL}/workspaces`, { type: 'client-request', rpcId: 'r', method: 'other' })).body,
    )
    assert.strictEqual(mismatch.result.ok, false)
    const unknown = JSON.parse((await call(route, 'pause', {})).body)
    assert.deepStrictEqual(unknown.result.error.code, 'not-found')
  })
})
