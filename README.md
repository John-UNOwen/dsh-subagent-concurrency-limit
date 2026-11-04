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
- A delegation that fails or is cancelled frees its permit at once, whether
  the tool throws or returns an error result.
- A local child with no reservation (one published by a tool outside
  `subagentToolNames`, such as `subagent_fork` or `workflow`, or whose publish
  lost the delegating call's async context) queues like a root delegation when
  its parent is a root agent. A deeper one never queues: it takes a permit
  immediately when one is free and fails loudly when the pool is full, so it
  cannot block the ancestor that is waiting for it.
- With the baton on, nested children are admitted over a full pool. They do
  not count against the limit, so they never hold up a queued root
  delegation.
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
  pauses the parent. A background child published while the parent is already
  generating its next step waits for that step to finish. The parent's next step waits until the child goes idle,
  its run ends, or it is disposed.
- Children delegated by a paused parent run one at a time in order, and the
  parent resumes after the last one.
- Nested subagents work: the deepest active agent runs, and each ancestor
  resumes in turn as its children finish. Paused ancestors never borrow the
  baton from a descendant.
- While the holder is inside a tool call it is not generating, so another
  agent may borrow the baton:
  - its own descendants at once, which prevents a deadlock when a parent
    waits on a child. A deeper agent the plugin cannot link to the holder
    (such as a workflow `agent()` call) counts only if it first asks for the
    baton during the holder's current tool call and is not of another
    project; an older one, such as a resumed session, waits like anyone else;
  - anyone else only after the holder has spent `lendAfterMs` (default
    30000) in tools. Short tool calls keep the baton, and the prompt cache,
    with the agent that made them; a long one lets others use the idle slot.
    `0` lends on every tool call.
  - Waiting for a tool approval counts as tool time too, whether a human or
    an AI reviewer subagent answers it, so a reviewer can run and others can
    borrow while you decide.
- When the baton is handed on and no parent or sibling in the same tree is
  due, a waiting agent of the same project (its session's working folder)
  goes before agents of other projects, so one codebase's agents run
  back to back. Once another project's agent has waited `projectPriorityMs`
  (default 600000, ten minutes) it goes next. `0` makes hand-offs plain first
  come, first served. Subagents belong to their parent's project.
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

## Per-provider lanes

By default one lane covers every agent: one baton and one pool limit for the
whole process. If you run several local servers, or mix local and cloud
models, list the providers that need gating under `providers`. Each listed
provider gets its own baton and pool, so agents on different providers run in
parallel, and providers you do not list run without any limit:

```yaml
config:
  baton: true             # defaults for listed providers
  maxConcurrentSubagents: 4
  providers:
    my-llamacpp: {}                       # inherits the defaults
    my-llamacpp-alt: { lane: my-llamacpp } # same server, same baton
    my-other-gpu: { maxConcurrentSubagents: 2, lendAfterMs: 60000 }
```

Provider ids that point at the same server must share a lane (`lane:`),
otherwise they interleave on its single slot. A shared lane takes its
settings from the provider it is named for (`my-llamacpp` above). If that
provider is not listed itself, it still runs on the lane, and the lane takes
the strictest setting its other providers state: the lowest limit, the longest
lend delay, and the baton on if any of them turns it on. A `lane:` may point
at a provider that itself follows another; the chain is followed to its end.

- The names are your dsh provider ids (the `provider` in your model routes).
- An agent's lane is the provider its last model request used. Before its
  first request, a child is expected to use the provider named in the
  `subagent` call, or else its parent's.
- A `subagent` call takes its pool slot in the lane of the provider named in
  its arguments, or else the parent's.
- The baton is handed to a child only when parent and child share a lane, so
  a parent on one GPU keeps working while its child runs on another.
- An agent that switches model mid-session moves to the new lane at its next
  request. A child in the middle of a turn moves its pool permit there at its
  next step.
- A change to which providers are listed, which lane each one uses, or a
  lane's baton applies once no agent holds or waits for a permit or a baton,
  so in-flight work is never split across two lanes. Until then the settings
  page says the change is waiting. Per-provider limits and lend delays apply
  at once.

On the settings page, the **Providers** section lists the providers from your
model catalog. Switch on the ones that run on a single-slot local server, pick
**Shares a server with** for provider ids that point at the same server, and
optionally set a per-provider subagent limit. **Edit as text** shows the same
map as one line, for example
`my-llamacpp: limit=4; my-llamacpp-alt: lane=my-llamacpp; my-other-gpu: limit=2 lend=60000`.

## Pausing a workspace

A workspace is a working folder: a chat's folder, compared ignoring case and
slash direction, the same rule as same-project priority. Subagents belong to
their parent's workspace. Pause one so another workspace can use the model:

- On the settings page, the **Workspaces** section lists the workspaces the
  plugin has seen and any paused folders, with what their agents are doing
  (for example "Paused · 3 agents held" or "Running · 1 agent · holds the
  baton"). Its switches apply at once, without **Save**, and the list
  refreshes every few seconds while it is shown.
- In a chat, the **Pause workspace** button beside the send button pauses
  that chat's workspace. It reads **Resume workspace** while paused.

What pausing does:

- It takes effect at a step boundary. A model request or tool call already
  under way finishes, then the agent waits just before its next model
  request. Nothing in flight is cut off, and the model does not notice.
- It covers every agent of the workspace on every provider, including
  unlisted providers and cloud models, and it works with the baton off.
- A paused workspace keeps its place in the baton's order: once resumed, its
  children still run before their parents. If its baton holder is inside a
  long tool call, the baton is lent at once instead of after `lendAfterMs`.
- Several workspaces can be paused at once. Resuming one puts it back in the
  queue behind agents already waiting, with no priority.
- Aborting a paused turn ends its wait.

Limits:

- A paused workspace's subagents keep their pool slots, so other workspaces
  reach `maxConcurrentSubagents` sooner, and their delegations then queue
  (and fail after `queueTimeoutMs`). Raise the limit if that matters.
- Model calls outside agent steps, such as title generation, are not paused.
- A held agent rechecks about once a second, so a resumed workspace starts
  within a second or so.

The list is `pausedWorkspaces` on its own entry, `subagent-concurrency-pause`,
which the bundled patch inserts. It is stored in the profile patch, so pauses
survive a restart, and it can be edited by hand:

```yaml
- id: subagent-concurrency-pause
  config:
    pausedWorkspaces:
      - D:/work/app
```

It is a separate entry so that pausing never interferes with unsaved edits on
the main settings form: dsh refuses a form's save once its entry has changed
since the edit began.

The settings page and the button read the workspaces from a small read-only
route the host half serves at `/subagent-concurrency-limit` (`workspaces` and
`workspaceOf`). It sits behind dsh's own Host/Origin checks and browser
authentication. Pausing and resuming write the setting through dsh's settings
service, which validates and persists it like any other.

## Install (this fork)

This fork is not on npm. Push it to your GitHub account and install it from
there. These examples use the `web` profile; replace `web` with your profile
name and `<owner>` with your GitHub account.

```sh
dsh plugin --profile web add github:<owner>/dsh-subagent-concurrency-limit
```

Add `#<branch>` or `#<commit>` to install something other than the default
branch. The built `lib/` is committed, so the install runs no build step and
needs no `allowBuilds` entry.

Check that `dsh-subagent-concurrency-limit` is listed under
`dsh.profile.bundles` in `$DSH_HOME/profiles/web/package.json`. Only bundles in
that list load, and the bundle brings its own `cordis.patch.yml`.

### Do I need a profile cordis patch?

No. The fork's bundled patch inserts the plugin with baton mode on, plus the
pause entry that holds the paused workspaces:

```yaml
- insert:
    - id: subagent-concurrency-limit
      name: dsh-subagent-concurrency-limit
      config:
        baton: true
        maxConcurrentSubagents: 4
        subagentToolNames:
          - subagent
    - id: subagent-concurrency-pause
      name: dsh-subagent-concurrency-limit/pause
```

dsh reads bundle patches on every start, so an update that adds an entry needs
no profile edit.

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
form with the workspaces (see [Pausing a workspace](#pausing-a-workspace)),
the baton switch, the lend delay, the concurrency limit, the queue timeout and
the delegation tool names. **Save** validates against the plugin's schema and
writes the profile patch. The workspace switches are not part of **Save**;
they apply at once.

Changes apply live, without restarting the profile:

- A raised limit admits queued calls within about a second; a lowered one
  admits no new work until enough has finished.
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
`projectPriorityMs` must be a non-negative safe integer; the default is 600000.

For a single-slot server also start it so requests queue instead of splitting
the slot, for example llama.cpp with `-np 1`.

Start the profile:

```sh
dsh --profile web
```

## Update

Rerun the install command (with the new commit hash, if you pin one).

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

`lib/` is committed so a GitHub install needs no build. After changing
`src/`, run `pnpm run build` and commit `lib/` with the change;
`pnpm run check` fails (`check:lib`) when the committed `lib/` does not match
what `src/` builds to. `npm publish` runs the checks through `prepublishOnly`.

## License

The project is licensed under [MIT](LICENSE).

`src/rpc-channel.ts` is adapted from
[dsh-pause](https://github.com/better-er/dsh-pause), Copyright (c) 2026
betterer, under the MIT License; the file carries its notice.

[dsh-repository]: https://github.com/deepseek-ai/deepseek-harness
[dsh-commit]: https://github.com/deepseek-ai/deepseek-harness/tree/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e
[dsh-workflow]: https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/workflow/workflow-worker-thread/src/index.ts
[dsh-subagent]: https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/subagent/tool-subagent/src/index.ts
[dsh-tool-calls]: https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/agent-loop/src/tool-calls.ts

## Harness compatibility

This version targets DeepSeek Harness `0.2.0-rc.2`.
