# Live test: pausing a workspace

Run this after installing a new commit, on a profile with baton mode on. Use
two folders, called A and B here (for example `D:/work/a` and `D:/work/b`).
Keep the plugin's settings page open in a second tab: its **Workspaces**
section shows what each workspace's agents are doing.

## Prompt

Use the same prompt in both chats. It keeps an agent tree busy for several
steps, with tool calls between them:

> Spawn 3 subagents one after another. Each one lists this folder, then writes
> a 300-word note on a different topic into its own file here. When all three
> are done, read the files and write a one-paragraph summary.

## Steps and what to expect

1. Start the prompt in a chat in A. A's row reads "Running · … · holds the
   baton".
2. Start it in a chat in B. B waits for the baton ("waiting for the baton").
3. While A is generating, press **Pause workspace** in A's chat. The text that
   is streaming finishes; no new request starts. A's row goes from "Pausing ·
   … finishing a step" to "Paused · … held". B's row now holds the baton and
   B's chat moves on.
4. Pause B as well. Nothing generates; the local server goes idle.
5. Resume A. A carries on where it stopped: a subagent that was mid-run
   finishes before its parent writes the summary.
6. Resume B. It queues behind A's agents that were already waiting, and runs
   when A hands the baton on.
7. Pause A, restart dsh, and open the settings page: A is still listed as
   paused. Resume it.
8. Pause A while it runs, then press Stop in its chat. The turn ends at once.

## Cleanup

Turn every workspace switch off, so no folder stays paused.
