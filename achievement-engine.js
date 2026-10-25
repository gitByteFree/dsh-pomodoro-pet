/**
 * Achievement engine — 18 achievements (DESIGN.md §7.4).
 *
 * Pure: evaluate(state, now) inspects the settled engine state and returns
 * the rows that should unlock NOW. Idempotency comes from the caller:
 * already-unlocked ids (state.achievements) are skipped. Achievements grant
 * 装扮碎片 (dress fragments) or pure honor — never EXP (D15).
 *
 * Hour-window achievements (晨型人/夜猫子) and 年度坚持 read settled focus
 * sessions from state.history; everything else reads state.days / tasks / pet.
 */

import { stageFor } from './pet-engine.js'

export const FRAGMENT_ITEM = 'dress_fragment'

/** id → { name, rarity, reward: {fragment: n} | null } (§7.4 order). */
export const ACHIEVEMENTS = Object.freeze({
  'first-tomato': { name: '第一个番茄', rarity: '普通', fragment: 0 },
  'streak-3': { name: '连续 3 天', rarity: '普通', fragment: 0 },
  'streak-7': { name: '连续 7 天', rarity: '稀有', fragment: 1 },
  'streak-30': { name: '连续 30 天', rarity: '史诗', fragment: 3 },
  'day-4': { name: '单日 4 番茄', rarity: '普通', fragment: 0 },
  'day-8': { name: '单日 8 番茄', rarity: '稀有', fragment: 1 },
  'total-10h': { name: '累计 10 小时', rarity: '普通', fragment: 0 },
  'total-100h': { name: '累计 100 小时', rarity: '史诗', fragment: 3 },
  'total-500h': { name: '累计 500 小时', rarity: '传说', fragment: 10 },
  'b-region-60': { name: 'B 区践行者', rarity: '稀有', fragment: 1 },
  'deep-flow': { name: '深度心流', rarity: '稀有', fragment: 1 },
  'early-bird': { name: '晨型人', rarity: '普通', fragment: 0 },
  'night-owl': { name: '夜猫子', rarity: '普通', fragment: 0 },
  'task-finisher': { name: '任务清道夫', rarity: '稀有', fragment: 1 },
  'uncategorized-10': { name: '未分类也算数', rarity: '普通', fragment: 0 },
  'perfect-estimates': { name: '满分预估', rarity: '稀有', fragment: 1 },
  'rainbow-king': { name: '彩虹王', rarity: '传说', fragment: 5 },
  'year-200h': { name: '年度坚持', rarity: '传说', fragment: 10 },
})

/* ---------------- aggregate helpers (all pure) ---------------- */

function totals(days) {
  let focusMinutes = 0
  let completed = 0
  let bCount = 0
  for (const row of Object.values(days)) {
    focusMinutes += row.focusMinutes ?? 0
    completed += row.completed ?? 0
    bCount += row.quadrantB ?? 0
  }
  return { focusMinutes, completed, bCount }
}

function maxStreak(days) {
  return Math.max(0, ...Object.values(days).map(d => d.streak ?? 0))
}

function maxDayCompleted(days) {
  return Math.max(0, ...Object.values(days).map(d => d.completed ?? 0))
}

function yearFocusMinutes(days) {
  const byYear = {}
  for (const [date, row] of Object.entries(days)) {
    const y = date.slice(0, 4)
    byYear[y] = (byYear[y] ?? 0) + (row.focusMinutes ?? 0)
  }
  return byYear
}

/**
 * Count focus completions whose settle hour (statsTimeZone) falls in [from, to).
 * 判定数据源 = days.hours（§10.2 24 小时桶），不受 sessions 保留期限制。
 */
function settledInHours(days, tz, from, to) {
  let count = 0
  for (const row of Object.values(days)) {
    let buckets
    try { buckets = JSON.parse(row.hours) } catch { continue }
    if (!Array.isArray(buckets)) continue
    for (let h = 0; h < 24; h++) {
      if (!buckets[h]) continue
      const inWindow = from <= to ? (h >= from && h < to) : (h >= from || h < to)
      if (inWindow) count += buckets[h]
    }
  }
  return count
}

function finishedTasks(tasks) {
  return Object.values(tasks)
    .filter(t => t.estimatedPomodoros > 0 && t.completedPomodoros >= t.estimatedPomodoros)
}

function perfectEstimateRun(tasks) {
  // tasks with progress, ordered by completedAt; count the longest run of
  // consecutive tasks whose completed === estimated (exact match).
  const done = Object.values(tasks)
    .filter(t => t.completedPomodoros > 0 && t.completedAt != null)
    .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0))
  let run = 0
  let best = 0
  for (const t of done) {
    if (t.completedPomodoros === t.estimatedPomodoros) {
      run += 1
      best = Math.max(best, run)
    } else {
      run = 0
    }
  }
  return best
}

/** Is this settled session a focus completion? Breaks settle to 'waiting'. */
function isFocusCompletion(s) {
  return s.outcome === 'completed' && s.status === 'done' && s.mode != null
}

/* ---------------- evaluation ---------------- */

/**
 * @param state engine state (post-settle)
 * @returns {{ unlocked: Array<{id, name, rarity, unlockedAt, meta}>, fragments: number }}
 */
export function evaluate(state, now) {
  const { days, tasks, history, pet } = state
  const tz = state.settings?.statsTimeZone
  const unlocked = []
  const grant = (id, meta) => {
    if (state.achievements?.[id]) return
    const def = ACHIEVEMENTS[id]
    if (!def) return
    unlocked.push({ id, name: def.name, rarity: def.rarity, unlockedAt: now, meta: meta ?? null })
  }

  const t = totals(days)
  if (t.completed >= 1) grant('first-tomato')
  const streak = maxStreak(days)
  if (streak >= 3) grant('streak-3', { streak })
  if (streak >= 7) grant('streak-7', { streak })
  if (streak >= 30) grant('streak-30', { streak })
  const dayMax = maxDayCompleted(days)
  if (dayMax >= 4) grant('day-4', { dayMax })
  if (dayMax >= 8) grant('day-8', { dayMax })
  if (t.focusMinutes >= 600) grant('total-10h', { focusMinutes: t.focusMinutes })
  if (t.focusMinutes >= 6000) grant('total-100h', { focusMinutes: t.focusMinutes })
  if (t.focusMinutes >= 30000) grant('total-500h', { focusMinutes: t.focusMinutes })
  if (t.completed >= 20 && t.bCount / t.completed >= 0.6) {
    grant('b-region-60', { bRatio: Math.round(t.bCount / t.completed * 100) })
  }
  if (history.some(s => isFocusCompletion(s) && s.mode === 'deep' && s.focusMinutes >= 50)) {
    grant('deep-flow')
  }
  const earlyCount = settledInHours(days, tz, 6, 9)
  if (earlyCount >= 10) grant('early-bird', { count: earlyCount })
  const nightCount = settledInHours(days, tz, 22, 2)
  if (nightCount >= 10) grant('night-owl', { count: nightCount })
  if (finishedTasks(tasks).length >= 10) grant('task-finisher', { count: finishedTasks(tasks).length })
  const uncategorized = Object.values(days).reduce((n, d) => n + (d.uncategorized ?? 0), 0)
  if (uncategorized >= 10) grant('uncategorized-10', { count: uncategorized })
  if (perfectEstimateRun(tasks) >= 5) grant('perfect-estimates')
  if (stageFor(pet?.level ?? 1) === 'rainbow') grant('rainbow-king', { level: pet.level })
  const byYear = yearFocusMinutes(days)
  for (const [year, minutes] of Object.entries(byYear)) {
    if (minutes >= 12000) { grant('year-200h', { year, minutes }); break }
  }

  const fragments = unlocked.reduce((n, a) => n + (ACHIEVEMENTS[a.id].fragment ?? 0), 0)
  return { unlocked, fragments }
}
