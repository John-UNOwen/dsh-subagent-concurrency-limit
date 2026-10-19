// Browser half: this plugin's settings form on the dsh Plugins page.
//
// Hand-written in the lazy-CJS bundle protocol (window.__ModuleLoader__.load
// with a factory returning cordis-plugin exports), so there is no build step.
// The values are the host half's volatile Config fields; dsh's settings
// service validates each save against that schema and writes it to the
// profile's cordis.patch.yml, and the plugin picks it up live.
window.__ModuleLoader__.load({
  id: 'dsh-subagent-concurrency-limit',
  factory: (require) => {
    var module = { exports: {} }

    // The Plugins page keys a bundle's configuration by npm package name.
    var PACKAGE_NAME = 'dsh-subagent-concurrency-limit'
    // The profile entry id the bundle patch inserts; the settings namespace.
    var ENTRY_ID = 'subagent-concurrency-limit'
    var NS = 'subagentConcurrencyLimit'

    var en = {
      summary: 'Limit subagent runs; baton mode lets one agent generate at a time.',
      batonTitle: 'Baton mode',
      batonLabel: 'One agent generates at a time',
      batonHint:
        'For a single-slot local LLM server. A parent pauses while its subagent runs, so agents never interleave and evict the prompt cache.',
      lendAfter: 'Lend after (ms)',
      lendAfterHint:
        'While the baton holder runs a tool, another agent may take the slot only after this long. Its own subagents may at once. Short tool calls keep the prompt cache warm.',
      invalidNonNegative: 'Enter a whole number of 0 or more.',
      providers: 'Per-provider lanes',
      providersHint:
        'Give each listed provider its own baton and limit, e.g. "gpu-a: limit=4; gpu-a-alt: lane=gpu-a; gpu-b: limit=1 lend=60000". Providers on the same server should share a lane. Unlisted providers run freely. Leave empty for one lane covering every agent.',
      invalidProviders: 'Use "name: lane=NAME baton=on|off limit=N lend=N", separated by semicolons.',
      providersTitle: 'Providers',
      providersIntro:
        'Switch on each provider that runs on a local server with one slot. It gets its own baton and limit; providers left off run freely. Leave all off for one baton covering every agent.',
      limitProvider: 'Limit',
      sharesWith: 'Shares a server with',
      ownServer: 'Its own server',
      providerLimit: 'Subagent limit',
      providerLimitDefault: 'default',
      notInCatalog: 'not in the current model list',
      catalogLoading: 'Loading providers…',
      catalogError: 'Could not load the provider list.',
      catalogPartial: 'Some providers could not be listed.',
      refresh: 'Refresh',
      advanced: 'Edit as text',
      limitsTitle: 'Limits',
      maxConcurrent: 'Maximum concurrent subagents',
      maxConcurrentHint:
        'Live child runs and turns at once, the root excluded. With baton mode on, keep this above 1 so nested subagents are admitted.',
      queueTimeout: 'Queue timeout (ms)',
      queueTimeoutHint: 'How long a delegation or child turn may wait for a free slot before failing.',
      toolNames: 'Delegation tool names',
      toolNamesHint: 'Comma-separated tool names whose calls count against the limit.',
      invalidInteger: 'Enter a whole number of 1 or more.',
      invalidNames: 'Enter at least one tool name.',
      overridden: 'Changed',
      reset: 'Reset',
      unavailable: 'This plugin is not running in the current profile.',
      readOnly: 'Settings are read-only in this deployment.',
      saveFailed: 'The save was not accepted.',
      save: 'Save',
      saving: 'Saving…',
    }
    var zh = {
      summary: '限制子代理并发；接力棒模式下同一时间只有一个代理在生成。',
      batonTitle: '接力棒模式',
      batonLabel: '同一时间只有一个代理生成',
      batonHint: '适用于单槽位本地 LLM 服务。子代理运行时父代理暂停，代理不会交错请求而冲掉提示缓存。',
      lendAfter: '借出等待（毫秒）',
      lendAfterHint:
        '持棒代理执行工具时，其他代理需等待这么久才能借用槽位；它自己的子代理可立即借用。短工具调用可保持提示缓存。',
      invalidNonNegative: '请输入不小于 0 的整数。',
      providers: '按提供方分道',
      providersHint:
        '为列出的每个提供方单独设置接力棒和上限，例如 "gpu-a: limit=4; gpu-a-alt: lane=gpu-a; gpu-b: limit=1 lend=60000"。同一服务器上的提供方应共用一道。未列出的提供方不受限制。留空则所有代理共用一道。',
      invalidProviders: '格式为 "名称: lane=道名 baton=on|off limit=N lend=N"，以分号分隔。',
      providersTitle: '提供方',
      providersIntro:
        '为每个运行在单槽位本地服务器上的提供方打开开关，它会获得独立的接力棒和上限；未开启的提供方不受限制。全部关闭则所有代理共用一个接力棒。',
      limitProvider: '限制',
      sharesWith: '与之共用服务器',
      ownServer: '独立服务器',
      providerLimit: '子代理上限',
      providerLimitDefault: '默认',
      notInCatalog: '不在当前模型列表中',
      catalogLoading: '正在加载提供方…',
      catalogError: '无法加载提供方列表。',
      catalogPartial: '部分提供方无法列出。',
      refresh: '刷新',
      advanced: '以文本编辑',
      limitsTitle: '限制',
      maxConcurrent: '最大并发子代理数',
      maxConcurrentHint: '同时存活的子运行和回合数，不含根代理。开启接力棒模式时请保持大于 1，以允许嵌套子代理。',
      queueTimeout: '排队超时（毫秒）',
      queueTimeoutHint: '委派或子回合等待空位的最长时间，超时即失败。',
      toolNames: '委派工具名',
      toolNamesHint: '以逗号分隔，这些工具的调用计入限制。',
      invalidInteger: '请输入不小于 1 的整数。',
      invalidNames: '请至少输入一个工具名。',
      overridden: '已修改',
      reset: '重置',
      unavailable: '当前配置中此插件未运行。',
      readOnly: '此部署的设置为只读。',
      saveFailed: '保存未被接受。',
      save: '保存',
      saving: '保存中…',
    }

    function booleanField(field) {
      return {
        field: field,
        format: (value) => (value === true ? 'true' : value === false ? 'false' : ''),
        parse: (text) =>
          text === ''
            ? { kind: 'clear' }
            : text === 'true' || text === 'false'
              ? { kind: 'set', value: text === 'true' }
              : undefined,
      }
    }

    function integerField(field, minimum) {
      return {
        field: field,
        format: (value) => (typeof value === 'number' ? String(value) : ''),
        parse: (text) => {
          var trimmed = text.trim()
          if (trimmed === '') return { kind: 'clear' }
          if (!/^\d+$/.test(trimmed)) return undefined
          var value = Number(trimmed)
          return Number.isSafeInteger(value) && value >= minimum ? { kind: 'set', value: value } : undefined
        },
      }
    }

    function positiveIntegerField(field) {
      return integerField(field, 1)
    }

    function nonNegativeIntegerField(field) {
      return integerField(field, 0)
    }

    var LANE_KEYS = { lane: 'lane', baton: 'baton', limit: 'maxConcurrentSubagents', lend: 'lendAfterMs' }

    function formatLanes(value) {
      if (typeof value !== 'object' || value === null) return ''
      return Object.keys(value)
        .map((name) => {
          var lane = value[name] || {}
          var parts = [`${name}:`]
          if (typeof lane.lane === 'string') parts.push(`lane=${lane.lane}`)
          if (typeof lane.baton === 'boolean') parts.push(`baton=${lane.baton ? 'on' : 'off'}`)
          if (typeof lane.maxConcurrentSubagents === 'number') parts.push(`limit=${lane.maxConcurrentSubagents}`)
          if (typeof lane.lendAfterMs === 'number') parts.push(`lend=${lane.lendAfterMs}`)
          return parts.join(' ')
        })
        .join('; ')
    }

    function parseLanes(text) {
      const lanes = {}
      const entries = text
        .split(/[;\n]/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
      for (const entry of entries) {
        const colon = entry.indexOf(':')
        const name = (colon < 0 ? entry : entry.slice(0, colon)).trim()
        if (name.length === 0 || Object.hasOwn(lanes, name)) return undefined
        const lane = {}
        const rest = colon < 0 ? '' : entry.slice(colon + 1).trim()
        for (const token of rest.split(/\s+/).filter((part) => part.length > 0)) {
          const match = /^(lane|baton|limit|lend)=(.+)$/.exec(token)
          if (match === null) return undefined
          const key = LANE_KEYS[match[1]]
          if (key === 'lane') {
            lane.lane = match[2]
          } else if (key === 'baton') {
            if (match[2] !== 'on' && match[2] !== 'off') return undefined
            lane.baton = match[2] === 'on'
          } else {
            if (!/^\d+$/.test(match[2])) return undefined
            const number = Number(match[2])
            if (!Number.isSafeInteger(number) || (key === 'maxConcurrentSubagents' && number < 1)) return undefined
            lane[key] = number
          }
        }
        lanes[name] = lane
      }
      return lanes
    }

    function lanesField(field) {
      return {
        field: field,
        format: formatLanes,
        parse: (text) => {
          if (text.trim() === '') return { kind: 'clear' }
          var lanes = parseLanes(text)
          return lanes === undefined ? undefined : { kind: 'set', value: lanes }
        },
      }
    }

    /** The lane root a provider's baton belongs to. */
    function laneRoot(map, id) {
      var entry = map[id]
      return entry && typeof entry.lane === 'string' && entry.lane !== id ? entry.lane : id
    }

    function withProvider(map, id) {
      var next = Object.assign({}, map)
      if (!Object.hasOwn(next, id)) next[id] = {}
      return next
    }

    /** Turn a provider off; providers that shared its server get their own lane. */
    function withoutProvider(map, id) {
      var next = {}
      for (var name of Object.keys(map)) {
        if (name === id) continue
        var entry = Object.assign({}, map[name])
        if (entry.lane === id) delete entry.lane
        next[name] = entry
      }
      return next
    }

    /** Point a provider at another provider's server, or back to its own (`root` empty). */
    function withLane(map, id, root) {
      var next = withProvider(map, id)
      var entry = Object.assign({}, next[id])
      if (root === '' || root === id) delete entry.lane
      else {
        entry.lane = root
        next = withProvider(next, root)
        // Providers that shared this one's server now follow the new root.
        for (var name of Object.keys(next)) {
          if (name !== id && next[name].lane === id) next[name] = Object.assign({}, next[name], { lane: root })
        }
      }
      next[id] = entry
      return next
    }

    function withLimit(map, id, text) {
      var next = withProvider(map, id)
      var entry = Object.assign({}, next[id])
      var trimmed = text.trim()
      if (trimmed === '') delete entry.maxConcurrentSubagents
      else if (/^\d+$/.test(trimmed) && Number(trimmed) >= 1) entry.maxConcurrentSubagents = Number(trimmed)
      else return undefined
      next[id] = entry
      return next
    }

    function nameListField(field) {
      return {
        field: field,
        format: (value) => (Array.isArray(value) ? value.join(', ') : ''),
        parse: (text) => {
          if (text.trim() === '') return { kind: 'clear' }
          var names = text
            .split(',')
            .map((name) => name.trim())
            .filter((name) => name.length > 0)
          return names.length > 0 ? { kind: 'set', value: names } : undefined
        },
      }
    }

    function createCatalog() {
      var listeners = new Set()
      var snapshot = { status: 'idle', groups: [], partial: false }
      return {
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        getSnapshot: () => snapshot,
        set: (next) => {
          snapshot = next
          for (var listener of listeners) listener()
        },
        load: undefined,
      }
    }

    function ProvidersEditor(react, ui, catalog, actions) {
      var h = react.createElement
      var hint = { margin: 0, fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' }
      var row = {
        display: 'grid',
        gridTemplateColumns: 'minmax(0,1fr) auto',
        gap: '8px 16px',
        alignItems: 'center',
        padding: '10px 0',
        borderTop: '0.5px solid var(--dsw-alias-border-l3)',
      }
      var details = { gridColumn: '1 / -1', display: 'flex', flexWrap: 'wrap', gap: '12px', fontSize: '12px' }
      var control = {
        font: 'inherit',
        fontSize: '12px',
        padding: '4px 6px',
        borderRadius: 'var(--dsw-radius-md)',
        border: '0.5px solid var(--dsw-alias-border-l4)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
      }
      var link = {
        background: 'none',
        border: 0,
        padding: 0,
        cursor: 'pointer',
        fontSize: '12px',
        color: 'var(--dsw-alias-brand-primary)',
      }

      return function Providers(props) {
        var t = props.t
        var listing = react.useSyncExternalStore(catalog.subscribe, catalog.getSnapshot)
        var map = props.text.trim() === '' ? {} : parseLanes(props.text)
        if (map === undefined) return null
        var names = new Map()
        for (var group of listing.groups) names.set(group.id, group.name || group.id)
        var ids = [...names.keys()]
        for (var id of Object.keys(map)) if (!names.has(id)) ids.push(id)
        var write = (next) => {
          if (next !== undefined) actions.edit('providers', formatLanes(next))
        }

        var status = null
        if (listing.status === 'loading') status = h('p', { style: hint }, t('catalogLoading'))
        else if (listing.status === 'error')
          status = h(
            'p',
            { style: hint },
            `${t('catalogError')} `,
            catalog.load ? h('button', { type: 'button', style: link, onClick: catalog.load }, t('refresh')) : null,
          )
        else if (listing.partial) status = h('p', { style: hint }, t('catalogPartial'))

        return h(
          'div',
          null,
          h('p', { style: hint }, t('providersIntro')),
          status,
          ids.map((id) => {
            var on = Object.hasOwn(map, id)
            var entry = map[id] || {}
            var roots = ids.filter(
              (other) => other !== id && Object.hasOwn(map, other) && laneRoot(map, other) === other,
            )
            var label = names.has(id) ? names.get(id) : `${id} (${t('notInCatalog')})`
            return h(
              'div',
              { key: id, style: row },
              h(
                'div',
                { style: { minWidth: 0 } },
                h('div', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-primary)' } }, label),
                label !== id ? h('div', { style: hint }, id) : null,
              ),
              h(ui.Switch, {
                checked: on,
                label: `${t('limitProvider')} ${label}`,
                disabled: props.disabled,
                onChange: (next) => write(next ? withProvider(map, id) : withoutProvider(map, id)),
              }),
              on
                ? h(
                    'div',
                    { style: details },
                    h(
                      'label',
                      null,
                      `${t('sharesWith')} `,
                      h(
                        'select',
                        {
                          style: control,
                          disabled: props.disabled,
                          value: laneRoot(map, id) === id ? '' : laneRoot(map, id),
                          onChange: (event) => write(withLane(map, id, event.target.value)),
                        },
                        h('option', { value: '' }, t('ownServer')),
                        roots.map((root) => h('option', { key: root, value: root }, names.get(root) || root)),
                      ),
                    ),
                    laneRoot(map, id) === id
                      ? h(
                          'label',
                          null,
                          `${t('providerLimit')} `,
                          h('input', {
                            style: Object.assign({}, control, { width: '64px' }),
                            inputMode: 'numeric',
                            disabled: props.disabled,
                            placeholder: t('providerLimitDefault'),
                            value:
                              typeof entry.maxConcurrentSubagents === 'number'
                                ? String(entry.maxConcurrentSubagents)
                                : '',
                            onChange: (event) => write(withLimit(map, id, event.target.value)),
                          }),
                        )
                      : null,
                  )
                : null,
            )
          }),
        )
      }
    }

    function createCard(react, ui, store, actions, catalog) {
      var Providers = ProvidersEditor(react, ui, catalog, actions)
      var h = react.createElement
      var section = { padding: '16px 0', display: 'grid', gap: '12px', minWidth: 0 }
      var heading = {
        margin: 0,
        fontSize: '13px',
        fontWeight: 600,
        lineHeight: 1.5,
        color: 'var(--dsw-alias-label-primary)',
      }
      var hint = { margin: 0, fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' }
      var row = {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: '16px',
        fontSize: '13px',
      }
      var link = {
        background: 'none',
        border: 0,
        padding: 0,
        cursor: 'pointer',
        fontSize: '12px',
        color: 'var(--dsw-alias-brand-primary)',
      }

      return function SubagentConcurrencyLimitCard(props) {
        var t = props.t
        var state = react.useSyncExternalStore(store.subscribe, store.getSnapshot)
        if (props.view === 'summary') return t('summary')
        var disabled = !state.writable || state.saving

        function valueField(id, field, label, hintKey, invalidKey, numeric) {
          return h(
            ui.SettingsValueField,
            Object.assign(
              {
                id: `plugin-config-subagent-concurrency-limit-${id}`,
                label: t(label),
                hint: t(hintKey),
                overriddenLabel: t('overridden'),
                resetLabel: t('reset'),
                invalidLabel: t(invalidKey),
                numeric: numeric,
                disabled: disabled,
              },
              state[field],
              {
                onEdit: (text) => actions.edit(field, text),
                onReset: () => actions.resetField(field),
              },
            ),
          )
        }

        return h(
          ui.SettingsForm,
          {
            labels: {
              unavailable: t('unavailable'),
              readOnly: t('readOnly'),
              saveFailed: t('saveFailed'),
              save: t('save'),
              saving: t('saving'),
            },
            state: state,
            onSave: actions.save,
            onDiscard: actions.discard,
          },
          h(
            'section',
            { style: section },
            h('h3', { style: heading }, t('batonTitle')),
            h(
              'div',
              { style: row },
              h('span', null, t('batonLabel')),
              h(ui.Switch, {
                checked: state.baton.text === 'true',
                label: t('batonLabel'),
                disabled: disabled,
                onChange: (next) => actions.edit('baton', next ? 'true' : 'false'),
              }),
            ),
            h('p', { style: hint }, t('batonHint')),
            valueField('lend', 'lendAfterMs', 'lendAfter', 'lendAfterHint', 'invalidNonNegative', true),
            state.baton.overridden
              ? h(
                  'button',
                  { type: 'button', style: link, disabled: disabled, onClick: () => actions.resetField('baton') },
                  t('reset'),
                )
              : null,
          ),
          h(
            'section',
            { style: section },
            h('h3', { style: heading }, t('limitsTitle')),
            valueField('max', 'maxConcurrentSubagents', 'maxConcurrent', 'maxConcurrentHint', 'invalidInteger', true),
            valueField('timeout', 'queueTimeoutMs', 'queueTimeout', 'queueTimeoutHint', 'invalidInteger', true),
            valueField('tools', 'subagentToolNames', 'toolNames', 'toolNamesHint', 'invalidNames', false),
          ),
          h(
            'section',
            { style: section },
            h('h3', { style: heading }, t('providersTitle')),
            h(Providers, { t: t, text: state.providers.text, disabled: disabled }),
            h(
              'details',
              null,
              h('summary', { style: { cursor: 'pointer', fontSize: '12px' } }, t('advanced')),
              valueField('providers', 'providers', 'providers', 'providersHint', 'invalidProviders', false),
            ),
          ),
        )
      }
    }

    function apply(ctx) {
      var react = require('react')
      var ui = require('@deepseek-ai/dsh-client-ui-primitives')
      ctx.effect(() => ctx.locale.register(NS, { en: en, zh: zh }), 'subagent-concurrency-limit: dictionaries')

      var form = new ui.SettingsFormModel(ctx.configForms.get(ENTRY_ID), [
        booleanField('baton'),
        nonNegativeIntegerField('lendAfterMs'),
        positiveIntegerField('maxConcurrentSubagents'),
        positiveIntegerField('queueTimeoutMs'),
        nameListField('subagentToolNames'),
        lanesField('providers'),
      ])
      var store = form.bind(() =>
        Object.assign(form.shell(), {
          baton: form.field('baton'),
          lendAfterMs: form.field('lendAfterMs'),
          maxConcurrentSubagents: form.field('maxConcurrentSubagents'),
          queueTimeoutMs: form.field('queueTimeoutMs'),
          subagentToolNames: form.field('subagentToolNames'),
          providers: form.field('providers'),
        }),
      )
      ctx.effect(() => () => form.dispose(), 'subagent-concurrency-limit: form subscription')
      var catalog = createCatalog()
      // The model catalog is optional: without it the page keeps the text editor.
      ctx.inject(['remote.session'], (scope) => {
        var generation = 0
        catalog.load = () => {
          var mine = ++generation
          catalog.set(Object.assign({}, catalog.getSnapshot(), { status: 'loading' }))
          Promise.resolve(scope.remote.session.modelCatalog())
            .then((response) => {
              if (mine !== generation) return
              if (response?.ok) {
                catalog.set({
                  status: 'ready',
                  groups: response.value.groups,
                  partial: response.value.failures.length > 0,
                })
              } else catalog.set({ status: 'error', groups: catalog.getSnapshot().groups, partial: false })
            })
            .catch(() => {
              if (mine === generation)
                catalog.set({ status: 'error', groups: catalog.getSnapshot().groups, partial: false })
            })
        }
        catalog.load()
        if (typeof scope.remote.$on === 'function') {
          scope.effect(
            () => scope.remote.$on('llm/adapters-updated', () => catalog.load()),
            'subagent-concurrency-limit: catalog refresh',
          )
        }
        scope.effect(
          () => () => {
            generation++
            catalog.load = undefined
          },
          'subagent-concurrency-limit: catalog',
        )
      })
      var Card = createCard(react, ui, store, form.actions(), catalog)

      // Registered only while the Host serves the entry, so a profile that
      // switched the bundle off shows no form.
      ctx.effect(
        () =>
          ctx.configForms.whileServed([ENTRY_ID], () =>
            ctx.slots.inject('plugins.bundle.config', () =>
              ctx.slots.register({ name: 'plugins.bundle.config', key: PACKAGE_NAME, locale: NS }, Card),
            ),
          ),
        'subagent-concurrency-limit: settings page',
      )
    }

    module.exports.apply = apply
    module.exports.inject = ['slots', 'locale', 'configForms']
    // Exposed for this repo's tests only; not part of the plugin contract.
    module.exports.__fields = {
      booleanField: booleanField,
      positiveIntegerField: positiveIntegerField,
      nonNegativeIntegerField: nonNegativeIntegerField,
      nameListField: nameListField,
      lanesField: lanesField,
    }
    module.exports.__lanes = {
      parseLanes: parseLanes,
      formatLanes: formatLanes,
      withProvider: withProvider,
      withoutProvider: withoutProvider,
      withLane: withLane,
      withLimit: withLimit,
    }
    return module.exports
  },
})
