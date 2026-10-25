# Pomodoro Pet (番茄精灵)

A focus companion for DeepSeek Harness Web: a pomodoro timer, four-quadrant tasks, a pet that grows with your focus, and an agent-facing tool that ties sessions, workspaces, and skills into a focus plan.

**English** | [中文](README.zh.md)

- Version: **0.9.1**
- Runtime: DSH Web (`0.2.1-rc.2` or newer, developed and tested on `0.2.1-rc.2`)
- Dependencies: **none** — plain ESM on the Host side and an injected React UI on the Client side
- Data stays local: no uploads, no telemetry, no remote calls

## Features

- **Focus timer.** Standard, Deep, and Sprint modes, custom lengths from 5 to 120 minutes, pause/resume/stop, automatic short and long breaks, deadline recovery after a DSH restart, and a reconciliation sweep that settles rounds whose timer event was missed.
- **Four-quadrant tasks.** Tasks carry a quadrant (A urgent & important, B important & not urgent, C urgent & not important, D other), an optional group, an estimate in pomodoros, and an active/done/archived status. Drag a task between quadrants or start a focus round directly on it.
- **Proposal loop.** The agent can only *propose* task creation or updates. A proposal is stored in a queue and changes nothing until you confirm it in the UI.
- **A pet that grows.** Completed focus rounds grant EXP; levels unlock four evolution stages. Mood reflects focus, breaks, abandonment, and level-ups. Eighteen achievements grant outfit fragments, and fragments redeem cosmetic outfits.
- **Stats that mean something.** A daily focus heatmap (six months or full year), weekly focus time, time-of-day distribution, quadrant distribution, per-session and per-workspace attribution, totals, goal completion, and streaks.
- **Reports and export.** Weekly and monthly reports, share cards rendered as portrait or landscape PNG, and a JSON backup of tasks, stats, and achievements.
- **Agent integration.** The `pomodoro_pet` tool lets an agent start, pause, resume, or stop rounds, read status and stats, list tasks, propose task changes, start a round on an existing task, list workspace skills, build a read-only focus plan, and summarize the day's agent activity.
- **Local privacy.** Session names, workspace paths, tool activity, and task titles are displayed locally only. Task titles are hidden by default, and agent context is never included in exports.

## Requirements

- A DSH Web profile whose composition provides `storageDomain`, `webServer`, `tools`, and `timer` on the Host, plus `slots` and `locale` on the Client. The stock `web` profile provides all of them.
- A browser with `localStorage`. Desktop notifications and the chime need a browser permission; localhost counts as a secure context.
- No Node.js build step is required to use the plugin. Node.js is only needed by `install.sh` and the unit tests.

## Installation

A detailed Chinese walkthrough lives in [INSTALL.md](INSTALL.md).

### One-click script

```bash
tar -xzf dsh-pomodoro-pet-0.9.1.tar.gz
cd dsh-pomodoro-pet
./install.sh                      # installs to ~/dsh-plugins, profile "web"
# ./install.sh --dest ~/my-plugins --profile web
# ./install.sh --home /path/to/.dsh --profile web
```

The script copies the plugin, adds it to the profile's `dependencies` and `dsh.profile.bundles`, creates the `@local` symlink, and appends the plugin row to `cordis.patch.yml`. It is idempotent. Restart `dsh web` afterwards; Host-side code is only loaded at startup.

### Manual installation

1. Copy this directory to a stable location, for example `~/dsh-plugins/dsh-pomodoro-pet`.
2. In `~/.dsh/profiles/web/package.json`, add the dependency and the bundle:

   ```json
   {
     "dependencies": {
       "@local/dsh-pomodoro-pet": "link:/home/<you>/dsh-plugins/dsh-pomodoro-pet"
     },
     "dsh": {
       "profile": {
         "bundles": ["...existing bundles...", "@local/dsh-pomodoro-pet"]
       }
     }
   }
   ```

3. Link the package into the profile:

   ```bash
   mkdir -p ~/.dsh/profiles/web/node_modules/@local
   ln -sfn ~/dsh-plugins/dsh-pomodoro-pet ~/.dsh/profiles/web/node_modules/@local/dsh-pomodoro-pet
   ```

4. Append the plugin row to `~/.dsh/profiles/web/cordis.patch.yml`:

   ```yaml
   - insert:
       - id: pomodoro-pet
         name: '@local/dsh-pomodoro-pet'
         config: {}
   ```

5. Restart `dsh web` and open the Web UI. The examples below use DSH's default port `3080`; if you start DSH with `--port` (for example `8080`), use that port instead.

### Install from the plugin index

DSH ships no built-in index source. This repository publishes a format-1 index:

```text
https://cdn.jsdelivr.net/gh/gitByteFree/dsh-pomodoro-pet@main/market/index.json
```

1. Open **Plugins**, enable the experimental **Custom plugin indexes** bundle, and open the **Discover** tab.
2. Choose **Add index source** and paste the URL above.
3. Select Pomodoro Pet and install the listed version. DSH pins this Git repository to the commit recorded in the index.

The index is served through jsDelivr because the market requires a direct `200` without redirects. Where GitHub is reachable, `https://raw.githubusercontent.com/gitByteFree/dsh-pomodoro-pet/main/market/index.json` serves the same file. Both URLs follow `main`; jsDelivr caches the branch for 12 hours at the edge and browsers may reuse their copy for longer, so a new release can take a while to appear. Every listed version pins an immutable commit.

The index entry is a Git source because this package is local and private; nothing is published to npm.

### Verify

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3080/dsh-pomodoro/state
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3080/dsh-pomodoro/context
```

`3080` is `dsh web`'s default port; substitute your own `--port` value if it differs. Both requests should return `200`. In the GUI, the sidebar shows a tomato icon, the panel reports version `0.9.1` under Settings → About, and a draggable pet capsule appears in the bottom-right corner.

## Usage

### Panel and shortcuts

The sidebar entry opens three tabs: **Focus**, **Stats**, and **Settings**. The panel is a normal DSH client bundle, so the theme follows DSH (Settings → General → Appearance) and the language follows the DSH locale.

| Key | Action |
| --- | --- |
| `Space` | Start, pause, or resume the current round |
| `S` | Stop the round (during a break: skip the break) |
| `1` / `2` / `3` | Switch Standard / Deep / Sprint while idle or waiting |
| `?` or `Shift` + `/` | Toggle the shortcuts overlay |
| `Esc` | Close a dialog, or leave an input |
| `Enter` / `Esc` on a collapsed pet | Expand / tuck away the pet |

Shortcuts only apply while the panel is mounted. Inside an input, textarea, select, contenteditable element, or dialog, only `Esc` is handled.

Stopping a focus round is an abandonment: it grants no EXP, lowers mood by 1, and resets the round streak. Stopping a break or a waiting round skips it without a penalty.

### Focus modes

| Mode | Default length | EXP multiplier |
| --- | --- | --- |
| Standard | 25 min | 1.0 |
| Deep | 50 min | 1.2 |
| Sprint | 15 min | 0.8 |

A custom length between 5 and 120 minutes overrides the default. Rounds follow the configured short-break and long-break cadence; a long break happens after `roundsPerLong` focus rounds.

### Tasks

- Quadrants: A urgent & important, B important & not urgent, C urgent & not important, D other.
- A task stores a title, quadrant, optional group, estimated pomodoros, completed pomodoros, and status (`active`, `done`, `archived`).
- You can filter by quadrant, drag a task to another quadrant, complete or reopen it, and start a focus round on an active task.
- Agent-created or agent-updated tasks land in the **Pending proposals** area first. Confirm to apply, decline to discard.
- Starting on a task attributes the round's EXP to that task's quadrant and records the title snapshot on the session.

### Pet growth

| Level | Stage |
| --- | --- |
| 1 | Sprout (青芽) |
| 3 | Red fruit (红果) |
| 5 | Glowing fruit (发光果) |
| 7 | Rainbow king (彩虹王) |

- EXP per completed focus: `round(quadrantBase × modeMultiplier × focusMinutes / 25)`, at least 1. Quadrant bases are A 10, B 12, C 8, D 5; an unbound task uses 10.
- Finishing a break grants 2 EXP; a new daily streak grants 5 bonus EXP.
- EXP needed to advance from level `L` is `30 + 20 × L`.
- Mood runs from 0 to 5 and starts at 3. Abandoning a focus round lowers it by 1; a level-up raises it by 1.
- Feeding raises mood by 1 and is capped by `dailyFeedLimit` (default 3). Greeting never changes it. Neither action grants EXP.
- Eighteen achievements span rarity tiers from Common to Legendary and grant 0–10 outfit fragments. Ten fragments redeem one of four outfits.

### Stats and reports

- Heatmap for the last six months or the full year, with hover details per day.
- Weekly focus-time chart, time-of-day buckets (morning, afternoon, evening, late night), and quadrant distribution.
- Totals: focus time, pomodoros, longest streak, goal completion.
- Per-session and per-workspace attribution, including the workspace skills available in the current session.
- Agent activity: whether DSH is running, recent tools, and today's tool and step counts.
- Weekly and monthly reports, portrait/landscape share cards (PNG), and JSON backup.

### Settings

- Timer: focus length, short break, long break, long-break interval, daily goal.
- Sound and alerts: chime, volume, desktop notifications, animations.
- Appearance: follows DSH; no separate theme switch.
- Pet: size (0.5–2.0×) and position reset.
- Local data sources: pet tool bubbles and status dot, recent sessions and workspace details, session/tool events (display only).
- Time zone for day boundaries. Changing it does not rewrite history.
- Export JSON, action audit log (up to 1000 entries), and version information.

## Agent tool: `pomodoro_pet`

The Host registers one raw tool definition. Its description and parameters are model-facing; every call is serialized through the same command chain as UI actions.

| Action | Parameters | Effect |
| --- | --- | --- |
| `start` | `focusMinutes`, `taskId`, `mode` | Start a focus round. Fails with `busy` when a round is already running. |
| `pause` / `resume` / `stop` | — | Pause, resume, or stop the current round (stop during a break skips it). |
| `status` | — | Current round, pet stage/level/mood, and today's completed pomodoros. |
| `stats` | `days` (1–90, default 7) | Recent days and quadrant distribution. |
| `pet` | `petAction`: `feed` or `greet` | Mood-only interaction; `feed` is capped per day and never grants EXP. |
| `task_list` | `quadrant`, `status` | Read-only task listing. |
| `task_create` | `title`, `quadrant`, `estimatedPomodoros`, `groupId` | Enqueue a creation proposal; nothing is written until the user confirms. |
| `task_start` | `taskId`, `focusMinutes` | Start a round bound to an existing `active` task. |
| `task_update` | `taskId`, `patch`, `title`, `estimatedPomodoros`, `groupId` | Enqueue an update proposal. |
| `skill_list` | — | List workspace skills (60-second cache). |
| `focus_plan` | `goal`, `minutes` | Read-only plan combining the current session, tasks, and matching skills. |
| `agent_summary` | `days` (1–90, default 7) | Today's agent activity plus focus collaboration. |

Guarantees:

- The agent cannot change EXP, completed pomodoros, or history.
- Task mutations are proposals; only the UI confirms them.
- Every tool call is written to the audit log (when `auditEnabled` is on), trimmed to 1000 entries and 90 days.
- `focus_plan` and `skill_list` never write data.

## HTTP API

All routes are registered on `ctx.webServer` behind the DSH connection trust fence, so they are reachable from the Web UI session.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/dsh-pomodoro/events` | Server-Sent Events: snapshot and agent-context pushes |
| `GET` | `/dsh-pomodoro/state` | Full snapshot |
| `POST` | `/dsh-pomodoro/action` | `start`, `pause`, `resume`, `stop`, `setTask`, `setMode`, `redeemOutfit` |
| `GET` / `POST` | `/dsh-pomodoro/settings` | Read or patch settings |
| `GET` | `/dsh-pomodoro/history` | Recent days |
| `GET` / `POST` / `PATCH` / `DELETE` | `/dsh-pomodoro/tasks` and `/tasks/:id` | Task CRUD |
| `GET` / `POST` / `PATCH` / `DELETE` | `/dsh-pomodoro/groups` and `/groups/:id` | Group CRUD |
| `GET` | `/dsh-pomodoro/heatmap`, `/trend`, `/quadrants`, `/hours` | Aggregations |
| `GET` | `/dsh-pomodoro/report?period=week\|month` | Weekly or monthly report |
| `GET` | `/dsh-pomodoro/achievements` | Achievement catalogue and inventory |
| `GET` | `/dsh-pomodoro/audit` | Audit log |
| `GET` / `POST` | `/dsh-pomodoro/proposals` | List, confirm, or reject proposals |
| `GET` | `/dsh-pomodoro/context` | Session, workspace, skills, and agent activity |
| `GET` | `/dsh-pomodoro/days`, `/sessions` | Daily and session aggregates |

## Data and storage

- Domain storage: `storageDomain: pomodoro_pet`, persisted at `$DSH_HOME/storages/pomodoro_pet.json` on the default single-file layout.
- Tables: `pets`, `sessions`, `days`, `settings`, `tasks`, `groups`, `achievements`, `inventory`, `proposals`, `audit_log`.
- Migration: stop DSH, copy `pomodoro_pet.json` to the same path on the new machine, then start DSH. Pet level, tasks, stats, and achievements are restored.
- Device preferences live in `localStorage` and do not travel with the data file: `pp-pet-pos`, `pp-pet-collapsed`, `pp-show-agent`, `pp-show-context`, `pp-seen-settlement`.

## Development

The plugin has no build step. `client.js` is the ready-to-serve browser bundle with the English dictionary inlined; `i18n-en.mjs` is the dictionary source kept for editing, and `locale/*.json` provide the sidebar and page metadata.

```text
index.js              Host half: routes, tool, timer effects, storage
pet-engine.js         Pure state machine: focus rounds, EXP, mood, tasks
stats-engine.js       Heatmap, trends, quadrant/hour distributions, reports
achievement-engine.js 18 achievement definitions and evaluation
agent-bridge.js       Folds DSH session/agent/tool activity into context
client.js             Client half: the complete React UI
i18n-en.mjs           English dictionary source
locale/*.json         Localized plugin metadata
install.sh            Idempotent installer
*.test.mjs            Engine and bridge unit tests
```

Run the tests:

```bash
node --test engine.test.mjs v03-engine.test.mjs v04-engine.test.mjs agent-bridge.test.mjs
```

Expected: 107 tests, 107 passing. Changing `client.js` needs a browser refresh (hard-refresh if the client bundle is cached); changing any Host file needs a `dsh web` restart.

## Troubleshooting

- **No sidebar icon, or an empty panel.** Check the `dsh web` log for `pomodoro-pet` errors, then verify the YAML indentation in `cordis.patch.yml` and that the bundle appears in `dsh.profile.bundles`.
- **`/dsh-pomodoro/state` returns 404.** The Host half did not load. Check the bundle list, the `@local` symlink, and whether DSH was restarted.
- **`Cannot find module '@local/dsh-pomodoro-pet'`.** The symlink or the `link:` path is wrong; inspect `~/.dsh/profiles/web/node_modules/@local/`.
- **Changes to `client.js` do not appear.** The client bundle is cached; hard-refresh. Host changes always need a restart.
- **Shortcuts do nothing.** They only work while the panel is mounted and focus is not inside an input or dialog.
- **Theme does not follow DSH.** The plugin reads the DSH theme; restart DSH after changing Settings → General → Appearance.
- **No desktop notification.** Grant the browser permission; notifications from a background tab also depend on browser policy.

## Uninstall

1. Remove `@local/dsh-pomodoro-pet` from `dsh.profile.bundles` and from `dependencies` in `~/.dsh/profiles/web/package.json`.
2. Remove the `pomodoro-pet` row from `cordis.patch.yml`.
3. Remove the symlink: `rm ~/.dsh/profiles/web/node_modules/@local/dsh-pomodoro-pet`.
4. Restart `dsh web`.

Data is not deleted automatically. Delete `$DSH_HOME/storages/pomodoro_pet.json` to reset everything.

## License

MIT © 2026 chris. See [LICENSE](LICENSE).
