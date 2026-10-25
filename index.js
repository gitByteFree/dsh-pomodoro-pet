/**
 * Pomodoro Pet — Host half (plain-JS function plugin, zero npm deps).
 *
 * Architecture (DESIGN.md §3/§10, M0-probe-verified):
 *  - storageDomain 'pomodoro_pet' for pets/sessions/days/settings
 *  - webServer routes /dsh-pomodoro/* behind the connection trust fence
 *  - ctx.timer arms absolute endsAt deadlines; recovery on boot
 *  - ctx.tools.register raw ToolDefinition `pomodoro_pet`
 *  - ALL writes go through pet-engine.transition() on a serial command chain
 */

export const name = 'pomodoro-pet'
export const inject = ['storageDomain', 'webServer', 'tools', 'timer']

/**
 * Plugin Config — Standard Schema face (cordis calls Config['~standard'].validate).
 * Zero-dependency: numeric range checks with defaults.
 */
const CONFIG_FIELDS = {
  focusMin: [1, 240, 25],
  breakMin: [1, 60, 5],
  longBreakMin: [1, 120, 15],
  roundsPerLong: [1, 12, 4],
  maxFocusMin: [1, 240, 120],
  maxSessionDays: [1, 365, 30],
}
export const Config = {
  '~standard': {
    version: 1,
    validate(value) {
      const input = (typeof value === 'object' && value !== null) ? value : {}
      const out = {}
      const issues = []
      for (const [key, [min, max, dflt]] of Object.entries(CONFIG_FIELDS)) {
        const raw = input[key] ?? dflt
        const num = Number(raw)
        if (!Number.isFinite(num) || num < min || num > max) {
          issues.push({ message: `${key} must be a number in [${min}, ${max}]`, path: [key] })
        } else {
          out[key] = num
        }
      }
      return issues.length ? { issues } : { value: out }
    },
  },
}

/* ---------------- zod-compatible schema stubs (M0 V1 pattern) -------- */

function objSchema(fields) {
  return {
    parse(raw) {
      if (typeof raw !== 'object' || raw === null) throw new Error('record must be an object')
      const out = { ...raw }
      for (const [key, type] of Object.entries(fields)) {
        if (raw[key] === undefined || raw[key] === null) continue
        const t = Array.isArray(type) ? type : [type]
        if (!t.includes(typeof raw[key])) throw new Error(`field "${key}" must be ${t.join('|')}`)
      }
      return out
    },
    safeParse(v) { try { this.parse(v); return { success: true } } catch { return { success: false } } },
  }
}

const domainSpec = {
  // single 布局的 JSON 后端要求存储版本严格等于 spec version（compatibleVersions
  // 仅对 per-record 布局生效），因此保持 version 1，v0.4 新字段由 loadState
  // 迁移默认值（§10.3 的兼容策略在 single 布局下等价于「字段级可选+加载补齐」）。
  name: 'pomodoro_pet', version: 1,
  tables: {
    pets: { valueSchema: objSchema({ exp: 'number', level: 'number', mood: 'number', updatedAt: 'number', rounds: 'number', outfitId: ['string', 'object'] }) },
    sessions: { valueSchema: objSchema({ status: 'string', startedAt: 'number', endsAt: ['number', 'object'], focusMinutes: 'number', revision: 'number' }) },
    days: { valueSchema: objSchema({ completed: 'number', focusMinutes: 'number', streak: 'number', expGained: 'number', hours: ['string', 'object'], moodEnd: ['number', 'object'] }) },
    settings: { valueSchema: objSchema({ value: ['string', 'number', 'object', 'boolean'] }) },
    // v0.3 (§10.2): task system + achievements + inventory.
    tasks: { valueSchema: objSchema({ title: 'string', groupId: ['string', 'object'], quadrant: 'string', estimatedPomodoros: 'number', completedPomodoros: 'number', status: 'string', sortOrder: 'number', createdAt: 'number', completedAt: ['number', 'object'] }) },
    groups: { valueSchema: objSchema({ name: 'string', sortOrder: 'number', createdAt: 'number' }) },
    achievements: { valueSchema: objSchema({ unlockedAt: 'number', meta: ['string', 'number', 'object'] }) },
    inventory: { valueSchema: objSchema({ count: 'number', firstObtainedAt: 'number' }) },
    // v0.4 (D16/§10.2): proposal loop + audit trail.
    proposals: { valueSchema: objSchema({ type: 'string', payload: 'string', status: 'string', createdAt: 'number', resolvedAt: ['number', 'object'] }) },
    audit_log: { valueSchema: objSchema({ toolAction: 'string', params: 'string', result: 'string', at: 'number' }) },
  },
}

/* ---------------- helpers ---------------- */

const BODY_MAX = 64 * 1024

/**
 * Row deletion with a probe-safe fallback: M0 verified put/get/entries only,
 * so when table.delete is unavailable we tombstone and filter on load.
 */
async function removeRow(table, id) {
  if (typeof table.delete === 'function') {
    await table.delete(id)
  } else {
    await table.put(id, { _deleted: true })
  }
}

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > BODY_MAX) { req.resume(); return null }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/* ---------------- apply ---------------- */

export function apply(ctx, config) {
  const cfg = { ...config }
  const now = () => Date.now()
  /** Serial write chain: every mutation queues here (M0-verified schedule pattern). */
  let chain = Promise.resolve()
  const serialize = (job) => {
    const run = chain.then(job, job)
    chain = run.then(() => {}, () => {})
    return run
  }

  let domain
  let ready = ctx.storageDomain.open(domainSpec).then(d => { domain = d; return d })

  /* Engine state is loaded from tables on boot and re-folded on every write. */
  const loadState = async () => {
    await ready
    // v0.4 migration (§10.3): pets 补 rounds/outfitId；days 补 hours/moodEnd。
    const petsTable = domain.table('pets')
    const petRaw = petsTable.get('default')
    const petRow = petRaw
      ? { rounds: 0, outfitId: null, ...petRaw }
      : { exp: 0, level: 1, mood: 3, rounds: 0, outfitId: null, updatedAt: now() }
    const settings = {}
    for (const [k, v] of domain.table('settings').entries()) {
      if (k.startsWith('_')) continue // internal keys (feeds/meta/settlement) handled below
      settings[k] = v.value
    }
    // Rebuild day rows (authoritative) and find any unsettled running session.
    const days = {}
    for (const [date, row] of domain.table('days').entries()) {
      days[date] = { hours: JSON.stringify(new Array(24).fill(0)), moodEnd: null, ...row }
    }
    let running = null
    let history = []
    for (const [, s] of domain.table('sessions').entries()) {
      if (s._deleted) continue // tombstone（测试清理/审计删除）不进运行态也不进历史
      if (['focus', 'paused', 'break', 'longBreak', 'waiting'].includes(s.status) && !s.settledAt) {
        if (!running || s.startedAt > running.startedAt) running = s
      } else {
        history.push(s)
      }
    }
    history.sort((a, b) => (a.settledAt ?? 0) - (b.settledAt ?? 0))
    // v0.3 tables + engine meta (tombstones filtered — probe-safe deletion).
    const tasks = {}
    for (const [id, t] of domain.table('tasks').entries()) if (!t._deleted) tasks[id] = t
    const groups = {}
    for (const [id, g] of domain.table('groups').entries()) if (!g._deleted) groups[id] = g
    const achievements = {}
    for (const [id, a] of domain.table('achievements').entries()) achievements[id] = a
    const inventory = {}
    for (const [id, i] of domain.table('inventory').entries()) inventory[id] = i
    const meta = domain.table('settings').get('_meta')?.value ?? {}
    // v0.4 (D16): proposals — pending 超 7 天自动置 rejected（懒过期，防堆积）。
    const proposalsTable = domain.table('proposals')
    const proposals = []
    for (const [id, p] of proposalsTable.entries()) {
      if (p._deleted) continue
      if (p.status === 'pending' && now() - p.createdAt > 7 * 86_400_000) {
        const expired = { ...p, status: 'rejected', resolvedAt: now() }
        await proposalsTable.put(id, expired)
        proposals.push(expired)
      } else {
        proposals.push(p)
      }
    }
    proposals.sort((a, b) => b.createdAt - a.createdAt)
    const engineState = {
      pet: petRow,
      running, history: history.slice(-200), days,
      settings: { ...DEFAULT_SETTINGS, focusMin: cfg.focusMin, breakMin: cfg.breakMin, longBreakMin: cfg.longBreakMin, ...settings },
      roundIndex: running?.roundIndex ?? 0,
      tasks, groups, achievements, inventory,
      activeTaskId: meta.activeTaskId ?? null,
      lastSettlement: domain.table('settings').get('_lastSettlement')?.value ?? null,
      seq: meta.seq ?? 0,
    }
    return {
      engineState, proposals,
      settingsTable: domain.table('settings'), sessionsTable: domain.table('sessions'), daysTable: domain.table('days'), petsTable,
      tasksTable: domain.table('tasks'), groupsTable: domain.table('groups'),
      achievementsTable: domain.table('achievements'), inventoryTable: domain.table('inventory'),
      proposalsTable, auditLogTable: domain.table('audit_log'),
    }
  }

  /* ---------------- persistence of one transition ---------------- */

  const persist = async (tables, prevState, result) => {
    const { engineState } = result.state ? { engineState: result.state } : {}
    if (!engineState) return
    const pet = engineState.pet
    // v0.4: rounds/outfitId（D18/§7.6）也是 pets 行字段，变更需落库。
    if (!prevState || prevState.pet.exp !== pet.exp || prevState.pet.level !== pet.level || prevState.pet.mood !== pet.mood
      || prevState.pet.rounds !== pet.rounds || prevState.pet.outfitId !== pet.outfitId) {
      await tables.petsTable.put('default', { ...pet })
    }
    if (prevState?.running?.id !== engineState.running?.id || prevState?.running?.revision !== engineState.running?.revision) {
      if (prevState?.running) await tables.sessionsTable.put(prevState.running.id, { ...prevState.running, settledAt: prevState.running.settledAt ?? now() })
      if (engineState.running) await tables.sessionsTable.put(engineState.running.id, { ...engineState.running })
    }
    // 终态行落库：transition 把 settled 行（done/skipped/completed + outcome）追加进
    // history，上面 prevState.running 写的是终止前的旧快照，必须以 history 里的
    // 终态行覆盖，否则重启后该行带 status:focus 残留（§4.3.1 终态表）。
    if (prevState) {
      const prevSettled = new Set((prevState.history ?? []).map(s => `${s.id}:${s.settledAt ?? ''}`))
      for (const s of engineState.history ?? []) {
        if (!prevSettled.has(`${s.id}:${s.settledAt ?? ''}`) && s.settledAt) {
          await tables.sessionsTable.put(s.id, { ...s })
        }
      }
    }
    for (const [date, row] of Object.entries(engineState.days)) {
      const prevRow = prevState?.days?.[date]
      if (!prevRow || prevRow.completed !== row.completed || prevRow.expGained !== row.expGained) {
        await tables.daysTable.put(date, { ...row })
      }
    }
    // v0.3: tasks / groups (per-row diff), achievements / inventory (map diff).
    for (const [id, t] of Object.entries(engineState.tasks)) {
      if (JSON.stringify(prevState?.tasks?.[id]) !== JSON.stringify(t)) await tables.tasksTable.put(id, { ...t })
    }
    if (prevState) {
      for (const id of Object.keys(prevState.tasks ?? {})) {
        if (!engineState.tasks[id]) await removeRow(tables.tasksTable, id)
      }
    }
    for (const [id, g] of Object.entries(engineState.groups)) {
      if (JSON.stringify(prevState?.groups?.[id]) !== JSON.stringify(g)) await tables.groupsTable.put(id, { ...g })
    }
    if (prevState) {
      for (const id of Object.keys(prevState.groups ?? {})) {
        if (!engineState.groups[id]) await removeRow(tables.groupsTable, id)
      }
    }
    for (const [id, a] of Object.entries(engineState.achievements)) {
      if (!prevState?.achievements?.[id]) await tables.achievementsTable.put(id, { ...a })
    }
    for (const [id, i] of Object.entries(engineState.inventory)) {
      if (prevState?.inventory?.[id]?.count !== i.count) await tables.inventoryTable.put(id, { ...i })
    }
    // Engine meta (seq counter, default task) + settlement payload.
    const meta = { seq: engineState.seq, activeTaskId: engineState.activeTaskId }
    if (JSON.stringify(prevState && { seq: prevState.seq, activeTaskId: prevState.activeTaskId }) !== JSON.stringify(meta)) {
      await tables.settingsTable.put('_meta', { value: meta })
    }
    if (JSON.stringify(prevState?.lastSettlement ?? null) !== JSON.stringify(engineState.lastSettlement ?? null)) {
      await tables.settingsTable.put('_lastSettlement', { value: engineState.lastSettlement })
    }
  }

  /* ---------------- the ONE write entry (UI + Tool share it) -------- */

  let engineCache = null
  const withEngine = async () => {
    if (!engineCache) engineCache = await loadState()
    return engineCache
  }

  /* ---------------- v0.8 agent bridge (DSH session / agent / tools) ---- */

  const optionalService = (name) => {
    try { return ctx.get(name) } catch { return undefined }
  }
  const bridgeDayOf = (ts) => {
    try {
      const tz = engineCache?.engineState?.settings?.statsTimeZone
      return dayOf(ts, tz)
    } catch { return dayOf(ts) }
  }
  /** 会话正式标题（sessionTitle 服务, 10s 缓存; 服务缺失时返回 null）。 */
  const titleCache = new Map()
  const titleOf = (session) => {
    try {
      const id = session?.id
      if (!id) return null
      const hit = titleCache.get(id)
      if (hit && now() - hit.at < 10_000) return hit.title
      const svc = optionalService('sessionTitle')
      const title = svc?.get ? (svc.get(session)?.title ?? null) : null
      titleCache.set(id, { title, at: now() })
      if (titleCache.size > 50) {
        const oldest = [...titleCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
        if (oldest) titleCache.delete(oldest[0])
      }
      return title
    } catch { return null }
  }
  const bridge = createAgentBridge({ now, dayOf: bridgeDayOf, titleOf })

  /** engine session id → DSH session context captured when the focus started. */
  const focusMeta = new Map()

  /** Attach DSH session context + agent tool count to running/settled rows. */
  const decorateFocus = (state) => {
    if (!state) return
    const live = bridge.session()
    if (state.running) {
      const prev = focusMeta.get(state.running.id)
      // 开始时可能还没有会话上下文；后到的事件补上（label/cwd 都可能晚到）
      if (prev === undefined || (prev === null && live) || (prev && !prev.label && live && live.id === prev.id)) {
        focusMeta.set(state.running.id, live ?? prev ?? null)
      }
    }
    for (const row of state.history ?? []) {
      if (!row?.settledAt || row.dshCwd !== undefined) continue
      const m = focusMeta.get(row.id)
      if (!m) continue
      // 结算时若当前会话已补上标签，用更新的那份
      const use = (live && m.id && live.id === m.id && !m.label && live.label) ? live : m
      row.agentToolCount = bridge.countTools(row.startedAt, row.settledAt)
      row.dshSessionId = use.id ?? null
      row.dshSessionLabel = use.label ?? null
      row.dshCwd = use.cwd ?? null
      row.dshCwdName = use.cwdName ?? null
      focusMeta.delete(row.id)
      if (state.lastSettlement && state.lastSettlement.id === row.id) {
        state.lastSettlement = {
          ...state.lastSettlement,
          agentToolCount: row.agentToolCount,
          dshSessionLabel: row.dshSessionLabel,
        }
      }
    }
    // bound the map (abandoned running sessions)
    if (focusMeta.size > 40) {
      const keep = state.running ? state.running.id : null
      for (const id of [...focusMeta.keys()]) if (id !== keep) focusMeta.delete(id)
    }
  }

  /* ---- skills directory for the current workspace (60s cache) ---- */
  let skillsCache = { at: 0, cwd: null, data: null }
  const loadSkills = async (cwd) => {
    const skills = optionalService('skills')
    if (!skills?.list) return null
    const key = cwd ?? ''
    if (skillsCache.data && skillsCache.cwd === key && now() - skillsCache.at < 60_000) return skillsCache.data
    try {
      const list = await skills.list({ cwd: cwd ?? undefined })
      const items = (Array.isArray(list) ? list : []).slice(0, 20).map(s => ({
        name: s.name,
        description: String(s.description ?? '').slice(0, 80),
        userInvocable: s.invocation?.userInvocable !== false,
      }))
      const data = { cwd: cwd ?? null, count: Array.isArray(list) ? list.length : items.length, items }
      skillsCache = { at: now(), cwd: key, data }
      return data
    } catch { return skillsCache.data ?? null }
  }

  /** Context payload shared by GET /context and the `agent` SSE frame. */
  const buildContext = async ({ withSkills = false } = {}) => {
    const snap = bridge.snapshot()
    return {
      ok: true,
      now: snap.now,
      session: snap.session,
      agent: snap.agent,
      ...(withSkills ? { skills: await loadSkills(snap.session?.cwd) } : {}),
    }
  }

  /* ---- throttled `agent` SSE frame ---- */
  let agentFrameTimer = null
  const scheduleAgentFrame = () => {
    if (agentFrameTimer) return
    agentFrameTimer = setTimeout(async () => {
      agentFrameTimer = null
      if (sseClients.size === 0) return
      let data
      try { data = await buildContext() } catch { return }
      const frame = `event: agent\ndata: ${JSON.stringify(data)}\n\n`
      for (const res of [...sseClients]) {
        try { res.write(frame) } catch { sseClients.delete(res) }
      }
    }, 800)
    agentFrameTimer.unref?.()
  }

  /* ---- daily agent counters (settings KV `_agent_<YYYY-MM-DD>`) ---- */
  let agentFlushTimer = null
  let lastPrunedDay = null
  const pruneAgentKeys = async (env) => {
    const today = bridge.currentDay()
    if (lastPrunedDay === today) return
    lastPrunedDay = today
    const cutoff = new Date(now() - 30 * 86_400_000).toISOString().slice(0, 10)
    for (const key of [...env.settingsTable.entries()].map(([k]) => k)) {
      if (!key.startsWith('_agent_')) continue
      const day = key.slice('_agent_'.length)
      if (day < cutoff) await removeRow(env.settingsTable, key)
    }
  }
  const flushAgentCounters = () => {
    const dirty = bridge.takeDirty()
    if (!dirty) return
    void serialize(async () => {
      const env = await withEngine()
      await env.settingsTable.put(`_agent_${dirty.day}`, { value: { tools: dirty.tools, steps: dirty.steps, updatedAt: now() } })
      await pruneAgentKeys(env)
    }).catch(() => { /* counters are best-effort */ })
  }
  agentFlushTimer = setInterval(flushAgentCounters, 5000)
  agentFlushTimer.unref?.()

  /* ---- listeners: session / agent / tool activity ---- */
  ctx.effect(() => {
    const offs = []
    const on = (name, fn) => {
      try { offs.push(ctx.on(name, fn)) } catch { /* event channel unavailable */ }
    }
    on('session/event', (session, event) => bridge.onSessionEvent(session, event))
    on('agent/status', (payload) => bridge.onAgentStatus(payload))
    on('tools/result', (exec, result) => bridge.onToolResult(exec, result))
    const offChange = bridge.onChange(() => scheduleAgentFrame())
    return () => {
      offChange?.()
      for (const off of offs) { try { off?.() } catch { /* already gone */ } }
      bridge.dispose()
    }
  }, 'pomodoro-pet: agent bridge')

  /* boot: restore today's counters + prune old ones */
  ctx.effect(async () => {
    try {
      // 启动即给 bridge 播一个当前会话（取最新创建的 root 会话），
      // 这样重启后即使还没有新的用户消息，番茄也能归属到正确会话。
      const roots = optionalService('agents')?.roots?.() ?? []
      const live = roots
        .map(agent => agent?.session)
        .filter(Boolean)
        .sort((a, b) => (b.header?.createdAt ?? 0) - (a.header?.createdAt ?? 0))[0]
      if (live) bridge.adopt(live)
      const env = await withEngine()
      const today = bridge.currentDay()
      const row = env.settingsTable.get(`_agent_${today}`)
      if (row?.value) bridge.loadBucket(today, row.value)
      await pruneAgentKeys(env)
    } catch { /* non-fatal */ }
  }, 'pomodoro-pet: agent counters boot')

  /* ---------------- SSE broadcast: push snapshots to live Clients ------- */

  const sseClients = new Set()
  const broadcast = async () => {
    if (sseClients.size === 0) return
    let snap
    try { snap = await readSnapshot() } catch { return }
    const frame = `event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`
    for (const res of [...sseClients]) {
      try { res.write(frame) } catch { sseClients.delete(res) }
    }
  }

  /** Body of one transition — runs INSIDE a serialize() job (never nests). */
  const execEvent = async (event, source) => {
    const env = await withEngine()
    const result = transition(env.engineState, { ...event, source }, { now })
    const withProposals = (snap) => ({ ...snap, proposals: env.proposals.filter(p => p.status === 'pending') })
    if (result.code) {
      // Rejections still carry a fresh snapshot: broadcast so stale views realign.
      const snap = withProposals(snapshotOf(env.engineState, now()))
      const frame = `event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`
      for (const res of [...sseClients]) { try { res.write(frame) } catch { sseClients.delete(res) } }
      return { ok: false, code: result.code, snapshot: snap }
    }
    decorateFocus(result.state)
    await persist(env, env.engineState, result)
    engineCache = { ...env, engineState: result.state }
    applyEffects(result.effects ?? [])
    const snap = withProposals(snapshotOf(result.state, now()))
    const frame = `event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`
    for (const res of [...sseClients]) { try { res.write(frame) } catch { sseClients.delete(res) } }
    // §11.1: 变更类接口附带本次落库的专项结构（task/group）。
    const extra = {}
    if (result.task) extra.task = result.task
    if (result.group) extra.group = result.group
    return { ok: true, ...extra, snapshot: snap }
  }

  const dispatch = (event, source) => serialize(() => execEvent(event, source))

  /* ---------------- v0.4 proposals (D16: Agent 写操作一律入队) -------- */

  const PROPOSAL_TYPES = ['task_create', 'task_update']

  const createProposal = (type, payload) => serialize(async () => {
    if (!PROPOSAL_TYPES.includes(type)) return { ok: false, code: 'invalid', summary: `未知提议类型 ${type}` }
    const env = await withEngine()
    const row = {
      id: `p${now()}`, type, payload: JSON.stringify(payload),
      status: 'pending', createdAt: now(), resolvedAt: null,
    }
    await env.proposalsTable.put(row.id, row)
    engineCache = { ...env, proposals: [row, ...env.proposals] }
    await broadcast()
    return { ok: true, proposal: row }
  })

  const resolveProposal = (id, verdict) => serialize(async () => {
    const env = await withEngine()
    const row = env.proposals.find(p => p.id === id)
    if (!row || row._deleted) return { ok: false, code: 'not_found', summary: `提议 ${id} 不存在` }
    if (row.status !== 'pending') {
      return { ok: false, code: 'invalid_state', summary: `提议已处理（${row.status}）` }
    }
    const closed = { ...row, status: verdict, resolvedAt: now() }
    await env.proposalsTable.put(id, closed)
    engineCache = { ...env, proposals: env.proposals.map(p => (p.id === id ? closed : p)) }
    // confirmed：串行链内执行 payload，等效用户手工操作（D16）。
    if (verdict === 'confirmed') {
      const payload = JSON.parse(row.payload ?? '{}')
      const result = row.type === 'task_create'
        ? await execEvent(TASK_CREATE(payload), 'ui')
        : await execEvent(TASK_UPDATE(payload.taskId, payload.patch ?? {}), 'ui')
      if (!result.ok) return { ok: false, code: result.code ?? 'invalid', summary: `提议执行失败: ${result.code ?? ''}`, snapshot: result.snapshot }
      return { ok: true, snapshot: result.snapshot }
    }
    await broadcast()
    return { ok: true, snapshot: await readSnapshot() }
  })

  /* ---------------- effects: timers + notifications ---------------- */

  let armToken = 0
  function applyEffects(effects) {
    for (const fx of effects) {
      if (fx.type === 'armTimer') {
        const token = ++armToken
        const delay = Math.max(0, fx.at - now())
        const stop = ctx.timer.timeout(() => {
          if (token === armToken) void dispatch(TICK_EXPIRE(), 'timer')
        }, delay)
        // Re-arm replaces the previous deadline: cancelling the old one is implied
        // by the token check; keep a stopper for plugin teardown.
        currentTimerStop = stop
      } else if (fx.type === 'cancelTimer') {
        armToken += 1
        currentTimerStop?.()
        currentTimerStop = undefined
      } else if (fx.type === 'notify') {
        ctx.emit('pomodoro/changed', { kind: fx.kind, at: now() })
      }
      // petHappy/petSad/petCheer/evolve ride the snapshot to the Client.
    }
  }
  let currentTimerStop

  /* ---------------- snapshot read path (no chain, no write) -------- */

  const readSnapshot = async () => {
    const env = await withEngine()
    // v0.4: 快照携带 pending 提议（§13.5 任务 Tab 待确认区）。
    return { ...snapshotOf(env.engineState, now()), proposals: env.proposals.filter(p => p.status === 'pending') }
  }

  /* ---------------- HTTP routes (M0 V2 pattern) ---------------- */

  let connection
  try { connection = ctx.connection } catch { /* optional */ }
  const rejected = (req, res) => {
    if (connection?.requestRejection === undefined) return false
    const code = connection.requestRejection({ headers: req.headers })
    if (code === undefined) return false
    res.statusCode = code
    res.end()
    return true
  }

  const routeDisposers = [
    ctx.webServer.register({
      kind: 'exact', path: '/dsh-pomodoro/events',
      handler: async (req, res) => {
        if (rejected(req, res)) return
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, code: 'method' })
        // Server-Sent Events: one push channel per connected browser surface.
        res.statusCode = 200
        res.setHeader('content-type', 'text/event-stream; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.setHeader('connection', 'keep-alive')
        res.write(': connected\n\n')
        sseClients.add(res)
        // Initial frame so a fresh subscriber renders immediately.
        try { res.write(`event: snapshot\ndata: ${JSON.stringify(await readSnapshot())}\n\n`) } catch { /* closed */ }
        try { res.write(`event: agent\ndata: ${JSON.stringify(await buildContext())}\n\n`) } catch { /* closed */ }
        // Heartbeat keeps proxies from closing an idle stream; a hard 5-min
        // lifetime bounds each stream so a leaked subscriber (crashed tab,
        // dead extension session) frees its slot instead of pinning the
        // browser's HTTP/1.1 connection pool — the Client reconnects on
        // visibility and its 30s poll covers the gap.
        const MAX_STREAM_MS = 5 * 60_000
        const startedAt = Date.now()
        const heartbeat = setInterval(() => {
          if (Date.now() - startedAt > MAX_STREAM_MS) {
            try { res.end() } catch { /* already gone */ }
            clearInterval(heartbeat)
            sseClients.delete(res)
            return
          }
          try { res.write(': ping\n\n') } catch { clearInterval(heartbeat); sseClients.delete(res) }
        }, 25_000)
        req.on('close', () => { clearInterval(heartbeat); sseClients.delete(res) })
      },
    }),
    ctx.webServer.register({
      kind: 'exact', path: '/dsh-pomodoro/state',
      handler: async (req, res) => {
        if (rejected(req, res)) return
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, code: 'method' })
        try { sendJson(res, 200, { ok: true, snapshot: await readSnapshot() }) }
        catch (error) { sendJson(res, 500, { ok: false, code: 'internal', message: String(error?.message ?? error) }) }
      },
    }),
    ctx.webServer.register({
      kind: 'exact', path: '/dsh-pomodoro/action',
      handler: async (req, res) => {
        if (rejected(req, res)) return
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, code: 'method' })
        const body = await readBody(req)
        let parsed
        try { parsed = JSON.parse(String(body ?? '')) } catch { parsed = null }
        const action = parsed?.action
        if (action === 'start') return sendJson(res, 200, await dispatch(START(parsed?.focusMinutes, { taskId: parsed?.taskId, mode: parsed?.mode }), 'ui'))
        if (action === 'pause') return sendJson(res, 200, await dispatch(PAUSE(), 'ui'))
        if (action === 'resume') return sendJson(res, 200, await dispatch(RESUME(), 'ui'))
        if (action === 'stop') return sendJson(res, 200, await dispatch(STOP(), 'ui'))
        if (action === 'setTask') return sendJson(res, 200, await dispatch(SET_TASK(parsed?.taskId), 'ui'))
        if (action === 'setMode') return sendJson(res, 200, await dispatch(SET_MODE(parsed?.mode), 'ui'))
        if (action === 'redeemOutfit') return sendJson(res, 200, await dispatch(REDEEM_OUTFIT(parsed?.itemId), 'ui'))
        sendJson(res, 400, { ok: false, code: 'invalid', message: `unknown action ${JSON.stringify(action)}` })
      },
    }),
    ctx.webServer.register({
      kind: 'exact', path: '/dsh-pomodoro/settings',
      handler: async (req, res) => {
        if (rejected(req, res)) return
        if (req.method === 'GET') {
          const env = await withEngine()
          return sendJson(res, 200, { ok: true, settings: env.engineState.settings })
        }
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, code: 'method' })
        const body = await readBody(req)
        let patch
        try { patch = JSON.parse(String(body ?? '')) } catch { patch = null }
        if (typeof patch !== 'object' || patch === null) return sendJson(res, 400, { ok: false, code: 'invalid' })
        await serialize(async () => {
          const env = await withEngine()
          const allowed = [
            'focusMin', 'breakMin', 'longBreakMin', 'roundsPerLong', 'soundEnabled', 'statsTimeZone',
            'petPosition', 'petScale', 'mode', 'defaultQuadrant',
            // v0.4 (§10.2 settings 全量键)
            'volume', 'notificationEnabled', 'animationEnabled', 'dailyGoalPomodoros',
            'maxPauseMin', 'auditEnabled', 'reconcileIntervalMs', 'dailyFeedLimit',
          ]
          let reconcileChanged = false
          // 数值键合法域（D19/D20）：越界钳制到边界，避免写入非法值。
          const clamp = { focusMin: [5, 120], breakMin: [1, 60], longBreakMin: [1, 120], roundsPerLong: [2, 12], dailyGoalPomodoros: [1, 50], maxPauseMin: [1, 60], dailyFeedLimit: [0, 20], volume: [0, 1], petScale: [0.5, 2], reconcileIntervalMs: [10_000, 600_000] }
          for (const key of allowed) {
            if (patch[key] === undefined) continue
            let value = patch[key]
            const range = clamp[key]
            if (range && typeof value === 'number' && Number.isFinite(value)) value = Math.min(range[1], Math.max(range[0], value))
            if (key === 'reconcileIntervalMs' && value !== env.engineState.settings.reconcileIntervalMs) reconcileChanged = true
            env.engineState.settings[key] = value
            await env.settingsTable.put(key, { value })
          }
          if (reconcileChanged) void setupReconcile()
          return null
        })
        sendJson(res, 200, { ok: true, snapshot: await readSnapshot() })
      },
    }),
    ctx.webServer.register({
      kind: 'exact', path: '/dsh-pomodoro/history',
      handler: async (req, res) => {
        if (rejected(req, res)) return
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, code: 'method' })
        const url = new URL(String(req.url), 'http://localhost')
        const days = Math.max(1, Math.min(90, Number(url.searchParams.get('days')) || 7))
        const snap = await readSnapshot()
        sendJson(res, 200, { ok: true, recent: snap.recent.slice(-days), today: snap.today })
      },
    }),

    /* -------- v0.3: tasks / groups (§11.1) -------- */

    ctx.webServer.register({
      kind: 'exact', path: '/dsh-pomodoro/tasks',
      handler: async (req, res) => {
        if (rejected(req, res)) return
        const url = new URL(String(req.url), 'http://localhost')
        // Fallback channel: PATCH/DELETE /dsh-pomodoro/tasks?id=... (prefix route
        // may be unavailable in some webServer builds; M0 verified exact only).
        const fallbackId = url.searchParams.get('id')
        const snap = await readSnapshot()
        if (req.method === 'GET') {
          const quadrant = url.searchParams.get('quadrant')
          const status = url.searchParams.get('status')
          let tasks = snap.tasks
          if (quadrant) tasks = tasks.filter(t => t.quadrant === quadrant)
          if (status) tasks = tasks.filter(t => t.status === status)
          return sendJson(res, 200, { ok: true, tasks, groups: snap.groups })
        }
        if (req.method === 'POST') {
          const body = await readBody(req)
          let parsed
          try { parsed = JSON.parse(String(body ?? '')) } catch { parsed = null }
          const result = await dispatch(TASK_CREATE(parsed ?? {}), 'ui')
          return sendJson(res, 200, result.ok
            ? { ok: true, task: result.task, snapshot: result.snapshot }
            : { ok: false, code: result.code === 'not_found' ? 'not_found' : 'invalid', snapshot: result.snapshot })
        }
        if ((req.method === 'PATCH' || req.method === 'DELETE') && fallbackId) {
          return handleTaskPatchDelete(req, res, fallbackId)
        }
        sendJson(res, 405, { ok: false, code: 'method' })
      },
    }),
    ctx.webServer.register({
      // Variable segment: /dsh-pomodoro/tasks/:id — registered as prefix with a
      // graceful skip when the host build doesn't support the kind.
      kind: 'prefix', path: '/dsh-pomodoro/tasks/',
      handler: async (req, res) => {
        if (rejected(req, res)) return
        const id = decodeURIComponent(String(req.url).replace(/^.*\/dsh-pomodoro\/tasks\//, '').split('?')[0])
        return handleTaskPatchDelete(req, res, id)
      },
    }),
    ctx.webServer.register({
      kind: 'exact', path: '/dsh-pomodoro/groups',
      handler: async (req, res) => {
        if (rejected(req, res)) return
        const url = new URL(String(req.url), 'http://localhost')
        const fallbackId = url.searchParams.get('id')
        if (req.method === 'GET') {
          const snap = await readSnapshot()
          return sendJson(res, 200, { ok: true, groups: snap.groups })
        }
        if (req.method === 'POST') {
          const body = await readBody(req)
          let parsed
          try { parsed = JSON.parse(String(body ?? '')) } catch { parsed = null }
          const result = await dispatch(GROUP_CREATE(parsed?.name), 'ui')
          return sendJson(res, 200, result.ok
            ? { ok: true, group: result.group, snapshot: result.snapshot }
            : { ok: false, code: 'invalid', snapshot: result.snapshot })
        }
        if ((req.method === 'PATCH' || req.method === 'DELETE') && fallbackId) {
          return handleGroupPatchDelete(req, res, fallbackId, req.method)
        }
        sendJson(res, 405, { ok: false, code: 'method' })
      },
    }),
    ctx.webServer.register({
      kind: 'prefix', path: '/dsh-pomodoro/groups/',
      handler: async (req, res) => {
        if (rejected(req, res)) return
        const id = decodeURIComponent(String(req.url).replace(/^.*\/dsh-pomodoro\/groups\//, '').split('?')[0])
        return handleGroupPatchDelete(req, res, id, req.method)
      },
    }),

    /* -------- v0.3: stats & achievements (§8, §11.1) -------- */

    ctx.webServer.register({
      kind: 'exact', path: '/dsh-pomodoro/heatmap',
      handler: async (req, res) => {
        if (rejected(req, res)) return
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, code: 'method' })
        const url = new URL(String(req.url), 'http://localhost')
        const env = await withEngine()
        const tz = env.engineState.settings.statsTimeZone
        const year = Math.max(2000, Math.min(2100, Number(url.searchParams.get('year')) || Number(dayOf(now(), tz).slice(0, 4))))
        sendJson(res, 200, { ok: true, ...heatmap(env.engineState, year), year })
      },
    }),
    ctx.webServer.register({
      kind: 'exact', path: '/dsh-pomodoro/trend',
      handler: async (req, res) => {
        if (rejected(req, res)) return
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, code: 'method' })
        const url = new URL(String(req.url), 'http://localhost')
        const weeks = Math.max(1, Math.min(26, Number(url.searchParams.get('weeks')) || 4))
        const env = await withEngine()
        const tz = env.engineState.settings.statsTimeZone
        sendJson(res, 200, { ok: true, weeks: trend(env.engineState, now(), weeks, tz) })
      },
    }),
    ctx.webServer.register({
      kind: 'exact', path: '/dsh-pomodoro/quadrants',
      handler: async (req, res) => {
        if (rejected(req, res)) return
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, code: 'method' })
        const url = new URL(String(req.url), 'http://localhost')
        const from = url.searchParams.get('from')
        const env = await withEngine()
        sendJson(res, 200, { ok: true, distribution: quadrantDist(env.engineState, from) })
      },
    }),
    ctx.webServer.register({
      kind: 'exact', path: '/dsh-pomodoro/report',
      handler: async (req, res) => {
        if (rejected(req, res)) return
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, code: 'method' })
        const url = new URL(String(req.url), 'http://localhost')
        const period = url.searchParams.get('period') === 'month' ? 'month' : 'week'
        const env = await withEngine()
        const tz = env.engineState.settings.statsTimeZone
        const report = period === 'month'
          ? monthlyReport(env.engineState, now(), tz)
          : weeklyReport(env.engineState, now(), tz)
        sendJson(res, 200, { ok: true, report })
      },
    }),
    ctx.webServer.register({
      kind: 'exact', path: '/dsh-pomodoro/achievements',
      handler: async (req, res) => {
        if (rejected(req, res)) return
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, code: 'method' })
        const env = await withEngine()
        sendJson(res, 200, {
          ok: true,
          catalogue: Object.entries(ACHIEVEMENTS).map(([id, def]) => ({
            id, name: def.name, rarity: def.rarity,
            fragment: def.fragment || 0,
            unlockedAt: env.engineState.achievements[id]?.unlockedAt ?? null,
          })),
          inventory: env.engineState.inventory,
        })
      },
    }),

    ctx.webServer.register({
      kind: 'exact', path: '/dsh-pomodoro/hours',
      handler: async (req, res) => {
        if (rejected(req, res)) return
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, code: 'method' })
        const url = new URL(String(req.url), 'http://localhost')
        const from = url.searchParams.get('from')
        const env = await withEngine()
        const tz = env.engineState.settings.statsTimeZone
        sendJson(res, 200, { ok: true, hours: hourDist(env.engineState, tz, from) })
      },
    }),
    ctx.webServer.register({
      kind: 'exact', path: '/dsh-pomodoro/audit',
      handler: async (req, res) => {
        if (rejected(req, res)) return
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, code: 'method' })
        const env = await withEngine()
        const rows = [...env.auditLogTable.entries()]
          .map(([id, row]) => ({ id, ...row }))
          .sort((a, b) => a.at - b.at)
        sendJson(res, 200, { ok: true, rows })
      },
    }),

    /* -------- v0.4: proposals 提议闭环 (D16, §11.1) -------- */

    ctx.webServer.register({
      kind: 'exact', path: '/dsh-pomodoro/proposals',
      handler: async (req, res) => {
        if (rejected(req, res)) return
        const url = new URL(String(req.url), 'http://localhost')
        if (req.method === 'POST') {
          // Fallback channel (prefix kind may be unavailable): POST ?id=..&verb=confirm|reject
          const id = url.searchParams.get('id')
          const verb = url.searchParams.get('verb')
          if (id && ['confirm', 'reject'].includes(verb)) {
            return sendJson(res, 200, await resolveProposal(id, verb === 'confirm' ? 'confirmed' : 'rejected'))
          }
          return sendJson(res, 400, { ok: false, code: 'invalid' })
        }
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, code: 'method' })
        const status = url.searchParams.get('status')
        const env = await withEngine()
        let proposals = env.proposals
        if (status) proposals = proposals.filter(p => p.status === status)
        sendJson(res, 200, { ok: true, proposals })
      },
    }),
    ctx.webServer.register({
      // /dsh-pomodoro/proposals/:id/confirm|reject — prefix kind with a query-param
      // fallback (M0 verified exact only).
      kind: 'prefix', path: '/dsh-pomodoro/proposals/',
      handler: async (req, res) => {
        if (rejected(req, res)) return
        const tail = decodeURIComponent(String(req.url).replace(/^.*\/dsh-pomodoro\/proposals\//, '').split('?')[0])
        const [id, verb] = tail.split('/')
        if (req.method !== 'POST' || !id || !['confirm', 'reject'].includes(verb)) {
          return sendJson(res, 405, { ok: false, code: 'method' })
        }
        const result = await resolveProposal(id, verb === 'confirm' ? 'confirmed' : 'rejected')
        sendJson(res, 200, result)
      },
    }),
    // Fallback: POST /dsh-pomodoro/proposals?id=...&verb=confirm|reject
    // (handled inside the exact route below when prefix kind is unsupported).
  ]
  // v0.8: /context —— 当前会话 / Agent 动态 / 工作区技能（只读）。
  routeDisposers.push(ctx.webServer.register({
    kind: 'exact', path: '/dsh-pomodoro/context',
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, code: 'method' })
      try { sendJson(res, 200, await buildContext({ withSkills: true })) }
      catch (error) { sendJson(res, 500, { ok: false, code: 'internal', message: String(error?.message ?? error) }) }
    },
  }))
  // v0.5: /days 注册在数组字面量之外（补挂, 同样纳入 teardown 循环）。
  routeDisposers.push(ctx.webServer.register({
    kind: 'exact', path: '/dsh-pomodoro/days',
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, code: 'method' })
      const url = new URL(String(req.url), 'http://localhost')
      const n = Math.max(1, Math.min(400, Number(url.searchParams.get('days')) || 180))
      const env = await withEngine()
      const tz = env.engineState.settings.statsTimeZone
      const today = dayOf(now(), tz)
      // 今日往前 n 天（含今日），升序。
      const lower = dayOf(now() - (n - 1) * 86_400_000, tz)
      const days = Object.entries(env.engineState.days)
        .filter(([date]) => date >= lower && date <= today)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([date, row]) => ({
          date,
          completed: row.completed ?? 0,
          focusMinutes: row.focusMinutes ?? 0,
          streak: row.streak ?? 0,
          expGained: row.expGained ?? 0,
          quadrantA: row.quadrantA ?? 0, quadrantB: row.quadrantB ?? 0,
          quadrantC: row.quadrantC ?? 0, quadrantD: row.quadrantD ?? 0,
          uncategorized: row.uncategorized ?? 0,
        }))
      sendJson(res, 200, { ok: true, today, days })
    },
  }))

  // v0.8: 已结算的专注会话（含 DSH 会话归属/Agent 工具数），统计页「按会话」使用。
  routeDisposers.push(ctx.webServer.register({
    kind: 'exact', path: '/dsh-pomodoro/sessions',
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, code: 'method' })
      try {
        const url = new URL(String(req.url), 'http://localhost')
        const n = Math.max(1, Math.min(365, Number(url.searchParams.get('days')) || 90))
        const env = await withEngine()
        const cutoff = now() - n * 86_400_000
        const sessionsSvc = optionalService('sessions')
        const labelFor = (row) => {
          let label = sanitizeSessionLabel(row.dshSessionLabel)
          let cwdName = row.dshCwdName ?? null
          if (row.dshSessionId) {
            try {
              const live = sessionsSvc?.get?.(row.dshSessionId)
              if (live) {
                const title = titleOf(live)
                if (title) label = title
                if (!cwdName) {
                  const base = basenameOf(live.header?.cwd ?? null)
                  if (base) cwdName = base
                }
              }
            } catch { /* historical session unavailable */ }
          }
          return { label, cwdName }
        }
        const rows = (env.engineState.history ?? [])
          .filter(row => row?.settledAt && row.settledAt >= cutoff)
          .sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0))
          .slice(0, 400)
          .map(row => {
            const { label, cwdName } = labelFor(row)
            return {
            id: row.id,
            status: row.status, outcome: row.outcome ?? null,
            startedAt: row.startedAt ?? null, settledAt: row.settledAt ?? null,
            focusMinutes: row.focusMinutes ?? 0, mode: row.mode ?? null,
            quadrant: row.quadrant ?? null, taskTitle: row.taskTitle ?? null,
            dshSessionId: row.dshSessionId ?? null,
            dshSessionLabel: label,
            dshCwd: row.dshCwd ?? null,
            dshCwdName: cwdName,
            agentToolCount: row.agentToolCount ?? 0,
            }
          })
        sendJson(res, 200, { ok: true, days: n, sessions: rows })
      } catch (error) {
        sendJson(res, 500, { ok: false, code: 'internal', message: String(error?.message ?? error) })
      }
    },
  }))

  /* -------- shared handlers for /tasks/:id and /groups/:id -------- */

  async function handleTaskPatchDelete(req, res, id) {
    if (req.method === 'PATCH') {
      const body = await readBody(req)
      let patch
      try { patch = JSON.parse(String(body ?? '')) } catch { patch = null }
      if (typeof patch !== 'object' || patch === null) return sendJson(res, 400, { ok: false, code: 'invalid' })
      const result = await dispatch(TASK_UPDATE(id, patch), 'ui')
      return sendJson(res, 200, result.ok
        ? { ok: true, task: result.task, snapshot: result.snapshot }
        : { ok: false, code: result.code === 'not_found' ? 'not_found' : 'invalid', snapshot: result.snapshot })
    }
    if (req.method === 'DELETE') {
      const result = await dispatch(TASK_DELETE(id), 'ui')
      return sendJson(res, 200, result.ok
        ? { ok: true, snapshot: result.snapshot }
        : { ok: false, code: 'not_found', snapshot: result.snapshot })
    }
    sendJson(res, 405, { ok: false, code: 'method' })
  }

  async function handleGroupPatchDelete(req, res, id, method) {
    if (method === 'PATCH') {
      const body = await readBody(req)
      let patch
      try { patch = JSON.parse(String(body ?? '')) } catch { patch = null }
      if (typeof patch !== 'object' || patch === null) return sendJson(res, 400, { ok: false, code: 'invalid' })
      const result = await dispatch(GROUP_UPDATE(id, patch), 'ui')
      return sendJson(res, 200, result.ok
        ? { ok: true, group: result.group, snapshot: result.snapshot }
        : { ok: false, code: 'not_found', snapshot: result.snapshot })
    }
    if (method === 'DELETE') {
      const result = await dispatch(GROUP_DELETE(id), 'ui')
      return sendJson(res, 200, result.ok
        ? { ok: true, snapshot: result.snapshot }
        : { ok: false, code: 'not_found', snapshot: result.snapshot })
    }
    sendJson(res, 405, { ok: false, code: 'method' })
  }

  /* ---------------- recovery on boot (DESIGN.md §4.1 RECOVER) -------- */

  /* v0.4 (D17): 周期对账扫描 — timer 漏触发/存储写失败不丢结算。
   * 扫描 running 中 endsAt ≤ now 的未结算行，补触发 TICK_EXPIRE。 */
  let reconcileTimer = null
  async function setupReconcile() {
    try {
      const env = await withEngine()
      const ms = Math.max(5_000, Number(env.engineState.settings.reconcileIntervalMs) || 30_000)
      if (reconcileTimer) clearInterval(reconcileTimer)
      reconcileTimer = setInterval(() => {
        const r = engineCache?.engineState?.running
        if (r && r.endsAt != null && r.endsAt <= now()
          && ['focus', 'break', 'longBreak'].includes(r.status)) {
          void dispatch(TICK_EXPIRE(), 'reconcile')
        }
      }, ms)
      reconcileTimer.unref?.()
    } catch { /* storage not ready yet — boot effect re-runs this */ }
  }

  /* v0.4 (§12.3): Tool 审计日志 — 90 天/1000 条上限（先进先出）。 */
  async function writeAudit(toolAction, params, result) {
    try {
      const env = await withEngine()
      if (env.engineState.settings.auditEnabled === false) return // 停写但保留旧记录
      const at = now()
      await env.auditLogTable.put(`a${at}`, {
        toolAction, params: JSON.stringify(params).slice(0, 500), result: String(result).slice(0, 64), at,
      })
      // FIFO trim: 1000 条上限 + 90 天保留。
      const rows = [...env.auditLogTable.entries()]
      const stale = rows.filter(([, r]) => at - r.at > 90 * 86_400_000).map(([id]) => id)
      rows.sort((a, b) => a[1].at - b[1].at)
      const overflow = rows.slice(0, Math.max(0, rows.length - 1000)).map(([id]) => id)
      for (const id of [...new Set([...stale, ...overflow])]) await removeRow(env.auditLogTable, id)
    } catch { /* audit must never break the Tool call */ }
  }

  ctx.effect(async () => {
    const env = await withEngine()
    const running = env.engineState.running
    if (running?.status === 'focus' || running?.status === 'break' || running?.status === 'longBreak') {
      if (running.endsAt != null && running.endsAt <= now()) {
        // Overdue: settle now (idempotent with timer path).
        await dispatch(TICK_EXPIRE(), 'recover')
      } else if (running.endsAt != null) {
        applyEffects([{ type: 'armTimer', at: running.endsAt }])
      }
    }
    // paused: zero action — remainingMs frozen in storage (§4.1).
    await setupReconcile()
    ctx.logger.info?.('pomodoro-pet: service ready, recovery checked')
  }, 'pomodoro-pet: boot recovery')

  /* ---------------- Agent Tool (raw ToolDefinition, M0 V4 pattern) ---- */

  const toolDisposer = ctx.tools.register({
    name: 'pomodoro_pet',
    description: '番茄钟宠物工具:帮用户启动/暂停/继续/停止番茄钟、查询状态与统计、管理任务(只读列表/提议创建/对已有任务开钟)、和宠物互动(feed/greet 调整心情)、读取当前工作区技能(skill_list)、结合任务/会话/技能给出只读专注计划(focus_plan)、汇总今日 Agent 活动与专注协作(agent_summary)。不能修改经验值或已完成番茄数,不能删除历史。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['start', 'pause', 'resume', 'stop', 'status', 'stats', 'pet', 'task_list', 'task_create', 'task_start', 'task_update', 'skill_list', 'focus_plan', 'agent_summary'], description: '要执行的操作。task_create/task_update 会写入提议队列(proposals),需用户在 UI 确认后才落库。skill_list=列出当前工作区技能;focus_plan=结合任务/会话/技能给出只读专注计划;agent_summary=今日 Agent 活动与专注协作摘要。' },
        focusMinutes: { type: 'number', description: 'start/task_start 时的专注时长(分钟,1-120,缺省用当前模式默认)。' },
        taskId: { type: 'string', description: 'start/task_start/task_update 的任务 id(task_list 可查)。' },
        mode: { type: 'string', enum: ['standard', 'deep', 'sprint'], description: 'start 时的专注模式:标准25min×1.0/深度50min×1.2/冲刺15min×0.8。' },
        quadrant: { type: 'string', enum: ['A', 'B', 'C', 'D'], description: 'task_list/task_create 的象限过滤或指定。' },
        status: { type: 'string', enum: ['active', 'done', 'archived'], description: 'task_list 的状态过滤。' },
        title: { type: 'string', description: 'task_create/task_update 的任务标题。' },
        estimatedPomodoros: { type: 'number', description: 'task_create/task_update 的预估番茄数。' },
        groupId: { type: 'string', description: 'task_create/task_update 的分组 id(groups 可查)。' },
        patch: { type: 'object', description: 'task_update 的变更字段(提议,不落库)。' },
        petAction: { type: 'string', enum: ['feed', 'greet'], description: 'action=pet 时的互动方式。' },
        days: { type: 'number', description: 'stats/agent_summary 的统计天数(1-90,默认 7)。' },
        goal: { type: 'string', description: 'focus_plan 的专注目标(一句话),用于挑选任务与匹配技能。' },
        minutes: { type: 'number', description: 'focus_plan 建议的专注时长(分钟,1-120)。' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          code: { type: 'string' },
          summary: { type: 'string' },
        },
        required: ['ok'],
      },
      render(_args, value) {
        return [{ type: 'text', text: `pomodoro_pet: ${JSON.stringify(value).slice(0, 400)}` }]
      },
    },
    async execute(args, exec) {
      if (exec.signal?.aborted) return { ok: false, code: 'aborted', summary: '调用被取消' }
      let result
      try {
        result = await toolExecute(args, exec)
        return result
      } catch (error) {
        result = { ok: false, code: 'internal', summary: String(error?.message ?? error) }
        return result
      } finally {
        // 审计（§12.3）：所有 Tool 调用写 audit_log，result = ok 或错误码。
        void writeAudit(args?.action ?? 'unknown', args, result?.ok ? 'ok' : (result?.code ?? 'internal'))
      }
    },
  })

  /* Tool 主逻辑（与审计包装分离；v0.4: task_create/task_update 落 proposals）。 */
  async function toolExecute(args, exec) {
      const snap = await readSnapshot()
      const fmt = (s) => {
        const r = s.running
        const remain = r ? (r.endsAt != null ? Math.ceil((r.endsAt - s.now) / 60000) : Math.ceil((r.remainingMs ?? 0) / 60000)) : null
        return r
          ? `${r.status}${remain != null ? `,剩余约 ${remain} 分钟` : ''}(Lv.${s.pet.level} ${s.pet.stage},心情 ${s.pet.mood}/5)`
          : `空闲(Lv.${s.pet.level} ${s.pet.stage},心情 ${s.pet.mood}/5,今日完成 ${s.todayStats.completed} 个番茄)`
      }
      switch (args.action) {
        case 'status':
          return { ok: true, summary: fmt(snap), snapshot: snap }
        case 'stats': {
          const env = await withEngine()
          const days = Math.max(1, Math.min(90, Number(args.days) || 7))
          const dist = quadrantDist(env.engineState)
          return {
            ok: true,
            summary: `今日 ${snap.todayStats.completed} 个番茄 / ${snap.todayStats.focusMinutes} 分钟;近${days}天合计 ${snap.recent.slice(-days).reduce((n, d) => n + d.completed, 0)} 个;累计象限分布 A:${dist.A} B:${dist.B} C:${dist.C} D:${dist.D} 未分类:${dist.uncategorized}`,
            recent: snap.recent.slice(-days),
            distribution: dist,
          }
        }
        case 'start':
        case 'pause':
        case 'resume':
        case 'stop': {
          const result = await dispatch({ start: START, pause: PAUSE, resume: RESUME, stop: STOP }[args.action](
            args.action === 'start' ? args.focusMinutes : undefined,
            args.action === 'start' ? { taskId: args.taskId, mode: args.mode } : {},
          ), 'agent')
          const summary = result.ok
            ? { start: '已开始专注', pause: '已暂停', resume: '已继续', stop: '已停止' }[args.action] + '。' + fmt(result.snapshot)
            : ({ busy: '已有进行中的番茄钟,未重复启动', stale: '当前状态不支持该操作', already_settled: '该阶段已结算过', not_found: '任务不存在,先用 task_list 查 id', invalid_state: '任务状态不支持开钟(需 active)' }[result.code] ?? result.code)
          // Lossless JSON: never emit `code: undefined` — include the key only on failure.
          return result.ok
            ? { ok: true, summary, snapshot: result.snapshot }
            : { ok: false, code: result.code, summary, snapshot: result.snapshot }
        }
        case 'pet': {
          // mood-only interaction, daily-capped, never touches EXP (DESIGN.md §6).
          const result = await serialize(async () => {
            const env = await withEngine()
            const s = env.engineState
            const todayKey = dayOf(now(), s.settings.statsTimeZone)
            // Simple daily cap via settings table (v0.4: dailyFeedLimit 可配)。
            const feedRow = env.settingsTable.get('_feeds_' + todayKey)
            const count = (feedRow?.value ?? 0)
            const limit = Math.max(0, Number(s.settings.dailyFeedLimit ?? 3) || 3)
            if (args.petAction === 'feed' && count >= limit) {
              return { ok: false, code: 'daily-limit', summary: `今天已经喂过 ${limit} 次啦,宠物吃撑了(每日上限 ${limit} 次)` }
            }
            const delta = args.petAction === 'feed' ? 1 : 0
            const pet = { ...s.pet, mood: Math.min(5, Math.max(0, s.pet.mood + delta)), updatedAt: now() }
            await env.petsTable.put('default', { ...pet })
            if (args.petAction === 'feed') await env.settingsTable.put('_feeds_' + todayKey, { value: count + 1 })
            engineCache = { ...env, engineState: { ...s, pet } }
            return { ok: true, summary: args.petAction === 'feed' ? `喂食成功,心情 ${pet.mood}/5` : `打招呼,宠物很开心(心情 ${pet.mood}/5)` }
          })
          return result
        }
        /* -------- §12.2 task_* actions (read / propose / start) -------- */
        case 'task_list': {
          let tasks = snap.tasks
          if (args.quadrant) tasks = tasks.filter(t => t.quadrant === args.quadrant)
          if (args.status) tasks = tasks.filter(t => t.status === args.status)
          const brief = tasks.slice(0, 20).map(t =>
            `[${t.quadrant}] ${t.title} 🍅${t.completedPomodoros}/${t.estimatedPomodoros} (${t.status}, id=${t.id})`)
          return { ok: true, summary: brief.length ? brief.join(';') : '没有匹配的任务', tasks, groups: snap.groups }
        }
        case 'task_create': {
          // 提议闭环 (D16): 落 proposals(pending) 并广播，用户在 UI 确认后落库。
          const payload = {
            title: args.title ?? '', quadrant: args.quadrant ?? 'B',
            estimatedPomodoros: args.estimatedPomodoros ?? 1, groupId: args.groupId ?? null,
          }
          if (!String(payload.title).trim()) return { ok: false, code: 'invalid', summary: '提议缺少任务标题(title)' }
          const created = await createProposal('task_create', payload)
          if (!created.ok) return { ok: false, code: created.code ?? 'invalid', summary: '提议入队失败' }
          return {
            ok: true, proposal: true, proposalId: created.proposal.id,
            summary: `已创建任务提议(${created.proposal.id}):[${payload.quadrant}] ${payload.title} 🍅×${payload.estimatedPomodoros},请在 UI 任务 Tab 确认`,
          }
        }
        case 'task_start': {
          if (!args.taskId) return { ok: false, code: 'invalid', summary: '缺少 taskId(先用 task_list 查)' }
          const result = await dispatch(START(args.focusMinutes, { taskId: args.taskId, mode: args.mode }), 'agent')
          return result.ok
            ? { ok: true, summary: '已开始专注。' + fmt(result.snapshot), snapshot: result.snapshot }
            : { ok: false, code: result.code, summary: ({ busy: '已有进行中的番茄钟', not_found: '任务不存在', invalid_state: '任务需为 active 状态' }[result.code] ?? result.code), snapshot: result.snapshot }
        }
        case 'task_update': {
          // 提议闭环 (D16): 落 proposals(pending)，UI 确认后应用 patch。
          if (!args.taskId && !args.patch) return { ok: false, code: 'invalid', summary: '缺少 taskId/patch' }
          const target = snap.tasks.find(t => t.id === args.taskId)
          const upd = await createProposal('task_update', { taskId: args.taskId, patch: args.patch ?? null })
          if (!upd.ok) return { ok: false, code: upd.code ?? 'invalid', summary: '提议入队失败' }
          return {
            ok: true, proposal: true, proposalId: upd.proposal.id,
            summary: target
              ? `已创建修改提议(${upd.proposal.id}):把「${target.title}」更新为 ${JSON.stringify(args.patch ?? {})},请在 UI 确认`
              : `已创建修改提议(${upd.proposal.id}):任务 ${args.taskId} 不在当前列表,请在 UI 确认`,
          }
        }
        /* -------- v0.8 Agent 联动 actions -------- */
        case 'skill_list': {
          const cwd = bridge.session()?.cwd ?? null
          const skills = await loadSkills(cwd)
          if (!skills) return { ok: true, summary: '技能服务不可用或当前工作区没有技能', skills: null }
          const brief = (skills.items ?? []).map(s => `${s.name}${s.userInvocable ? '' : '(模型专用)'}`).join(', ')
          return {
            ok: true,
            summary: `当前工作区可用技能 ${skills.count} 个:${brief || '无'}`,
            skills,
          }
        }
        case 'focus_plan': {
          const cwd = bridge.session()?.cwd ?? null
          const skills = await loadSkills(cwd)
          const goal = String(args.goal ?? '').trim()
          const active = snap.tasks.filter(t => t.status === 'active')
          const rank = { A: 0, B: 1, C: 2, D: 3 }
          const picked = active.slice().sort((a, b) => (rank[a.quadrant] ?? 9) - (rank[b.quadrant] ?? 9) || (a.sortOrder ?? 0) - (b.sortOrder ?? 0)).slice(0, 3)
          const haystack = `${goal} ${picked.map(t => t.title).join(' ')}`.toLowerCase()
          const tokens = haystack.split(/[^a-z0-9\u4e00-\u9fa5]+/).filter(w => w.length >= 2)
          const matched = (skills?.items ?? []).filter(s => {
            const text = `${s.name} ${s.description}`.toLowerCase()
            return tokens.some(w => text.includes(w))
          }).slice(0, 3)
          const minutes = Math.max(5, Math.min(120, Number(args.minutes) || snap.settings.focusMin || 25))
          const mode = minutes >= 45 ? 'deep' : minutes <= 15 ? 'sprint' : 'standard'
          const sessionLabel = bridge.session()?.label ?? '当前会话'
          const taskBrief = picked.length ? picked.map(t => `[${t.quadrant}] ${t.title}`).join('、') : '（暂无进行中任务）'
          const skillBrief = matched.length ? matched.map(s => s.name).join('、') : '（无匹配技能）'
          return {
            ok: true,
            summary: `专注计划:在「${sessionLabel}」用 ${mode}/${minutes} 分钟做 ${taskBrief};可配合技能:${skillBrief}`,
            plan: {
              session: bridge.session(),
              minutes,
              mode,
              tasks: picked.map(t => ({ id: t.id, title: t.title, quadrant: t.quadrant })),
              skills: matched,
              goal: goal || null,
            },
          }
        }
        case 'agent_summary': {
          const days = Math.max(1, Math.min(90, Number(args.days) || 7))
          const agentSnap = bridge.snapshot()
          const since = now() - days * 86_400_000
          const toolEnv = await withEngine()
          const focusRows = (toolEnv.engineState.history ?? []).filter(s => s.settledAt && s.settledAt >= since)
          const withAgent = focusRows.filter(s => (s.agentToolCount ?? 0) > 0)
          const focusTools = focusRows.reduce((n, s) => n + (s.agentToolCount ?? 0), 0)
          const last = agentSnap.agent.lastTools.slice(0, 5).map(t => `${t.name}${t.ok ? '' : '(失败)'}`).join(', ')
          return {
            ok: true,
            summary: `今日 Agent 工具 ${agentSnap.agent.today.tools} 次/步骤 ${agentSnap.agent.today.steps} 个;` +
              `近 ${days} 天有 ${withAgent.length}/${focusRows.length} 个番茄与 Agent 并行,期间工具 ${focusTools} 次;` +
              `最近工具:${last || '无'}`,
            agent: agentSnap.agent,
            session: agentSnap.session,
            focus: { sessions: focusRows.length, withAgentSessions: withAgent.length, toolsDuringFocus: focusTools },
          }
        }
        default:
          return { ok: false, code: 'invalid', summary: `未知 action ${args.action}` }
      }
  }

  /* ---------------- teardown ---------------- */

  return () => {
    if (reconcileTimer) clearInterval(reconcileTimer)
    if (agentFlushTimer) clearInterval(agentFlushTimer)
    if (agentFrameTimer) clearTimeout(agentFrameTimer)
    flushAgentCounters()
    currentTimerStop?.()
    toolDisposer?.()
    for (const d of routeDisposers) { try { d?.() } catch { /* already gone */ } }
    void ready.then(d => d?.close?.()).catch(() => {})
  }
}

/* Re-export engine bits used above (hoisted import; ESM allows bottom imports). */
import { START, PAUSE, RESUME, STOP, TICK_EXPIRE, SET_TASK, SET_MODE, REDEEM_OUTFIT, TASK_CREATE, TASK_UPDATE, TASK_DELETE, GROUP_CREATE, GROUP_UPDATE, GROUP_DELETE, transition, snapshotOf, dayOf, DEFAULT_SETTINGS } from './pet-engine.js'
import { createAgentBridge, basenameOf, sanitizeSessionLabel } from './agent-bridge.js'
import { ACHIEVEMENTS } from './achievement-engine.js'
import { heatmap, trend, quadrantDist, hourDist, weeklyReport, monthlyReport } from './stats-engine.js'
