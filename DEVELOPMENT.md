# Pomodoro Pet · Developer Reference

Technical details for developers and tool authors. User-facing docs: [README.md](README.md) / [README.zh.md](README.zh.md). Install walkthrough: [INSTALL.md](INSTALL.md).

- Version: **0.10.0**
- Runtime: DSH Web / Desktop `0.2.1-rc.2` or newer
- Dependencies: none — plain ESM on the Host, injected React UI on the Client

## Runtime requirements

The plugin needs these services from the DSH profile:

| Side | Services |
| --- | --- |
| Host | `storageDomain`, `webServer`, `tools`, `timer` |
| Host (fence) | `connection` — resolved per request with `ctx.get('connection')` |
| Client | `slots`, `locale`; optional `uiWorkspace` (used to open a waiting session) |

The stock `web` profile provides all of them. If `connection` is missing, every HTTP route fails closed with `503` rather than serving unauthenticated requests.

DSH Desktop runs the same Web client inside Electron: its profile is initialized from the `web` template, so the same services are mounted and `dsh.client.platform: "web"` is correct. Keep every Client URL document-relative (`/dsh-pomodoro/...`): Desktop forwards unknown `dsh-app://app/*` paths to its authenticated Host on an OS-assigned port, serves `/assets/*` from its own bundle, and does not forward page-initiated WebSocket upgrades — use SSE plus `fetch`.

## File map

```text
index.js              Host half: routes, tool, timer effects, storage
pet-engine.js         Pure state machine: focus rounds, EXP, mood, tasks
stats-engine.js       Heatmap, trends, quadrant/hour distributions, reports
achievement-engine.js 18 achievement definitions and evaluation
agent-bridge.js       Folds DSH session/agent/tool activity into context
client.js             Client half: the complete React UI (no build step)
i18n-en.mjs           Generated readable copy of the dictionary in client.js
locale/*.json         Localized plugin metadata
scripts/sync-i18n.mjs Regenerates i18n-en.mjs from client.js
install.sh            Idempotent installer
*.test.mjs            Engine, bridge, Host-route, and i18n guard tests
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

## Agent/session waiting observation (read-only)

The Host watches two DSH waterfalls per root agent and never changes their result:

| Event | Meaning |
| --- | --- |
| `user-questions/request` | The agent is waiting for the user to answer a question |
| `approval/request` | The agent is waiting for the user to approve a tool call |
| `approval/asked` / `approval/decided` (session events) | Durable fallback when the waterfall listener is missing (not a replay source after reload) |

Implementation rules:

- Listeners are installed on `agent.ctx` for root sessions (`agent/created` + `agents.list()` on boot) and fall back to the global `ctx.on` channel; `agent/disposed`/`session/disposed` clear them.
- The wrapper calls `next()` exactly once and returns its value unchanged. It never answers, rejects, mutates the request, or extends the prompt.
- Listeners are registered with `{ prepend: true }` so observation runs before an answerer that might claim the waterfall without calling `next()`; the wrapper still delegates unchanged.
- `beginWait(session, kind, { toolName })` / `endWait(...)` are refcounted, so the waterfall and the `approval/asked|decided` audit pair cannot double-count.
- Only root sessions are observed; subagent children are ignored.
- Waiting changes bypass the 800 ms SSE agent-frame throttle so the UI reacts immediately.

`GET /dsh-pomodoro/context` and every `agent` SSE frame now include:

```json
"agent": {
  "waiting": {
    "active": true,
    "count": 1,
    "list": [
      { "sessionId": "…", "kind": "approval", "since": 0, "toolName": "bash", "label": "session title", "cwdName": "repo" }
    ]
  }
}
```

The daily agent bucket (`settings` key `_agent_<YYYY-MM-DD>`) additionally stores `questions`, `approvals`, and `waitMs`; older buckets without those fields read as 0.

The Client renders the same list three ways: the `pomodoro-pet-wait` overlay banner (flashing, dismissible), a `ContextBar` chip, and an `AgentWaitCard` in the Focus tab. All three call `uiWorkspace.openSession(sessionId)`; desktop notifications use `tag: pp-wait-<sessionId>` and also open the session on click. Device preferences: `pp-wait-alert` (in-app banner, default on) and `pp-wait-notify` (desktop notification, default on). The overlay is excluded from animation only when `prefers-reduced-motion` or `animationEnabled=false`, matching the rest of the UI.

## HTTP API

All routes are registered on `ctx.webServer` behind the DSH connection trust fence, so they are reachable from the Web UI session. The fence is resolved per request (`ctx.get('connection')`): untrusted requests get the fence's `401`/`403`, and if the service is unavailable every route fails closed with `503`.

`POST /settings` validates the whole patch before writing anything (`SETTING_RULES`): unknown keys, wrong types, out-of-range numeric strings, and invalid IANA time zones return `400 { ok: false, code: 'invalid', field }`. Persisted settings are re-sanitized on boot, so a corrupt value written by an older version cannot break `/state` or the SSE stream.

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

- Domain storage: `storageDomain: pomodoro_pet`, persisted at `$DSH_HOME/storages/pomodoro_pet/` on the `per-record` layout (one JSON document per row, so a write costs a constant ~2-4ms instead of republishing the whole file). The storage backend automatically bootstraps this tree from the legacy 0.9.4 single file `$DSH_HOME/storages/pomodoro_pet.json` on first open and leaves that file untouched as a backup.
- Tables: `pets`, `sessions`, `days`, `settings`, `tasks`, `groups`, `achievements`, `inventory`, `proposals`, `audit_log`.
- Retention: settled `sessions` rows older than the `maxSessionDays` plugin config (default 90) are deleted in small batches (one batch on boot, then one per reconcile tick); deletes are cheap now that each row is its own file. `days` aggregates behind the heatmap/reports are never pruned; waiting/running rows are never pruned.
- Migration: stop DSH and copy `storages/pomodoro_pet/` (0.9.5+) to the new machine; from ≤0.9.4 copy the single `storages/pomodoro_pet.json` and the first start migrates it automatically. Pet level, tasks, stats, and achievements are restored.
- Device preferences live in browser `localStorage` and do not travel with the data file: `pp-pet-pos`, `pp-pet-collapsed`, `pp-show-agent`, `pp-show-context`, `pp-wait-alert`, `pp-wait-notify`, `pp-seen-settlement`.

## Development

There is no build step. `client.js` is the ready-to-serve browser bundle and it owns the only English dictionary the browser executes (the `EN_TEXT` / `PATTERNS` blocks between the `i18n:*` markers). `i18n-en.mjs` is a generated, readable copy: after editing the inline dictionary run `node scripts/sync-i18n.mjs`; `i18n.test.mjs` fails when the copy is stale.

Two rules keep user data out of the translation pipeline (both pinned by `i18n.test.mjs`):

- wrap task names, group names, session labels, workspace names, and skill names with `raw(value)`; `h()` unwraps it to a plain string and never translates it;
- when data must sit inside UI copy, build the string with `trRaw('删除任务 {title}', { title })` for anything passed to `h()` (the result is already translated, so `h()` must not translate it a second time), or `trf(...)` when the result is consumed as a plain string (confirm dialogs, canvas, templates). The template is translated first; the data is only substituted afterwards.

Changing `client.js` needs a browser refresh (hard-refresh if the client bundle is cached). Changing any Host file (`index.js`, `*-engine.js`) needs a `dsh web` restart.

Run the tests:

```bash
node --test
```

Expected: 129 tests, 129 passing. `host.test.mjs` loads the real `apply()` on an in-memory context and pins the trust fence, settings validation, break→waiting persistence/restart, and read-only waiting observation (pass-through, approval audit folding, waterfall/audit overlap, `agent/created` install, `session/disposed` cleanup, subagent exclusion, multi-session sorting, model-facing summary sanitization); `i18n.test.mjs` pins dictionary sync and the `raw()` / `trRaw()` / `trf()` data boundary.
