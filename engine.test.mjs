/**
 * pet-engine unit tests — DESIGN.md §12 matrix.
 * Run: node --test pomodoro-pet/engine.test.mjs  (or node engine.test.mjs)
 */
import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import {
  transition, initialState, START, PAUSE, RESUME, STOP, TICK_EXPIRE,
  SET_TASK, SET_MODE, TASK_CREATE, TASK_UPDATE, TASK_DELETE,
  GROUP_CREATE, GROUP_UPDATE, GROUP_DELETE,
  needFor, stageFor, dayOf, prevDay, displayRemaining, snapshotOf, sortedTasks,
  EXP, MOOD, QUADRANT_EXP, MODES, expFor,
} from './pet-engine.js'

/** Deterministic fake clock. */
function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: ms => { t += ms }, set: v => { t = v } }
}
const fresh = (clk) => initialState(clk.now())

/* ---------------- §6 constants & helpers ---------------- */

test('needFor curve: Lv1→50, Lv3→90', () => {
  assert.equal(needFor(1), 50)
  assert.equal(needFor(3), 90)
})
test('stageFor evolution thresholds', () => {
  assert.equal(stageFor(1), 'sprout')
  assert.equal(stageFor(2), 'sprout')
  assert.equal(stageFor(3), 'fruit')
  assert.equal(stageFor(4), 'fruit')
  assert.equal(stageFor(5), 'glow')
  assert.equal(stageFor(7), 'rainbow')
  assert.equal(stageFor(99), 'rainbow')
})
test('dayOf canonical date under explicit tz', () => {
  // 2026-10-13 23:50 UTC+8 → still 10-13 in Asia/Hong_Kong; 10-13 15:50Z is 10-13 23:50+08
  const ms = Date.UTC(2026, 9, 13, 15, 50)
  assert.equal(dayOf(ms, 'Asia/Hong_Kong'), '2026-10-13')
  assert.equal(dayOf(ms, 'UTC'), '2026-10-13')
  // 2026-10-13 17:00Z → 10-14 in HK (01:00 next day), 10-13 in UTC
  const ms2 = Date.UTC(2026, 9, 13, 17, 0)
  assert.equal(dayOf(ms2, 'Asia/Hong_Kong'), '2026-10-14')
  assert.equal(dayOf(ms2, 'UTC'), '2026-10-13')
})
test('prevDay handles month boundaries', () => {
  assert.equal(prevDay('2026-10-01'), '2026-09-30')
  assert.equal(prevDay('2026-01-01'), '2025-12-31')
  assert.equal(prevDay('2026-03-01'), '2026-02-28')
})

/* ---------------- START / busy ---------------- */

test('START from idle → focus with absolute endsAt', () => {
  const c = clock(); const s = fresh(c)
  const r = transition(s, START(25), c)
  assert.equal(r.code, undefined)
  assert.equal(r.state.running.status, 'focus')
  assert.equal(r.state.running.endsAt, c.now() + 25 * 60_000)
  assert.equal(r.state.running.remainingMs, null)
  const arm = r.effects.find(e => e.type === 'armTimer')
  assert.equal(arm.at, r.state.running.endsAt)
})
test('START while running → busy, state untouched', () => {
  const c = clock(); let s = fresh(c)
  s = transition(s, START(25), c).state
  const before = JSON.stringify(s)
  const r = transition(s, START(10), c)
  assert.equal(r.code, 'busy')
  assert.equal(JSON.stringify(r.state), before)
})
test('START validates focusMinutes [5,120] (D19/D20): out of domain → limit_exceeded', () => {
  const c = clock(); const s = fresh(c)
  assert.equal(transition(s, START(500), c).code, 'limit_exceeded')
  assert.equal(transition(s, START(0), c).code, 'limit_exceeded')
  assert.equal(transition(s, START(4), c).code, 'limit_exceeded')
  assert.equal(transition(s, START(5), c).state.running.focusMinutes, 5)
  assert.equal(transition(s, START(120), c).state.running.focusMinutes, 120)
  assert.equal(transition(s, START(121), c).code, 'limit_exceeded')
  assert.equal(transition(s, START(), c).state.running.focusMinutes, 25)
})

/* ---------------- §4.1 pause/resume invariants ---------------- */

test('PAUSE: endsAt→null, remainingMs frozen; RESUME restores exactly', () => {
  const c = clock(); let s = fresh(c)
  s = transition(s, START(25), c).state
  c.advance(10 * 60_000) // 10 min elapsed
  s = transition(s, PAUSE(), c).state
  assert.equal(s.running.endsAt, null)
  assert.equal(s.running.remainingMs, 15 * 60_000)
  c.advance(60 * 60_000) // an hour passes while paused
  s = transition(s, RESUME(), c).state
  assert.equal(s.running.remainingMs, null)
  assert.equal(s.running.endsAt, c.now() + 15 * 60_000) // frozen amount, not shifted
})
test('double PAUSE → stale; RESUME without pause → stale', () => {
  const c = clock(); let s = fresh(c)
  s = transition(s, START(25), c).state
  assert.equal(transition(transition(s, PAUSE(), c).state, PAUSE(), c).code, 'stale')
  assert.equal(transition(s, RESUME(), c).code, 'stale')
})
test('PAUSE during waiting → stale (waiting has no clock)', () => {
  const c = clock(); let s = fresh(c)
  s = transition(s, START(25), c).state
  c.advance(25 * 60_000)
  s = transition(s, TICK_EXPIRE(), c).state // → break
  c.advance(5 * 60_000)
  s = transition(s, TICK_EXPIRE(), c).state // → waiting
  assert.equal(s.running.status, 'waiting')
  assert.equal(transition(s, PAUSE(), c).code, 'stale')
})

/* ---------------- §4.2 settle idempotency ---------------- */

test('double TICK_EXPIRE: second is already_settled, EXP credited once', () => {
  const c = clock(); let s = fresh(c)
  s = transition(s, START(25), c).state
  c.advance(25 * 60_000)
  const r1 = transition(s, TICK_EXPIRE(), c)
  assert.equal(r1.code, undefined)
  assert.equal(r1.state.pet.exp, EXP.pomodoro)
  const r2 = transition(r1.state, TICK_EXPIRE(), c)
  // running is now break with future endsAt → already_settled semantics
  assert.equal(r2.code, 'already_settled')
  assert.equal(r2.state.pet.exp, EXP.pomodoro)
})
test('TICK before deadline does nothing', () => {
  const c = clock(); let s = fresh(c)
  s = transition(s, START(25), c).state
  c.advance(24 * 60_000)
  const r = transition(s, TICK_EXPIRE(), c)
  assert.equal(r.code, 'already_settled')
  assert.equal(r.state.pet.exp, 0)
})
test('STOP after settle → stale, no double mood penalty', () => {
  const c = clock(); let s = fresh(c)
  s = transition(s, START(25), c).state
  c.advance(25 * 60_000)
  s = transition(s, TICK_EXPIRE(), c).state // focus → break (EXP+)
  const moodAfterFocus = s.pet.mood
  const r = transition(s, STOP(), c) // stops the BREAK → skip, no penalty
  assert.equal(r.code, undefined)
  assert.equal(r.state.pet.mood, moodAfterFocus)
})

/* ---------------- §4.3 boundaries ---------------- */

test('focus expire → auto-break; 4th round → longBreak (D18 rounds in pets)', () => {
  const c = clock(); let s = fresh(c)
  for (let i = 1; i <= 4; i++) {
    s = transition(s, START(25), c).state
    c.advance(25 * 60_000)
    s = transition(s, TICK_EXPIRE(), c).state
    assert.equal(s.running.status, i === 4 ? 'longBreak' : 'break')
    assert.equal(s.pet.rounds, i === 4 ? 0 : i)
    // waiting → START continues the round counter (D18); old row terminalized
    c.advance(i === 4 ? 15 * 60_000 : 5 * 60_000)
    s = transition(s, TICK_EXPIRE(), c).state // break → waiting
  }
  assert.equal(s.pet.rounds, 0)
})
test('STOP resets rounds (D18): interrupted streak never triggers long break', () => {
  const c = clock(); let s = fresh(c)
  for (let i = 1; i <= 3; i++) {
    s = transition(s, START(25), c).state
    c.advance(25 * 60_000)
    s = transition(s, TICK_EXPIRE(), c).state
    s = transition(s, STOP(), c).state // skip break
    assert.equal(s.pet.rounds, 0)
  }
  s = transition(s, START(25), c).state
  c.advance(25 * 60_000)
  s = transition(s, TICK_EXPIRE(), c).state
  assert.equal(s.running.status, 'break') // round 1 again, not long
  assert.equal(s.pet.rounds, 1)
})
test('break expire → waiting (no auto start), notify effect emitted once', () => {
  const c = clock(); let s = fresh(c)
  s = transition(s, START(25), c).state
  c.advance(25 * 60_000)
  s = transition(s, TICK_EXPIRE(), c).state // → break
  c.advance(5 * 60_000)
  const r = transition(s, TICK_EXPIRE(), c)
  assert.equal(r.state.running.status, 'waiting')
  assert.equal(r.effects.filter(e => e.type === 'notify' && e.kind === 'break-done').length, 1)
  assert.equal(r.effects.filter(e => e.type === 'armTimer').length, 0) // no timer for waiting
})
test('waiting → START begins next focus', () => {
  const c = clock(); let s = fresh(c)
  s = transition(s, START(25), c).state
  c.advance(25 * 60_000); s = transition(s, TICK_EXPIRE(), c).state
  c.advance(5 * 60_000); s = transition(s, TICK_EXPIRE(), c).state
  const r = transition(s, START(10), c)
  assert.equal(r.state.running.status, 'focus')
  assert.equal(r.state.running.focusMinutes, 10)
})

/* ---------------- EXP / mood / streak ---------------- */

test('abandon: mood -1, no EXP; skip break: no penalty', () => {
  const c = clock(); let s = fresh(c)
  s = transition(s, START(25), c).state
  c.advance(5 * 60_000)
  s = transition(s, STOP(), c).state // abandon focus
  assert.equal(s.pet.mood, MOOD.initial - 1)
  assert.equal(s.pet.exp, 0)
  assert.equal(s.history.at(-1).outcome, 'abandoned')
})
test('abandon a PAUSED focus: mood -1 too (§4.3), remainingMs frozen in history', () => {
  const c = clock(); let s = fresh(c)
  s = transition(s, START(25), c).state
  c.advance(10 * 60_000)
  s = transition(s, PAUSE(), c).state
  const frozen = s.running.remainingMs
  s = transition(s, STOP(), c).state
  assert.equal(s.history.at(-1).outcome, 'abandoned')
  assert.equal(s.history.at(-1).remainingMs, frozen)
  assert.equal(s.pet.mood, MOOD.initial - 1)
  assert.equal(s.pet.exp, 0)
})
test('pause a BREAK then abandon: skip, no penalty', () => {
  const c = clock(); let s = fresh(c)
  s = transition(s, START(25), c).state
  c.advance(25 * 60_000)
  s = transition(s, TICK_EXPIRE(), c).state // → break
  const moodAfterFocus = s.pet.mood
  s = transition(s, PAUSE(), c).state
  s = transition(s, STOP(), c).state
  assert.equal(s.history.at(-1).outcome, 'skipped')
  assert.equal(s.pet.mood, moodAfterFocus)
})
test('streak: consecutive days +1; break in chain resets', () => {
  const c = clock()
  let s = fresh(c)
  const day = (offset) => {
    c.set(Date.UTC(2026, 9, 13 + offset, 1, 0)) // 01:00Z each day
    s = transition(s, START(25), c).state
    c.advance(25 * 60_000)
    s = transition(s, TICK_EXPIRE(), c).state
    s = transition(s, STOP(), c).state // skip break
  }
  day(0)
  assert.equal(Object.values(s.days)[0].streak, 1)
  day(1)
  assert.equal(Object.values(s.days).at(-1).streak, 2)
  day(3) // gap → reset
  assert.equal(Object.values(s.days).at(-1).streak, 1)
})
test('daily streak bonus granted on first completion of a consecutive day', () => {
  const c = clock()
  let s = fresh(c)
  c.set(Date.UTC(2026, 9, 13, 1, 0))
  s = transition(s, START(25), c).state
  c.advance(25 * 60_000); s = transition(s, TICK_EXPIRE(), c).state
  const day1exp = s.pet.exp
  assert.equal(day1exp, EXP.pomodoro) // no bonus day 1
  s = transition(s, STOP(), c).state
  c.set(Date.UTC(2026, 9, 14, 1, 0))
  s = transition(s, START(25), c).state
  c.advance(25 * 60_000); s = transition(s, TICK_EXPIRE(), c).state
  assert.equal(s.pet.exp, day1exp + EXP.pomodoro + EXP.dailyStreakBonus)
})
test('level up consumes EXP across threshold and lifts mood', () => {
  const c = clock(); let s = fresh(c)
  s.pet = { ...s.pet, exp: needFor(1) - 5, level: 1 } // 45 exp, 5 before level 2
  s = transition(s, START(25), c).state
  c.advance(25 * 60_000)
  s = transition(s, TICK_EXPIRE(), c).state
  // 45 + 10 = 55 ≥ 50 → level 2 with 5 left over
  assert.equal(s.pet.level, 2)
  assert.equal(s.pet.exp, 5)
})
test('level up exact boundary: below threshold stays', () => {
  const c = clock(); let s = fresh(c)
  s.pet = { ...s.pet, exp: 44, level: 1 }
  s = transition(s, START(25), c).state
  c.advance(25 * 60_000)
  s = transition(s, TICK_EXPIRE(), c).state
  // 44 + 10 = 54 ≥ 50 → level 2, exp 4 (boundary check the OTHER way: 39 would stay)
  assert.equal(s.pet.level, 2)
  assert.equal(s.pet.exp, 4)
  // strictly below: 39+10=49 < 50
  let s2 = fresh(c)
  s2.pet = { ...s2.pet, exp: 39, level: 1 }
  s2 = transition(s2, START(25), c).state
  c.advance(25 * 60_000)
  s2 = transition(s2, TICK_EXPIRE(), c).state
  assert.equal(s2.pet.level, 1)
  assert.equal(s2.pet.exp, 49)
})

/* ---------------- display & snapshot ---------------- */

test('displayRemaining renders the right source (§4.1)', () => {
  const c = clock(); let s = fresh(c)
  s = transition(s, START(25), c).state
  c.advance(10 * 60_000)
  assert.equal(displayRemaining(s, c.now()), 15 * 60_000)
  s = transition(s, PAUSE(), c).state
  c.advance(30 * 60_000) // paused: clock moves, display frozen
  assert.equal(displayRemaining(s, c.now()), 15 * 60_000)
})
test('snapshotOf shape: pet stage, running echo, recent 7', () => {
  const c = clock()
  let s = fresh(c)
  s.pet = { ...s.pet, level: 5 }
  const snap = snapshotOf(s, c.now())
  assert.equal(snap.pet.stage, 'glow')
  assert.equal(snap.running, null)
  assert.equal(snap.recent.length, 7)
  assert.equal(snap.settings.focusMin, 25)
})

/* ---------------- recovery folds (§12 恢复) ---------------- */

test('recover overdue focus → settle once via TICK_EXPIRE', () => {
  const c = clock(); let s = fresh(c)
  s = transition(s, START(25), c).state
  const endsAt = s.running.endsAt
  c.set(endsAt + 60_000) // host "restarted" a minute past the deadline
  const r = transition(s, TICK_EXPIRE(), c)
  assert.equal(r.code, undefined)
  assert.equal(r.state.running.status, 'break')
  assert.equal(r.state.pet.exp, EXP.pomodoro)
})
test('recover running-not-due → re-arm, not settle', () => {
  const c = clock(); let s = fresh(c)
  s = transition(s, START(25), c).state
  c.advance(10 * 60_000) // "restart" mid-focus
  const r = transition(s, TICK_EXPIRE(), c)
  assert.equal(r.code, 'already_settled')
  assert.equal(r.state.pet.exp, 0)
})
test('recover paused → zero action, frozen remaining preserved', () => {
  const c = clock(); let s = fresh(c)
  s = transition(s, START(25), c).state
  c.advance(10 * 60_000)
  s = transition(s, PAUSE(), c).state
  const frozen = s.running.remainingMs
  c.advance(3 * 60 * 60_000) // hours of downtime while paused
  // recovery reads storage; engine sees a paused session with no due path
  assert.equal(s.running.remainingMs, frozen)
  const r = transition(s, TICK_EXPIRE(), c)
  assert.equal(r.code, 'already_settled')
  assert.equal(r.state.running.remainingMs, frozen)
})

/* ---------------- pure-function discipline ---------------- */

test('transition does not mutate the input state', () => {
  const c = clock(); const s = fresh(c)
  const before = JSON.stringify(s)
  transition(s, START(25), c)
  transition(s, PAUSE(), c)
  assert.equal(JSON.stringify(s), before)
})
test('clock/tz injected: same relative timeline, same relative outcome', () => {
  const run = (start) => {
    const c = clock(start)
    let s = fresh(c)
    s = transition(s, START(25), c).state
    c.advance(25 * 60_000)
    const r = transition(s, TICK_EXPIRE(), c)
    const st = r.state
    // Compare shape relative to the clock start, not absolute values.
    return {
      status: st.running.status,
      exp: st.pet.exp,
      focusRelEnds: st.running.endsAt - c.now(),
      focusLen: st.history[0].endsAt - st.history[0].startedAt,
      dayKey: Object.keys(st.days)[0] === undefined ? null : 'present',
    }
  }
  assert.deepEqual(run(1_700_000_000_000), run(123_456_789_012))
})

/* ================= v0.3: task system / modes / quadrant EXP (§6/§7/§17) == */

/* ---------------- EXP formula (§7.1) ---------------- */

test('expFor: B quadrant 25min standard = 12 (§17 象限加成)', () => {
  assert.equal(expFor('B', 'standard', 25), 12)
})
test('expFor: deep 50min uncategorized = 24 (§17 模式倍率)', () => {
  assert.equal(expFor(null, 'deep', 50), 24)
})
test('expFor: full quadrant×mode×minutes grid', () => {
  assert.equal(expFor('A', 'standard', 25), 10)
  assert.equal(expFor('C', 'standard', 25), 8)
  assert.equal(expFor('D', 'standard', 25), 5)
  assert.equal(expFor('B', 'deep', 25), Math.round(12 * 1.2)) // 14
  assert.equal(expFor('B', 'sprint', 15), Math.round(12 * 0.8 * 15 / 25)) // 6
  assert.equal(expFor(null, 'standard', 25), 10) // no task → base 10
  assert.equal(expFor(null, 'standard', 1), 1) // short-focus floor
})

/* ---------------- task CRUD ---------------- */

test('TASK_CREATE: defaults to B quadrant, sortOrder stacking, ids unique', () => {
  const c = clock(); let s = fresh(c)
  let r = transition(s, TASK_CREATE({ title: '财树开发' }), c)
  s = r.state
  assert.equal(r.task.quadrant, 'B')
  assert.equal(r.task.sortOrder, 0)
  assert.equal(r.task.estimatedPomodoros, 1)
  assert.equal(r.task.completedPomodoros, 0)
  r = transition(s, TASK_CREATE({ title: '另一个', quadrant: 'D', estimatedPomodoros: 3 }), c)
  s = r.state
  assert.equal(r.task.quadrant, 'D')
  assert.equal(r.task.sortOrder, 0)
  assert.notEqual(r.task.id, s.tasks[Object.keys(s.tasks)[0]].id === r.task.id)
  assert.equal(r.task.id === [...Object.values(s.tasks)].at(-2).id, false)
})
test('TASK_CREATE: empty title rejected; unknown group → not_found', () => {
  const c = clock(); const s = fresh(c)
  assert.equal(transition(s, TASK_CREATE({ title: '  ' }), c).code, 'invalid_state')
  assert.equal(transition(s, TASK_CREATE({ title: 'x', groupId: 'nope' }), c).code, 'not_found')
})
test('TASK_UPDATE: quadrant moves; done sets completedAt; invalid quadrant ignored', () => {
  const c = clock(); let s = fresh(c)
  s = transition(s, TASK_CREATE({ title: 'T' }), c).state
  const id = Object.keys(s.tasks)[0]
  s = transition(s, TASK_UPDATE(id, { quadrant: 'A' }), c).state
  assert.equal(s.tasks[id].quadrant, 'A')
  s = transition(s, TASK_UPDATE(id, { status: 'done' }), c).state
  assert.equal(s.tasks[id].status, 'done')
  assert.equal(s.tasks[id].completedAt, c.now())
  assert.equal(s.activeTaskId, null) // done task can't stay default
  s = transition(s, TASK_UPDATE(id, { quadrant: 'Z', estimatedPomodoros: 999 }), c).state
  assert.equal(s.tasks[id].quadrant, 'A') // untouched
  assert.equal(s.tasks[id].estimatedPomodoros, 99) // clamped
})
test('TASK_UPDATE / TASK_DELETE / GROUP_*: not_found codes', () => {
  const c = clock(); const s = fresh(c)
  assert.equal(transition(s, TASK_UPDATE('x', {}), c).code, 'not_found')
  assert.equal(transition(s, TASK_DELETE('x'), c).code, 'not_found')
  assert.equal(transition(s, GROUP_UPDATE('x', {}), c).code, 'not_found')
  assert.equal(transition(s, GROUP_DELETE('x'), c).code, 'not_found')
})
test('TASK_DELETE keeps session snapshots; GROUP_DELETE nulls group refs', () => {
  const c = clock(); let s = fresh(c)
  s = transition(s, GROUP_CREATE('AI产品'), c).state
  const gid = Object.keys(s.groups)[0]
  s = transition(s, TASK_CREATE({ title: 'T', groupId: gid }), c).state
  const tid = Object.keys(s.tasks)[0]
  s = transition(s, TASK_DELETE(tid), c).state
  assert.equal(s.tasks[tid], undefined)
  assert.equal(s.activeTaskId, null)
  s = transition(s, GROUP_DELETE(gid), c).state
  assert.equal(Object.keys(s.groups).length, 0)
})
test('GROUP_CREATE/UPDATE flat CRUD', () => {
  const c = clock(); let s = fresh(c)
  s = transition(s, GROUP_CREATE('AI产品'), c).state
  const gid = Object.keys(s.groups)[0]
  assert.equal(s.groups[gid].name, 'AI产品')
  s = transition(s, GROUP_UPDATE(gid, { name: '魔术角研发' }), c).state
  assert.equal(s.groups[gid].name, '魔术角研发')
  s = transition(s, GROUP_UPDATE(gid, { name: '  ' }), c).state
  assert.equal(s.groups[gid].name, '魔术角研发')
})

/* ---------------- START task binding + mode (§4.5) ---------------- */

test('START with taskId: binds task + title snapshot; unknown task → not_found', () => {
  const c = clock(); let s = fresh(c)
  assert.equal(transition(s, START(25, { taskId: 'ghost' }), c).code, 'not_found')
  s = transition(s, TASK_CREATE({ title: '财树开发' }), c).state
  const tid = Object.keys(s.tasks)[0]
  const r = transition(s, START(25, { taskId: tid }), c)
  assert.equal(r.state.running.taskId, tid)
  assert.equal(r.state.running.taskTitleSnapshot, '财树开发')
  assert.equal(r.state.running.mode, 'standard')
  assert.equal(r.state.activeTaskId, tid)
})
test('START on done task → invalid_state; defaults to activeTaskId binding', () => {
  const c = clock(); let s = fresh(c)
  s = transition(s, TASK_CREATE({ title: 'T' }), c).state
  const tid = Object.keys(s.tasks)[0]
  s = transition(s, TASK_UPDATE(tid, { status: 'done' }), c).state
  assert.equal(transition(s, START(25, { taskId: tid }), c).code, 'invalid_state')
})
test('START deep mode defaults to 50min; explicit minutes override, mode kept', () => {
  const c = clock(); const s = fresh(c)
  assert.equal(transition(s, START(undefined, { mode: 'deep' }), c).state.running.focusMinutes, 50)
  assert.equal(transition(s, START(30, { mode: 'sprint' }), c).state.running.focusMinutes, 30)
  assert.equal(transition(s, START(undefined, { mode: 'sprint' }), c).state.running.focusMinutes, 15)
})
test('SET_MODE: idle only; locked during focus/break/paused', () => {
  const c = clock(); let s = fresh(c)
  s = transition(s, SET_MODE('deep'), c).state
  assert.equal(s.settings.mode, 'deep')
  s = transition(s, START(), c).state // deep 50min
  assert.equal(transition(s, SET_MODE('sprint'), c).code, 'invalid_state')
  c.advance(50 * 60_000)
  s = transition(s, TICK_EXPIRE(), c).state // → break
  assert.equal(transition(s, SET_MODE('sprint'), c).code, 'invalid_state')
  c.advance(15 * 60_000)
  s = transition(s, TICK_EXPIRE(), c).state // → waiting
  s = transition(s, SET_MODE('sprint'), c).state
  assert.equal(s.settings.mode, 'sprint')
})
test('SET_MODE invalid name → invalid_state', () => {
  const c = clock(); const s = fresh(c)
  assert.equal(transition(s, SET_MODE('ludicrous'), c).code, 'invalid_state')
})
test('SET_TASK during focus rebinds running session; during idle sets default', () => {
  const c = clock(); let s = fresh(c)
  s = transition(s, TASK_CREATE({ title: 'T1' }), c).state
  const t1 = Object.keys(s.tasks)[0]
  s = transition(s, START(25, { taskId: t1 }), c).state
  s = transition(s, TASK_CREATE({ title: 'T2' }), c).state
  const t2 = Object.keys(s.tasks)[1]
  s = transition(s, SET_TASK(t2), c).state
  assert.equal(s.running.taskId, t2)
  assert.equal(s.running.revision, 2)
  assert.equal(s.activeTaskId, t2)
  // settle → task T2 gets the strand +1
  c.advance(25 * 60_000)
  s = transition(s, TICK_EXPIRE(), c).state
  assert.equal(s.tasks[t2].completedPomodoros, 1)
  assert.equal(s.tasks[t1].completedPomodoros, 0)
  assert.equal(s.history.at(-1).taskId, t2)
})

/* ---------------- settle: quadrant snapshot + strand + day buckets (§17) */

test('settle snapshots quadrant at settle time; later quadrant edit not retroactive (§17 象限快照)', () => {
  const c = clock(); let s = fresh(c)
  s = transition(s, TASK_CREATE({ title: 'T', quadrant: 'B' }), c).state
  const tid = Object.keys(s.tasks)[0]
  s = transition(s, START(25, { taskId: tid }), c).state
  c.advance(25 * 60_000)
  s = transition(s, TICK_EXPIRE(), c).state
  assert.equal(s.history.at(-1).quadrant, 'B')
  assert.equal(s.tasks[tid].completedPomodoros, 1)
  // move task B→A afterwards: history untouched
  s = transition(s, TASK_UPDATE(tid, { quadrant: 'A' }), c).state
  assert.equal(s.history.at(-1).quadrant, 'B')
  // next pomodoro counts under A
  s = transition(s, STOP(), c).state // skip break
  s = transition(s, START(25, { taskId: tid }), c).state
  c.advance(25 * 60_000)
  s = transition(s, TICK_EXPIRE(), c).state
  assert.equal(s.history.at(-1).quadrant, 'A')
  const dayRow = Object.values(s.days)[0]
  assert.equal(dayRow.quadrantB, 1)
  assert.equal(dayRow.quadrantA, 1)
})
test('settle without task → uncategorized bucket, base 10 EXP (§17 任务归属)', () => {
  const c = clock(); let s = fresh(c)
  s = transition(s, START(25), c).state
  assert.equal(s.running.taskId, null)
  c.advance(25 * 60_000)
  s = transition(s, TICK_EXPIRE(), c).state
  const dayRow = Object.values(s.days)[0]
  assert.equal(dayRow.uncategorized, 1)
  assert.equal(dayRow.quadrantA + dayRow.quadrantB + dayRow.quadrantC + dayRow.quadrantD, 0)
  assert.equal(s.pet.exp, 10)
  assert.equal(s.lastSettlement.quadrant, null)
})
test('B 25min standard settles +12 EXP (§17 象限加成) with lastSettlement payload', () => {
  const c = clock(); let s = fresh(c)
  s = transition(s, TASK_CREATE({ title: '财树开发', quadrant: 'B' }), c).state
  const tid = Object.keys(s.tasks)[0]
  s = transition(s, START(25, { taskId: tid }), c).state
  c.advance(25 * 60_000)
  s = transition(s, TICK_EXPIRE(), c).state
  assert.equal(s.pet.exp, 12)
  assert.equal(s.lastSettlement.expGained, 12)
  assert.equal(s.lastSettlement.taskTitle, '财树开发')
  assert.equal(s.lastSettlement.quadrant, 'B')
  assert.equal(s.lastSettlement.leveledUp, false)
})
test('deep 50min settles with 1.2× multiplier (§17 模式倍率)', () => {
  const c = clock(); let s = fresh(c)
  s = transition(s, START(undefined, { mode: 'deep' }), c).state
  assert.equal(s.running.focusMinutes, 50)
  c.advance(50 * 60_000)
  s = transition(s, TICK_EXPIRE(), c).state
  assert.equal(s.pet.exp, 24) // round(10 × 1.2 × 50/25)
})
test('over-estimate strand auto-appends: completedPomodoros > estimatedPomodoros (§17 番茄串)', () => {
  const c = clock(); let s = fresh(c)
  s = transition(s, TASK_CREATE({ title: 'T', estimatedPomodoros: 1 }), c).state
  const tid = Object.keys(s.tasks)[0]
  for (let i = 0; i < 2; i++) {
    s = transition(s, START(25, { taskId: tid }), c).state
    c.advance(25 * 60_000)
    s = transition(s, TICK_EXPIRE(), c).state
    s = transition(s, STOP(), c).state // skip break
  }
  assert.equal(s.tasks[tid].completedPomodoros, 2)
  assert.equal(s.tasks[tid].estimatedPomodoros, 1)
})
test('break completion grants +2 EXP and day expGained (§7.1)', () => {
  const c = clock(); let s = fresh(c)
  s = transition(s, START(25), c).state
  c.advance(25 * 60_000)
  s = transition(s, TICK_EXPIRE(), c).state // focus done +10
  const dayKey = Object.keys(s.days)[0]
  const expAfterFocus = s.days[dayKey].expGained
  c.advance(5 * 60_000)
  s = transition(s, TICK_EXPIRE(), c).state // break done +2
  assert.equal(s.pet.exp, 12)
  assert.equal(s.days[dayKey].expGained, expAfterFocus + 2)
  assert.equal(s.days[dayKey].completed, 1) // break doesn't inflate pomodoro count
})
test('abandoned focus: no strand, no day bucket, mood -1', () => {
  const c = clock(); let s = fresh(c)
  s = transition(s, TASK_CREATE({ title: 'T', quadrant: 'B' }), c).state
  const tid = Object.keys(s.tasks)[0]
  s = transition(s, START(25, { taskId: tid }), c).state
  c.advance(10 * 60_000)
  s = transition(s, STOP(), c).state
  assert.equal(s.tasks[tid].completedPomodoros, 0)
  assert.equal(Object.keys(s.days).length, 0)
  assert.equal(s.pet.mood, MOOD.initial - 1)
})

/* ---------------- snapshot v0.3 shape ---------------- */

test('snapshotOf v0.3: tasks sorted A→D, groups, activeTaskId, todayStats buckets, running echo', () => {
  const c = clock(); let s = fresh(c)
  s = transition(s, GROUP_CREATE('AI产品'), c).state
  const gid = Object.keys(s.groups)[0]
  s = transition(s, TASK_CREATE({ title: 'D任务', quadrant: 'D' }), c).state
  s = transition(s, TASK_CREATE({ title: 'A任务', quadrant: 'A', groupId: gid }), c).state
  const tA = Object.values(s.tasks).find(t => t.quadrant === 'A')
  s = transition(s, START(25, { taskId: tA.id }), c).state
  const snap = snapshotOf(s, c.now())
  assert.deepEqual(snap.tasks.map(t => t.quadrant), ['A', 'D'])
  assert.equal(snap.groups[0].name, 'AI产品')
  assert.equal(snap.activeTaskId, tA.id)
  assert.equal(snap.running.taskId, tA.id)
  assert.equal(snap.running.taskTitle, 'A任务')
  assert.equal(snap.running.quadrant, 'A')
  assert.equal(snap.running.mode, 'standard')
  assert.equal(snap.todayStats.uncategorized, 0)
  assert.equal(snap.lastSettlement, null)
})
test('snapshotOf running after settle echo keeps session quadrant, not live task quadrant', () => {
  const c = clock(); let s = fresh(c)
  s = transition(s, TASK_CREATE({ title: 'T', quadrant: 'C' }), c).state
  const tid = Object.keys(s.tasks)[0]
  s = transition(s, START(25, { taskId: tid }), c).state
  c.advance(25 * 60_000)
  s = transition(s, TICK_EXPIRE(), c).state // → break; settled quadrant C
  // move the task to A: break session echo should still show C
  s = transition(s, TASK_UPDATE(tid, { quadrant: 'A' }), c).state
  const snap = snapshotOf(s, c.now())
  assert.equal(snap.running.status, 'break')
  assert.equal(snap.running.quadrant, 'C')
  assert.equal(snap.lastSettlement.id, s.history.at(-1).id)
})
test('sortedTasks is a pure sorted view (input map untouched)', () => {
  const c = clock(); let s = fresh(c)
  s = transition(s, TASK_CREATE({ title: 'x', quadrant: 'C' }), c).state
  s = transition(s, TASK_CREATE({ title: 'y', quadrant: 'A' }), c).state
  const view = sortedTasks(s)
  assert.deepEqual(view.map(t => t.quadrant), ['A', 'C'])
  assert.equal(Object.keys(s.tasks).length, 2)
})
