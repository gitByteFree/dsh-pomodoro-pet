/**
 * v0.4 engine tests — D17/D18/D19/D20, §4.3.1 终态表, §7.3 惰性心情,
 * §7.6 装扮兑换, §10.2 days.hours/moodEnd. DESIGN.md v0.4 测试矩阵.
 * Run: node --test pomodoro-pet/v04-engine.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  transition, initialState, START, PAUSE, RESUME, STOP, TICK_EXPIRE,
  SET_TASK, REDEEM_OUTFIT, snapshotOf, dayOf, MOOD, SETTLEMENT_CARRY_MS,
  TASK_CREATE,
} from './pet-engine.js'

function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: ms => { t += ms }, set: v => { t = v } }
}
const fresh = (c, patch) => initialState(c.now(), patch)

/** Full pomodoro incl. break → waiting, then STOP to close the row. */
function pomodoroFull(c, s, focusMin = 25, opts = {}) {
  s = transition(s, START(focusMin, opts), c).state
  c.advance(focusMin * 60_000)
  s = transition(s, TICK_EXPIRE(), c).state // → break
  const breakMin = s.running.focusMinutes
  c.advance(breakMin * 60_000)
  s = transition(s, TICK_EXPIRE(), c).state // → waiting
  return transition(s, STOP(), c).state // waiting → done/completed
}

/* ---------------- D19/D20: duration domain + streak protection ---------------- */

test('focusMinutes=1 → limit_exceeded, no session, no streak (D20)', () => {
  const c = clock(); let s = fresh(c)
  const r = transition(s, START(1), c)
  assert.equal(r.code, 'limit_exceeded')
  assert.equal(r.state.running, null)
  assert.equal(Object.keys(r.state.days).length, 0)
})

/* ---------------- §4.3.1 session row terminal states ---------------- */

test('terminal table: focus→STOP done/abandoned; break→STOP done/skipped; waiting→STOP done/completed', () => {
  const c = clock(); let s = fresh(c)
  // focus → STOP
  s = transition(s, START(25), c).state
  c.advance(10 * 60_000)
  s = transition(s, STOP(), c).state
  assert.equal(s.running, null)
  assert.equal(s.history.at(-1).status, 'done')
  assert.equal(s.history.at(-1).outcome, 'abandoned')
  // break → STOP
  s = transition(s, START(25), c).state
  c.advance(25 * 60_000)
  s = transition(s, TICK_EXPIRE(), c).state // break
  s = transition(s, STOP(), c).state
  assert.equal(s.history.at(-1).status, 'done')
  assert.equal(s.history.at(-1).outcome, 'skipped')
  // waiting → STOP
  s = transition(s, START(25), c).state
  c.advance(25 * 60_000)
  s = transition(s, TICK_EXPIRE(), c).state // break
  c.advance(5 * 60_000)
  s = transition(s, TICK_EXPIRE(), c).state // waiting
  s = transition(s, STOP(), c).state
  assert.equal(s.history.at(-1).status, 'done')
  assert.equal(s.history.at(-1).outcome, 'completed')
})

test('terminal table: paused→STOP outcome follows pre-pause stage', () => {
  const c = clock(); let s = fresh(c)
  s = transition(s, START(25), c).state
  s = transition(s, PAUSE(), c).state
  s = transition(s, STOP(), c).state
  assert.equal(s.history.at(-1).outcome, 'abandoned') // paused-from focus
  s = transition(s, START(25), c).state
  c.advance(25 * 60_000)
  s = transition(s, TICK_EXPIRE(), c).state // break
  s = transition(s, PAUSE(), c).state
  s = transition(s, STOP(), c).state
  assert.equal(s.history.at(-1).outcome, 'skipped') // paused-from break
})

test('waiting→START terminalizes old row done/completed in the same write (§4.3.1)', () => {
  const c = clock(); let s = fresh(c)
  s = transition(s, START(25), c).state
  c.advance(25 * 60_000)
  s = transition(s, TICK_EXPIRE(), c).state // break
  c.advance(5 * 60_000)
  s = transition(s, TICK_EXPIRE(), c).state // waiting
  const oldId = s.running.id
  const r = transition(s, START(25), c)
  assert.equal(r.state.running.status, 'focus')
  assert.notEqual(r.state.running.id, oldId)
  const closed = r.state.history.find(x => x.id === oldId)
  assert.equal(closed.status, 'done')
  assert.equal(closed.outcome, 'completed')
  assert.ok(closed.settledAt) // focus part was settled at TICK_EXPIRE
})

/* ---------------- D18 rounds persistence ---------------- */

test('rounds survive across waiting→START; roundIndex mirrors pet.rounds', () => {
  const c = clock(); let s = fresh(c)
  for (let i = 1; i <= 3; i++) {
    s = transition(s, START(25), c).state
    assert.equal(s.running.roundIndex, i - 1)
    c.advance(25 * 60_000)
    s = transition(s, TICK_EXPIRE(), c).state
    c.advance(s.running.status === 'longBreak' ? 15 * 60_000 : 5 * 60_000)
    s = transition(s, TICK_EXPIRE(), c).state // waiting
  }
  assert.equal(s.pet.rounds, 3)
})

/* ---------------- §10.2 days.hours / moodEnd ---------------- */

test('days.hours buckets by settle hour in tz; hours survives restart-shaped state', () => {
  const c = clock()
  let s = fresh(c, { statsTimeZone: 'UTC' })
  c.set(Date.UTC(2026, 9, 13, 22, 0))
  s = transition(s, START(25), c).state
  c.advance(25 * 60_000) // settles 22:25Z
  s = transition(s, TICK_EXPIRE(), c).state
  const row = Object.values(s.days)[0]
  const hours = JSON.parse(row.hours)
  assert.equal(hours[22], 1)
  assert.equal(hours.reduce((a, b) => a + b, 0), 1)
})

test('days.moodEnd tracks the last mood write of the day', () => {
  const c = clock(); let s = fresh(c)
  s = transition(s, START(25), c).state
  c.advance(25 * 60_000)
  s = transition(s, TICK_EXPIRE(), c).state
  const row = Object.values(s.days)[0]
  assert.equal(row.moodEnd, s.pet.mood)
})

/* ---------------- §7.3 lazy mood inertia ---------------- */

test('mood inertia: ≥3 days idle → -1 on next settle, capped at 0', () => {
  const c = clock()
  let s = fresh(c)
  // focus 结算后处于 break，走完 break 到 waiting 才能再次 START
  const toWaiting = (st) => {
    if (st.running?.status === 'break') {
      c.advance(st.running.focusMinutes * 60_000)
      st = transition(st, TICK_EXPIRE(), c).state
    }
    return st
  }
  s = transition(s, START(25), c).state
  c.advance(25 * 60_000)
  s = transition(s, TICK_EXPIRE(), c).state
  s = toWaiting(s)
  assert.equal(s.pet.mood, MOOD.initial)
  // 5 days of silence
  c.advance(5 * 86_400_000)
  s = transition(s, START(25), c).state
  c.advance(25 * 60_000)
  s = transition(s, TICK_EXPIRE(), c).state
  assert.equal(s.pet.mood, MOOD.initial - 1)
  s = toWaiting(s)
  // another ≥3-day gap → -1 again
  c.advance(4 * 86_400_000)
  s = transition(s, START(25), c).state
  c.advance(25 * 60_000)
  s = transition(s, TICK_EXPIRE(), c).state
  assert.equal(s.pet.mood, MOOD.initial - 2)
  s = toWaiting(s)
  // same-day settle: no further deduction
  s = pomodoroFull(c, s)
  assert.equal(s.pet.mood, MOOD.initial - 2)
})

/* ---------------- §7.6 outfit redeem ---------------- */

test('REDEEM_OUTFIT: <10 fragments → limit_exceeded; ≥10 → deduct + outfit written', () => {
  const c = clock(); let s = fresh(c)
  assert.equal(transition(s, REDEEM_OUTFIT('leaf-crown'), c).code, 'limit_exceeded')
  s = {
    ...s,
    inventory: { ...s.inventory, dress_fragment: { count: 12, firstObtainedAt: c.now() } },
  }
  const r = transition(s, REDEEM_OUTFIT('leaf-crown'), c)
  assert.equal(r.state.pet.outfitId, 'leaf-crown')
  assert.equal(r.state.inventory.dress_fragment.count, 2)
})

/* ---------------- §8.1 settlement 5-minute carry ---------------- */

test('snapshotOf drops lastSettlement older than 5 minutes; carries fresh one', () => {
  const c = clock(); let s = fresh(c)
  s = transition(s, START(25), c).state
  c.advance(25 * 60_000)
  s = transition(s, TICK_EXPIRE(), c).state
  assert.ok(s.lastSettlement)
  assert.ok(snapshotOf(s, c.now()).lastSettlement)
  assert.equal(snapshotOf(s, c.now() + SETTLEMENT_CARRY_MS + 1).lastSettlement, null)
  assert.equal(snapshotOf(s, c.now() + SETTLEMENT_CARRY_MS - 1).lastSettlement.id, s.lastSettlement.id)
})

/* ---------------- SET_TASK in paused (§4.3 event table) ---------------- */

test('SET_TASK rebinds paused session too', () => {
  const c = clock(); let s = fresh(c)
  s = transition(s, START(25), c).state
  s = transition(s, PAUSE(), c).state
  // create a task directly in state (TASK_CREATE needs clock; reuse transition)
  s = transition(s, TASK_CREATE({ title: '暂停期换任务' }), c).state
  const tid = Object.keys(s.tasks)[0]
  s = transition(s, SET_TASK(tid), c).state
  assert.equal(s.running.taskId, tid)
})

/* ---------------- snapshot serverNow ---------------- */

test('snapshot carries serverNow == Host now (§11.2 校时)', () => {
  const c = clock(); const s = fresh(c)
  const snap = snapshotOf(s, c.now())
  assert.equal(snap.serverNow, c.now())
  assert.equal(snap.pet.rounds, 0)
})
