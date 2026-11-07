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
      projectPriority: 'Same-project priority (ms)',
      projectPriorityHint:
        'When the baton is handed on, agents of the same project (working folder) go first, unless another project has waited this long. 0 is plain first come, first served.',
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
      catalogUnavailable: 'The provider list is not available here; use Edit as text.',
      refresh: 'Refresh',
      advanced: 'Edit as text',
      providersPending:
        'A change to the providers list is waiting: it applies once no agent holds or waits for a slot, so running work is never split across two lanes.',
      providersTextInvalid:
        'The provider text below has an error. Fix it under "Edit as text" to use the switches again.',
      sharedBy: 'Server for {names}',
      sharedByLocked: 'Other providers run on this server. Switch them off or point them elsewhere first.',
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
      workspacesTitle: 'Workspaces',
      workspacesIntro:
        'Pause a workspace (working folder) so another can use the model. Its agents stop before their next model request; a request or tool call already under way finishes first. Resuming puts it back in the queue behind agents already waiting. The switches apply at once, without Save.',
      pauseWorkspaceLabel: 'Pause {path}',
      statePaused: 'Paused',
      statePausing: 'Pausing',
      stateRunning: 'Running',
      stateIdle: 'Idle',
      oneAgent: '1 agent',
      manyAgents: '{n} agents',
      partHeld: '{agents} held',
      partFinishing: '{agents} finishing a step',
      partInTool: '{agents} in a tool call',
      partAwaitingAnswer: 'waiting for your answer',
      unansweredTitle: 'Unanswered questions',
      unansweredAfter: 'Pause after (ms)',
      unansweredAfterHint:
        "When an agent's question waits this long for your answer, its workspace pauses so others can use the model. Answering resumes it: it rejoins the queue behind agents already waiting. 0 turns this off. Default 1800000 (30 minutes).",
      unansweredApprovals: 'Count approval prompts too',
      unansweredApprovalsHint:
        'Also pause on a tool approval prompt that waits this long for you, not only on questions.',
      partBaton: 'holds the baton',
      partWaiting: '{agents} waiting for the baton',
      workspacesLoading: 'Loading workspaces…',
      workspacesEmpty: 'No workspaces yet. A workspace shows here once a chat in its folder has started.',
      workspacesError: 'Could not load the workspace list.',
      workspacesUnavailable: 'The workspace list is not available here.',
      pauseUnavailable:
        'Pausing is not available: the profile does not run the subagent-concurrency-pause entry. Update or reinstall the plugin so its bundle patch adds it.',
      pauseReadOnly: 'Settings are read-only in this deployment, so workspaces cannot be paused here.',
      pauseFailed: 'The change was not saved.',
      pauseWorkspace: 'Pause workspace',
      resumeWorkspace: 'Resume workspace',
      pauseWorkspaceHint: 'Pause this chat’s workspace ({path}) so another workspace can use the model.',
      resumeWorkspaceHint: '{path} is paused. Resuming puts it back in the queue.',
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
      projectPriority: '同项目优先（毫秒）',
      projectPriorityHint: '交接接力棒时，同一项目（工作目录）的代理优先，除非其他项目已等待这么久。0 表示先到先得。',
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
      catalogUnavailable: '此处无法获取提供方列表，请使用“以文本编辑”。',
      refresh: '刷新',
      advanced: '以文本编辑',
      providersPending: '提供方列表的更改正在等待：没有代理占用或等待槽位时才会生效，以免运行中的工作被拆到两道。',
      providersTextInvalid: '下方的提供方文本有误。请在“以文本编辑”中修正后再使用开关。',
      sharedBy: '{names} 的服务器',
      sharedByLocked: '其他提供方运行在此服务器上。请先关闭它们或改为其他服务器。',
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
      workspacesTitle: '工作区',
      workspacesIntro:
        '暂停一个工作区（工作目录），让其他工作区使用模型。它的代理会在下一次模型请求前停下；已在进行的请求或工具调用会先完成。恢复后它会排到已在等待的代理之后。开关立即生效，无需保存。',
      pauseWorkspaceLabel: '暂停 {path}',
      statePaused: '已暂停',
      statePausing: '正在暂停',
      stateRunning: '运行中',
      stateIdle: '空闲',
      oneAgent: '1 个代理',
      manyAgents: '{n} 个代理',
      partHeld: '{agents}已停下',
      partFinishing: '{agents}正在完成当前步骤',
      partInTool: '{agents}在工具调用中',
      partAwaitingAnswer: '等待你的回答',
      unansweredTitle: '未回答的问题',
      unansweredAfter: '暂停等待（毫秒）',
      unansweredAfterHint:
        '代理的问题等待你回答这么久后，暂停其工作区，让其他工作区使用模型。回答后恢复：它会排到已在等待的代理之后。0 表示关闭。默认 1800000（30 分钟）。',
      unansweredApprovals: '审批请求也计入',
      unansweredApprovalsHint: '工具审批请求等待你这么久时同样暂停，而不仅是问题。',
      partBaton: '持有接力棒',
      partWaiting: '{agents}在等待接力棒',
      workspacesLoading: '正在加载工作区…',
      workspacesEmpty: '暂无工作区。某个目录中的对话开始后，它的工作区会显示在这里。',
      workspacesError: '无法加载工作区列表。',
      workspacesUnavailable: '此处无法获取工作区列表。',
      pauseUnavailable:
        '无法暂停：当前配置未运行 subagent-concurrency-pause 条目。请更新或重新安装插件，由其捆绑补丁添加该条目。',
      pauseReadOnly: '此部署的设置为只读，无法在此暂停工作区。',
      pauseFailed: '更改未保存。',
      pauseWorkspace: '暂停工作区',
      resumeWorkspace: '恢复工作区',
      pauseWorkspaceHint: '暂停此对话的工作区（{path}），让其他工作区使用模型。',
      resumeWorkspaceHint: '{path} 已暂停。恢复后它会重新排队。',
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

    /** A field that takes one of a fixed set of strings. */
    function choiceField(field, choices) {
      return {
        field: field,
        format: (value) => (typeof value === 'string' ? value : ''),
        parse: (text) =>
          text === '' ? { kind: 'clear' } : choices.includes(text) ? { kind: 'set', value: text } : undefined,
      }
    }

    var LANE_KEYS = { lane: 'lane', baton: 'baton', limit: 'maxConcurrentSubagents', lend: 'lendAfterMs' }

    // Names and lane values that hold spaces or any of ; : = " are written as
    // JSON strings, so every provider id round-trips through the text form.
    function quote(text, bareOk) {
      return bareOk.test(text) ? text : JSON.stringify(text)
    }
    var BARE_NAME = /^[^\s;:="]+$/
    var BARE_VALUE = /^[^\s;"]+$/

    function formatLanes(value) {
      if (typeof value !== 'object' || value === null) return ''
      return Object.keys(value)
        .map((name) => {
          var lane = value[name] || {}
          var parts = [`${quote(name, BARE_NAME)}:`]
          if (typeof lane.lane === 'string') parts.push(`lane=${quote(lane.lane, BARE_VALUE)}`)
          if (typeof lane.baton === 'boolean') parts.push(`baton=${lane.baton ? 'on' : 'off'}`)
          if (typeof lane.maxConcurrentSubagents === 'number') parts.push(`limit=${lane.maxConcurrentSubagents}`)
          if (typeof lane.lendAfterMs === 'number') parts.push(`lend=${lane.lendAfterMs}`)
          return parts.join(' ')
        })
        .join('; ')
    }

    /** Read a JSON string starting at `start`; returns [value, next index] or undefined. */
    function readQuoted(text, start) {
      for (let i = start + 1; i < text.length; i++) {
        if (text[i] === '\\') i++
        else if (text[i] === '"') {
          try {
            const value = JSON.parse(text.slice(start, i + 1))
            return typeof value === 'string' ? [value, i + 1] : undefined
          } catch {
            return undefined
          }
        }
      }
      return undefined
    }

    function parseLanes(text) {
      const lanes = {}
      let i = 0
      const isSpace = (ch) => ch === ' ' || ch === '\t' || ch === '\r'
      const isEnd = (ch) => ch === undefined || ch === ';' || ch === '\n'
      while (i < text.length) {
        while (i < text.length && (isSpace(text[i]) || isEnd(text[i]))) i++
        if (i >= text.length) break
        // The name: a JSON string, or plain text up to ':' or the entry's end.
        let name
        if (text[i] === '"') {
          const quoted = readQuoted(text, i)
          if (quoted === undefined) return undefined
          name = quoted[0]
          i = quoted[1]
          while (isSpace(text[i])) i++
          if (text[i] !== ':' && !isEnd(text[i])) return undefined
        } else {
          const from = i
          while (!isEnd(text[i]) && text[i] !== ':') i++
          name = text.slice(from, i).trim()
        }
        if (name.length === 0 || Object.hasOwn(lanes, name)) return undefined
        if (text[i] === ':') i++
        const lane = {}
        for (;;) {
          while (isSpace(text[i])) i++
          if (isEnd(text[i])) break
          const match = /^(lane|baton|limit|lend)=/.exec(text.slice(i))
          if (match === null) return undefined
          i += match[0].length
          let raw
          if (text[i] === '"') {
            const value = readQuoted(text, i)
            if (value === undefined) return undefined
            raw = value[0]
            i = value[1]
            if (!isSpace(text[i]) && !isEnd(text[i])) return undefined
          } else {
            const begin = i
            while (!isSpace(text[i]) && !isEnd(text[i])) i++
            raw = text.slice(begin, i)
          }
          const key = LANE_KEYS[match[1]]
          if (key === 'lane') {
            if (raw.length === 0) return undefined
            lane.lane = raw
          } else if (key === 'baton') {
            if (raw !== 'on' && raw !== 'off') return undefined
            lane.baton = raw === 'on'
          } else {
            if (!/^\d+$/.test(raw)) return undefined
            const number = Number(raw)
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
          // A chain that loops would split one server into several lanes; the host refuses it too.
          if (lanes === undefined || Object.keys(lanes).some((name) => laneCycles(lanes, name))) return undefined
          return { kind: 'set', value: lanes }
        },
      }
    }

    /** Whether a provider's `lane` chain comes back to a provider already on it. */
    function laneCycles(map, id) {
      var current = id
      var seen = new Set([current])
      for (;;) {
        const entry = Object.hasOwn(map, current) ? map[current] : undefined
        const next = entry && typeof entry.lane === 'string' ? entry.lane : undefined
        if (next === undefined || next === current) return false
        if (seen.has(next)) return true
        seen.add(next)
        current = next
      }
    }

    /** The lane root a provider's baton belongs to: its `lane` chain followed to the end, as the host does. */
    function laneRoot(map, id) {
      var current = id
      var seen = new Set([current])
      for (;;) {
        const entry = Object.hasOwn(map, current) ? map[current] : undefined
        const next = entry && typeof entry.lane === 'string' ? entry.lane : undefined
        if (next === undefined || next === current || seen.has(next)) return current
        seen.add(next)
        current = next
      }
    }

    /** Providers other than `root` whose lane is `root`. */
    function followersOf(map, root) {
      return Object.keys(map).filter((name) => name !== root && laneRoot(map, name) === root)
    }

    /** A lane root's settings: its own entry, else the strictest its followers state (as the host reads them). */
    function laneEntry(map, root) {
      if (Object.hasOwn(map, root) && laneRoot(map, root) === root) return map[root]
      var merged = {}
      var followers = followersOf(map, root)
      var limits = followers.map((name) => map[name].maxConcurrentSubagents).filter((v) => typeof v === 'number')
      var lends = followers.map((name) => map[name].lendAfterMs).filter((v) => typeof v === 'number')
      var batons = followers.map((name) => map[name].baton).filter((v) => typeof v === 'boolean')
      if (limits.length > 0) merged.maxConcurrentSubagents = Math.min(...limits)
      if (lends.length > 0) merged.lendAfterMs = Math.max(...lends)
      if (batons.length > 0) merged.baton = batons.includes(true)
      return merged
    }

    function withProvider(map, id) {
      var next = Object.assign({}, map)
      if (!Object.hasOwn(next, id)) next[id] = {}
      return next
    }

    /** Turn a provider off; providers that pointed at it follow its own server, or get their own lane. */
    function withoutProvider(map, id) {
      var root = laneRoot(map, id)
      var next = {}
      for (var name of Object.keys(map)) {
        if (name === id) continue
        const entry = Object.assign({}, map[name])
        if (entry.lane === id) {
          if (root !== id) entry.lane = root
          else delete entry.lane
        }
        next[name] = entry
      }
      return next
    }

    /** Point a provider at another provider's server, or back to its own (`root` empty). */
    function withLane(map, id, root) {
      var next = withProvider(map, id)
      var entry = Object.assign({}, next[id])
      var seedRoot = false
      if (root === '' || root === id) delete entry.lane
      else {
        entry.lane = root
        // A listed or already-followed root stands as a lane as it is; a new one gets an entry.
        seedRoot = !Object.hasOwn(next, root) && followersOf(next, root).length === 0
        // Providers that shared this one's server now follow the new root.
        for (var name of Object.keys(next)) {
          if (name !== id && next[name].lane === id) next[name] = Object.assign({}, next[name], { lane: root })
        }
      }
      next[id] = entry
      // The new root's entry keeps the settings its followers gave the lane
      // (as withLimit does): an empty entry would govern the lane with the defaults.
      if (seedRoot) next[root] = laneEntry(next, root)
      return next
    }

    function withLimit(map, id, text) {
      // A lane root without its own entry gets one that keeps the settings it had.
      var seeded = Object.hasOwn(map, id) ? map[id] : laneEntry(map, id)
      var next = Object.assign({}, map, { [id]: seeded })
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
      var catalog = {
        subscribe: (listener) => {
          listeners.add(listener)
          // Load when the page is first shown, like the official pages: at
          // plugin start the connection may not be up and the call can hang.
          if (snapshot.status === 'idle' && catalog.load) catalog.load()
          return () => listeners.delete(listener)
        },
        getSnapshot: () => snapshot,
        listening: () => listeners.size > 0,
        set: (next) => {
          snapshot = next
          for (var listener of listeners) listener()
        },
        load: undefined,
      }
      return catalog
    }

    var CATALOG_TIMEOUT_MS = 15000

    function ProvidersEditor(react, ui, catalog, actions, list) {
      var h = react.createElement
      var hint = { margin: 0, fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' }
      var error = Object.assign({}, hint, { color: 'var(--dsw-alias-label-error, #d9534f)' })
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
        var pending = react.useSyncExternalStore(list.subscribe, list.getSnapshot).providersPending === true
        // Limit text the user typed that is not a valid limit, by provider, shown with an error.
        var draftState = react.useState({})
        var drafts = draftState[0]
        var setDrafts = draftState[1]
        var map = props.text.trim() === '' ? {} : parseLanes(props.text)
        var pendingNote = pending ? h('p', { style: hint }, t('providersPending')) : null
        // The text has an error: the switches would discard it, so point at the text box instead.
        if (map === undefined) return h('div', null, pendingNote, h('p', { style: error }, t('providersTextInvalid')))
        var names = new Map()
        for (var group of listing.groups) names.set(group.id, group.name || group.id)
        var ids = [...names.keys()]
        for (var id of Object.keys(map)) if (!names.has(id)) ids.push(id)
        // A lane root nobody lists still stands for a server: show it.
        for (var name of Object.keys(map)) {
          const root = laneRoot(map, name)
          if (!ids.includes(root)) ids.push(root)
        }
        var write = (next) => {
          if (next !== undefined) actions.edit('providers', formatLanes(next))
        }
        var setDraft = (providerId, text) => {
          var next = Object.assign({}, drafts)
          if (text === undefined) delete next[providerId]
          else next[providerId] = text
          setDrafts(next)
        }
        // A change of server drops the rejected drafts of the rows it touches, the lane roots included:
        // a root row has no input of its own, so its rejected text would come back on a lane it no longer governs.
        var moveWrite = (providerId, next) => {
          var touched = new Set([providerId])
          for (var name of new Set([...Object.keys(map), ...Object.keys(next)])) {
            const before = laneRoot(map, name)
            const after = laneRoot(next, name)
            if (before !== after) {
              touched.add(name)
              touched.add(before)
              touched.add(after)
            }
          }
          var kept = Object.assign({}, drafts)
          var changed = false
          for (var key of touched) {
            if (Object.hasOwn(kept, key)) {
              delete kept[key]
              changed = true
            }
          }
          if (changed) setDrafts(kept)
          write(next)
        }

        var status = null
        // Without a model catalog (no remote, or it went away mid-request)
        // nothing will ever load: say so instead of "Loading…" forever.
        if (!catalog.load && (listing.status === 'loading' || listing.status === 'idle'))
          status = h('p', { style: hint }, t('catalogUnavailable'))
        else if (listing.status === 'loading' || listing.status === 'idle')
          status = h(
            'p',
            { style: hint },
            `${t('catalogLoading')} `,
            catalog.load ? h('button', { type: 'button', style: link, onClick: catalog.load }, t('refresh')) : null,
          )
        else if (listing.status === 'error')
          status = h(
            'p',
            { style: hint },
            `${t('catalogError')} `,
            catalog.load ? h('button', { type: 'button', style: link, onClick: catalog.load }, t('refresh')) : null,
            listing.message ? h('span', { style: { display: 'block' } }, listing.message) : null,
          )
        else if (listing.partial) status = h('p', { style: hint }, t('catalogPartial'))

        var nameOf = (providerId) => names.get(providerId) || providerId

        return h(
          'div',
          null,
          h('p', { style: hint }, t('providersIntro')),
          pendingNote,
          status,
          ids.map((id) => {
            var followers = followersOf(map, id)
            var isRoot = laneRoot(map, id) === id
            // Limited when listed, or when another provider uses it as its server.
            var on = Object.hasOwn(map, id) || (isRoot && followers.length > 0)
            var entry = isRoot ? laneEntry(map, id) : map[id] || {}
            var roots = ids.filter(
              (other) =>
                other !== id &&
                laneRoot(map, other) === other &&
                (Object.hasOwn(map, other) || followersOf(map, other).length > 0) &&
                // Never offer a provider that runs on this one's server.
                !followersOf(map, id).includes(other),
            )
            var label = names.has(id) ? names.get(id) : `${id} (${t('notInCatalog')})`
            var draft = Object.hasOwn(drafts, id) ? drafts[id] : undefined
            return h(
              'div',
              { key: id, style: row },
              h(
                'div',
                { style: { minWidth: 0 } },
                h('div', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-primary)' } }, label),
                label !== id ? h('div', { style: hint }, id) : null,
                // Switching off a server others run on would silently split them off: say why it is locked.
                isRoot && followers.length > 0
                  ? h('div', { style: hint }, t('sharedBy', { names: followers.map(nameOf).join(', ') }))
                  : null,
              ),
              h(ui.Switch, {
                checked: on,
                label: `${t('limitProvider')} ${label}`,
                disabled: props.disabled || (isRoot && followers.length > 0),
                title: isRoot && followers.length > 0 ? t('sharedByLocked') : undefined,
                onChange: (next) => moveWrite(id, next ? withProvider(map, id) : withoutProvider(map, id)),
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
                          value: isRoot ? '' : laneRoot(map, id),
                          onChange: (event) => moveWrite(id, withLane(map, id, event.target.value)),
                        },
                        h('option', { value: '' }, t('ownServer')),
                        roots.map((other) => h('option', { key: other, value: other }, nameOf(other))),
                      ),
                    ),
                    isRoot
                      ? h(
                          'label',
                          null,
                          `${t('providerLimit')} `,
                          h('input', {
                            style: Object.assign({}, control, { width: '64px' }),
                            inputMode: 'numeric',
                            disabled: props.disabled,
                            placeholder: t('providerLimitDefault'),
                            'aria-invalid': draft !== undefined,
                            value:
                              draft !== undefined
                                ? draft
                                : typeof entry.maxConcurrentSubagents === 'number'
                                  ? String(entry.maxConcurrentSubagents)
                                  : '',
                            onChange: (event) => {
                              var next = withLimit(map, id, event.target.value)
                              if (next === undefined) setDraft(id, event.target.value)
                              else {
                                setDraft(id, undefined)
                                write(next)
                              }
                            },
                          }),
                          draft !== undefined ? h('span', { style: error }, ` ${t('invalidInteger')}`) : null,
                        )
                      : null,
                  )
                : null,
            )
          }),
        )
      }
    }

    // ---- Workspaces: pause one so another can use the model ----

    // The pause row's profile entry id and settings namespace. Keeping the
    // paused list there means an instant pause never moves the main entry's
    // revision, so it cannot invalidate unsaved edits on the main form.
    var PAUSE_ENTRY_ID = 'subagent-concurrency-pause'
    // The host half's read-only route (CHANNEL in src/index.ts).
    var CHANNEL = '/subagent-concurrency-limit'
    var WORKSPACES_REFRESH_MS = 3000
    var ROUTE_TIMEOUT_MS = 15000
    var LOOKUP_RETRY_MS = 5000
    var WRITE_RETRY_MS = 1000

    /** A folder's workspace key, matched the way the host half matches it. */
    function projectKey(path) {
      return String(path).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    }

    /** The paused folders in a pause-form snapshot. */
    function pausedList(snapshot) {
      var value = snapshot ? snapshot.value : undefined
      var list = value ? value.pausedWorkspaces : undefined
      return Array.isArray(list) ? list.filter((path) => typeof path === 'string' && path.length > 0) : []
    }

    /** The paused list with `path`'s workspace added or removed; undefined when nothing changes. */
    function withPaused(list, path, paused) {
      var key = projectKey(path)
      var listed = list.some((entry) => projectKey(entry) === key)
      if (paused) return listed ? undefined : list.concat([path])
      return listed ? list.filter((entry) => projectKey(entry) !== key) : undefined
    }

    /** The host route, callable while the connection service is up. */
    function createRoute() {
      var listeners = new Set()
      var route = {
        call: undefined,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        set: (call) => {
          route.call = call
          for (var listener of listeners) listener()
        },
        /** @returns the endpoint's result, or undefined without a connection; rejects on transport failure. */
        request: (endpoint, payload) => {
          var call = route.call
          if (call === undefined) return Promise.resolve(undefined)
          var timer
          var timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('the workspace route timed out')), ROUTE_TIMEOUT_MS)
          })
          return Promise.race([Promise.resolve().then(() => call(endpoint, payload)), timeout]).finally(() =>
            clearTimeout(timer),
          )
        },
      }
      return route
    }

    /** The route's workspace list, refreshed while the settings page shows it. */
    function createWorkspaceList(route) {
      var listeners = new Set()
      var snapshot = { status: 'idle', rows: [], message: '' }
      var timer
      var generation = 0
      var set = (next) => {
        snapshot = next
        for (var listener of listeners) listener()
      }
      var stop = () => {
        clearTimeout(timer)
        timer = undefined
      }
      var list = {
        subscribe: (listener) => {
          listeners.add(listener)
          if (listeners.size === 1) list.refresh()
          return () => {
            listeners.delete(listener)
            if (listeners.size === 0) {
              generation++
              stop()
            }
          }
        },
        getSnapshot: () => snapshot,
        listening: () => listeners.size > 0,
        refresh: () => {
          var mine = ++generation
          stop()
          // Each state keeps the last rows and pending note until a reply replaces them.
          var kept = { rows: snapshot.rows, providersPending: snapshot.providersPending === true }
          if (route.call === undefined) {
            set(Object.assign({ status: 'unavailable', message: '' }, kept))
            return
          }
          if (snapshot.status !== 'ready' && snapshot.status !== 'loading')
            set(Object.assign({ status: 'loading', message: '' }, kept))
          var settle = (next) => {
            if (mine !== generation) return
            set(next)
            if (listeners.size > 0) timer = setTimeout(list.refresh, WORKSPACES_REFRESH_MS)
          }
          route.request('workspaces', {}).then(
            (result) => {
              var value = result?.ok ? result.value : undefined
              if (value && Array.isArray(value.workspaces))
                settle({
                  status: 'ready',
                  rows: value.workspaces,
                  message: '',
                  providersPending: value.providersPending === true,
                })
              else
                settle(
                  Object.assign(
                    { status: 'error', message: String(result?.error?.message ?? result?.error ?? '') },
                    kept,
                  ),
                )
            },
            (error) => settle(Object.assign({ status: 'error', message: String(error?.message ?? error) }, kept)),
          )
        },
      }
      route.subscribe(() => {
        if (listeners.size > 0) list.refresh()
      })
      return list
    }

    /**
     * Pause and resume through the pause row's settings entry. Changes run one
     * at a time, each computing its list from the one the previous change
     * left, and a change the Host refused is retried once after its recovery
     * read. Until a change settles, its workspace shows the state it asked for.
     */
    function createPauseControl(form, onSettled) {
      var listeners = new Set()
      var pending = new Map()
      var failed = new Set()
      var tail = Promise.resolve()
      var serial = 0
      var version = 0
      var memo
      var notify = () => {
        version++
        for (var listener of listeners) listener()
      }
      var write = (path, paused, retried) => {
        var current = form.getSnapshot()
        if (current.status !== 'ready' || !current.writable) return Promise.resolve(false)
        var next = withPaused(pausedList(current), path, paused)
        if (next === undefined) return Promise.resolve(true)
        return form.set('pausedWorkspaces', next).then(
          (ok) => (ok || retried ? ok : write(path, paused, true)),
          // A transport failure gets no recovery read from the form: wait a moment and try once more.
          (error) =>
            retried
              ? Promise.reject(error)
              : new Promise((resolve) => setTimeout(resolve, WRITE_RETRY_MS)).then(() => write(path, paused, true)),
        )
      }
      var control = {
        subscribe: (listener) => {
          listeners.add(listener)
          var off = form.subscribe(listener)
          return () => {
            listeners.delete(listener)
            off()
          }
        },
        getSnapshot: () => {
          var current = form.getSnapshot()
          if (memo === undefined || memo.form !== current || memo.version !== version) {
            const paused = pausedList(current)
            const asked = new Map()
            for (const [key, change] of pending) asked.set(key, change.paused)
            memo = {
              form: current,
              version: version,
              writable: current.status === 'ready' && current.writable === true,
              paused: paused,
              keys: new Set(paused.map(projectKey)),
              pending: asked,
              failed: new Set(failed),
            }
          }
          return memo
        },
        /** Whether a workspace is paused, counting a change still on its way. */
        isPaused: (snapshot, key) => (snapshot.pending.has(key) ? snapshot.pending.get(key) : snapshot.keys.has(key)),
        toggle: (path, paused) => {
          var key = projectKey(path)
          var mine = ++serial
          pending.set(key, { paused: paused, serial: mine })
          failed.delete(key)
          notify()
          var run = tail.then(() => write(path, paused, false))
          tail = run.then(
            () => undefined,
            () => undefined,
          )
          return run
            .catch(() => false)
            .then((ok) => {
              if (pending.get(key)?.serial === mine) pending.delete(key)
              if (!ok) failed.add(key)
              notify()
              if (onSettled) onSettled()
              return ok
            })
        },
      }
      return control
    }

    /** Each chat's workspace, looked up once through the route. */
    function createWorkspaceLookup(route) {
      var listeners = new Set()
      var found = new Map()
      var retries = new Map()
      var set = (sessionId, entry) => {
        found = new Map(found)
        found.set(sessionId, entry)
        for (var listener of listeners) listener()
      }
      var stopRetries = () => {
        for (var timer of retries.values()) clearTimeout(timer)
        retries.clear()
      }
      // How many mounted composers show each chat; only those are asked about again.
      var watched = new Map()
      var askLater = (sessionId, delay) => {
        retries.set(
          sessionId,
          setTimeout(() => {
            retries.delete(sessionId)
            if (listeners.size > 0 && watched.has(sessionId)) lookup.want(sessionId, true)
          }, delay),
        )
      }
      var lookup = {
        subscribe: (listener) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
            if (listeners.size === 0) stopRetries()
          }
        },
        getSnapshot: () => found,
        /** A composer shows this chat: look it up, and keep asking while it is unknown. */
        watch: (sessionId) => {
          watched.set(sessionId, (watched.get(sessionId) ?? 0) + 1)
          lookup.want(sessionId)
          return () => {
            const left = (watched.get(sessionId) ?? 1) - 1
            if (left > 0) watched.set(sessionId, left)
            else {
              watched.delete(sessionId)
              clearTimeout(retries.get(sessionId))
              retries.delete(sessionId)
            }
          }
        },
        want: (sessionId, retry) => {
          if (typeof sessionId !== 'string' || sessionId.length === 0 || route.call === undefined) return
          var known = found.get(sessionId)
          if (known !== undefined && known.status !== 'missing') return
          if (known !== undefined && !retry && Date.now() - known.at < LOOKUP_RETRY_MS) {
            // Still cooling down after a miss: ask again when the cooldown ends, as a composer may still show it.
            if (listeners.size > 0 && watched.has(sessionId) && !retries.has(sessionId))
              askLater(sessionId, LOOKUP_RETRY_MS - (Date.now() - known.at))
            return
          }
          clearTimeout(retries.get(sessionId))
          retries.delete(sessionId)
          set(sessionId, { status: 'loading' })
          // Ask again later while a composer shows, without waiting for a re-render.
          var missing = () => {
            set(sessionId, { status: 'missing', at: Date.now() })
            if (listeners.size === 0 || !watched.has(sessionId)) return
            askLater(sessionId, LOOKUP_RETRY_MS)
          }
          route.request('workspaceOf', { sessionId: sessionId }).then((result) => {
            var value = result?.ok ? result.value : undefined
            if (value && typeof value.key === 'string' && typeof value.path === 'string')
              set(sessionId, { status: 'ready', workspace: { key: value.key, path: value.path } })
            else missing()
          }, missing)
        },
      }
      // A lookup skipped or retried while the route was down asks again once it is back.
      route.subscribe(() => {
        if (route.call === undefined) return
        for (var sessionId of watched.keys()) lookup.want(sessionId, true)
      })
      return lookup
    }

    /** The settings page's workspaces: the route's list plus paused folders it has not reported. */
    function mergeWorkspaces(rows, paused) {
      var byKey = new Map()
      for (var row of rows) {
        if (row && typeof row.key === 'string' && typeof row.path === 'string') byKey.set(row.key, row)
      }
      for (var path of paused) {
        const key = projectKey(path)
        if (!byKey.has(key))
          byKey.set(key, { key: key, path: path, running: 0, held: 0, inTool: 0, waiting: 0, holdsBaton: false })
      }
      return [...byKey.values()].sort((a, b) => a.path.localeCompare(b.path))
    }

    function agentCount(t, n) {
      return n === 1 ? t('oneAgent') : t('manyAgents', { n: n })
    }

    /** The line under a workspace: what its agents are doing. */
    function workspaceStatus(t, row, paused) {
      var running = row.running || 0
      var held = row.held || 0
      var waiting = row.waiting || 0
      var inTool = row.inTool || 0
      var parts = []
      if (row.awaitingAnswer === true) paused = true
      if (paused) {
        // Stopped: held at the gate, or queued for the baton (they cannot get
        // it while paused). In a tool: a running tool, or a parent waiting on
        // a paused subagent. Only the rest are still generating a step.
        const stopped = held + waiting
        const finishing = Math.max(0, running - stopped - inTool)
        parts.push(finishing > 0 ? t('statePausing') : t('statePaused'))
        if (stopped > 0) parts.push(t('partHeld', { agents: agentCount(t, stopped) }))
        if (inTool > 0) parts.push(t('partInTool', { agents: agentCount(t, inTool) }))
        if (finishing > 0) parts.push(t('partFinishing', { agents: agentCount(t, finishing) }))
        if (row.awaitingAnswer === true) parts.push(t('partAwaitingAnswer'))
      } else {
        parts.push(running > 0 || row.holdsBaton || waiting > 0 ? t('stateRunning') : t('stateIdle'))
        if (running > 0) parts.push(agentCount(t, running))
        if (row.holdsBaton) parts.push(t('partBaton'))
        if (waiting > 0) parts.push(t('partWaiting', { agents: agentCount(t, waiting) }))
      }
      return parts.join(' · ')
    }

    function WorkspacesEditor(react, ui, list, control) {
      var h = react.createElement
      var hint = { margin: 0, fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' }
      var row = {
        display: 'grid',
        gridTemplateColumns: 'minmax(0,1fr) auto',
        gap: '4px 16px',
        alignItems: 'center',
        padding: '10px 0',
        borderTop: '0.5px solid var(--dsw-alias-border-l3)',
      }
      var path = { fontSize: '13px', color: 'var(--dsw-alias-label-primary)', overflowWrap: 'anywhere' }
      var error = Object.assign({}, hint, { color: 'var(--dsw-alias-label-error, #d9534f)' })
      var link = {
        background: 'none',
        border: 0,
        padding: 0,
        cursor: 'pointer',
        fontSize: '12px',
        color: 'var(--dsw-alias-brand-primary)',
      }

      return function Workspaces(props) {
        var t = props.t
        var listing = react.useSyncExternalStore(list.subscribe, list.getSnapshot)
        var pause = react.useSyncExternalStore(control.subscribe, control.getSnapshot)
        var form = pause.form
        var rows = mergeWorkspaces(listing.rows, pause.paused)

        var notice = null
        if (form.mode === 'memory' || (form.status === 'ready' && !form.writable))
          notice = h('p', { style: hint }, t('pauseReadOnly'))
        else if (form.status === 'unavailable') notice = h('p', { style: hint }, t('pauseUnavailable'))

        var status = null
        if (listing.status === 'unavailable') status = h('p', { style: hint }, t('workspacesUnavailable'))
        else if (listing.status === 'error')
          status = h(
            'p',
            { style: hint },
            `${t('workspacesError')} `,
            h('button', { type: 'button', style: link, onClick: list.refresh }, t('refresh')),
            listing.message ? h('span', { style: { display: 'block' } }, listing.message) : null,
          )
        else if (rows.length === 0)
          status = h('p', { style: hint }, listing.status === 'ready' ? t('workspacesEmpty') : t('workspacesLoading'))

        return h(
          'div',
          null,
          h('p', { style: hint }, t('workspacesIntro')),
          notice,
          status,
          rows.map((entry) => {
            var paused = control.isPaused(pause, entry.key)
            return h(
              'div',
              { key: entry.key, style: row },
              h(
                'div',
                { style: { minWidth: 0 } },
                h('div', { style: path }, entry.path),
                h('div', { style: hint }, workspaceStatus(t, entry, paused)),
                pause.failed.has(entry.key) ? h('div', { style: error }, t('pauseFailed')) : null,
              ),
              h(ui.Switch, {
                checked: paused,
                label: t('pauseWorkspaceLabel', { path: entry.path }),
                disabled: !pause.writable || pause.pending.has(entry.key),
                onChange: (next) => control.toggle(entry.path, next),
              }),
            )
          }),
        )
      }
    }

    function PauseIcon(h, paused) {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 12, height: 12, fill: 'currentColor', 'aria-hidden': 'true' },
        paused
          ? h('path', { d: 'M4.5 3.2v9.6a.6.6 0 0 0 .9.5l7.6-4.8a.6.6 0 0 0 0-1L5.4 2.7a.6.6 0 0 0-.9.5z' })
          : h('path', { d: 'M4.5 3h2v10h-2zM9.5 3h2v10h-2z' }),
      )
    }

    /** The composer's "Pause workspace / Resume workspace" button for the open chat. */
    function ComposerPause(react, lookup, control) {
      var h = react.createElement
      var wrap = { display: 'inline-flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' }
      var button = {
        cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '6px',
        padding: '1px 8px',
        fontSize: '12px',
        lineHeight: '18px',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
      }
      var idle = Object.assign({}, button, { background: 'transparent', color: 'var(--dsw-alias-label-secondary)' })
      var active = Object.assign({}, button, {
        background: 'var(--dsw-alias-state-business-primary)',
        color: 'var(--dsw-alias-label-primary-inverted)',
      })
      var error = { fontSize: '12px', color: 'var(--dsw-alias-label-error, #d9534f)' }

      return function SubagentConcurrencyPauseButton(props) {
        var t = props.t
        var sessionId = props.sessionId
        var found = react.useSyncExternalStore(lookup.subscribe, lookup.getSnapshot)
        var pause = react.useSyncExternalStore(control.subscribe, control.getSnapshot)
        // Per chat: switching chats stops the retries for the one left.
        react.useEffect(() => lookup.watch(sessionId), [sessionId])
        var workspace = found.get(sessionId)?.workspace
        if (workspace === undefined || !pause.writable) return null
        var paused = control.isPaused(pause, workspace.key)
        return h(
          'span',
          { style: wrap },
          h(
            'button',
            {
              type: 'button',
              'aria-pressed': paused,
              title: t(paused ? 'resumeWorkspaceHint' : 'pauseWorkspaceHint', { path: workspace.path }),
              disabled: pause.pending.has(workspace.key),
              style: paused ? active : idle,
              onClick: () => control.toggle(workspace.path, !paused),
            },
            PauseIcon(h, paused),
            t(paused ? 'resumeWorkspace' : 'pauseWorkspace'),
          ),
          pause.failed.has(workspace.key) ? h('span', { style: error }, t('pauseFailed')) : null,
        )
      }
    }

    function createCard(react, ui, store, actions, catalog, Workspaces, list) {
      var Providers = ProvidersEditor(react, ui, catalog, actions, list)
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
          // Pausing writes its own entry at once; it is not part of this form's Save.
          h('section', { style: section }, h('h3', { style: heading }, t('workspacesTitle')), h(Workspaces, { t: t })),
          h(
            'section',
            { style: section },
            h('h3', { style: heading }, t('unansweredTitle')),
            valueField(
              'unanswered',
              'pauseUnansweredAfterMs',
              'unansweredAfter',
              'unansweredAfterHint',
              'invalidNonNegative',
              true,
            ),
            h(
              'div',
              { style: row },
              h('span', null, t('unansweredApprovals')),
              h(ui.Switch, {
                checked: state.pauseUnansweredOn.text === 'questions-and-approvals',
                label: t('unansweredApprovals'),
                disabled: disabled,
                onChange: (next) => actions.edit('pauseUnansweredOn', next ? 'questions-and-approvals' : 'questions'),
              }),
            ),
            h('p', { style: hint }, t('unansweredApprovalsHint')),
          ),
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
            valueField(
              'project',
              'projectPriorityMs',
              'projectPriority',
              'projectPriorityHint',
              'invalidNonNegative',
              true,
            ),
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
        nonNegativeIntegerField('projectPriorityMs'),
        nonNegativeIntegerField('pauseUnansweredAfterMs'),
        choiceField('pauseUnansweredOn', ['questions', 'questions-and-approvals']),
        positiveIntegerField('maxConcurrentSubagents'),
        positiveIntegerField('queueTimeoutMs'),
        nameListField('subagentToolNames'),
        lanesField('providers'),
      ])
      var store = form.bind(() =>
        Object.assign(form.shell(), {
          baton: form.field('baton'),
          lendAfterMs: form.field('lendAfterMs'),
          projectPriorityMs: form.field('projectPriorityMs'),
          pauseUnansweredAfterMs: form.field('pauseUnansweredAfterMs'),
          pauseUnansweredOn: form.field('pauseUnansweredOn'),
          maxConcurrentSubagents: form.field('maxConcurrentSubagents'),
          queueTimeoutMs: form.field('queueTimeoutMs'),
          subagentToolNames: form.field('subagentToolNames'),
          providers: form.field('providers'),
        }),
      )
      ctx.effect(() => () => form.dispose(), 'subagent-concurrency-limit: form subscription')
      var catalog = createCatalog()
      // The model catalog is optional: without it the page keeps the text editor.
      ctx.inject(['remote', 'remote.session'], (scope) => {
        var generation = 0
        catalog.load = () => {
          var mine = ++generation
          catalog.set(Object.assign({}, catalog.getSnapshot(), { status: 'loading' }))
          var timer
          var timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('model catalog timed out')), CATALOG_TIMEOUT_MS)
          })
          Promise.race([Promise.resolve().then(() => scope.remote.session.modelCatalog()), timeout])
            .finally(() => clearTimeout(timer))
            .then((response) => {
              if (mine !== generation) return
              if (response?.ok) {
                catalog.set({
                  status: 'ready',
                  groups: response.value.groups,
                  partial: response.value.failures.length > 0,
                })
              } else
                catalog.set({
                  status: 'error',
                  groups: catalog.getSnapshot().groups,
                  partial: false,
                  message: String(response?.error?.message ?? response?.error ?? ''),
                })
            })
            .catch((error) => {
              if (mine === generation)
                catalog.set({
                  status: 'error',
                  groups: catalog.getSnapshot().groups,
                  partial: false,
                  message: String(error?.message ?? error),
                })
            })
        }
        // Already on screen: load now; otherwise the first subscribe loads.
        if (catalog.getSnapshot().status !== 'idle' || catalog.listening()) catalog.load()
        if (typeof scope.on === 'function') {
          scope.effect(
            () =>
              scope.on('connection/reset', () => {
                catalog.set({ status: 'idle', groups: catalog.getSnapshot().groups, partial: false })
                catalog.load()
              }),
            'subagent-concurrency-limit: catalog after reconnect',
          )
        }
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
            // A request in flight is abandoned: go back to idle, so the next
            // remote loads on its own, and re-render to show the state.
            var snapshot = catalog.getSnapshot()
            catalog.set(
              Object.assign({}, snapshot, { status: snapshot.status === 'loading' ? 'idle' : snapshot.status }),
            )
          },
          'subagent-concurrency-limit: catalog',
        )
      })
      var route = createRoute()
      var list = createWorkspaceList(route)
      var control = createPauseControl(ctx.configForms.get(PAUSE_ENTRY_ID), () => {
        if (list.listening()) list.refresh()
      })
      var lookup = createWorkspaceLookup(route)
      // The workspace route rides the connection; without it the page lists
      // only the paused folders and the composer shows no button.
      ctx.inject(['connection'], (scope) => {
        route.set((endpoint, payload) => scope.connection.rpc.call(CHANNEL, endpoint, payload))
        scope.effect(() => () => route.set(undefined), 'subagent-concurrency-limit: workspace route')
      })
      var Card = createCard(react, ui, store, form.actions(), catalog, WorkspacesEditor(react, ui, list, control), list)

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
      var ComposerButton = ComposerPause(react, lookup, control)
      ctx.effect(
        () =>
          ctx.configForms.whileServed([PAUSE_ENTRY_ID], () =>
            ctx.slots.inject('conversation.input.right', () =>
              ctx.slots.register(
                { name: 'conversation.input.right', id: 'subagent-concurrency-pause', order: 31, locale: NS },
                ComposerButton,
              ),
            ),
          ),
        'subagent-concurrency-limit: composer pause button',
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
      choiceField: choiceField,
    }
    module.exports.__workspaces = {
      projectKey: projectKey,
      withPaused: withPaused,
      mergeWorkspaces: mergeWorkspaces,
      workspaceStatus: workspaceStatus,
      createPauseControl: createPauseControl,
      createRoute: createRoute,
      createWorkspaceList: createWorkspaceList,
      createWorkspaceLookup: createWorkspaceLookup,
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
