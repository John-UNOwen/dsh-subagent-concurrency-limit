# dsh-subagent-concurrency-limit

Limit how many DeepSeek Harness subagent runs and local child-agent turns run at
the same time in one process. The root Agent is not counted.

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
  parent resumes after the last one. A nested delegation runs before the
  child that made it continues.
- While the holder is inside a tool call it is not generating, so a waiting
  agent may borrow the baton. This prevents a deadlock when a parent waits on
  a child the plugin cannot link to it (for example a workflow `agent()` call).
- Baton waits have no timeout; they end on the turn's abort signal.
- The pool still limits live runs. Raise `maxConcurrentSubagents` above `1` if
  nested delegation should be admitted instead of failing fast; the baton
  still lets only one of them generate.

```yaml
config:
  baton: true
  maxConcurrentSubagents: 4
```

## Install

These examples use the `web` profile. Replace `web` with your profile name in
each command and path.

Install the plugin:

```sh
dsh plugin --profile web add dsh-subagent-concurrency-limit
```

Add the plugin configuration to
`$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- id: subagent-concurrency-limit
  name: dsh-subagent-concurrency-limit
  config:
    maxConcurrentSubagents: 2
    queueTimeoutMs: 300000
    baton: false
    subagentToolNames:
      - subagent
```

`maxConcurrentSubagents` must be a positive safe integer.
`queueTimeoutMs` must be a positive safe integer; the default is 300000 (five
minutes), which bounds every pool wait.
`subagentToolNames` must contain at least one nonempty delegation tool name.
`baton` must be a boolean; the default is `false`.
The bundle patch applies the defaults above; edit the same keys to override
them.

Start the profile:

```sh
dsh --profile web
```

## Update

To update the installed plugin to the latest npm release, run:

```sh
dsh plugin --profile web add dsh-subagent-concurrency-limit@latest
```

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
