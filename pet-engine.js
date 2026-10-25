/**
 * Pomodoro Pet — pure transition engine.
 *
 * transition(state, event, ctx) → { state, effects }
 *
 * Pure: no Date.now, no Math.random, no I/O. Time comes from ctx.now(),
 * time zone from ctx.tz, configured durations from state.settings.
 * All effects (timer re-arm, notify, persist) are returned as data for the
 * Host service to execute — this module never performs them.
 *
 * Invariants (DESIGN.md §4.1):
 *   running  : endsAt != null && remainingMs == null
 *   paused   : remainingMs != null && endsAt == null
 *   settled  : sessions rows never re-settle — the status flip IS the settle.
 */

/* ------------------------------------------------------------------ *
 * Constants (tuning table, DESIGN.md §6)                             *
 * ------------------------------------------------------------------ */

export const EXP = { pomodoro: 10, breakDone: 2, dailyStreakBonus: 5 }
export const MOOD = { initial: 3, min: 0, max: 5, abandon: -1, levelUp: 1 }
export const EVOLVE = [
  { level: 1, stage: 'sprout' },
  { level: 3, stage: 'fruit' },
  { level: 5, stage: 'glow' },
  { level: 7, stage: 'rainbow' },
]
/** Quadrant EXP bases (DESIGN.md §7.1): no task → UNCATEGORIZED_EXP. */
export const QUADRANT_EXP = Object.freeze({ A: 10, B: 12, C: 8, D: 5 })
export const UNCATEGORIZED_EXP = 10
/** Focus modes (DESIGN.md §4.5): default minutes + EXP multiplier. */
export const MODES = Object.freeze({
  standard: Object.freeze({ focusMin: 25, mult: 1.0 }),
  deep: Object.freeze({ focusMin: 50, mult: 1.2 }),
  sprint: Object.freeze({ focusMin: 15, mult: 0.8 }),
})
export const QUADRANTS = Object.freeze(['A', 'B', 'C', 'D'])
export const TASK_STATUSES = Object.freeze(['active', 'done', 'archived'])
/** focusMinutes 合法域（D19/D20）：<5 不构成有效专注，防「1 分钟番茄保 streak」。 */
export const FOCUS_MIN_MIN = 5
export const FOCUS_MAX_MIN = 120
export const DEFAULT_SETTINGS = Object.freeze({
  focusMin: 25, breakMin: 5, longBreakMin: 15, roundsPerLong: 4,
  soundEnabled: true, statsTimeZone: null, petPosition: null, petScale: 1,
  mode: 'standard', defaultQuadrant: 'B',
  // v0.4 settings keys (§10.2, 与 §13.6 UI 对齐)
  volume: 0.5, notificationEnabled: true, animationEnabled: true,
  dailyGoalPomodoros: 8, maxPauseMin: 15, auditEnabled: true,
  reconcileIntervalMs: 30_000, dailyFeedLimit: 3,
})

/* ------------------------------------------------------------------ *
 * Derived helpers (also exported for tests)                          *
 * ------------------------------------------------------------------ */

/** EXP needed to advance FROM level `lv`. */
export const needFor = (lv) => 30 + lv * 20

/**
 * EXP for one completed focus (DESIGN.md §7.1):
 *   exp = round(base(quadrant) * modeMult * focusMinutes / 25), min 1.
 */
export function expFor(quadrant, mode, focusMinutes) {
  const base = quadrant ? (QUADRANT_EXP[quadrant] ?? UNCATEGORIZED_EXP) : UNCATEGORIZED_EXP
  const mult = MODES[mode]?.mult ?? 1
  const minutes = Math.max(1, Number(focusMinutes) || 25)
  return Math.max(1, Math.round(base * mult * minutes / 25))
}

/** Evolution stage for a level. */
export function stageFor(level) {
  let stage = EVOLVE[0].stage
  for (const e of EVOLVE) if (level >= e.level) stage = e.stage
  return stage
}

/**
 * Canonical `YYYY-MM-DD` for a UTC-ms instant under an IANA time zone.
 * en-CA yields ISO-formatted dates across all ICU builds.
 */
export function dayOf(ms, tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms))
}

/** Days between two canonical dates (a.full string compare works: ISO). */
export function prevDay(day) {
  const [y, m, d] = day.split('-').map(Number)
  return dayOf(Date.UTC(y, m - 1, d) - 86_400_000, 'UTC')
}

/* ------------------------------------------------------------------ *
 * State shape                                                        *
 * ------------------------------------------------------------------ */

export function initialState(now = 0, settingsPatch) {
  return {
    pet: { exp: 0, level: 1, mood: MOOD.initial, rounds: 0, outfitId: null, updatedAt: now },
    running: null,           // active session record or null
    history: [],             // settled sessions (newest last), kept small here; Host persists tables
    days: {},                // 'YYYY-MM-DD' → { completed, focusMinutes, streak, expGained, quadrantA..D, uncategorized, hours, moodEnd }
    settings: { ...DEFAULT_SETTINGS, ...settingsPatch },
    // v0.3 task system (DESIGN.md §6): plain JSON maps keyed by id.
    tasks: {},               // id → task row
    groups: {},              // id → group row
    activeTaskId: null,      // default task for the next START; mirrors running taskId
    lastSettlement: null,    // §11.2 settlement-panel payload (focus settles only)
    seq: 0,                  // id counter for tasks/groups
    achievements: {},        // id → { unlockedAt, meta } (§7.4)
    inventory: {},           // itemId → { count, firstObtainedAt }
  }
}

/* ------------------------------------------------------------------ *
 * Event constructors                                                 *
 * ------------------------------------------------------------------ */

export const START = (focusMin, opts = {}) =>
  ({ type: 'START', focusMin, taskId: opts.taskId, mode: opts.mode })
export const PAUSE = () => ({ type: 'PAUSE' })
export const RESUME = () => ({ type: 'RESUME' })
export const STOP = () => ({ type: 'STOP' })
export const TICK_EXPIRE = () => ({ type: 'TICK_EXPIRE' })
export const SET_TASK = (taskId) => ({ type: 'SET_TASK', taskId: taskId ?? null })
export const SET_MODE = (mode) => ({ type: 'SET_MODE', mode })
export const REDEEM_OUTFIT = (itemId) => ({ type: 'REDEEM_OUTFIT', itemId })
export const TASK_CREATE = (task) => ({ type: 'TASK_CREATE', task })
export const TASK_UPDATE = (taskId, patch) => ({ type: 'TASK_UPDATE', taskId, patch })
export const TASK_DELETE = (taskId) => ({ type: 'TASK_DELETE', taskId })
export const GROUP_CREATE = (name) => ({ type: 'GROUP_CREATE', name })
export const GROUP_UPDATE = (groupId, patch) => ({ type: 'GROUP_UPDATE', groupId, patch })
export const GROUP_DELETE = (groupId) => ({ type: 'GROUP_DELETE', groupId })

/* ------------------------------------------------------------------ *
 * Internal fold helpers                                              *
 * ------------------------------------------------------------------ */

function emptyDay() {
  return {
    completed: 0, focusMinutes: 0, streak: 0, expGained: 0,
    quadrantA: 0, quadrantB: 0, quadrantC: 0, quadrantD: 0, uncategorized: 0,
    hours: JSON.stringify(new Array(24).fill(0)), moodEnd: null,
  }
}

function parseHours(row) {
  try { return JSON.parse(row?.hours) } catch { return null }
}

/** Canonical date diff in days (b - a), both YYYY-MM-DD. */
function dayDiff(a, b) {
  const pa = a.split('-').map(Number)
  const pb = b.split('-').map(Number)
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86_400_000)
}

function creditDay(state, now, focusMin, expGain, quadrant, mood) {
  const tz = state.settings.statsTimeZone
  const day = dayOf(now, tz)
  const prev = state.days[day] ?? emptyDay()
  const prevDayRow = state.days[prevDay(day)]
  const isFirstToday = prev.completed === 0
  const streak = isFirstToday ? ((prevDayRow?.streak ?? 0) + 1) : prev.streak
  const bonus = isFirstToday && (prevDayRow?.streak ?? 0) >= 1 ? EXP.dailyStreakBonus : 0
  const bucket = quadrant ? `quadrant${quadrant}` : 'uncategorized'
  // hours 桶（§10.2）：按结算时刻落桶，供时段分布与晨/夜成就使用
  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz || 'UTC', hour: '2-digit', hour12: false,
  }).format(new Date(now)))
  const hours = parseHours(prev) ?? new Array(24).fill(0)
  hours[hour === 24 ? 0 : hour] += 1
  const row = {
    ...prev,
    completed: prev.completed + 1,
    focusMinutes: prev.focusMinutes + focusMin,
    streak,
    expGained: prev.expGained + expGain + bonus,
    [bucket]: (prev[bucket] ?? 0) + 1,
    hours: JSON.stringify(hours),
    moodEnd: mood ?? prev.moodEnd,
  }
  return { day, expGain: expGain + bonus, row }
}

/** Add EXP to a day's expGained without counting a pomodoro (break completion). */
function creditDayExp(state, now, exp, mood) {
  const tz = state.settings.statsTimeZone
  const day = dayOf(now, tz)
  const prev = state.days[day] ?? emptyDay()
  return { day, row: { ...prev, expGained: prev.expGained + exp, moodEnd: mood ?? prev.moodEnd } }
}

function grantExp(state, now, amount, moodDelta = 0) {
  let exp = state.pet.exp + amount
  let level = state.pet.level
  let levelUps = 0
  while (exp >= needFor(level)) { exp -= needFor(level); level += 1; levelUps += 1 }
  const mood = Math.max(MOOD.min, Math.min(MOOD.max, state.pet.mood + moodDelta + levelUps))
  return {
    pet: { ...state.pet, exp, level, mood, updatedAt: now },
    levelUps,
    stage: stageFor(level),
  }
}

const remainingOf = (session, now) =>
  session.endsAt != null ? session.endsAt - now : session.remainingMs

/* ------------------------------------------------------------------ *
 * transition — the ONLY state mutation path (DESIGN.md §4.2)         *
 * ------------------------------------------------------------------ */

/**
 * @param state full engine state (plain JSON)
 * @param event one of the constructors above
 * @param ctx { now(): number }
 * @returns { state, effects, code? } — code 'busy'|'stale'|'already_settled' on rejection
 */
export function transition(state, event, ctx) {
  const now = ctx.now()
  const running = state.running
  const status = running?.status ?? 'idle'

  switch (event.type) {
    /* ---------------- START (§4.5 task binding + D19 duration) -------- */
    case 'START': {
      if (running && running.status !== 'waiting') return { state, effects: [], code: 'busy' }
      const mode = MODES[event.mode] ? event.mode
        : (MODES[state.settings.mode] ? state.settings.mode : 'standard')
      const defaultMin = mode === 'standard' ? state.settings.focusMin : MODES[mode].focusMin
      const requested = event.focusMin ?? defaultMin
      const focusMin = Math.floor(Number(requested))
      // D19/D20: 合法域 [5,120]，越界不建会话、不计 streak
      if (!Number.isFinite(focusMin) || focusMin < FOCUS_MIN_MIN || focusMin > FOCUS_MAX_MIN) {
        return { state, effects: [], code: 'limit_exceeded' }
      }
      let task = null
      const taskId = event.taskId !== undefined ? event.taskId : state.activeTaskId
      if (taskId != null) {
        task = state.tasks[taskId]
        if (!task) return { state, effects: [], code: 'not_found' }
        if (task.status !== 'active') return { state, effects: [], code: 'invalid_state' }
      }
      // §4.3.1: waiting→START 在同一次写中终态化旧行（focus 已在 TICK_EXPIRE 结算）
      const closedOld = running
        ? { ...running, status: 'done', settledAt: running.settledAt ?? now, outcome: running.outcome ?? 'completed' }
        : null
      const session = {
        id: `s${now}`, kind: 'focus', status: 'focus', startedAt: now,
        endsAt: now + focusMin * 60_000,
        remainingMs: null, pausedAt: null, settledAt: null, outcome: null,
        source: event.source ?? 'ui', focusMinutes: focusMin, revision: (running?.revision ?? 0) + 1,
        roundIndex: state.pet.rounds ?? 0,
        taskId: task?.id ?? null, taskTitleSnapshot: task?.title ?? null,
        quadrant: null, mode,
      }
      return {
        state: {
          ...state,
          running: session,
          activeTaskId: task?.id ?? null,
          history: closedOld ? [...state.history, closedOld].slice(-200) : state.history,
        },
        effects: [{ type: 'armTimer', at: session.endsAt }, { type: 'snapshot' }],
      }
    }

    /* ---------------- PAUSE / RESUME (§4.1) ---------------- */
    case 'PAUSE': {
      // waiting has no clock to freeze; only timed statuses pause.
      if (!running || running.endsAt == null
        || !['focus', 'break', 'longBreak'].includes(running.status)) {
        return { state, effects: [], code: 'stale' }
      }
      const session = {
        ...running, remainingMs: Math.max(0, running.endsAt - now), endsAt: null, pausedAt: now,
        _pausedFrom: running.status, revision: running.revision + 1,
      }
      return { state: { ...state, running: session }, effects: [{ type: 'cancelTimer' }, { type: 'snapshot' }] }
    }
    case 'RESUME': {
      if (!running || running.remainingMs == null) return { state, effects: [], code: 'stale' }
      const session = {
        ...running, endsAt: now + running.remainingMs, remainingMs: null, pausedAt: null,
        _pausedFrom: undefined, revision: running.revision + 1,
      }
      delete session._pausedFrom
      return {
        state: { ...state, running: session },
        effects: [{ type: 'armTimer', at: session.endsAt }, { type: 'snapshot' }],
      }
    }

    /* ---------------- STOP（§4.3.1 会话行终态表） ---------------- */
    case 'STOP': {
      if (!running) return { state, effects: [], code: 'stale' }
      const pausedFrom = running.status === 'paused' ? (running._pausedFrom ?? 'focus') : null
      const isFocusPath = running.status === 'focus' || pausedFrom === 'focus'
      const isBreakPath = ['break', 'longBreak'].includes(running.status) || pausedFrom === 'break' || pausedFrom === 'longBreak'
      if (isFocusPath) {
        // 放弃专注：+0 EXP，mood -1，rounds 归零（D18）
        const settled = { ...running, status: 'done', settledAt: now, outcome: 'abandoned' }
        const grown = grantExp(state, now, 0, MOOD.abandon)
        return {
          state: {
            ...state,
            pet: { ...grown.pet, rounds: 0 },
            running: null, history: [...state.history, settled].slice(-200),
          },
          effects: [{ type: 'cancelTimer' }, { type: 'petSad' }, { type: 'snapshot' }],
        }
      }
      if (isBreakPath || running.status === 'waiting') {
        // 跳过休息/离开 waiting：无惩罚（waiting 已结算 completed）
        const settled = running.status === 'waiting'
          ? { ...running, status: 'done', settledAt: running.settledAt ?? now, outcome: 'completed' }
          : { ...running, status: 'done', settledAt: now, outcome: 'skipped' }
        return {
          state: {
            ...state,
            pet: { ...state.pet, rounds: 0 },
            running: null, history: [...state.history, settled].slice(-200),
          },
          effects: [{ type: 'cancelTimer' }, { type: 'snapshot' }],
        }
      }
      return { state, effects: [], code: 'stale' }
    }

    /* ---------------- TICK_EXPIRE (§4.2: the flip IS the settle) ---------------- */
    case 'TICK_EXPIRE': {
      if (!running || running.endsAt == null || running.endsAt > now) {
        return { state, effects: [], code: 'already_settled' }
      }
      if (running.status === 'focus') {
        // 1) settle the focus (single atomic flip + credit, §4.2).
        // Quadrant/mode snapshots are taken at settle time and never retroactively
        // changed by later task edits (D10: 统计口径不追溯).
        const task = running.taskId ? state.tasks[running.taskId] : null
        const quadrant = task?.quadrant ?? null
        const mode = running.mode ?? 'standard'
        const expGain = expFor(quadrant, mode, running.focusMinutes)
        // 惰性心情（§7.3）：距上次完成 ≥3 天，结算前补扣 mood（扣至 0）。
        // 扫描含 today：今天已有完成则 diff=0，不扣（同日多次结算不重复扣）。
        const tz = state.settings.statsTimeZone
        const today = dayOf(now, tz)
        let lastDoneDay = null
        for (const [d, row] of Object.entries(state.days)) {
          if (d <= today && (row.completed ?? 0) > 0 && (!lastDoneDay || d > lastDoneDay)) lastDoneDay = d
        }
        const inertiaDelta = lastDoneDay && dayDiff(lastDoneDay, today) >= 3 ? -1 : 0
        const settled = {
          ...running, status: 'done', settledAt: now, outcome: 'completed',
          quadrant, taskTitleSnapshot: task?.title ?? running.taskTitleSnapshot ?? null, mode,
        }
        const credit = creditDay(state, now, running.focusMinutes, expGain, quadrant)
        const grown = grantExp(state, now, credit.expGain, inertiaDelta)
        let days = { ...state.days, [credit.day]: { ...credit.row, moodEnd: grown.pet.mood } }
        // D18 轮次：focus 结算 +1；达到 roundsPerLong → longBreak 且归零
        const newRounds = (state.pet.rounds ?? 0) + 1
        const isLong = newRounds >= state.settings.roundsPerLong
        const petRounds = isLong ? 0 : newRounds
        // 2) task tomato-strand +1 (§6.3: over-estimate auto-appends).
        let tasks = state.tasks
        if (task) {
          tasks = { ...state.tasks, [task.id]: { ...task, completedPomodoros: task.completedPomodoros + 1 } }
        }
        // 2.5) achievement check (§7.4) against the just-updated world
        // (include the freshly settled session — history is appended below).
        const provisional = { ...state, days, tasks, pet: grown.pet, history: [...state.history, settled] }
        const { unlocked, fragments } = evaluateAchievements(provisional, now)
        let achievements = state.achievements
        let inventory = state.inventory
        if (unlocked.length > 0) {
          achievements = { ...state.achievements }
          for (const a of unlocked) achievements[a.id] = { unlockedAt: a.unlockedAt, meta: a.meta }
          if (fragments > 0) {
            const inv = inventory[FRAGMENT_ITEM]
            inventory = {
              ...inventory,
              [FRAGMENT_ITEM]: {
                count: (inv?.count ?? 0) + fragments,
                firstObtainedAt: inv?.firstObtainedAt ?? now,
              },
            }
          }
        }
        // 3) settlement-panel payload (§8.1/§11.2); ts drives the 5-min carry rule.
        const lastSettlement = {
          id: settled.id, taskTitle: settled.taskTitleSnapshot, quadrant,
          focusMinutes: running.focusMinutes,
          expGained: credit.expGain, streak: credit.row.streak,
          leveledUp: grown.levelUps > 0, level: grown.level, ts: now,
          achievements: unlocked.map(a => ({ id: a.id, name: a.name, rarity: a.rarity })),
        }
        // 4) auto-enter the break (§4.3: focus end is automatic)
        const breakMin = isLong ? state.settings.longBreakMin : state.settings.breakMin
        const brk = {
          id: `s${now}b`, kind: 'break', status: isLong ? 'longBreak' : 'break', startedAt: now,
          endsAt: now + breakMin * 60_000, remainingMs: null, pausedAt: null,
          settledAt: null, outcome: null, source: running.source,
          focusMinutes: breakMin, revision: running.revision + 1, roundIndex: petRounds,
          taskId: running.taskId, taskTitleSnapshot: settled.taskTitleSnapshot,
          quadrant: settled.quadrant, mode,
        }
        const effects = [
          { type: 'armTimer', at: brk.endsAt },
          { type: 'petHappy' }, { type: 'notify', kind: 'focus-done' },
        ]
        if (grown.levelUps > 0) effects.push({ type: 'evolve', stage: grown.stage, level: grown.level })
        if (unlocked.length > 0) effects.push({ type: 'achievement', achievements: lastSettlement.achievements })
        return {
          state: {
            ...state, pet: { ...grown.pet, rounds: petRounds }, days, running: brk,
            tasks, lastSettlement, achievements, inventory,
            history: [...state.history, settled].slice(-200),
          },
          effects,
        }
      }
      if (running.status === 'break' || running.status === 'longBreak') {
        // Break end → waiting: remind only, never auto-start (§4.3). +2 EXP (§7.1).
        // waiting 是未终态行（§4.3.1）：留在 running，不进 history；在下次
        // START/STOP 时才终态化入档，避免 history 出现同 id 两行。
        const settled = { ...running, status: 'waiting', settledAt: now, outcome: 'completed' }
        const grown = grantExp(state, now, EXP.breakDone)
        const credit = creditDayExp(state, now, EXP.breakDone, grown.pet.mood)
        return {
          state: {
            ...state, pet: grown.pet, days: { ...state.days, [credit.day]: credit.row },
            running: settled,
          },
          effects: [{ type: 'notify', kind: 'break-done' }, { type: 'petCheer' }, { type: 'snapshot' }],
        }
      }
      return { state, effects: [], code: 'already_settled' }
    }

    /* ---------------- SET_TASK (§4.5: focus/paused rebinding) -------- */
    case 'SET_TASK': {
      const taskId = event.taskId ?? null
      if (taskId != null && !state.tasks[taskId]) return { state, effects: [], code: 'not_found' }
      let running2 = running
      if (running && ['focus', 'paused'].includes(running.status)) {
        running2 = { ...running, taskId, revision: running.revision + 1 }
      }
      return {
        state: { ...state, activeTaskId: taskId, running: running2 },
        effects: [{ type: 'snapshot' }],
      }
    }

    /* ---------------- REDEEM_OUTFIT（§7.6：10 碎片 = 1 装扮） -------- */
    case 'REDEEM_OUTFIT': {
      const inv = state.inventory[FRAGMENT_ITEM]
      if ((inv?.count ?? 0) < 10) return { state, effects: [], code: 'limit_exceeded' }
      const items = ['leaf-crown', 'blush-sticker', 'halo-pendant', 'crown-outline']
      const itemId = items.includes(event.itemId) ? event.itemId : items[(state.pet.outfitId ? items.indexOf(state.pet.outfitId) + 1 : 0) % items.length]
      return {
        state: {
          ...state,
          pet: { ...state.pet, outfitId: itemId, updatedAt: now },
          inventory: { ...state.inventory, [FRAGMENT_ITEM]: { ...inv, count: inv.count - 10 } },
        },
        effects: [{ type: 'snapshot' }],
      }
    }

    /* ---------------- SET_MODE (§4.5: idle/waiting only, locked in focus) */
    case 'SET_MODE': {
      if (!MODES[event.mode]) return { state, effects: [], code: 'invalid_state' }
      if (running && running.status !== 'waiting') return { state, effects: [], code: 'invalid_state' }
      return {
        state: { ...state, settings: { ...state.settings, mode: event.mode } },
        effects: [{ type: 'snapshot' }],
      }
    }

    /* ---------------- TASK CRUD (§6.4) ---------------- */
    case 'TASK_CREATE': {
      const input = event.task ?? {}
      const title = String(input.title ?? '').trim()
      if (!title) return { state, effects: [], code: 'invalid_state' }
      const quadrant = QUADRANTS.includes(input.quadrant)
        ? input.quadrant : (QUADRANTS.includes(state.settings.defaultQuadrant) ? state.settings.defaultQuadrant : 'B')
      const groupId = input.groupId ?? null
      if (groupId != null && !state.groups[groupId]) return { state, effects: [], code: 'not_found' }
      const estimatedPomodoros = clampInt(input.estimatedPomodoros, 1, 99, 1)
      const sortOrder = Math.max(-1, ...Object.values(state.tasks)
        .filter(t => t.status === 'active' && t.quadrant === quadrant)
        .map(t => t.sortOrder ?? 0)) + 1
      const id = `t${now}_${state.seq + 1}`
      const task = {
        id, title, groupId, quadrant, estimatedPomodoros, completedPomodoros: 0,
        status: 'active', sortOrder, createdAt: now, completedAt: null,
      }
      return {
        state: { ...state, tasks: { ...state.tasks, [id]: task }, seq: state.seq + 1 },
        effects: [{ type: 'snapshot' }],
        task,
      }
    }
    case 'TASK_UPDATE': {
      const t = state.tasks[event.taskId]
      if (!t) return { state, effects: [], code: 'not_found' }
      const patch = event.patch ?? {}
      const next = { ...t }
      if (patch.title !== undefined) {
        const title = String(patch.title ?? '').trim()
        if (title) next.title = title
      }
      if (patch.quadrant !== undefined && QUADRANTS.includes(patch.quadrant)) next.quadrant = patch.quadrant
      if (patch.estimatedPomodoros !== undefined) next.estimatedPomodoros = clampInt(patch.estimatedPomodoros, 1, 99, t.estimatedPomodoros)
      // §6.4 拖拽排序: 相邻中值插入需要小数位（如 2.5），保留 2 位防漂移
      if (patch.sortOrder !== undefined) next.sortOrder = Math.round(Number(patch.sortOrder) * 100) / 100 || 0
      if (patch.groupId !== undefined) {
        const gid = patch.groupId ?? null
        if (gid != null && !state.groups[gid]) return { state, effects: [], code: 'not_found' }
        next.groupId = gid
      }
      if (patch.status !== undefined && TASK_STATUSES.includes(patch.status)) {
        if (patch.status !== t.status) {
          next.status = patch.status
          next.completedAt = patch.status === 'done' ? now : null
        }
      }
      return {
        state: {
          ...state,
          tasks: { ...state.tasks, [t.id]: next },
          // a done/archived task can't stay the default for the next START
          activeTaskId: state.activeTaskId === t.id && next.status !== 'active' ? null : state.activeTaskId,
        },
        effects: [{ type: 'snapshot' }],
        task: next,
      }
    }
    case 'TASK_DELETE': {
      if (!state.tasks[event.taskId]) return { state, effects: [], code: 'not_found' }
      const tasks = { ...state.tasks }
      delete tasks[event.taskId]
      // sessions keep their snapshots; the running session just loses live lookups.
      return {
        state: {
          ...state, tasks,
          activeTaskId: state.activeTaskId === event.taskId ? null : state.activeTaskId,
        },
        effects: [{ type: 'snapshot' }],
      }
    }

    /* ---------------- GROUP CRUD (§6.2: flat, one level) ------------ */
    case 'GROUP_CREATE': {
      const name = String(event.name ?? '').trim()
      if (!name) return { state, effects: [], code: 'invalid_state' }
      const sortOrder = Math.max(0, ...Object.values(state.groups).map(g => g.sortOrder ?? 0)) + 1
      const id = `g${now}_${state.seq + 1}`
      const group = { id, name, sortOrder, createdAt: now }
      return {
        state: { ...state, groups: { ...state.groups, [id]: group }, seq: state.seq + 1 },
        effects: [{ type: 'snapshot' }],
        group,
      }
    }
    case 'GROUP_UPDATE': {
      const g = state.groups[event.groupId]
      if (!g) return { state, effects: [], code: 'not_found' }
      const patch = event.patch ?? {}
      const next = { ...g }
      if (patch.name !== undefined) {
        const name = String(patch.name ?? '').trim()
        if (name) next.name = name
      }
      if (patch.sortOrder !== undefined) next.sortOrder = Math.round(Number(patch.sortOrder) * 100) / 100 || 0
      return {
        state: { ...state, groups: { ...state.groups, [g.id]: next } },
        effects: [{ type: 'snapshot' }],
        group: next,
      }
    }
    case 'GROUP_DELETE': {
      if (!state.groups[event.groupId]) return { state, effects: [], code: 'not_found' }
      const groups = { ...state.groups }
      delete groups[event.groupId]
      const tasks = {}
      for (const [id, t] of Object.entries(state.tasks)) {
        tasks[id] = t.groupId === event.groupId ? { ...t, groupId: null } : t
      }
      return { state: { ...state, groups, tasks }, effects: [{ type: 'snapshot' }] }
    }

    default:
      return { state, effects: [], code: 'stale' }
  }
}

function clampInt(value, min, max, fallback) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

/** Display remaining ms for any running session (null when idle). */
export function displayRemaining(state, now) {
  if (!state.running) return null
  return Math.max(0, remainingOf(state.running, now))
}

/** Task list sort: quadrant A→D, then sortOrder, then createdAt (§13.5). */
const QUADRANT_ORDER = { A: 0, B: 1, C: 2, D: 3 }
export function sortedTasks(state) {
  return Object.values(state.tasks).sort((a, b) =>
    (QUADRANT_ORDER[a.quadrant] - QUADRANT_ORDER[b.quadrant])
    || ((a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    || ((a.createdAt ?? 0) - (b.createdAt ?? 0)))
}

/** Build the wire snapshot the Client renders (§11.2). */
export const SETTLEMENT_CARRY_MS = 5 * 60_000
export function snapshotOf(state, now, recentDays = 7) {
  const tz = state.settings.statsTimeZone
  const today = dayOf(now, tz)
  const history = []
  for (let i = 0; i < recentDays; i++) {
    const d = dayOf(now - i * 86_400_000, tz)
    const row = state.days[d]
    history.push({ date: d, completed: row?.completed ?? 0, focusMinutes: row?.focusMinutes ?? 0, streak: row?.streak ?? 0 })
  }
  const dayRow = state.days[today]
  const running = state.running
  const runningTask = running?.taskId ? state.tasks[running.taskId] : null
  // §8.1: 仅携带最近 5 分钟内的结算，超龄不携带（重载后由 seenSettlementId 双保险）
  const settlement = state.lastSettlement
    && (now - (state.lastSettlement.ts ?? 0)) <= SETTLEMENT_CARRY_MS
    ? state.lastSettlement : null
  return {
    now,
    serverNow: now,
    today,
    pet: { ...state.pet, stage: stageFor(state.pet.level) },
    running: running && {
      id: running.id, status: running.status,
      endsAt: running.endsAt, remainingMs: running.remainingMs,
      focusMinutes: running.focusMinutes, revision: running.revision,
      taskId: running.taskId ?? null,
      taskTitle: runningTask?.title ?? running.taskTitleSnapshot ?? null,
      quadrant: running.status === 'focus' ? (runningTask?.quadrant ?? null) : (running.quadrant ?? null),
      mode: running.mode ?? 'standard',
    },
    todayStats: {
      completed: dayRow?.completed ?? 0, focusMinutes: dayRow?.focusMinutes ?? 0, streak: dayRow?.streak ?? 0,
      quadrantA: dayRow?.quadrantA ?? 0, quadrantB: dayRow?.quadrantB ?? 0,
      quadrantC: dayRow?.quadrantC ?? 0, quadrantD: dayRow?.quadrantD ?? 0,
      uncategorized: dayRow?.uncategorized ?? 0,
    },
    recent: history.reverse(),
    tasks: sortedTasks(state),
    groups: Object.values(state.groups).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)),
    activeTaskId: state.activeTaskId,
    lastSettlement: settlement,
    achievements: state.achievements,
    inventory: state.inventory,
    settings: state.settings,
  }
}

/* Bottom hoisted import (ESM): achievement-engine needs stageFor from here;
 * keeping the import at the bottom avoids any init-order coupling. */
import { evaluate as evaluateAchievements, FRAGMENT_ITEM } from './achievement-engine.js'
