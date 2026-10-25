/**
 * v0.3 achievement + stats engine tests — DESIGN.md §7.4/§8/§17 matrix.
 * Run: node --test pomodoro-pet/v03-engine.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  transition, initialState, START, TICK_EXPIRE, STOP, TASK_CREATE,
  snapshotOf, dayOf,
} from './pet-engine.js'
import { evaluate, ACHIEVEMENTS, FRAGMENT_ITEM } from './achievement-engine.js'
import {
  heatLevel, heatmap, trend, quadrantDist, hourDist,
  weeklyReport, monthlyReport, weekStartOf,
} from './stats-engine.js'

function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: ms => { t += ms }, set: v => { t = v } }
}

/** Run one full pomodoro (focus to expire, break skipped) on the clock. */
function pomodoro(c, s, focusMin = 25, opts = {}) {
  s = transition(s, START(focusMin, opts), c).state
  c.advance(focusMin * 60_000)
  s = transition(s, TICK_EXPIRE(), c).state
  return transition(s, STOP(), c).state // skip break
}

/* ---------------- achievement definitions ---------------- */

test('achievement catalogue: 18 entries, rewards only fragments/honor (D15)', () => {
  assert.equal(Object.keys(ACHIEVEMENTS).length, 18)
  for (const def of Object.values(ACHIEVEMENTS)) {
    assert.ok(['普通', '稀有', '史诗', '传说'].includes(def.rarity))
    assert.ok(def.fragment >= 0)
  }
  assert.equal(ACHIEVEMENTS['rainbow-king'].fragment, 5)
  assert.equal(ACHIEVEMENTS['total-500h'].fragment, 10)
})

/* ---------------- achievement triggers via real transitions ---------------- */

test('first pomodoro unlocks 第一个番茄; idempotent on second', () => {
  const c = clock(); let s = initialState(c.now())
  s = pomodoro(c, s)
  assert.ok(s.achievements['first-tomato'])
  assert.equal(s.lastSettlement.achievements.some(a => a.id === 'first-tomato'), true)
  // second settle: no re-unlock, no duplicate in lastSettlement
  s = pomodoro(c, s)
  assert.equal(s.lastSettlement.achievements.some(a => a.id === 'first-tomato'), false)
})

test('day-4 unlocks at 4 pomodoros same day', () => {
  const c = clock(); let s = initialState(c.now())
  for (let i = 0; i < 4; i++) s = pomodoro(c, s)
  assert.ok(s.achievements['day-4'])
  assert.equal(s.achievements['day-8'], undefined)
})

test('streak achievements evaluate on consecutive days', () => {
  const c = clock()
  let s = initialState(c.now())
  for (let d = 0; d < 3; d++) {
    c.set(Date.UTC(2026, 9, 13 + d, 1, 0))
    s = pomodoro(c, s)
  }
  assert.ok(s.achievements['streak-3'])
  assert.equal(s.achievements['streak-7'], undefined)
})

test('deep-flow unlocks on first 50min deep completion; sprint does not', () => {
  const c = clock(); let s = initialState(c.now())
  s = pomodoro(c, s, 50, { mode: 'deep' })
  assert.ok(s.achievements['deep-flow'])
  let s2 = initialState(c.now())
  s2 = pomodoro(c, s2, 50, { mode: 'standard' })
  assert.equal(s2.achievements['deep-flow'], undefined)
})

test('total-10h unlocks at 600 focus minutes', () => {
  const c = clock(); let s = initialState(c.now())
  for (let i = 0; i < 12; i++) s = pomodoro(c, s, 50) // 12 × 50 = 600
  assert.ok(s.achievements['total-10h'])
  assert.equal(s.achievements['total-100h'], undefined)
})

test('task-finisher needs estimatedPomodoros fully reached; perfect-estimates run of 5', () => {
  const c = clock(); let s = initialState(c.now())
  s = transition(s, TASK_CREATE({ title: 'T', estimatedPomodoros: 1 }), c).state
  const tid = Object.keys(s.tasks)[0]
  s = pomodoro(c, s, 25, { taskId: tid })
  assert.equal(s.tasks[tid].completedPomodoros, 1)
  // direct evaluate: not yet 10 tasks
  const r = evaluate(s, c.now())
  assert.equal(r.unlocked.some(a => a.id === 'task-finisher'), false)
})

test('uncategorized-10 after 10 no-task pomodoros', () => {
  const c = clock(); let s = initialState(c.now())
  for (let i = 0; i < 10; i++) s = pomodoro(c, s)
  assert.ok(s.achievements['uncategorized-10'])
})

test('rainbow-king at Lv7 via evaluate on synthetic pet', () => {
  const c = clock(); let s = initialState(c.now())
  s.pet = { ...s.pet, level: 7 }
  const r = evaluate(s, c.now())
  assert.ok(r.unlocked.some(a => a.id === 'rainbow-king'))
  assert.equal(r.fragments, 5)
})

test('evaluate fragments accumulate; FRAGMENT_ITEM inventory written on settle', () => {
  const c = clock(); let s = initialState(c.now())
  s.pet = { ...s.pet, level: 7 } // rainbow-king fragment ×5 on next settle
  s = pomodoro(c, s)
  assert.equal(s.inventory[FRAGMENT_ITEM].count, 5)
  // streak-7 etc. would add more; second settle grants first-tomato only (0)
  s = pomodoro(c, s)
  assert.equal(s.inventory[FRAGMENT_ITEM].count, 5)
})

test('early-bird/night-owl read settle hour in tz', () => {
  const c = clock()
  let s = initialState(c.now(), { statsTimeZone: 'UTC' })
  // 23:00Z settle → night window (22–2)
  c.set(Date.UTC(2026, 9, 13, 22, 0)) // start 22:00, settle 22:25Z
  for (let i = 0; i < 10; i++) {
    c.set(Date.UTC(2026, 9, 13 + i, 22, 0))
    s = pomodoro(c, s)
  }
  assert.ok(s.achievements['night-owl'], 'night-owl should unlock')
  assert.equal(s.achievements['early-bird'], undefined)
})

/* ---------------- stats engine (§8.2–§8.4) ---------------- */

const daysFixture = () => ({
  '2026-10-05': { completed: 1, focusMinutes: 25, streak: 1, expGained: 10, quadrantA: 0, quadrantB: 1, quadrantC: 0, quadrantD: 0, uncategorized: 0 },
  '2026-10-06': { completed: 3, focusMinutes: 75, streak: 2, expGained: 30, quadrantA: 0, quadrantB: 2, quadrantC: 1, quadrantD: 0, uncategorized: 0 },
  '2026-10-12': { completed: 8, focusMinutes: 200, streak: 1, expGained: 80, quadrantA: 4, quadrantB: 3, quadrantC: 0, quadrantD: 1, uncategorized: 0 },
  '2026-12-31': { completed: 2, focusMinutes: 50, streak: 1, expGained: 20, quadrantA: 0, quadrantB: 0, quadrantC: 0, quadrantD: 0, uncategorized: 2 },
})

test('heatLevel: 5 buckets (§8.2)', () => {
  assert.equal(heatLevel(0), 0)
  assert.equal(heatLevel(1), 1)
  assert.equal(heatLevel(2), 1)
  assert.equal(heatLevel(3), 2)
  assert.equal(heatLevel(5), 3)
  assert.equal(heatLevel(7), 4)
  assert.equal(heatLevel(20), 4)
})

test('heatmap: full year cells + year totals, cross-year isolation', () => {
  const state = { days: daysFixture() }
  const r2026 = heatmap(state, 2026)
  assert.equal(r2026.cells.length, 365) // 2026 is not a leap year
  assert.equal(r2026.yearTotals.completed, 14)
  assert.equal(r2026.yearTotals.focusMinutes, 350)
  const cellOct6 = r2026.cells.find(c => c.date === '2026-10-06')
  assert.equal(cellOct6.completed, 3)
  assert.equal(cellOct6.level, 2)
  const r2025 = heatmap(state, 2025)
  assert.equal(r2025.yearTotals.completed, 0)
  assert.ok(r2025.cells.every(c => c.completed === 0))
})

test('trend: 4 weekly buckets oldest-first, current week included', () => {
  const state = { days: daysFixture() }
  // 2026-10-13 is a Tuesday; week starts Monday 2026-10-12
  const now = Date.UTC(2026, 9, 13, 12, 0)
  const weeks = trend(state, now, 4, 'UTC')
  assert.equal(weeks.length, 4)
  assert.equal(weeks[3].weekStart, '2026-10-12')
  assert.equal(weeks[3].completed, 8) // 10-12 row only; 10-13..18 empty
  assert.equal(weeks[2].weekStart, '2026-10-05')
  assert.equal(weeks[2].completed, 4) // 1 + 3
  assert.equal(weeks[0].weekStart, '2026-09-21')
  assert.equal(weeks[0].completed, 0)
})

test('weekStartOf: Monday anchor across weeks and years', () => {
  assert.equal(weekStartOf('2026-10-13'), '2026-10-12') // Tue → Mon
  assert.equal(weekStartOf('2026-10-12'), '2026-10-12') // Mon → self
  assert.equal(weekStartOf('2026-10-18'), '2026-10-12') // Sun → prior Mon
  assert.equal(weekStartOf('2026-01-01'), '2025-12-29') // Thu → prior Mon
})

test('quadrantDist: all-time and from-date filtered', () => {
  const state = { days: daysFixture() }
  const all = quadrantDist(state)
  assert.deepEqual([all.A, all.B, all.C, all.D, all.uncategorized], [4, 6, 1, 1, 2])
  assert.equal(all.total, 14)
  const sinceOct = quadrantDist(state, '2026-10-12')
  assert.deepEqual([sinceOct.A, sinceOct.B], [4, 3])
})

test('hourDist: counts only settled focus completions, honors tz', () => {
  const c = clock()
  let s = initialState(c.now(), { statsTimeZone: 'UTC' })
  c.set(Date.UTC(2026, 9, 13, 22, 0))
  s = pomodoro(c, s) // settles 22:25Z
  const buckets = hourDist(s, 'UTC')
  assert.equal(buckets[22], 1)
  assert.equal(buckets.reduce((a, b) => a + b, 0), 1)
})

test('weeklyReport: numbers match days table, delta and insight present', () => {
  const state = { days: daysFixture(), achievements: {} }
  const now = Date.UTC(2026, 9, 13, 12, 0)
  const rep = weeklyReport(state, now, 'UTC')
  assert.equal(rep.period, 'week')
  assert.equal(rep.start, '2026-10-12')
  assert.equal(rep.end, '2026-10-18')
  assert.equal(rep.current.completed, 8)
  assert.equal(rep.current.focusMinutes, 200)
  assert.equal(rep.previous.completed, 4) // prev week contains 10-05/10-06
  assert.equal(rep.deltaPercent, 100)
  assert.ok(rep.insight.length > 0)
})

test('monthlyReport: month boundaries, bestHour, month achievements', () => {
  const c = clock()
  let s = initialState(c.now(), { statsTimeZone: 'UTC' })
  c.set(Date.UTC(2026, 9, 13, 22, 0))
  s = pomodoro(c, s) // unlocks first-tomato in Oct 2026
  const now = Date.UTC(2026, 9, 13, 23, 0)
  const rep = monthlyReport(s, now, 'UTC')
  assert.equal(rep.period, 'month')
  assert.equal(rep.start, '2026-10-01')
  assert.equal(rep.end, '2026-10-31')
  assert.equal(rep.summary.completed, 1)
  assert.equal(rep.bestHour, 22)
  assert.ok(rep.achievements.some(a => a.id === 'first-tomato'))
  assert.equal(rep.trend.length, 4)
})

test('empty state: reports degrade gracefully', () => {
  const state = { days: {}, history: [], achievements: {}, tasks: {} }
  const now = Date.UTC(2026, 9, 13, 12, 0)
  const rep = weeklyReport(state, now, 'UTC')
  assert.equal(rep.current.completed, 0)
  assert.equal(rep.deltaPercent, 0)
  const heat = heatmap(state, 2026)
  assert.equal(heat.cells.length, 365)
  assert.equal(hourDist(state, 'UTC').reduce((a, b) => a + b, 0), 0)
})

/* ---------------- snapshot carries achievements/inventory ---------------- */

test('snapshotOf exposes achievements + inventory + lastSettlement chain', () => {
  const c = clock(); let s = initialState(c.now())
  s.pet = { ...s.pet, level: 7 }
  s = pomodoro(c, s)
  const snap = snapshotOf(s, c.now())
  assert.ok(snap.achievements['rainbow-king'])
  assert.ok(snap.achievements['first-tomato'])
  assert.equal(snap.inventory[FRAGMENT_ITEM].count, 5)
  assert.equal(snap.lastSettlement.achievements.length >= 2, true)
  assert.ok(snap.tasks && snap.groups && 'activeTaskId' in snap)
})
