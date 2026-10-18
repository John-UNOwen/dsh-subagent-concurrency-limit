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
    maxConcurrentSubagents: field('4'),
    queueTimeoutMs: field('300000'),
    subagentToolNames: field('subagent'),
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

function apply(loaded: { exports: Record<string, unknown> }) {
  const registrations: { options: Record<string, unknown>; component: (props: unknown) => unknown }[] = []
  const namespaces: string[] = []
  const ctx = {
    effect: (fn: () => unknown) => fn(),
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
      ['baton', 'maxConcurrentSubagents', 'queueTimeoutMs', 'subagentToolNames'],
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
    const fields = loaded.exports.__fields as { booleanField: Spec; positiveIntegerField: Spec; nameListField: Spec }
    const bool = fields.booleanField('baton')
    assert.deepStrictEqual(plain(bool.parse('true')), { kind: 'set', value: true })
    assert.deepStrictEqual(plain(bool.parse('')), { kind: 'clear' })
    assert.strictEqual(bool.parse('yes'), undefined)
    assert.strictEqual(bool.format(false), 'false')

    const int = fields.positiveIntegerField('maxConcurrentSubagents')
    assert.deepStrictEqual(plain(int.parse(' 4 ')), { kind: 'set', value: 4 })
    for (const bad of ['0', '-1', '1.5', 'x', '9007199254740993']) assert.strictEqual(int.parse(bad), undefined)

    const names = fields.nameListField('subagentToolNames')
    assert.deepStrictEqual(plain(names.parse('subagent, delegate ,')), { kind: 'set', value: ['subagent', 'delegate'] })
    assert.deepStrictEqual(plain(names.parse('  ')), { kind: 'clear' })
    assert.strictEqual(names.parse(' , '), undefined)
    assert.strictEqual(names.format(['a', 'b']), 'a, b')
  })
})
