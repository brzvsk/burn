# Burn

See what each agent thread has cost, while it runs.

Burn puts a cost pill such as `$4.82 +$0.31` in pi's footer and in bb's prompt box: the thread's total, then what the last prompt added. Behind the pill is what every prompt, model and call cost, budgets that warn you before a thread gets expensive, and your spend across every thread.

<p align="center">
  <img src="assets/screenshots/bb-chip-card.png" alt="The Burn card in bb, opened from the cost chip under the prompt box" width="760">
</p>

## What you get

**In bb**, for every thread, whatever harness runs it (pi, OpenCode, Codex, Claude Code or another):

- A chip beside the context circle, with a card behind it that breaks the cost down and charts every call.
- A Burn tab in the side panel that lists every prompt and adds the cost of child threads, such as minions.
- A Burn page in bb's navigation with spend across all threads by day, project, model and harness.

<table>
  <tr>
    <td width="40%"><img src="assets/screenshots/bb-panel.png" alt="The Burn tab in a thread's side panel"></td>
    <td width="60%"><img src="assets/screenshots/bb-burn-page.png" alt="The Burn page: spend across all threads for the last 30 days"></td>
  </tr>
</table>

**In pi**, in the terminal, with or without bb:

- A pill in pi's status line.
- A `/burn` overlay with four views: an overview, what each prompt cost, cost by model, and this project's spend across sessions.

<table>
  <tr>
    <td width="50%"><img src="assets/screenshots/pi-burn-overview.png" alt="/burn overview: total, where the money went, spend over time"></td>
    <td width="50%"><img src="assets/screenshots/pi-burn-turns.png" alt="/burn turns: what each prompt cost"></td>
  </tr>
</table>

**Budgets** work in both. Burn warns at 80% and at 100% of a thread's budget. It never stops a thread unless you turn on the stop setting, which is off by default.

## Install

The bb plugin alone is enough in bb. The pi extension is optional: it adds the pill and `/burn` in pi's terminal, and in a bb thread it stops a run at its budget from inside pi, which is faster than stopping it through bb.

```bash
# bb plugin
bb plugin install git:https://github.com/kalindudc/burn

# pi extension
pi install git:github.com/kalindudc/burn
```

From a local checkout instead:

```bash
git clone https://github.com/kalindudc/burn && cd burn
npm ci --ignore-scripts
bb plugin install path:"$PWD"
pi install "$PWD"
```

To update, run `bb plugin update burn` and `pi update git:github.com/kalindudc/burn`. A bare `pi update` updates pi itself, not its packages.

Requirements: bb 0.46 or newer. The pi extension needs pi 1.x, which provides `ctx.mode`.

Do not install the bb plugin from npm. The npm package ships only the pi extension, and bb needs the whole repository to build the plugin.

Threads that are already running show their cost as soon as the bb plugin is installed.

## Documentation

- [Burn in bb](docs/bb.md): the chip, the card, the Burn tab, the Burn page, and settings.
- [Burn in pi](docs/pi.md): the pill, the `/burn` views, commands, and settings.
- [How Burn works](docs/how-it-works.md): where the numbers come from, and how the two halves talk.
- [Troubleshooting and limits](docs/troubleshooting.md).
- [Changelog](CHANGELOG.md): what changed in each release.

## Development

```bash
npm install
npm test
npm run typecheck
bb plugin build
```

If you installed with `npm ci --ignore-scripts` (the local-checkout install above), run `npm rebuild better-sqlite3` before `npm test`. The plugin SDK's test host uses its native binding, and without the rebuild 16 tests fail on a fresh checkout.

The shared report, formatting and budget code is in `src/`. The pi extension is in `extensions/pi`, and the bb plugin is in `extensions/bb`. `test/layout.test.ts` keeps the halves from importing each other's dependencies.

The screenshots come from a sandboxed bb and pi with made-up projects and threads.

## Credits

Support for OpenCode threads, which Burn reads from opencode's own database, is by [Nikolai Berezovskii](https://github.com/brzvsk) ([#1](https://github.com/kalindudc/burn/pull/1)).

Subagent accounting, which reads Claude Code transcripts and separates Codex child counters, is by [Artur Karapetyan](https://github.com/architawr) ([#2](https://github.com/kalindudc/burn/pull/2)).

## License

[MIT](LICENSE.md)
