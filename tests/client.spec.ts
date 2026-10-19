import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
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

/** Load the browser bundle with stand-ins for dsh's module loader, React, and UI primitives. */
function loadClient() {
  const specs: { field: string }[] = []
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
    maxConcurrentSubagents: field('4'),
    queueTimeoutMs: field('300000'),
    subagentToolNames: field('subagent'),
    providers: field(''),
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
        return { edit: () => {}, resetField: () => {}, save: () => {}, discard: () => {} }
      }
    },
  }
  const react = {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Element => ({
      type,
      props,
      children,
    }),
    useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
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
  vm.runInNewContext(readFileSync(new URL('../client/index.js', import.meta.url), 'utf8'), { window })
  assert.ok(loaded)
  return { loaded, specs }
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

function apply(loaded: { exports: Record<string, unknown> }, catalog: unknown = CATALOG) {
  const registrations: { options: Record<string, unknown>; component: (props: unknown) => unknown }[] = []
  const namespaces: string[] = []
  const ctx = {
    effect: (fn: () => unknown) => fn(),
    inject: (names: string[], fn: (scope: unknown) => void) => {
      if (catalog === undefined || !names.includes('remote.session')) return
      fn({
        effect: (inner: () => unknown) => inner(),
        remote: { session: { modelCatalog: () => Promise.resolve(catalog) } },
      })
    },
    locale: { register: () => () => {} },
    configForms: {
      get: (id: string) => {
        namespaces.push(id)
        return {}
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
    assert.deepStrictEqual([...new Set(namespaces)], ['subagent-concurrency-limit'])
    assert.strictEqual(registrations.length, 1)
    assert.deepStrictEqual(plain(registrations[0]?.options), {
      name: 'plugins.bundle.config',
      key: 'dsh-subagent-concurrency-limit',
      locale: 'subagentConcurrencyLimit',
    })
    assert.deepStrictEqual(
      specs.map((spec) => spec.field),
      ['baton', 'lendAfterMs', 'maxConcurrentSubagents', 'queueTimeoutMs', 'subagentToolNames', 'providers'],
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
    const rendered = (providers.type as (props: unknown) => unknown)(providers.props)
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

  it('keeps working without a model catalog', () => {
    const { loaded } = loadClient()
    const { registrations } = apply(loaded, undefined)
    assert.strictEqual(registrations.length, 1)
  })
})
