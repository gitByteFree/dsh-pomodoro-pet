# 🍅 Pomodoro Pet (番茄精灵)

A focus companion for DSH Web: a pomodoro timer, four-quadrant tasks, and a pet that grows along with your focus.

![Pomodoro Pet focus panel](https://cdn.jsdelivr.net/gh/gitByteFree/dsh-pomodoro-pet@main/png/focus-panel.png)

**Version 0.9.2** · Requires DSH Web `0.2.1-rc.2`+ · Zero npm dependencies · Data stays on your machine

**English** | [中文](README.zh.md)

## In one sentence

Open 🍅 in the DSH sidebar and start a focus round. When it ends, your pet gains EXP and the stats are recorded. Sort work with four-quadrant tasks, and let the agent start timers or create tasks for you — it always asks before changing anything.

After installing you get:

- A 🍅 **Pomodoro Pet** entry in the sidebar
- A draggable pet capsule in the bottom-right corner of the chat page, with the remaining time always in view
- Focus, Stats, and Settings tabs; theme and language follow DSH automatically

## Features

### ⏱ Focus timer

- Three modes: **Standard 25 min / Deep 50 min / Sprint 15 min**
- Or set any custom length between 5 and 120 minutes
- Start, pause, resume, stop; focus rounds flow into automatic short and long breaks
- A round is restored from its deadline after a DSH restart, and missed settlements are reconciled
- Chime and desktop notifications, so you still hear about it when the tab is in the background

| Mode | Default length | Best for |
| --- | --- | --- |
| Standard | 25 min | Daily tasks and routine work |
| Deep | 50 min | Coding, writing, anything that needs immersion |
| Sprint | 15 min | Getting started, or clearing small items |

### ✅ Four-quadrant tasks

- Sort tasks into **A urgent & important / B important & not urgent / C urgent & not important / D other**
- Estimate a task in pomodoros and bind focus rounds to it; EXP follows the task's quadrant
- Drag tasks between quadrants, complete or reopen them, filter by quadrant
- Group related tasks together

### 🐣 A pet that grows

- Every completed focus round grants EXP; evolve through **Sprout → Red fruit → Glowing fruit → Rainbow king**
- Mood reacts to focus, breaks, abandonment, and level-ups; you can feed and greet it
- 18 achievements reward outfit fragments; 10 fragments redeem one of 4 outfits
- Resize the pet, drag it anywhere, or tuck it into a compact capsule

![Pet capsule](https://cdn.jsdelivr.net/gh/gitByteFree/dsh-pomodoro-pet@main/png/pet-capsule.png)

*When you are busy, tuck the pet into the capsule at the bottom-right of the chat page: the countdown, pause, and stop controls stay within reach.*

### 📊 Stats you can actually use

- A focus heatmap for the last six months or the full year, so you can see how much you focused each day
- Weekly focus time, time-of-day buckets (morning / afternoon / evening / late night), and quadrant distribution
- Attribution by session and workspace, so you can see which project got your time
- Weekly and monthly reports, portrait and landscape share cards (PNG), and JSON backup
- Agent activity: whether DSH is running, tools used today, and step counts

### 🤖 Focus together with the agent

The plugin exposes a `pomodoro_pet` tool to the agent:

- Start, pause, or stop the timer, or ask for the current focus status
- Read recent stats and list tasks
- **Propose** new tasks or edits — nothing is written until you confirm in the UI
- Build a read-only focus plan from the current session, tasks, and available skills

Just ask in a DSH conversation:

- "Start a 25-minute focus round"
- "Show me today's focus stats"
- "Add 'write weekly report' to quadrant B with an estimate of 2 pomodoros"

### 🔒 Data stays on your machine

- No uploads, no telemetry, no remote calls
- Session names, workspace paths, and task titles are shown locally only; task titles are hidden by default
- Agent context never appears in exported files
- Data lives in `$DSH_HOME/storages/pomodoro_pet.json`; copy that file to migrate

## Installation

Before you start: **DSH Web** (`0.2.1-rc.2` or newer) and a modern browser with `localStorage`. The plugin has zero npm dependencies and needs no build step.

### Option 1: Install from npm (fastest)

The plugin is published on npm as `dsh-pomodoro-pet`.

In DSH, open **Plugins → Installed → Add plugin**, enter `dsh-pomodoro-pet`, and click **Install**. Or from a shell:

```bash
dsh plugin add dsh-pomodoro-pet
```

Then restart `dsh web` and refresh the browser. This path is not delayed by the plugin-market index cache.

### Option 2: Install from the plugin market

1. Open **Plugins** in DSH, enable the experimental **Custom plugin indexes** bundle, and go to **Discover**
2. Choose **Add index source** and paste:

   ```text
   https://cdn.jsdelivr.net/gh/gitByteFree/dsh-pomodoro-pet@main/market/index.json
   ```

3. Find **Pomodoro Pet** and install it
4. Restart `dsh web`, then refresh the browser

> The index is served through jsDelivr because the marketplace requires a direct `200` without redirects. A new release may take up to 12 hours to appear because of edge caching. Where GitHub is reachable, `https://raw.githubusercontent.com/gitByteFree/dsh-pomodoro-pet/main/market/index.json` serves the same file.

### Option 3: One-click script

```bash
tar -xzf dsh-pomodoro-pet-0.9.2.tar.gz
cd dsh-pomodoro-pet
./install.sh                # installs to ~/dsh-plugins, profile "web"
```

The script copies the plugin, registers it in the profile, creates the `node_modules` symlink, and injects the patch. It is idempotent. Then restart DSH:

```bash
# Press Ctrl+C in the terminal running dsh web, then start it again
dsh web
```

Custom location or profile:

```bash
./install.sh --dest ~/my-plugins --profile web
./install.sh --home /path/to/.dsh --profile web
```

### Option 4: Manual installation

<details>
<summary>Expand the manual steps (for people who want to see exactly what happens)</summary>

1. Copy the plugin to a stable location, e.g. `~/dsh-plugins/dsh-pomodoro-pet`
2. Edit `~/.dsh/profiles/web/package.json`:
   - Add `"dsh-pomodoro-pet": "link:/home/<you>/dsh-plugins/dsh-pomodoro-pet"` to `dependencies`
   - Add `"dsh-pomodoro-pet"` to the end of `dsh.profile.bundles`
3. Create the symlink:

   ```bash
   mkdir -p ~/.dsh/profiles/web/node_modules
   ln -sfn ~/dsh-plugins/dsh-pomodoro-pet ~/.dsh/profiles/web/node_modules/dsh-pomodoro-pet
   ```

4. Append the plugin row to `~/.dsh/profiles/web/cordis.patch.yml`:

   ```yaml
   - insert:
       - id: pomodoro-pet
         name: 'dsh-pomodoro-pet'
         config: {}
   ```

5. Restart `dsh web` and refresh the browser

For a detailed walkthrough, see [INSTALL.md](https://github.com/gitByteFree/dsh-pomodoro-pet/blob/main/INSTALL.md) (Chinese).

</details>

### Verify the install

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3080/dsh-pomodoro/state
```

A `200` means the Host half loaded. `3080` is `dsh web`'s default port; if you started it with `--port` (for example `8080`), use that port instead.

In the GUI you should see:

- 🍅 **Pomodoro Pet** in the sidebar
- A draggable pet capsule in the bottom-right corner
- Version `0.9.2` under Settings → About

## Quick start

### Shortcuts

Available while the panel is open:

| Key | Action |
| --- | --- |
| `Space` | Start / pause / resume |
| `S` | Stop the current round (during a break: skip it) |
| `1` / `2` / `3` | Switch Standard / Deep / Sprint |
| `?` | Toggle the shortcuts overlay |
| `Esc` | Close a dialog / leave an input |

> Shortcuts only work while the Pomodoro Pet panel is open; inside an input or dialog only `Esc` is handled. Stopping a focus round counts as abandonment: no EXP, mood −1, round streak reset. Stopping a break has no penalty.

### Three tabs

- **Focus**: timer, current task, today's progress, pet status, task distribution
- **Stats**: heatmap, trends, time-of-day and quadrant distributions, reports, share cards
- **Settings**: durations, alerts, pet size, stats time zone, data export

![Settings](https://cdn.jsdelivr.net/gh/gitByteFree/dsh-pomodoro-pet@main/png/settings.png)

*Settings: timer, sound and alerts, appearance, agent integration, pet, stats, and data — all on one page.*

## FAQ

<details>
<summary>Expand troubleshooting</summary>

- **No sidebar icon / blank panel**: check the `dsh web` log for `pomodoro-pet` errors, then verify the `cordis.patch.yml` indentation and that the bundle is in `dsh.profile.bundles`
- **`/dsh-pomodoro/state` returns 404**: the Host half did not load. Check the symlink and bundle list, and confirm you restarted `dsh web`
- **`Cannot find module 'dsh-pomodoro-pet'`**: the symlink or `link:` path is wrong; inspect `~/.dsh/profiles/web/node_modules/`
- **Changes to `client.js` do not appear**: the client bundle is cached; hard-refresh. Host-side changes always require a `dsh web` restart
- **No desktop notification**: grant the browser permission; background-tab notifications also depend on browser policy
- **Theme / language does not follow DSH**: the plugin follows DSH's Settings → General → Appearance / Language; restart DSH after changing them

</details>

## Data and uninstall

- Data file: `$DSH_HOME/storages/pomodoro_pet.json`
- Migration: stop DSH, copy that file to the same path on the new machine, start DSH
- Uninstall: remove `dsh-pomodoro-pet` from `~/.dsh/profiles/web/package.json`, delete the 4 patch lines from `cordis.patch.yml`, remove the `node_modules` symlink, restart `dsh web`
- Uninstalling keeps your data; delete the JSON file above to reset everything

## Development

- No build step: `client.js` is a browser-ready bundle
- Agent tool parameters, HTTP API, file map, and storage tables: see [DEVELOPMENT.md](https://github.com/gitByteFree/dsh-pomodoro-pet/blob/main/DEVELOPMENT.md)
- Run the unit tests:

  ```bash
  node --test engine.test.mjs v03-engine.test.mjs v04-engine.test.mjs agent-bridge.test.mjs
  # 107 tests, all passing
  ```

## License

MIT © 2026 chris. See [LICENSE](LICENSE).
