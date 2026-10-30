# How Burn works

Burn has two halves: a bb plugin and a pi extension. The bb plugin alone is enough in bb. The pi extension adds the pill and `/burn` in pi's terminal, with or without bb, and makes the budget stop faster in a bb thread.

## Where the numbers come from

In bb, Burn counts every thread, whatever harness runs it.

- **pi threads:** the figures come from pi's session logs, where every assistant message already carries the cost pi recorded.
- **OpenCode threads:** the figures come from opencode's own database on the thread's machine, where every assistant message records its tokens and cost, including the calls of subagents that opencode's task tool starts.
- **Claude Code threads:** a host reader reads the exact session identities and their recursive subagent transcript trees. Repeated content-block usage snapshots replace one another by API message ID. Logs replace event totals rather than being added to them.
- **Other harnesses,** such as Codex: the figures come from the usage bb records for each thread, and Burn keeps its own copy of it.

When a harness passes bb its own cost, Burn uses that cost as it is. Codex and Claude Code pass bb their tokens but no cost. Burn prices their tokens with pi's list prices for OpenAI Codex and Anthropic models, and marks every such amount as an estimate, for example `~$1.23`. A model without a known price shows tokens instead of dollars.

Burn reads and keeps list prices, and applies the discounts in its settings each time it answers. So a changed discount applies at once, to past figures as well, with nothing to rebuild. See [Discounts](bb.md#discounts).

## Reading pi's session logs and opencode's database

The bb plugin has a host entry: code that bb runs on every connected machine. It reads the session log that bb's pi bridge keeps for each pi thread on that machine, and builds the same report pi would.

The host entry watches the log folder, so the chip updates about a second after pi finishes a model call. It reads only the bytes pi appended since the last read. The plugin keeps the last figures each machine gave, so a thread on a machine that is offline still shows its cost. Whether a thread is working comes from bb's own thread status.

For OpenCode threads, the host entry opens `opencode.db` read-only. It is in `$XDG_DATA_HOME/opencode` when that is set, and in `~/.local/share/opencode` otherwise. Burn has no watch on the database, so it reads the database again each time bb records new events for the thread, about once a second while the thread works, and again when the thread stops. A user message that opencode writes itself, such as "Continue if you have next steps" or a compaction, does not count as a prompt; its calls count within the prompt before it.

## Reading the usage bb records

The host entry reads pi's logs and opencode's database. Claude Code also uses the host entry to read its transcripts; other harnesses need no host code. Their provider bridges, the adapters that connect an agent such as Codex to bb, already send bb a token-usage event after each model call or turn, and some send a running cost. bb tells the plugin within a second when a thread has new events, and the plugin reads them.

bb deletes older usage events and keeps only the latest one for each thread. So Burn keeps its own copy of what it read in the plugin's database, and the figures survive a plugin reload.

## The pi extension in a bb thread

The pi extension's report is optional. bb ignores a pi extension's footer status, so in a bb thread the pi extension sends its numbers to the plugin instead.

The plugin gives pi an address through the `BURN_BB_URL` environment variable. pi posts a small JSON report when a run starts, after each model call, and when the run ends. Only bb's own pi reports, which runs in RPC mode; a `pi -p` started from a thread's shell does not.

The figures still come from the session log. The report adds only what the log cannot know: the budget set with `/burn budget`, when pi stopped a run, and the context window.

The plugin's reply carries the thread's budget policy, so pi in a bb thread follows bb's budget settings. A thread budget set in bb takes precedence over one set with `/burn budget`. With the pi extension installed, pi stops a run at its budget from inside pi, which is faster than stopping it through bb.

bb gives pi the address to report to only when it starts a pi session. So after you install the pi extension, a thread that was already running starts reporting only after it restarts. Its cost shows in bb either way, from the session log.

See [Usage coverage and workflow accounting](usage-coverage.md) for source limits and the distinction between native subagents and BB workflow workers.
