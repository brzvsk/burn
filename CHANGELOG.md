# Changelog

Notable changes to Burn, newest first.

Burn follows [semantic versioning](https://semver.org). Releases from 0.4.0 on are tagged `vX.Y.Z` in this repository; earlier versions were not tagged. Each release's commit message has the full detail, including how the release was checked.

## 0.9.0 - 2026-10-30

Subagent spend is counted correctly and shown in the existing Burn views, and the readers, storage and report endpoint are hardened after an audit. Native-agent support is by [Artur Karapetyan](https://github.com/architawr) ([#2](https://github.com/kalindudc/burn/pull/2)).

- **Claude Code subagents are counted.** Burn reads Claude transcripts on the execution host, including nested subagent and workflow files. Repeated API-message snapshots replace one another, transcript totals replace the bb events that omit them, and copied fork history is excluded.
- **Codex child usage no longer mixes with its parent.** Native child events can reuse the parent's provider session ID; Burn separates their cumulative counters by the turn that started them and keeps that mapping, so 100 + 80 + 220 totals 300 rather than 320.
- **bb workflow workers count in their origin thread.** Workers are attached through lifecycle ownership, with deduplication and cycle protection, so their spend is in the family total and not only on the Burn page. A later independent prompt to an old worker stays in the family total but is not credited to a new prompt.
- **Native-agent spend is visible without being counted twice.** The popover gains a Subagents line and the details a With agents KPI; the family table expands agent rows under a thread and its children. The amounts remain a subset of the thread totals.
- **The popover explains where the family total comes from.** The large amount shows the calculation that separates the thread from its family, and the popover opens with that calculation closed.
- **A malformed usage line can no longer take down a machine's figures.** Every token and cost field is coerced to a finite number, and a host validates each thread's report on its own, so one bad log drops that thread instead of failing the batch for up to 32 threads.
- **Reports stay inside bb's KV cap.** Native-agent rows fold into an Other row past 50, as models and days already do; a report with thousands of subagents was reaching 588 KB. An older extension's oversized agent rows are folded too.
- **Session-log memory is bounded.** Each log keeps its newest 50,000 entries, all logs together keep 200,000, and an unterminated line over 4 MB is dropped. An evicted log is read again when needed, and eviction follows last use rather than last change.
- **A stale stored pi report no longer disables the server-side budget stop.** Burn defers to pi only while its last report is fresh.
- **`POST /usage` requires a per-thread token.** Burn mints it with the plugin's secret and gives it to that thread's pi session, so one thread cannot write another thread's figures or read its budget. A missing token is rejected before the body is read. A pi session running before this update reports again after it restarts; its cost still shows from the session log.
- **The Burn page reads storage in bounded batches**, not one KV read per thread at once.
- **Price overrides.** A new JSON setting prices router aliases and contract models for Claude Code and Codex threads; unknown models can now show dollars instead of tokens. Changing the overrides reprices held and saved reports, including the fallback copy kept for an offline machine.
- **OpenCode read failures are logged** once per reason instead of looking like a thread with no usage.
- **New threads show their figures within seconds.** A thread's pi session id may reach bb after Burn's first lookup; Burn now treats that lookup as provisional, retries it after five seconds, and tells the UI to reread. Before, the thread could show nothing for up to the five-minute lookup cache, even while the model worked. The retry stops after about a minute so a thread whose session is named by its thread id cannot loop.
- **The Where it went bar fills for a cheap thread.** Its segments used raw dollar amounts as flex-grow, and CSS leaves free space when those factors sum below 1, so a thread worth a few cents filled only a few percent of the bar. The bar now normalises the parts to shares, and the Burn page's token and cost bars use the same fix.
- **Where it went explains a cost it cannot split.** A harness can report one total with no token kinds, which used to leave the bar's grey background visible with four $0.00 rows. That part now shows as an **Unsplit** slice and legend row with a note, and the bar is hidden until a thread has a priced call instead of greeting a new thread with an empty grey bar.
- **The README's local install now says to run `npm rebuild better-sqlite3`** before tests, because `npm ci --ignore-scripts` leaves the plugin SDK's test host without its native binding.

Checked with the full suite, the type check, a plugin build and a live install from the checkout: a report without a token was rejected while the session-log reader kept the cost current, and a reloaded plugin restored its settings. Settings, stored keys and the plugin database's tables are the same as in 0.8.3; the new Price overrides setting defaults to empty, and reports gain optional native-agent detail that older versions ignore.

## 0.8.3 - 2026-10-29

pi threads on machines where `~/.bb` is a symlink show their cost again. On such a machine, bb's file watcher can refuse to watch a folder reached through a symlink. Burn's host entry waited for its watch on `~/.bb/pi-bridge-sessions` before it answered, bb never reported that watch as ready, and so every read on that machine ran into bb's 25-second deadline. Those threads showed no cost, or the last figures Burn had kept.

- **Burn watches the session folder's real path.** It resolves every symlink first, including a symlinked parent of a folder pi has not created yet.
- **A read waits at most a second for the watch.** The figures come from the session logs, not the watch, so a watch bb cannot start no longer holds them back.
- **An error from a watch that is not ready yet no longer starts a second watch**, because bb keeps retrying the first one on its own.

Checked live on fresh remote machines with a symlinked `~/.bb`: the chip of a pi thread there rose with each model call while it ran, and neither the machine's daemon log nor Burn's log had a deadline error. Four pi threads on other such machines, which Burn had never read, got their figures within seconds of the install. Settings, stored keys and the plugin database's tables are the same as in 0.8.2.

## 0.8.2 - 2026-10-28

Burn's settings survive removing and reinstalling the plugin. bb deletes a plugin's settings when the plugin is removed — `bb plugin update` keeps them, `bb plugin remove` does not — and Burn had no copy of its own, so a reinstall came back with no daily budget, no discount and every other choice at its default.

- **Burn keeps its own copy of its settings**, in its storage, which bb leaves alone when the plugin is removed. It writes the copy at every load and after every change, so it always matches what bb holds.
- **The copy goes back on the next load**, for each setting bb reports at its default while the copy holds something else. A setting bb holds a value for is never overwritten: if you changed it while the plugin was off, your newer value wins.
- **A setting you set back to its default stays there.** The copy records the default too, so resetting the discount to 0 is a choice Burn keeps, not a loss to restore.

Settings, stored keys and the plugin database's tables are the same as in 0.8.1.

## 0.8.1 - 2026-10-28

The Burn page stopped jumping. Every usage signal from a running thread refetches the page, and each refetch put the "Loading spend…" line back into the page's flow, pushing the cost cards, the chart and every panel below them down 36 pixels and pulling them up again a moment later. With a few threads working, the page moved every few seconds.

- **The line's row is always there.** It now holds its 16 pixels whether or not it has anything to say, so nothing below it moves when it appears.
- **It waits before it speaks.** The line appears only once a refresh has run for 600 ms, and stays for at least 500 ms once up, so the warm answer a usage signal earns — a fraction of a second over a warm cache — never flashes a line that is taken back at once. The first load is unchanged: the placeholders and the line paint together.
- **"Still reading N threads" still shows** whenever the answer left threads unread, and goes as soon as a later answer has nothing left to read.

A live check on this machine's data (572 threads, 7 days) drove seven refetches over 23 seconds while sampling the cost cards' position every 50 ms: before, the first card's top alternated between 167 and 203 pixels with 14 moves; after, it stayed at 189 pixels. Settings, stored keys and the plugin database's tables are the same as in 0.8.0.

## 0.8.0 - 2026-10-28

The Burn page opens quickly again when you have many threads. With 1,245 threads, a cold 30-day page took 6.8 seconds and showed only a bare "Loading spend…" box meanwhile.

- **Every thread is read once, not three times.** One shared listing of bb's threads now supplies each thread's title, project, provider, environment and machine, so Burn stops asking bb about each one. A cold page over 1,245 threads made about 2,200 `threads.get` and 1,245 `environments.get` calls; they are gone.
- **The page answers with what is ready.** The per-thread lookup is bounded and runs under the same one-second deadline as the machine reads, so a page over a thousand threads paints instead of waiting for every thread. The threads left over arrive with a usage signal.
- **The page shows its shape while it loads.** The first load paints the cost cards, the chart and the threads table as placeholders, and a refresh keeps the figures on screen with a line naming how many threads are still being read.
- **A background warm-up.** Three seconds after the plugin loads, Burn reads the details of threads touched in the last 30 days, so the first open is warm too.
- The Burn popover's "Where it went" legend no longer overflows its card under a wider UI font, such as a monospace theme.

Settings, stored keys and the plugin database's tables are the same as in 0.7.2.

## 0.7.2 - 2026-10-27

bb opens threads quickly again when you have many of them. With 1,155 threads, bb took over a minute to open a thread, and Burn caused most of that load: about 265 calls a minute, averaging 891 ms each.

- **The sidebar's over-budget flags read only unarchived threads**, as the sidebar shows, plus any thread that reported but is not in bb's list yet. Archiving or unarchiving a thread refreshes that list. The first check after a load now reads 26 logs instead of 1,155, in 28 ms instead of 3.1 seconds.
- **The daily budget check reads only threads updated since yesterday or running now.** It runs at most every 30 seconds, so a burst of changes leads to one check instead of one per change.
- **A slow machine no longer holds up an answer.** Burn waits at most a second for a machine, and that machine's figures arrive once it answers. A second request joins a read that is already under way instead of asking again.
- **Larger caches.** Burn keeps 5,000 threads' details and 2,000 reports, so a pass over every thread no longer evicts the entries it needs next.
- **What you will notice:** archived threads no longer get the over-budget flag, the daily budget notification can arrive up to 30 seconds late, and a slow machine's figures appear once it answers. Settings, stored keys and the plugin database's tables are the same as in 0.7.1.

## 0.7.1 - 2026-10-23

- **The call-time notes name OpenCode.** Burn 0.7.0 counts OpenCode's call times, but four notes still said only pi records them: the Call time panel and its entry in the View menu, the hints on the median-call and failed-call cards, and the card's note on where a thread's cost comes from. They now name pi and OpenCode.
- **New screenshots** of the card with each model's output speed, the Burn tab with its speed card, and the Burn page with its two-row toolbar.
- Upgrading from 0.6.0 keeps your settings, thread budgets and every thread's figures. Settings, stored keys and the plugin database's tables are the same as in 0.6.0.

## 0.7.0 - 2026-10-23

- **OpenCode threads are counted.** bb records no token usage for OpenCode threads, so Burn showed nothing for them. Burn now reads opencode's own SQLite database on the thread's machine, where every assistant message records its tokens and cost. It counts reasoning as output, includes the subagent sessions that opencode's task tool starts, and keeps failed and aborted calls. When opencode's models.dev catalog has no price for a model, Burn splits the recorded cost by token count. Contributed by Nikolai Berezovskii ([@brzvsk](https://github.com/brzvsk)) in [#1](https://github.com/kalindudc/burn/pull/1).
- **OpenCode prompts match what you typed.** Messages that opencode writes itself, such as "Continue if you have next steps", compactions and synthetic tool text, no longer start a prompt. Their calls count within the prompt before them. A prompt's text is the last text you typed, or a slash command's subtask prompt when there is none.
- **OpenCode figures move during a turn.** Burn read an OpenCode thread again only when it started or stopped. During a long turn the chip did not move, the budget stop could not fire, and after five minutes the chip dimmed as if the thread had stalled. Burn now reads the thread each time bb records new events for it, at most once a second.
- Finding a prompt's text reads only the parts of user messages: 1 to 7 ms on the heaviest local session, down from 165 ms. A session longer than 20,000 messages is read from its newest messages instead of its oldest.
- The README credits the OpenCode reader, and the docs say where opencode's database lives and that OpenCode times its calls.

## 0.6.0 - 2026-10-22

- **The Burn page looks back at earlier days.** It showed only ranges that end now, though each thread keeps its last 60 days with use. A Today button, arrows that step back or forward by one range, and a date picker on the dates now choose any earlier day, 7 days or 30 days. "Today" in the range switch is now "Day", since the new button jumps back to today. Clicking a bar in the per-day chart opens that day.
- **A two-row toolbar.** The first row says which days the page shows. The second says what it measures: Cost, Tokens or Calls, the project, and a View menu that now holds the Local or UTC switch beside the panel switches.
- **Links and the back button work.** The page address holds the days shown, such as `spend/7d/2026-10-15`, so the browser's back and forward buttons walk through them and a link opens the same days.
- **A past period compares with the same length of time before it**, such as "vs the day before". It names its dates in the threads table and leaves out the count of running threads.
- **The page remembers your choices** on this device: the range, the measure, the project, Local or UTC, and the price switch. It always opens on the newest days.

## 0.5.4 - 2026-10-20

- **Output speed in tokens per second.** Each model in the card and the Burn tab shows its speed, for example "18 calls · 62 tok/s". The Burn tab gets a Speed tile for the whole thread, an expanded prompt shows its own speed, and the Burn page's Output/s column uses the same figure.
- The speed is the output tokens of the calls that were timed, divided by how long those calls took. A call's time includes the wait for the first token, so the speed reads lower than a provider's quoted generation speed. Only pi times its calls, so threads in other harnesses show no speed.
- A report from Burn 0.5.3 or older still reads correctly.

## 0.5.3 - 2026-10-20

- **The chip shrinks to a flame in the phone header.** On a phone, bb's prompt box starts collapsed, so the chip sat in the thread header. There it squeezed the thread title to nothing and pushed the panel toggle off screen. The header now shows a 28-pixel round flame button, coloured by the chip's tone, that opens the same card. The full chip moves under the prompt box as soon as the prompt box expands. Desktop is unchanged.

## 0.5.2 - 2026-10-20

- **The price switch moves out of the Burn page toolbar.** In 0.5.1 it made the Today, 7 days and 30 days control wrap onto a second row. The toolbar is back to its 0.5.0 layout, and the switch sits under the cost cards, beside the note it explains.

## 0.5.1 - 2026-10-20

- **The Burn page gets the With discounts / List price switch**, shown only while a discount is set. At list price, every figure on the page drops the discounts. Budgets are left out, because they apply to the discounted figures, so there is no daily budget line and the Threads card reads "at list price".

## 0.5.0 - 2026-10-20

- **Discount settings, so bb shows what you pay.** Burn's dollar figures were list prices, which read too high for anyone who buys tokens below list, such as at a contract rate. The bb plugin gains a Discount (%) setting, with optional overrides for input, output, cache reads and cache writes. The default of 0 keeps list price. Every cost, budget, alert, the daily budget, the sidebar flag and the opt-in stop use the discounted figures.
- The card and the Burn page say when discounts apply, and the Burn tab has a With discounts / List price switch to compare the two.
- Burn keeps storing list prices and applies discounts when it answers, so a change applies at once, to history too, and is never mistaken for new spend by the alerts. Totals, days and the split by token kind are exact. Per-call, per-prompt and per-model figures use the thread's overall discount when the per-kind discounts differ.
- The pi extension still shows list price.

## 0.4.1 - 2026-10-19

- **Alerts stay up long enough to read.** Burn's alerts in bb closed after 4 seconds, often before you came back to bb. Over-budget and stopped-thread alerts now stay until you close them, near-budget and daily alerts last 15 seconds, and expensive-prompt alerts last 10. Every alert has a close button, and bb's notification center keeps them.

## 0.4.0 - 2026-10-19

- **The plugin ID is `burn`.** The package is renamed from `pi-burn` to `burn`, so bb's plugin ID is `burn` and the update command is `bb plugin update burn`.
- **A marketplace overview.** `PLUGIN_OVERVIEW.md` holds the long description for the BB Community marketplace.
- **A lighter README with screenshots.** The detail moves to [Burn in bb](docs/bb.md), [Burn in pi](docs/pi.md), [How Burn works](docs/how-it-works.md) and [Troubleshooting and limits](docs/troubleshooting.md).

## 0.3.1 - 2026-10-19

- **The Burn page keeps the days you chose after a quick switch.** A refresh scheduled just before you changed the days, range, project or metric ran with the old choice and replaced the new answer, so the page could show local figures under a pressed UTC button. The refresh now uses the page's current choice.

## 0.3.0 - 2026-10-19

- **Usage panels on the Burn page.** A Show switch picks Cost, Tokens or Calls and re-ranks the chart, the activity map, the threads, a new Models table and the bars by project and by harness. New panels show token and call totals, the mix of token kinds against their cost, call time with p50, p90, failed and stopped calls, and activity by hour. A Panels menu and a hide button on most panels hide what you do not want, in every bb window. The cache hit rate now covers the chosen days instead of the threads' whole lives.
- **Codex, Claude Code and other bb harnesses are counted**, from the usage events bb records. bb deletes older usage events, so Burn keeps its own copy. Codex and Claude Code report tokens but no cost, so Burn prices their tokens at list price and marks the amount as an estimate, such as `~$1.23`. A model with no known price shows tokens instead. The opt-in stop works for Codex. It never stops Claude Code, which reports only as each turn ends.
- **The bb plugin works without the pi extension.** It reads each pi thread's session log on the machine that runs it, remote machines included, and watches the log folder so figures update live. When the pi extension is installed, its report adds only pi's own budget, its stop and the context window. With the opt-in stop on, a thread without the extension is stopped through bb.
- **Threads that never reported are counted**, such as threads started before Burn was installed and the child threads they started.
- **Archived and hidden child threads count in a thread's total**, so a parent whose finished minions were archived no longer comes out low.
- **A forked session counts only from its creation**, so a side chat no longer counts its parent's calls twice, in bb and in pi.
- **Local or UTC days.** The Burn page gets a Local or UTC switch for which calendar day counts as today, and pi's History view gets a `u` key for the same.
- **A tidier card.** The chart's hover label stays inside the card, the card's actions become small icon buttons, and Copy summary says Copied after a copy that worked.
- bb still reads reports from Burn 0.2, with zeros for the new per-day figures.

## 0.2.0 - 2026-10-18

- **In pi**, the pill shows what the last prompt cost and the budget state, with a spinner while pi works. `/burn` opens a live overlay with Overview, Turns, Models and History views, and has `budget`, `copy` and `settings` subcommands.
- **In bb**, the chip opens a card with the breakdown, a per-call chart and a budget editor. A Burn tab in the side panel lists every prompt and the cost of child threads. Every thread menu gets a Cost entry, threads over budget get a red flame in the sidebar, and a Burn page shows spend by day, project and model.
- **Budgets.** Burn warns at 80% and at 100% of a thread's budget, in pi and in bb. Stopping a run at its budget is opt-in and off by default.

## 0.1.0 - 2026-10-18

The first version, named `pi-burn`, for pi threads only.

- A cost pill such as `$4.82 +0.31` in pi's status line: the thread's total, then what the last prompt added. `/burn` opens a panel with cost by token kind and by model.
- The same pill beside the context circle under bb's prompt box, with a hover card that charts cumulative cost and cost per call.
