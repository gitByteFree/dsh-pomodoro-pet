# Pomodoro Pet · Developer Reference

Technical details for developers and tool authors. User-facing docs: [README.md](README.md) / [README.zh.md](README.zh.md). Install walkthrough: [INSTALL.md](INSTALL.md).

- Version: **0.9.4**
- Runtime: DSH Web `0.2.1-rc.2` or newer
- Dependencies: none — plain ESM on the Host, injected React UI on the Client

## Runtime requirements

The plugin needs these services from the DSH profile:

| Side | Services |
| --- | --- |
| Host | `storageDomain`, `webServer`, `tools`, `timer` |
| Client | `slots`, `locale` |

The stock `web` profile provides all of them.

## File map

```text
index.js              Host half: routes, tool, timer effects, storage
pet-engine.js         Pure state machine: focus rounds, EXP, mood, tasks
stats-engine.js       Heatmap, trends, quadrant/hour distributions, reports
achievement-engine.js 18 achievement definitions and evaluation
agent-bridge.js       Folds DSH session/agent/tool activity into context
client.js             Client half: the complete React UI (no build step)
i18n-en.mjs           English dictionary source (client.js has an inlined copy)
locale/*.json         Localized plugin metadata
install.sh            Idempotent installer
*.test.mjs            Engine and bridge unit tests
cordis.patch.yml      One Host plugin row
```

## Agent tool: `pomodoro_pet`

The Host registers one raw tool definition. Its description and parameters are model-facing, and every call is serialized through the same command chain as UI actions.

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
- Device preferences live in browser `localStorage` and do not travel with the data file: `pp-pet-pos`, `pp-pet-collapsed`, `pp-show-agent`, `pp-show-context`, `pp-seen-settlement`.

## Development

There is no build step. `client.js` is the ready-to-serve browser bundle with the English dictionary inlined; `i18n-en.mjs` is the dictionary source kept for editing.

Changing `client.js` needs a browser refresh (hard-refresh if the client bundle is cached). Changing any Host file (`index.js`, `*-engine.js`) needs a `dsh web` restart.

Run the tests:

```bash
node --test engine.test.mjs v03-engine.test.mjs v04-engine.test.mjs agent-bridge.test.mjs
```

Expected: 107 tests, 107 passing.
