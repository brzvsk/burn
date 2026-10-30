# Troubleshooting and limits

## Troubleshooting

- **The chip shows a dashed "—" in bb.** The thread has made no model call yet, or its harness sends bb no usage. For a pi thread it can also mean that Burn found no session log on the thread's machine and no report from pi. Check that bb keeps its pi sessions in the default folder; see [session logs](#session-logs) below. For an OpenCode thread it can mean that Burn found no opencode database on the thread's machine at `~/.local/share/opencode/opencode.db`, or under `$XDG_DATA_HOME/opencode` when that is set.
- **The chip is dimmed with an age such as "3h".** bb says a pi or OpenCode thread is working, but its session log or opencode's database has not changed since then, so the agent may have stopped. Threads of other harnesses are never dimmed, because a Claude Code turn can run for minutes before bb records its usage.
- **There is no chip in bb.** Check that the **Cost chip** setting in Burn's plugin settings is on. `bb plugin list` should show `burn` as running.
- **The chip is in the thread header, not the footer.** Burn did not find bb's footer markup; see [bb's page markup](#bbs-page-markup) below. The chip works the same there. On a phone, the header shows only the flame until you expand the prompt box, and the chip then moves to the footer.
- **There is no pill in pi.** The pill shows only in pi's terminal UI. `/burn` works in any mode.

## Limits

### bb's page markup

bb's footer has no plugin slot. The chip is a thread header action that moves itself next to the context circle by finding bb's page markup (`[data-follow-up-composer-footer]`). If bb changes that markup, the chip stays in the thread header.

The sidebar flag uses an experimental bb API, so on a bb without it the flag does not show. It covers every thread that is not archived.

Burn checks the daily budget at most every 30 seconds, so its notification can arrive up to half a minute after the spend that passes it.

### Session logs

Burn reads pi's session logs from `~/.bb/pi-bridge-sessions` on each machine. bb's pi bridge can be pointed elsewhere with `BB_PI_BRIDGE_SESSION_DIR`, but Burn does not follow it.

After a machine's bb daemon restarts, live updates for its threads resume within a minute.

Burn waits at most a second for a machine to answer. When one takes longer, Burn shows the figures it last read there and updates them as soon as the machine answers.

### Prices

Dollar figures are list prices unless you set a **Discount (%)** in Burn's settings; see [Discounts](bb.md#discounts). They are either the costs pi recorded or Burn's estimates (`~$`), and estimates are discounted too. Burn cannot see what a proxy actually bills, so set the discounts to match its rates. Estimates also price every cache write as a five-minute write, because bb's usage events do not say which writes were one-hour writes.

The pi extension does not use Burn's discounts, so pi's pill and `/burn` show list price. With the pi extension installed and **Stop a thread at its budget** on, the extension stops a run when its list-price cost reaches the budget. With a discount set, that is earlier than the chip shows.

Router aliases such as `shopify/auto-best` have no known price, so their threads show tokens. A cost in a currency other than US dollars is not converted, so that thread shows tokens too.

### Harnesses other than pi

- A harness that sends bb no usage, and whose own records Burn does not read, shows nothing.
- Call time, output speed and failed calls come from pi's session logs and opencode's database, and only from the calls they timed. Codex and Claude Code record none of them, so their figures read "—".
- Output speed counts the whole call, from the request to the last token, so it reads lower than a provider's quoted generation speed. Figures that Burn 0.5.3 or older recorded, such as those kept for a machine that is offline, have no speed per prompt, and a model with some untimed calls has no speed until Burn reads that thread's log again.
- Claude Code threads read saved transcripts, including nested subagent/workflow transcripts, on the execution host. When transcripts are unavailable Burn keeps its last report or falls back to BB events with a limited-coverage notice. Claude Code is still never stopped at its budget; alerts still fire. See [coverage](usage-coverage.md).
- Usage that bb deleted before Burn first read a thread counts as one entry: the total is right, but the split by day and model is lost. Claude Code's event fallback can lose usage when its running total restarts between turns; transcript reads recover only history still present on disk.

### The Burn page

- The page counts the spend of every thread by the days on which its model calls were made.
- The Models table's cache hit rate, average call time, output per second and failure rate cover the whole life of the threads in the range, not only the chosen days.
- The activity map counts by UTC clock hour. In a time zone with a half-hour offset it shifts by half an hour, so calls in the first half hour after midnight show on the previous day.
- A report from a Burn 0.2 pi extension, or the last report of an offline machine, has no token, call-time or hourly detail until Burn reads the thread again.

### Stopping and counting

- The server-side stop, used when the pi extension is not installed, ends the thread's current work through bb.
- A forked session counts only from its creation, so pi's own footer reads higher for it.
- pi orders status entries by key, so where the pill sits next to other markers is up to pi.
