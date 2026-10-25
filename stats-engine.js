/**
 * Stats engine — heat-map / trend / quadrant / hour distribution / weekly
 * & monthly reports (DESIGN.md §8.2–§8.4).
 *
 * Pure functions over the engine state's persisted aggregates:
 *  - state.days: 'YYYY-MM-DD' → day rows (completed/focusMinutes/quadrant counts)
 *  - state.history: settled sessions (for hour-of-day distribution)
 *
 * All dates are canonical YYYY-MM-DD in the configured statsTimeZone.
 */

import { dayOf } from './pet-engine.js'

const HEAT_LEVELS = [
  { min: 7, level: 4 },
  { min: 5, level: 3 },
  { min: 3, level: 2 },
  { min: 1, level: 1 },
]

/** Heat level 0-4 for a completed count (§8.2: 5 档). */
export function heatLevel(completed) {
  for (const l of HEAT_LEVELS) if (completed >= l.min) return l.level
  return 0
}

function dayRow(days, date) {
  return days[date] ?? { completed: 0, focusMinutes: 0, streak: 0, expGained: 0, quadrantA: 0, quadrantB: 0, quadrantC: 0, quadrantD: 0, uncategorized: 0 }
}

function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number)
  return dayOf(Date.UTC(y, m - 1, d) + n * 86_400_000, 'UTC')
}

/** Monday of the ISO week containing `date`. */
export function weekStartOf(date) {
  const [y, m, d] = date.split('-').map(Number)
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0=Sun
  const back = dow === 0 ? 6 : dow - 1
  return addDays(date, -back)
}

/* ---------------- §8.2 heat-map: full-year cells ---------------- */

/**
 * @returns {{ cells: [{date, completed, focusMinutes, level}], yearTotals: {completed, focusMinutes, longestStreak, activeDays} }}
 */
export function heatmap(state, year) {
  const cells = []
  const start = `${year}-01-01`
  const end = `${year}-12-31`
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const row = state.days[d]
    const completed = row?.completed ?? 0
    cells.push({
      date: d,
      completed,
      focusMinutes: row?.focusMinutes ?? 0,
      level: heatLevel(completed),
    })
  }
  const yearTotals = { completed: 0, focusMinutes: 0, longestStreak: 0, activeDays: 0 }
  // 最长连续 = 当年 days 行内 streak 的最大值（结算日写下的 streak 快照即
  // 「截至当日的连续天数」，逐年取 max 与跨年滚动口径一致；无需端点修复）。
  for (const [date, row] of Object.entries(state.days)) {
    if (!date.startsWith(String(year))) continue
    yearTotals.completed += row.completed ?? 0
    yearTotals.focusMinutes += row.focusMinutes ?? 0
    yearTotals.longestStreak = Math.max(yearTotals.longestStreak, row.streak ?? 0)
    if ((row.completed ?? 0) > 0) yearTotals.activeDays += 1
  }
  return { cells, yearTotals }
}

/* ---------------- §8.3 trend: weekly buckets ---------------- */

/**
 * @param weeks how many recent weeks (including the current one)
 * @returns [{weekStart, completed, focusMinutes}] oldest first
 */
export function trend(state, now, weeks = 4, tz) {
  const today = dayOf(now, tz)
  const thisWeek = weekStartOf(today)
  const out = []
  for (let i = weeks - 1; i >= 0; i--) {
    const ws = addDays(thisWeek, -7 * i)
    let completed = 0
    let focusMinutes = 0
    for (let d = 0; d < 7; d++) {
      const row = state.days[addDays(ws, d)]
      if (!row) continue
      completed += row.completed ?? 0
      focusMinutes += row.focusMinutes ?? 0
    }
    out.push({ weekStart: ws, completed, focusMinutes })
  }
  return out
}

/* ---------------- §8.3 quadrant distribution ---------------- */

/**
 * @param from 'YYYY-MM-DD' inclusive lower bound (or null for all time)
 * @returns {A, B, C, D, uncategorized, total}
 */
export function quadrantDist(state, from = null) {
  const dist = { A: 0, B: 0, C: 0, D: 0, uncategorized: 0 }
  for (const [date, row] of Object.entries(state.days)) {
    if (from && date < from) continue
    dist.A += row.quadrantA ?? 0
    dist.B += row.quadrantB ?? 0
    dist.C += row.quadrantC ?? 0
    dist.D += row.quadrantD ?? 0
    dist.uncategorized += row.uncategorized ?? 0
  }
  dist.total = dist.A + dist.B + dist.C + dist.D + dist.uncategorized
  return dist
}

/* ---------------- §8.3 hour-of-day distribution ---------------- */

/**
 * 24 buckets from days.hours（§10.2 小时桶）。
 * @param from 'YYYY-MM-DD' inclusive lower bound; default = 90 days ago.
 */
export function hourDist(state, tz, from = null) {
  const buckets = Array(24).fill(0)
  const today = dayOf(Date.now(), tz)
  const defaultFrom = addDays(today, -90)
  const lower = from ?? defaultFrom
  for (const [date, row] of Object.entries(state.days ?? {})) {
    if (date < lower) continue
    let parsed
    try { parsed = JSON.parse(row.hours) } catch { continue }
    if (!Array.isArray(parsed)) continue
    for (let h = 0; h < 24; h++) buckets[h] += parsed[h] ?? 0
  }
  return buckets
}

/* ---------------- §8.4 weekly / monthly reports ---------------- */

function rangeRows(state, startDate, endDate) {
  const rows = []
  for (let d = startDate; d <= endDate; d = addDays(d, 1)) {
    rows.push({ date: d, ...dayRow(state.days, d) })
  }
  return rows
}

function summarize(rows) {
  const sum = rows.reduce((acc, r) => ({
    completed: acc.completed + (r.completed ?? 0),
    focusMinutes: acc.focusMinutes + (r.focusMinutes ?? 0),
    expGained: acc.expGained + (r.expGained ?? 0),
    quadrantA: acc.quadrantA + (r.quadrantA ?? 0),
    quadrantB: acc.quadrantB + (r.quadrantB ?? 0),
    quadrantC: acc.quadrantC + (r.quadrantC ?? 0),
    quadrantD: acc.quadrantD + (r.quadrantD ?? 0),
    uncategorized: acc.uncategorized + (r.uncategorized ?? 0),
  }), { completed: 0, focusMinutes: 0, expGained: 0, quadrantA: 0, quadrantB: 0, quadrantC: 0, quadrantD: 0, uncategorized: 0 })
  sum.activeDays = rows.filter(r => (r.completed ?? 0) > 0).length
  sum.bRatio = sum.completed > 0 ? Math.round(sum.quadrantB / sum.completed * 100) : 0
  return sum
}

/**
 * Weekly report (§8.4): current ISO week vs previous week.
 * @returns {period, start, end, current, previous, deltaPercent, insight}
 */
export function weeklyReport(state, now, tz) {
  const today = dayOf(now, tz)
  const start = weekStartOf(today)
  const end = addDays(start, 6)
  const prevStart = addDays(start, -7)
  const prevEnd = addDays(start, -1)
  const current = summarize(rangeRows(state, start, end))
  const previous = summarize(rangeRows(state, prevStart, prevEnd))
  const deltaPercent = previous.completed > 0
    ? Math.round((current.completed - previous.completed) / previous.completed * 100)
    : (current.completed > 0 ? 100 : 0)
  let insight
  if (current.completed === 0) insight = '本周还没有番茄，从一个小目标开始'
  else if (current.bRatio >= 60) insight = `本周 B 区占 ${current.bRatio}%，把时间投在重要的事上，很棒`
  else if (previous.completed > 0 && deltaPercent >= 0) insight = `比上周多完成 ${deltaPercent}%，保持节奏`
  else if (previous.completed > 0) insight = `比上周少完成 ${Math.abs(deltaPercent)}%，明天补上一个番茄`
  else insight = `本周完成 ${current.completed} 个番茄，继续保持`
  // 心情曲线（days.moodEnd，§8.4）
  const moodCurve = rangeRows(state, start, end).map(r => ({ date: r.date, mood: r.moodEnd ?? null }))
  return { period: 'week', start, end, current, previous, deltaPercent, insight, moodCurve }
}

/**
 * Monthly report (§8.4): calendar month + last-4-week trend.
 * @returns {period, start, end, summary, trend, bestHour}
 */
export function monthlyReport(state, now, tz) {
  const today = dayOf(now, tz)
  const [y, m] = today.split('-').map(Number)
  const start = `${y}-${String(m).padStart(2, '0')}-01`
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const end = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  const summary = summarize(rangeRows(state, start, end))
  const trendWeeks = trend(state, now, 4, tz)
  const hours = hourDist(state, tz)
  const bestHour = hours.indexOf(Math.max(...hours))
  // achievements unlocked this month
  const monthPrefix = start.slice(0, 7)
  const achievements = Object.entries(state.achievements ?? {})
    .filter(([, a]) => String(a.unlockedAt ?? '').length > 0
      && dayOf(a.unlockedAt, tz).startsWith(monthPrefix))
    .map(([id, a]) => ({ id, ...a }))
  return {
    period: 'month', start, end, summary, trend: trendWeeks,
    bestHour: summary.completed > 0 ? bestHour : null,
    achievements,
  }
}
