# dsh-subagent-concurrency-limit

Limit how many DeepSeek Harness subagent runs and local child-agent turns run at
the same time in one process. The root Agent is not counted.

This fork adds [baton mode](#baton-mode-single-slot-servers), on by default in
the bundled patch: only one Agent, the root included, generates at a time.

## Why it is needed

In [DeepSeek Harness][dsh-repository] `dsh-v0.1.1-rc.2` (commit
[`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`][dsh-commit]), the workflow
engine's [`maxConcurrentAgents` and `maxTotalAgents`][dsh-workflow] apply to
`agent()` calls inside each workflow run. The standard
[`subagent` tool][dsh-subagent] has no process-wide limit for root-level direct
runs outside a workflow. [`maxParallelToolCalls`][dsh-tool-calls] limits the
dispatch pool for parallel-safe tool calls in one Agent step, not the number of
background or continuable runs.

This plugin fills that gap by limiting concurrent root delegation admissions and
local descendant Agent turns in one process.

## Scope

The plugin limits the delegation tools listed in `subagentToolNames` and local
Agent turns in the same process where `delegationDepthOf(agent) > 0`. They share
one process-local pool. The default limit is `2`.

- A root Agent's delegation call waits in FIFO order before creating a child.
- Add nonstandard delegation tool names to `subagentToolNames`.
- Nested children that call the same delegation tool also consume the pool. If a
  permit is available, they take it immediately; when the pool is full, they
  fail without waiting so a child cannot block the ancestor that is waiting for
  it.
- Workflow `agent()` calls and resumed local child turns use the same pool when
  their Agent turn starts.
- A permit is released when the child turn becomes idle, the run ends, or the
  Agent is disposed.
- Pool waits are bounded: a root delegation call or a resumed local child turn
  that has been queued for `queueTimeoutMs` (default 300000, five minutes) fails
  with a clear error instead of waiting forever.
- A locally published child whose reservation was lost (for example a
  background job that published outside the delegating call's async context)
  never queues: it takes a permit immediately when one is free and fails loudly
  when the pool is full, so it cannot block the ancestor that is waiting for
  it.
- For remote-process providers such as Codex, Claude Code, and ACP, only the
  configured root delegation admission and the observable `subagent/start` and
  `subagent/end` boundaries are visible. Nested execution and restarts inside
  the remote process cannot be counted.
- `maxParallelToolCalls` is independent because it limits tool calls, not live
  runs.

## Baton mode (single-slot servers)

With `baton: true`, at most one Agent, the root included, may start a step at
a time. Use it with a single-slot local server (for example llama.cpp with
`-np 1`) so agents do not interleave and evict each other's prompt cache.

- The agent holding the baton keeps it across its steps until it goes idle.
- A delegation that publishes a local child passes the baton to the child and
  pauses the parent. The parent's next step waits until the child goes idle,
  its run ends, or it is disposed.
- Children delegated by a paused parent run one at a time in order, and the
  parent resumes after the last one.
- Nested subagents work: the deepest active agent runs, and each ancestor
  resumes in turn as its children finish. Paused ancestors never borrow the
  baton from a descendant.
- While the holder is inside a tool call it is not generating, so another
  agent may borrow the baton:
  - its own descendants at once, which prevents a deadlock when a parent
    waits on a child (including one the plugin cannot link to it, such as a
    workflow `agent()` call);
  - anyone else only after the holder has spent `lendAfterMs` (default
    30000) in tools. Short tool calls keep the baton, and the prompt cache,
    with the agent that made them; a long one lets others use the idle slot.
    `0` lends on every tool call.
- Baton waits have no timeout; they end on the turn's abort signal.
- The pool still queues root delegations, but a nested delegation that finds
  the pool full is admitted over the limit instead of failing: it cannot
  generate alongside anyone. Child turns are never refused or queued on the
  pool either. With the baton off, nested calls still fail fast.
- dsh's own `maxActiveSubagents` (default 8) still applies: idle continuable
  children count toward it until they are closed.
- Every wait timeout is capped at 2147483647 ms (about 24.8 days), the
  longest timer Node supports.

```yaml
config:
  baton: true
  maxConcurrentSubagents: 4
```

## Install (this fork)

This fork is not on npm. Push it to your GitHub account and install it from
there. These examples use the `web` profile; replace `web` with your profile
name, and `<owner>`/`<commit>` with your fork and the commit to install.

```sh
dsh plugin --profile web add github:<owner>/dsh-subagent-concurrency-limit#<commit>
```

`lib/` is not committed, so a git install builds it with the package's
`prepare` script. pnpm 10 and later block that build until it is allowed. If
the install stops, add the revision-specific key to
`$DSH_HOME/profiles/web/pnpm-workspace.yaml` (keep existing entries), then rerun
the install:

```yaml
allowBuilds:
  'dsh-subagent-concurrency-limit@https://codeload.github.com/<owner>/dsh-subagent-concurrency-limit/tar.gz/<commit>': true
```

Check that `dsh-subagent-concurrency-limit` is listed under
`dsh.profile.bundles` in `$DSH_HOME/profiles/web/package.json`. Only bundles in
that list load, and the bundle brings its own `cordis.patch.yml`.

### Do I need a profile cordis patch?

No. The fork's bundled patch inserts the plugin with baton mode on:

```yaml
baton: true
maxConcurrentSubagents: 4
subagentToolNames:
  - subagent
```

To change a value, use the settings page (below) or edit the profile patch by
hand. Either way the change lands in `$DSH_HOME/profiles/web/cordis.patch.yml`,
which is applied after every bundle layer and targets the plugin by id:

```yaml
- id: subagent-concurrency-limit
  config:
    baton: true
    maxConcurrentSubagents: 4
    queueTimeoutMs: 300000
    subagentToolNames:
      - subagent
```

Set `baton: false` to get upstream behaviour (root not counted, only the pool
limit).

### Settings page

Every option is a volatile Config field, so it appears on the web client's
**Plugins** page: open the bundle **dsh-subagent-concurrency-limit** to get a
form with the baton switch, the lend delay, the concurrency limit, the queue
timeout and the delegation tool names. **Save** validates against the plugin's schema and
writes the profile patch.

Changes apply live, without restarting the profile:

- A raised limit admits queued calls on the next agent activity (a step or a
  tool call); a lowered one admits no new work until enough has finished.
- Switching the baton off lets every agent waiting for it continue. Switching
  it on starts fresh: the next agent to step takes the baton.
- New delegation tool names count from the next call.

The page needs the web client (`@deepseek-ai/dsh-web-app`); headless profiles
still read the same fields from the patch.

`maxConcurrentSubagents` must be a positive safe integer.
`queueTimeoutMs` must be a positive safe integer; the default is 300000 (five
minutes), which bounds every pool wait.
`subagentToolNames` must contain at least one nonempty delegation tool name.
`baton` must be a boolean; the code default is `false`, the bundled patch sets
`true`.
`lendAfterMs` must be a non-negative safe integer; the default is 30000.

For a single-slot server also start it so requests queue instead of splitting
the slot, for example llama.cpp with `-np 1`.

Start the profile:

```sh
dsh --profile web
```

## Update

Rerun the install command with the new commit hash (and its new
`allowBuilds` key).

Restart the profile after updating.

## Development

```sh
pnpm install
pnpm run check
```

To inspect the package before publishing:

```sh
npm pack --dry-run
```

`prepare` builds `lib/` when packing or publishing. `npm publish` runs the
checks through `prepublishOnly` before publishing to npm.

## License

The project is licensed under [MIT](LICENSE).

[dsh-repository]: https://github.com/deepseek-ai/deepseek-harness
[dsh-commit]: https://github.com/deepseek-ai/deepseek-harness/tree/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e
[dsh-workflow]: https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/workflow/workflow-worker-thread/src/index.ts
[dsh-subagent]: https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/subagent/tool-subagent/src/index.ts
[dsh-tool-calls]: https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/agent-loop/src/tool-calls.ts

## Harness compatibility

This version targets DeepSeek Harness `0.2.0-rc.2`.
