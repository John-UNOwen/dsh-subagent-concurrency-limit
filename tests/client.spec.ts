import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterEach, describe, it } from 'node:test'
import vm from 'node:vm'

/** Copy a value out of the vm realm so deepStrictEqual compares plain data. */
function plain(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

interface Element {
  type: unknown
  props: Record<string, unknown> | null
  children: unknown[]
}

/** Unsubscribes of every loaded client, run after each test even when it fails. */
const releases: (() => void)[] = []
afterEach(() => {
  for (const release of releases.splice(0)) release()
})

/** Load the browser bundle with stand-ins for dsh's module loader, React, and UI primitives. */
function loadClient(options: { providers?: string } = {}) {
  const edits: [string, string][] = []
  const specs: { field: string }[] = []
  const subscriptions: (() => void)[] = []
  let hookIndex = 0
  const effects: { deps?: unknown[]; cleanup?: () => void }[] = []
  const states: unknown[] = []
  const beginRender = () => {
    hookIndex = 0
  }
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot }
  const field = (text: string) => ({ text, overridden: false, invalid: false })
  const snapshot = {
    available: true,
    writable: true,
    dirty: false,
    invalid: false,
    saving: false,
    failed: false,
    baton: field('true'),
    lendAfterMs: field('30000'),
    projectPriorityMs: field('600000'),
    pauseUnansweredAfterMs: field('1800000'),
    pauseUnansweredOn: field('questions'),
    maxConcurrentSubagents: field('4'),
    queueTimeoutMs: field('300000'),
    subagentToolNames: field('subagent'),
    providers: field(options.providers ?? ''),
  }
  const ui = {
    SettingsForm: 'SettingsForm',
    SettingsValueField: 'SettingsValueField',
    Switch: 'Switch',
    SettingsFormModel: class {
      constructor(_scope: unknown, fieldSpecs: { field: string }[]) {
        specs.push(...fieldSpecs)
      }
      bind() {
        return store
      }
      actions() {
        return {
          edit: (name: string, text: string) => edits.push([name, text]),
          resetField: () => {},
          save: () => {},
          discard: () => {},
        }
      }
    },
  }
  const react = {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Element => ({
      type,
      props,
      children,
    }),
    useSyncExternalStore: (subscribe: (listener: () => void) => () => void, get: () => unknown) => {
      subscriptions.push(subscribe(() => {}))
      return get()
    },
    // Hooks by call order; `beginRender` starts a component's render again at its first hook.
    useEffect: (effect: () => unknown, deps?: unknown[]) => {
      const index = hookIndex++
      const previous = effects[index]
      if (
        previous?.deps &&
        deps &&
        deps.length === previous.deps.length &&
        deps.every((d, i) => Object.is(d, previous.deps?.[i]))
      )
        return
      previous?.cleanup?.()
      const cleanup = effect()
      effects[index] = { deps, cleanup: typeof cleanup === 'function' ? (cleanup as () => void) : undefined }
    },
    useState: (initial: unknown) => {
      const index = hookIndex++
      if (!(index in states)) states[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
      return [
        states[index],
        (next: unknown) => {
          states[index] = typeof next === 'function' ? (next as (v: unknown) => unknown)(states[index]) : next
        },
      ]
    },
  }
  let loaded: { id: string; exports: Record<string, unknown> } | undefined
  const window = {
    __ModuleLoader__: {
      load: (spec: { id: string; factory: (require: (id: string) => unknown) => Record<string, unknown> }) => {
        loaded = {
          id: spec.id,
          exports: spec.factory((id) => ({ react, '@deepseek-ai/dsh-client-ui-primitives': ui })[id]),
        }
      },
    },
  }
  vm.runInNewContext(readFileSync(new URL('../client/index.js', import.meta.url), 'utf8'), {
    window,
    setTimeout,
    clearTimeout,
  })
  assert.ok(loaded)
  /** Unsubscribe every render, as unmounting does; stops the workspace list's refresh. */
  const release = () => {
    for (const off of subscriptions.splice(0)) off()
    for (const effect of effects.splice(0)) effect?.cleanup?.()
  }
  releases.push(release)
  return { loaded, specs, release, beginRender, edits }
}

const CATALOG = {
  ok: true,
  value: {
    groups: [
      { id: 'remote4090-ninfer', name: '4090 NInfer', models: [] },
      { id: 'strata-llm', name: 'Strata', models: [] },
      { id: 'deepseek-official', name: 'DeepSeek', models: [] },
    ],
    failures: [],
  },
}

interface Extra {
  /** The connection's rpc.call; omitted, the page has no connection. */
  rpc?: (channel: string, endpoint: string, payload: unknown) => Promise<unknown>
  /** The pause row's config form. */
  pauseForm?: unknown
}

function apply(loaded: { exports: Record<string, unknown> }, catalog: unknown = CATALOG, extra: Extra = {}) {
  const registrations: { options: Record<string, unknown>; component: (props: unknown) => unknown }[] = []
  const namespaces: string[] = []
  const ctx = {
    effect: (fn: () => unknown) => fn(),
    inject: (names: string[], fn: (scope: unknown) => void) => {
      if (names.includes('connection')) {
        if (extra.rpc) fn({ effect: (inner: () => unknown) => inner(), connection: { rpc: { call: extra.rpc } } })
        return
      }
      if (catalog == null || !names.includes('remote.session')) return
      const remote = { session: { modelCatalog: () => Promise.resolve(catalog) } }
      // Like cordis: reading a service the scope did not inject throws.
      fn({
        effect: (inner: () => unknown) => inner(),
        get remote() {
          if (!names.includes('remote')) throw new Error('cannot get property "remote" without inject')
          return remote
        },
      })
    },
    locale: { register: () => () => {} },
    configForms: {
      get: (id: string) => {
        namespaces.push(id)
        return id === 'subagent-concurrency-pause' ? (extra.pauseForm ?? {}) : {}
      },
      whileServed: (ids: string[], register: () => () => void) => {
        namespaces.push(...ids)
        return register()
      },
    },
    slots: {
      inject: (_name: string, fn: () => () => void) => fn(),
      register: (options: Record<string, unknown>, component: (props: unknown) => unknown) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  ;(loaded.exports.apply as (ctx: unknown) => void)(ctx)
  return { registrations, namespaces }
}

describe('client settings page', () => {
  it('registers the bundle form for the plugin entry', () => {
    const { loaded, specs } = loadClient()
    assert.strictEqual(loaded.id, 'dsh-subagent-concurrency-limit')
    assert.deepStrictEqual(plain(loaded.exports.inject), ['slots', 'locale', 'configForms'])
    const { registrations, namespaces } = apply(loaded)
    assert.deepStrictEqual([...new Set(namespaces)], ['subagent-concurrency-limit', 'subagent-concurrency-pause'])
    assert.strictEqual(registrations.length, 2)
    assert.deepStrictEqual(plain(registrations[0]?.options), {
      name: 'plugins.bundle.config',
      key: 'dsh-subagent-concurrency-limit',
      locale: 'subagentConcurrencyLimit',
    })
    assert.deepStrictEqual(plain(registrations[1]?.options), {
      name: 'conversation.input.right',
      id: 'subagent-concurrency-pause',
      order: 31,
      locale: 'subagentConcurrencyLimit',
    })
    assert.deepStrictEqual(
      specs.map((spec) => spec.field),
      [
        'baton',
        'lendAfterMs',
        'projectPriorityMs',
        'pauseUnansweredAfterMs',
        'pauseUnansweredOn',
        'maxConcurrentSubagents',
        'queueTimeoutMs',
        'subagentToolNames',
        'providers',
      ],
    )
  })

  it('renders a summary and the full form', () => {
    const { loaded } = loadClient()
    const card = apply(loaded).registrations[0]?.component
    assert.ok(card)
    const t = (key: string) => key
    assert.strictEqual(card({ t, view: 'summary' }), 'summary')
    const form = card({ t, view: 'page' }) as Element
    assert.strictEqual(form.type, 'SettingsForm')
    const text = JSON.stringify(form)
    for (const field of ['maxConcurrentSubagents', 'queueTimeoutMs', 'subagentToolNames']) {
      assert.ok(
        text.includes(
          `"text":"${field === 'maxConcurrentSubagents' ? '4' : field === 'queueTimeoutMs' ? '300000' : 'subagent'}"`,
        ),
      )
    }
    assert.ok(text.includes('"type":"Switch"') && text.includes('"checked":true'))
  })

  it('parses drafts the way the schema accepts them', () => {
    const { loaded } = loadClient()
    type Spec = (field: string) => { format(value: unknown): string; parse(text: string): unknown }
    const fields = loaded.exports.__fields as {
      booleanField: Spec
      positiveIntegerField: Spec
      nonNegativeIntegerField: Spec
      nameListField: Spec
      lanesField: Spec
    }
    const bool = fields.booleanField('baton')
    assert.deepStrictEqual(plain(bool.parse('true')), { kind: 'set', value: true })
    assert.deepStrictEqual(plain(bool.parse('')), { kind: 'clear' })
    assert.strictEqual(bool.parse('yes'), undefined)
    assert.strictEqual(bool.format(false), 'false')

    const int = fields.positiveIntegerField('maxConcurrentSubagents')
    assert.deepStrictEqual(plain(int.parse(' 4 ')), { kind: 'set', value: 4 })
    for (const bad of ['0', '-1', '1.5', 'x', '9007199254740993']) assert.strictEqual(int.parse(bad), undefined)

    const nonNegative = fields.nonNegativeIntegerField('lendAfterMs')
    assert.deepStrictEqual(plain(nonNegative.parse('0')), { kind: 'set', value: 0 })
    assert.strictEqual(nonNegative.parse('-1'), undefined)

    const lanes = fields.lanesField('providers')
    assert.deepStrictEqual(plain(lanes.parse('local-a: baton=on limit=4 lend=60000; local-b: limit=1')), {
      kind: 'set',
      value: {
        'local-a': { baton: true, maxConcurrentSubagents: 4, lendAfterMs: 60000 },
        'local-b': { maxConcurrentSubagents: 1 },
      },
    })
    assert.deepStrictEqual(plain(lanes.parse('cloud')), { kind: 'set', value: { cloud: {} } })
    assert.deepStrictEqual(plain(lanes.parse('alt: lane=gpu-a')), { kind: 'set', value: { alt: { lane: 'gpu-a' } } })
    for (const bad of ['a: limit=0', 'a: baton=yes', 'a: speed=2', 'a; a', ': limit=1'])
      assert.strictEqual(lanes.parse(bad), undefined)
    assert.strictEqual(
      lanes.format({ 'local-a': { baton: false, maxConcurrentSubagents: 2 } }),
      'local-a: baton=off limit=2',
    )

    const names = fields.nameListField('subagentToolNames')
    assert.deepStrictEqual(plain(names.parse('subagent, delegate ,')), { kind: 'set', value: ['subagent', 'delegate'] })
    assert.deepStrictEqual(plain(names.parse('  ')), { kind: 'clear' })
    assert.strictEqual(names.parse(' , '), undefined)
    assert.strictEqual(names.format(['a', 'b']), 'a, b')
  })
})

describe('client provider list', () => {
  type Lanes = Record<string, { lane?: string; maxConcurrentSubagents?: number }>
  function lanes() {
    const { loaded } = loadClient()
    return loaded.exports.__lanes as {
      parseLanes(text: string): Lanes | undefined
      formatLanes(map: Lanes): string
      withProvider(map: Lanes, id: string): Lanes
      withoutProvider(map: Lanes, id: string): Lanes
      withLane(map: Lanes, id: string, root: string): Lanes
      withLimit(map: Lanes, id: string, text: string): Lanes | undefined
    }
  }

  it('edits the providers map the way the switches and dropdowns do', () => {
    const l = lanes()
    let map: Lanes = l.withProvider({}, 'a')
    map = l.withLane(map, 'b', 'a')
    map = l.withLimit(map, 'a', '3') as Lanes
    assert.strictEqual(l.formatLanes(map), 'a: limit=3; b: lane=a')
    // Pointing the root elsewhere carries its followers along.
    map = l.withLane(map, 'a', 'c')
    assert.deepStrictEqual(plain(map), { a: { lane: 'c', maxConcurrentSubagents: 3 }, b: { lane: 'c' }, c: {} })
    // Switching a root off frees its followers.
    assert.deepStrictEqual(plain(l.withoutProvider(map, 'c')), { a: { maxConcurrentSubagents: 3 }, b: {} })
    assert.strictEqual(l.withLimit(map, 'a', '0'), undefined)
    assert.deepStrictEqual(plain(l.withLimit(map, 'a', '')?.a), { lane: 'c' })
  })

  it('lists the catalog providers with switches and writes the map on change', async () => {
    const { loaded } = loadClient()
    const { registrations } = apply(loaded)
    await new Promise((resolve) => setImmediate(resolve))
    const card = registrations[0]?.component
    assert.ok(card)
    const t = (key: string) => key
    const form = card({ t, view: 'page' }) as Element
    const find = (node: unknown, test: (el: Element) => boolean): Element | undefined => {
      if (node === null || typeof node !== 'object') return undefined
      const el = node as Element
      if (Array.isArray(node))
        for (const child of node) {
          const hit = find(child, test)
          if (hit) return hit
        }
      if (el.type !== undefined && test(el)) return el
      for (const child of el.children ?? []) {
        const hit = find(child, test)
        if (hit) return hit
      }
      return undefined
    }
    const providers = find(form, (el) => typeof el.type === 'function' && el.props?.text !== undefined)
    assert.ok(providers)
    const render = () => (providers.type as (props: unknown) => unknown)(providers.props)
    // The first render subscribes, which starts the load.
    render()
    await new Promise((resolve) => setImmediate(resolve))
    const rendered = render()
    const text = JSON.stringify(rendered)
    for (const name of ['4090 NInfer', 'Strata', 'DeepSeek']) assert.ok(text.includes(name), name)
    const switches: Element[] = []
    find(rendered, (el) => {
      if (el.type === 'Switch') switches.push(el)
      return false
    })
    assert.strictEqual(switches.length, 3)
    assert.ok(switches.every((el) => el.props?.checked === false))
  })

  it('round-trips provider names with spaces and separators (#9)', () => {
    const l = lanes()
    const map: Lanes = { 'my gpu': { lane: 'a:b' }, 'a:b': { maxConcurrentSubagents: 2 }, 'x;y': { lane: 'my gpu' } }
    assert.deepStrictEqual(plain(l.parseLanes(l.formatLanes(map))), map)
    // Picking a spaced name in "Shares a server with" keeps the draft valid.
    const shared = l.withLane(l.withProvider({}, 'my gpu'), 'other', 'my gpu')
    assert.deepStrictEqual(plain(l.parseLanes(l.formatLanes(shared))), { 'my gpu': {}, other: { lane: 'my gpu' } })
    // Unquoted text parses as before.
    assert.deepStrictEqual(plain(l.parseLanes('a: limit=3; b: lane=a')), {
      a: { maxConcurrentSubagents: 3 },
      b: { lane: 'a' },
    })
    assert.strictEqual(l.parseLanes('a: lane="unterminated'), undefined)
  })

  it('says the provider list is unavailable instead of loading forever (#10)', () => {
    const { loaded } = loadClient()
    const { registrations } = apply(loaded, null)
    const card = registrations[0]?.component
    assert.ok(card)
    const form = card({ t: (key: string) => key, view: 'page' }) as Element
    const find = (node: unknown): Element | undefined => {
      if (node === null || typeof node !== 'object') return undefined
      if (Array.isArray(node)) {
        for (const child of node) {
          const hit = find(child)
          if (hit) return hit
        }
        return undefined
      }
      const el = node as Element
      if (typeof el.type === 'function' && el.props?.text !== undefined) return el
      for (const child of el.children ?? []) {
        const hit = find(child)
        if (hit) return hit
      }
      return undefined
    }
    const providers = find(form)
    assert.ok(providers)
    const text = JSON.stringify((providers.type as (props: unknown) => unknown)(providers.props))
    assert.ok(text.includes('catalogUnavailable'), text)
    assert.ok(!text.includes('catalogLoading'), text)
  })

  it('keeps working without a model catalog', () => {
    const { loaded } = loadClient()
    const { registrations } = apply(loaded, undefined)
    assert.strictEqual(registrations.length, 2)
  })
})

describe('client catalog loading', () => {
  it('loads the catalog when the page is shown, not at plugin start', async () => {
    const { loaded } = loadClient()
    let calls = 0
    const { registrations } = apply(loaded, {
      get ok() {
        calls++
        return true
      },
      value: CATALOG.value,
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.strictEqual(calls, 0)
    const card = registrations[0]?.component
    assert.ok(card)
    card({ t: (key: string) => key, view: 'page' })
    // The card itself does not subscribe to the catalog; only the provider list does.
    assert.strictEqual(calls, 0)
  })
})

/** Every element in a tree that passes `test`. */
function findAll(node: unknown, test: (el: Element) => boolean, hits: Element[] = []): Element[] {
  if (node === null || typeof node !== 'object') return hits
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, test, hits)
    return hits
  }
  const el = node as Element
  if (el.type !== undefined && test(el)) hits.push(el)
  for (const child of el.children ?? []) findAll(child, test, hits)
  return hits
}

/** Call an element's event handler. */
function fire(el: Element | undefined, handler: string, ...args: unknown[]): unknown {
  const fn = el?.props?.[handler]
  assert.ok(typeof fn === 'function', handler)
  return (fn as (...values: unknown[]) => unknown)(...args)
}

/** Translate to the key, with params appended, so tests can read what was asked for. */
const t = (key: string, params?: Record<string, unknown>) => (params ? `${key}${JSON.stringify(params)}` : key)
const tick = () => new Promise((resolve) => setImmediate(resolve))

/** A pause-row config form over an in-memory list, like dsh's ConfigForm. */
function fakePauseForm(initial: string[], options: { refuse?: number; writable?: boolean; status?: string } = {}) {
  let snapshot = {
    status: options.status ?? 'ready',
    writable: options.writable ?? true,
    mode: 'host',
    value: { pausedWorkspaces: initial },
    revision: 1,
  }
  const listeners = new Set<() => void>()
  const writes: unknown[] = []
  let refusals = options.refuse ?? 0
  const publish = (list: string[]) => {
    snapshot = { ...snapshot, value: { pausedWorkspaces: list }, revision: snapshot.revision + 1 }
    for (const listener of listeners) listener()
  }
  const form = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set: async (field: string, value: unknown) => {
      assert.strictEqual(field, 'pausedWorkspaces')
      writes.push(plain(value))
      await tick()
      if (refusals > 0) {
        refusals--
        // The recovery read finds a folder paused elsewhere meanwhile.
        publish([...snapshot.value.pausedWorkspaces, 'D:\\Elsewhere'])
        return false
      }
      publish(plain(value) as string[])
      return true
    },
  }
  return { form, writes, paused: () => snapshot.value.pausedWorkspaces }
}

const ROWS = [
  { key: 'c:/work/a', path: 'C:\\Work\\A', paused: false, running: 2, held: 0, waiting: 1, holdsBaton: true },
  { key: 'c:/work/b', path: 'C:\\Work\\B', paused: false, running: 0, held: 0, waiting: 0, holdsBaton: false },
]

function fakeRoute(rows: unknown[] = ROWS, folders: Record<string, { key: string; path: string }> = {}) {
  const calls: { channel: string; endpoint: string; payload: unknown }[] = []
  const rpc = async (channel: string, endpoint: string, payload: unknown) => {
    calls.push({ channel, endpoint, payload: plain(payload) })
    if (endpoint === 'workspaces') return { ok: true, value: { paused: [], workspaces: rows } }
    if (endpoint === 'workspaceOf') {
      const id = (payload as { sessionId: string }).sessionId
      const found = folders[id]
      return { ok: true, value: found ? { ...found, paused: false } : null }
    }
    return { ok: false, error: { code: 'not-found', message: 'unknown endpoint' } }
  }
  return { rpc, calls }
}

function workspacesOf(loaded: { exports: Record<string, unknown> }, extra: Extra) {
  const { registrations } = apply(loaded, undefined, extra)
  const card = registrations[0]?.component
  assert.ok(card)
  const page = card({ t, view: 'page' })
  const [workspaces] = findAll(
    page,
    (el) => typeof el.type === 'function' && (el.type as { name?: string }).name === 'Workspaces',
  )
  assert.ok(workspaces)
  return { render: () => (workspaces.type as (props: unknown) => unknown)(workspaces.props), registrations }
}

describe('client workspaces', () => {
  it('lists workspaces and pauses one at once, without Save', async () => {
    const { loaded, release } = loadClient()
    const pause = fakePauseForm([])
    const route = fakeRoute()
    const { render } = workspacesOf(loaded, { rpc: route.rpc, pauseForm: pause.form })
    render()
    await tick()
    let view = render()
    assert.deepStrictEqual(
      route.calls.map((call) => [call.channel, call.endpoint]),
      [['/subagent-concurrency-limit', 'workspaces']],
    )
    const text = JSON.stringify(view)
    assert.ok(text.includes('stateRunning · manyAgents{\\"n\\":2} · partBaton · partWaiting'), text)
    assert.ok(text.includes('stateIdle'), text)
    let switches = findAll(view, (el) => el.type === 'Switch')
    assert.deepStrictEqual(
      switches.map((el) => el.props?.checked),
      [false, false],
    )
    fire(switches[0], 'onChange', true)
    // The switch shows the change while it is on its way, and is held still.
    switches = findAll(render(), (el) => el.type === 'Switch')
    assert.strictEqual(switches[0]?.props?.checked, true)
    assert.strictEqual(switches[0]?.props?.disabled, true)
    await tick()
    await tick()
    assert.deepStrictEqual(pause.writes, [['C:\\Work\\A']])
    view = render()
    switches = findAll(view, (el) => el.type === 'Switch')
    assert.deepStrictEqual(
      switches.map((el) => [el.props?.checked, el.props?.disabled]),
      [
        [true, false],
        [false, false],
      ],
    )
    // One agent still generating its step (the other is queued): pausing, not yet paused.
    assert.ok(JSON.stringify(view).includes('statePausing · partHeld'), JSON.stringify(view))
    release()
  })

  it('runs changes one at a time, each from the list the last one left', async () => {
    const { loaded, release } = loadClient()
    const pause = fakePauseForm([])
    const { render } = workspacesOf(loaded, { rpc: fakeRoute().rpc, pauseForm: pause.form })
    render()
    await tick()
    const switches = findAll(render(), (el) => el.type === 'Switch')
    fire(switches[0], 'onChange', true)
    fire(switches[1], 'onChange', true)
    for (let i = 0; i < 6; i++) await tick()
    assert.deepStrictEqual(pause.writes, [['C:\\Work\\A'], ['C:\\Work\\A', 'C:\\Work\\B']])
    assert.deepStrictEqual(plain(pause.paused()), ['C:\\Work\\A', 'C:\\Work\\B'])
    release()
  })

  it('retries a refused change once, from the list the Host answered', async () => {
    const { loaded } = loadClient()
    const helpers = loaded.exports.__workspaces as {
      createPauseControl(form: unknown): { toggle(path: string, paused: boolean): Promise<boolean> }
    }
    const pause = fakePauseForm([], { refuse: 1 })
    const ok = await helpers.createPauseControl(pause.form).toggle('C:\\Work\\A', true)
    assert.strictEqual(ok, true)
    assert.deepStrictEqual(pause.writes, [['C:\\Work\\A'], ['D:\\Elsewhere', 'C:\\Work\\A']])

    const stubborn = fakePauseForm([], { refuse: 2 })
    const control = (loaded.exports.__workspaces as typeof helpers).createPauseControl(stubborn.form) as {
      toggle(path: string, paused: boolean): Promise<boolean>
      getSnapshot(): { failed: Set<string> }
    }
    assert.strictEqual(await control.toggle('C:\\Work\\A', true), false)
    assert.strictEqual(stubborn.writes.length, 2)
    assert.ok(control.getSnapshot().failed.has('c:/work/a'))
  })

  it('resumes every spelling of a folder and keeps the others', async () => {
    const { loaded } = loadClient()
    const helpers = loaded.exports.__workspaces as {
      createPauseControl(form: unknown): { toggle(path: string, paused: boolean): Promise<boolean> }
      withPaused(list: string[], path: string, paused: boolean): string[] | undefined
      projectKey(path: string): string
    }
    const pause = fakePauseForm(['C:\\Work\\A', 'c:/work/a/', 'C:\\Work\\B'])
    assert.strictEqual(await helpers.createPauseControl(pause.form).toggle('C:/WORK/A', false), true)
    assert.deepStrictEqual(plain(pause.paused()), ['C:\\Work\\B'])
    assert.strictEqual(helpers.withPaused(['C:\\Work\\B'], 'c:/work/b', true), undefined)
    assert.strictEqual(helpers.withPaused(['C:\\Work\\B'], 'C:\\Work\\A', false), undefined)
    assert.strictEqual(helpers.projectKey('C:\\Work\\A\\'), 'c:/work/a')
  })

  it('shows paused folders the route has not reported, and works without a connection', async () => {
    const { loaded, release } = loadClient()
    const pause = fakePauseForm(['E:\\Old'])
    const { render } = workspacesOf(loaded, { pauseForm: pause.form })
    render()
    await tick()
    const view = render()
    const text = JSON.stringify(view)
    assert.ok(text.includes('workspacesUnavailable'), text)
    assert.ok(text.includes('E:\\\\Old'), text)
    const switches = findAll(view, (el) => el.type === 'Switch')
    assert.deepStrictEqual(
      switches.map((el) => el.props?.checked),
      [true],
    )
    fire(switches[0], 'onChange', false)
    await tick()
    await tick()
    assert.deepStrictEqual(plain(pause.paused()), [])
    release()
  })

  it('says why pausing is off when the pause entry is missing or read-only', async () => {
    for (const [options, expected] of [
      [{ status: 'unavailable' }, 'pauseUnavailable'],
      [{ writable: false }, 'pauseReadOnly'],
    ] as const) {
      const { loaded, release } = loadClient()
      const pause = fakePauseForm([], options)
      const { render } = workspacesOf(loaded, { rpc: fakeRoute().rpc, pauseForm: pause.form })
      render()
      await tick()
      const view = render()
      assert.ok(JSON.stringify(view).includes(expected), expected)
      assert.ok(findAll(view, (el) => el.type === 'Switch').every((el) => el.props?.disabled === true))
      release()
    }
  })

  it('words each workspace state', () => {
    const { loaded } = loadClient()
    const { workspaceStatus } = loaded.exports.__workspaces as {
      workspaceStatus(t: unknown, row: Record<string, unknown>, paused: boolean): string
    }
    const row = (fields: Record<string, unknown>) => ({ running: 0, held: 0, waiting: 0, holdsBaton: false, ...fields })
    assert.strictEqual(
      workspaceStatus(t, row({ running: 3, held: 3 }), true),
      'statePaused · partHeld{"agents":"manyAgents{\\"n\\":3}"}',
    )
    assert.strictEqual(
      workspaceStatus(t, row({ running: 2, held: 1 }), true),
      'statePausing · partHeld{"agents":"oneAgent"} · partFinishing{"agents":"oneAgent"}',
    )
    assert.strictEqual(workspaceStatus(t, row({}), true), 'statePaused')
    // A parent waiting on its paused subagent, and an agent queued for the baton, are not finishing a step.
    assert.strictEqual(
      workspaceStatus(t, row({ running: 3, held: 1, waiting: 1, inTool: 1 }), true),
      'statePaused · partHeld{"agents":"manyAgents{\\"n\\":2}"} · partInTool{"agents":"oneAgent"}',
    )
    assert.strictEqual(
      workspaceStatus(t, row({ running: 2, inTool: 1 }), true),
      'statePausing · partInTool{"agents":"oneAgent"} · partFinishing{"agents":"oneAgent"}',
    )
    assert.strictEqual(workspaceStatus(t, row({}), false), 'stateIdle')
    // Paused by an unanswered question while the switch is off.
    assert.strictEqual(
      workspaceStatus(t, row({ running: 1, inTool: 1, awaitingAnswer: true }), false),
      'statePaused · partInTool{"agents":"oneAgent"} · partAwaitingAnswer',
    )
    assert.strictEqual(
      workspaceStatus(t, row({ running: 1, holdsBaton: true }), false),
      'stateRunning · oneAgent · partBaton',
    )
  })
})

describe('client composer button', () => {
  it("pauses and resumes the open chat's workspace", async () => {
    const { loaded, release } = loadClient()
    const pause = fakePauseForm([])
    const route = fakeRoute(ROWS, { s1: { key: 'c:/work/a', path: 'C:\\Work\\A' } })
    const { registrations } = apply(loaded, undefined, { rpc: route.rpc, pauseForm: pause.form })
    const button = registrations[1]?.component
    assert.ok(button)
    // Nothing until the workspace is known.
    assert.strictEqual(button({ t, sessionId: 's1' }), null)
    await tick()
    let view = button({ t, sessionId: 's1' }) as Element
    assert.deepStrictEqual(plain(route.calls.at(-1)), {
      channel: '/subagent-concurrency-limit',
      endpoint: 'workspaceOf',
      payload: { sessionId: 's1' },
    })
    let [control] = findAll(view, (el) => el.type === 'button')
    assert.ok(control)
    assert.strictEqual(control.props?.['aria-pressed'], false)
    assert.ok(JSON.stringify(control).includes('"pauseWorkspace"'))
    fire(control, 'onClick')
    await tick()
    await tick()
    assert.deepStrictEqual(plain(pause.paused()), ['C:\\Work\\A'])
    view = button({ t, sessionId: 's1' }) as Element
    ;[control] = findAll(view, (el) => el.type === 'button')
    assert.strictEqual(control?.props?.['aria-pressed'], true)
    assert.ok(JSON.stringify(control).includes('"resumeWorkspace"'))
    // A workspace paused from the settings page shows here too; one lookup per chat.
    assert.strictEqual(route.calls.filter((call) => call.endpoint === 'workspaceOf').length, 1)
    release()
  })

  it('asks again for a chat whose workspace was not known yet, without a re-render', async (t2) => {
    t2.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const { loaded } = loadClient()
    const folders: Record<string, { key: string; path: string }> = {}
    const route = fakeRoute(ROWS, folders)
    const button = apply(loaded, undefined, { rpc: route.rpc, pauseForm: fakePauseForm([]).form }).registrations[1]
    assert.ok(button)
    assert.strictEqual(button.component({ t, sessionId: 's1' }), null)
    await tick()
    // The chat steps now, so the route would know it.
    folders.s1 = { key: 'c:/work/a', path: 'C:\\Work\\A' }
    t2.mock.timers.tick(5000)
    await tick()
    assert.strictEqual(route.calls.filter((call) => call.endpoint === 'workspaceOf').length, 2)
    assert.notStrictEqual(button.component({ t, sessionId: 's1' }), null)
  })

  it('stays hidden for an unknown chat or when pausing is unavailable', async () => {
    const { loaded, release } = loadClient()
    const route = fakeRoute(ROWS, { s1: { key: 'c:/work/a', path: 'C:\\Work\\A' } })
    const unknown = apply(loaded, undefined, { rpc: route.rpc, pauseForm: fakePauseForm([]).form }).registrations[1]
    assert.ok(unknown)
    unknown.component({ t, sessionId: 'nope' })
    await tick()
    assert.strictEqual(unknown.component({ t, sessionId: 'nope' }), null)
    const locked = apply(loaded, undefined, { rpc: route.rpc, pauseForm: fakePauseForm([], { writable: false }).form })
      .registrations[1]
    assert.ok(locked)
    locked.component({ t, sessionId: 's1' })
    await tick()
    assert.strictEqual(locked.component({ t, sessionId: 's1' }), null)
    release()
  })
})

describe('client provider editor (checkup)', () => {
  const CATALOG3 = {
    ok: true,
    value: {
      groups: [
        { id: 'gpu-a', name: 'GPU A', models: [] },
        { id: 'gpu-b', name: 'GPU B', models: [] },
        { id: 'gpu-c', name: 'GPU C', models: [] },
      ],
      failures: [],
    },
  }

  async function providersOf(text: string) {
    const client = loadClient({ providers: text })
    const { registrations } = apply(client.loaded, CATALOG3)
    await tick()
    const card = registrations[0]?.component
    assert.ok(card)
    const page = card({ t, view: 'page' })
    const [providers] = findAll(page, (el) => typeof el.type === 'function' && el.props?.text !== undefined)
    assert.ok(providers)
    const render = () => {
      client.beginRender()
      return (providers.type as (props: unknown) => unknown)(providers.props) as Element
    }
    render()
    await tick()
    return { render, edits: client.edits }
  }

  it('shows a lane root nobody lists as limited, locked while others use it, with the limit that governs (#8, #9)', async () => {
    const { render, edits } = await providersOf('gpu-b: lane=gpu-a limit=2')
    const view = render()
    const switches = findAll(view, (el) => el.type === 'Switch')
    const a = switches.find((el) => String(el.props?.label).includes('GPU A'))
    assert.strictEqual(a?.props?.checked, true)
    assert.strictEqual(a?.props?.disabled, true)
    assert.ok(findAll(view, (el) => el.children.includes('sharedBy{"names":"GPU B"}')).length > 0)
    const [, select] = findAll(view, (el) => el.type === 'select')
    assert.strictEqual(select?.props?.value, 'gpu-a')
    assert.ok(findAll(select, (el) => el.type === 'option').some((el) => el.props?.value === 'gpu-a'))
    const inputs = findAll(view, (el) => el.type === 'input')
    assert.strictEqual(inputs.length, 1)
    assert.strictEqual(inputs[0]?.props?.value, '2')
    // Setting the root's limit gives it an entry; the follower keeps its server.
    fire(inputs[0], 'onChange', { target: { value: '3' } })
    assert.deepStrictEqual(edits.at(-1), ['providers', 'gpu-b: lane=gpu-a limit=2; gpu-a: limit=3'])
  })

  it('follows a lane chain to its end (#8)', async () => {
    const { render } = await providersOf('gpu-b: lane=gpu-c; gpu-c: lane=gpu-a')
    const view = render()
    const selects = findAll(view, (el) => el.type === 'select')
    assert.deepStrictEqual(
      selects.map((el) => el.props?.value),
      ['', 'gpu-a', 'gpu-a'],
    )
    for (const select of selects.slice(1))
      assert.ok(findAll(select, (el) => el.type === 'option').some((el) => el.props?.value === 'gpu-a'))
  })

  it('keeps a rejected limit on screen with an error and stages nothing (#10)', async () => {
    const { render, edits } = await providersOf('gpu-a: limit=4')
    let [input] = findAll(render(), (el) => el.type === 'input')
    fire(input, 'onChange', { target: { value: '0' } })
    const view = render()
    ;[input] = findAll(view, (el) => el.type === 'input')
    assert.strictEqual(input?.props?.value, '0')
    assert.strictEqual(input?.props?.['aria-invalid'], true)
    assert.ok(JSON.stringify(view).includes('invalidInteger'))
    assert.deepStrictEqual(edits, [])
    fire(input, 'onChange', { target: { value: '7' } })
    assert.deepStrictEqual(edits, [['providers', 'gpu-a: limit=7']])
    ;[input] = findAll(render(), (el) => el.type === 'input')
    assert.strictEqual(input?.props?.value, '4')
  })

  it('says the text has an error instead of vanishing (#22)', async () => {
    const { render } = await providersOf('gpu-a: limit')
    const view = render()
    assert.ok(view)
    assert.ok(JSON.stringify(view).includes('providersTextInvalid'))
  })

  it('seeds a new root entry with the settings its followers gave the lane', () => {
    const { loaded } = loadClient()
    const l = loaded.exports.__lanes as { withLimit(map: unknown, id: string, text: string): unknown }
    assert.deepStrictEqual(plain(l.withLimit({ b: { lane: 'a', baton: true, lendAfterMs: 5 } }, 'a', '3')), {
      b: { lane: 'a', baton: true, lendAfterMs: 5 },
      a: { baton: true, lendAfterMs: 5, maxConcurrentSubagents: 3 },
    })
  })
})

describe('client composer and writes (checkup)', () => {
  it('stops asking about a chat once the composer shows another (#24)', async (t2) => {
    t2.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const client = loadClient()
    const route = fakeRoute(ROWS, { 'chat-b': { key: 'c:/work/b', path: 'C:\\Work\\B' } })
    const button = apply(client.loaded, undefined, { rpc: route.rpc, pauseForm: fakePauseForm([]).form })
      .registrations[1]
    assert.ok(button)
    const render = (sessionId: string) => {
      client.beginRender()
      return button.component({ t, sessionId })
    }
    render('chat-a')
    await tick()
    render('chat-b')
    await tick()
    for (let i = 0; i < 3; i++) {
      t2.mock.timers.tick(5000)
      await tick()
    }
    const asked = (id: string) =>
      route.calls.filter((call) => (call.payload as { sessionId?: string })?.sessionId === id).length
    assert.strictEqual(asked('chat-a'), 1)
    assert.strictEqual(asked('chat-b'), 1)
  })

  it('retries a pause write once after a transport failure (#25)', async (t2) => {
    t2.mock.timers.enable({ apis: ['setTimeout'] })
    const { loaded } = loadClient()
    const pause = fakePauseForm([])
    let failures = 1
    const set = pause.form.set
    pause.form.set = (field: string, value: unknown) => {
      if (failures-- > 0) return Promise.reject(new Error('connection lost'))
      return set(field, value)
    }
    const control = (
      loaded.exports.__workspaces as {
        createPauseControl(form: unknown): { toggle(path: string, paused: boolean): Promise<boolean> }
      }
    ).createPauseControl(pause.form)
    const result = control.toggle('C:\\Work\\A', true)
    await tick()
    t2.mock.timers.tick(1000)
    assert.strictEqual(await result, true)
    assert.deepStrictEqual(plain(pause.paused()), ['C:\\Work\\A'])
  })
})

describe('client unanswered-question settings', () => {
  it('shows the delay and the approvals switch, and stages the switch as a choice', () => {
    const client = loadClient()
    const card = apply(client.loaded).registrations[0]?.component
    assert.ok(card)
    const page = card({ t, view: 'page' })
    const text = JSON.stringify(page)
    assert.ok(text.includes('unansweredTitle') && text.includes('"text":"1800000"'))
    const toggle = findAll(page, (el) => el.type === 'Switch' && el.props?.label === 'unansweredApprovals')[0]
    assert.strictEqual(toggle?.props?.checked, false)
    fire(toggle, 'onChange', true)
    assert.deepStrictEqual(client.edits.at(-1), ['pauseUnansweredOn', 'questions-and-approvals'])
    type Spec = { parse(text: string): unknown }
    const choice = (client.loaded.exports.__fields as { choiceField(f: string, c: string[]): Spec }).choiceField(
      'pauseUnansweredOn',
      ['questions', 'questions-and-approvals'],
    )
    assert.deepStrictEqual(plain(choice.parse('questions')), { kind: 'set', value: 'questions' })
    assert.strictEqual(choice.parse('always'), undefined)
  })
})
