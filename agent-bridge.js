/**
 * Agent bridge — folds DSH session / agent / tool activity into a small
 * serializable "context" the pomodoro panel and pet can display (v0.8).
 *
 * Pure-ish module: no timers, no I/O. The host plugin supplies `now` and
 * `dayOf` and consumes `snapshot()` / `takeDirty()` / `countTools()`.
 */

export const LABEL_MAX = 28
export const TOOL_RING_MAX = 200
export const LAST_TOOLS_MAX = 5
/** Bound on cached session metadata kept for waiting alerts. */
export const SESSION_META_MAX = 20
/** Tool activity window (ms) used to estimate "running tools". */
export const ACTIVE_TOOL_WINDOW_MS = 8_000

const TEXT_BLOCK = 'text'

/** Collapse whitespace and truncate a user message into a short session label. */
export function normalizeLabel(text, max = LABEL_MAX) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!s) return null
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** Last path segment of an absolute cwd (works for POSIX and Windows paths). */
export function basenameOf(cwd) {
  if (!cwd) return null
  const parts = String(cwd).split(/[\\/]+/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : null
}

/** Root sessions only: subagent children stay out of "current session". */
export function isRootSession(session) {
  const header = session?.header ?? {}
  return header.origin !== 'subagent' && (header.delegationDepth ?? 0) === 0
}

/** Reject labels that came from injected system messages (time/runtime/skill context). */
export function sanitizeSessionLabel(raw) {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim()
  if (!s) return null
  if (s.startsWith('<')) return null
  if (/^(time sampled|elapsed since|browser time zone|system reminder|system-reminder|runtime context|available skills|skill catalog|plan mode|elapsed)/i.test(s)) return null
  return s.length > 32 ? `${s.slice(0, 31)}…` : s
}

/** First text block of a user message. */
export function firstText(userMessage) {
  const content = userMessage?.content
  if (!Array.isArray(content)) return null
  for (const block of content) {
    if (block?.type === TEXT_BLOCK && typeof block.text === 'string' && block.text.trim()) return block.text
  }
  return null
}

/**
 * @param {object} deps
 * @param {() => number} [deps.now]
 * @param {(ts: number) => string} [deps.dayOf] canonical YYYY-MM-DD
 */
export function createAgentBridge({ now = () => Date.now(), dayOf, titleOf } = {}) {
  const dayKey = () => {
    try {
      if (typeof dayOf === 'function') return dayOf(now())
    } catch { /* fall through */ }
    return new Date(now()).toISOString().slice(0, 10)
  }

  const state = {
    session: null,
    /** sessionId -> { id, label, cwd, cwdName }, bounded; used by waiting alerts. */
    sessionMeta: new Map(),
    agentRunning: false,
    runningSessionId: null,
    lastTools: [],
    toolEvents: [],
    /** `${sessionId}:${kind}` -> { sessionId, kind, since, toolName, label, cwdName, refs } */
    waiting: new Map(),
    today: { day: dayKey(), tools: 0, steps: 0, questions: 0, approvals: 0, waitMs: 0 },
    dirty: false,
    listeners: new Set(),
  }

  const emit = (reason = 'change') => {
    for (const fn of state.listeners) {
      try { fn(reason) } catch { /* listener containment */ }
    }
  }

  const emptyToday = (day) => ({ day, tools: 0, steps: 0, questions: 0, approvals: 0, waitMs: 0 })

  const rollDay = () => {
    const day = dayKey()
    if (state.today.day !== day) {
      state.today = emptyToday(day)
      state.dirty = true
      // A session that waited across midnight still belongs to the new bucket's
      // totals; keep the waiting entries but their elapsed time counts on end.
    }
    return day
  }

  /** Remember a root session's display metadata (label/cwd) for waiting alerts. */
  const rememberSession = (session) => {
    if (!session || !isRootSession(session) || !session.id) return null
    const prev = state.sessionMeta.get(session.id)
    let title = null
    try { title = typeof titleOf === 'function' ? titleOf(session) : null } catch { title = null }
    const cwd = session.header?.cwd ?? prev?.cwd ?? null
    const meta = {
      id: session.id,
      label: sanitizeSessionLabel(title) || sanitizeSessionLabel(prev?.label) || null,
      cwd,
      cwdName: basenameOf(cwd) || prev?.cwdName || null,
    }
    state.sessionMeta.delete(session.id)
    state.sessionMeta.set(session.id, meta)
    if (state.sessionMeta.size > SESSION_META_MAX) {
      const oldest = state.sessionMeta.keys().next().value
      if (oldest !== undefined) state.sessionMeta.delete(oldest)
    }
    return meta
  }

  /** Merge a root session into the "current session" slot. */
  const adoptSession = (session, labelPatch) => {
    if (!session || !isRootSession(session)) return false
    const cwd = session.header?.cwd ?? state.session?.cwd ?? null
    const prev = state.session?.id === session.id ? state.session : null
    let title = null
    try { title = typeof titleOf === 'function' ? titleOf(session) : null } catch { title = null }
    state.session = {
      id: session.id,
      // 优先级: 正式会话标题 > 真人首条消息 > 已知旧标签
      label: title || labelPatch || prev?.label || null,
      cwd,
      cwdName: basenameOf(cwd),
      lastActiveAt: now(),
    }
    rememberSession(session)
    emit()
    return true
  }

  const pushTool = (name, ok) => {
    const at = now()
    state.lastTools = [{ name, ok, at }, ...state.lastTools].slice(0, LAST_TOOLS_MAX)
    state.toolEvents.push({ at, name })
    if (state.toolEvents.length > TOOL_RING_MAX) state.toolEvents.splice(0, state.toolEvents.length - TOOL_RING_MAX)
    rollDay()
    state.today.tools += 1
    state.dirty = true
  }

  /** Waiting entry for one session/kind; refcounted across waterfall + session events. */
  const waitingList = () => [...state.waiting.values()]
    .sort((a, b) => (b.since - a.since) || String(a.sessionId).localeCompare(String(b.sessionId)))
    .map(({ sessionId, kind, since, toolName, label, cwdName }) => ({ sessionId, kind, since, toolName, label, cwdName }))

  const beginWait = (session, kind, extra = {}) => {
    if (!session || !isRootSession(session) || !session.id) return
    const key = `${session.id}:${kind}`
    const meta = rememberSession(session)
    const existing = state.waiting.get(key)
    if (existing) {
      existing.refs += 1
      if (extra.toolName) existing.toolName = String(extra.toolName)
      if (meta) {
        existing.label = meta.label ?? existing.label
        existing.cwdName = meta.cwdName ?? existing.cwdName
      }
      return // the visible list did not change; skip a redundant immediate frame
    }
    state.waiting.set(key, {
      sessionId: session.id,
      kind,
      since: now(),
      toolName: extra.toolName ? String(extra.toolName) : null,
      label: meta?.label ?? null,
      cwdName: meta?.cwdName ?? null,
      refs: 1,
    })
    rollDay()
    if (kind === 'question') state.today.questions += 1
    else if (kind === 'approval') state.today.approvals += 1
    state.dirty = true
    emit('waiting')
  }

  const endWait = (sessionOrId, kind) => {
    const id = typeof sessionOrId === 'string' ? sessionOrId : sessionOrId?.id
    if (!id) return
    const key = `${id}:${kind}`
    const entry = state.waiting.get(key)
    if (!entry) return
    entry.refs -= 1
    if (entry.refs > 0) return // still waiting for another observer; no visible change
    state.waiting.delete(key)
    rollDay()
    state.today.waitMs += Math.max(0, now() - entry.since)
    state.dirty = true
    emit('waiting')
  }

  const clearSession = (sessionOrId) => {
    const id = typeof sessionOrId === 'string' ? sessionOrId : sessionOrId?.id
    if (!id) return
    let cleared = false
    for (const [key, entry] of [...state.waiting.entries()]) {
      if (entry.sessionId !== id) continue
      state.waiting.delete(key)
      state.today.waitMs += Math.max(0, now() - entry.since)
      cleared = true
    }
    if (!cleared) return
    rollDay()
    state.dirty = true
    emit('waiting')
  }

  return {
    /** `session/event` feed. */
    onSessionEvent(session, event) {
      if (!isRootSession(session)) return
      const type = event?.type
      // Durable approval audit pair: keeps the wait accurate when the waterfall
      // listener is missing and clears it from the decided side. This is not a
      // replay source: a reload cannot recover an already in-flight request.
      if (type === 'approval/asked') {
        beginWait(session, 'approval', { toolName: event.data?.toolName })
        return
      }
      if (type === 'approval/decided') {
        endWait(session, 'approval')
        return
      }
      if (type === 'step/end') {
        rollDay()
        state.today.steps += 1
        state.dirty = true
        emit()
        return
      }
      if (type === 'user/message') {
        // 只把「真人输入」当会话标题：time-context/runtime-context/goal 等注入消息
        // 的 source.kind 不是 'user'，否则标题会变成 "Time sampled while…"。
        const kind = event.data?.source?.kind
        if (kind !== undefined && kind !== 'user') return
        const label = normalizeLabel(firstText(event.data))
        if (label) adoptSession(session, label)
      }
    },

    /** `agent/status` feed. */
    onAgentStatus(payload) {
      const agent = payload?.agent
      const session = agent?.session
      if (!session || !isRootSession(session)) return
      const running = payload?.status === 'running'
      state.agentRunning = running
      if (running) {
        state.runningSessionId = session.id
        adoptSession(session)
      } else if (state.runningSessionId === session.id) {
        state.runningSessionId = null
        emit()
      }
    },

    /** `tools/result` feed. The pomodoro tool excludes itself to avoid echo. */
    onToolResult(exec, result) {
      const name = exec?.name
      if (!name || name === 'pomodoro_pet') return
      pushTool(name, result ? !result.isError : true)
      const session = exec?.agent?.session
      if (session && isRootSession(session)) adoptSession(session)
      emit()
    },

    /** Number of (non-pomodoro) tool results inside [startMs, endMs]. */
    countTools(startMs, endMs) {
      const from = Number(startMs) || 0
      const to = Number(endMs) || now()
      let n = 0
      for (const row of state.toolEvents) if (row.at >= from && row.at <= to) n += 1
      return n
    },

    /** Serializable context (no skills; the host merges those separately). */
    snapshot() {
      const at = now()
      const recent = state.toolEvents.filter(row => at - row.at <= ACTIVE_TOOL_WINDOW_MS)
      return {
        now: at,
        session: state.session ? { ...state.session } : null,
        agent: {
          running: state.agentRunning,
          runningTools: recent.length,
          lastTools: state.lastTools.map(row => ({ ...row })),
          today: { ...state.today },
          waiting: (() => {
            const list = waitingList()
            return { active: list.length > 0, count: list.length, list }
          })(),
        },
        toolCount: state.toolEvents.length,
      }
    },

    /** Load the persisted daily bucket when it belongs to today. */
    loadBucket(day, bucket) {
      if (!day || day !== dayKey() || !bucket) return
      state.today = {
        day,
        tools: Math.max(0, Number(bucket.tools) || 0),
        steps: Math.max(0, Number(bucket.steps) || 0),
        questions: Math.max(0, Number(bucket.questions) || 0),
        approvals: Math.max(0, Number(bucket.approvals) || 0),
        waitMs: Math.max(0, Number(bucket.waitMs) || 0),
      }
    },

    /** Daily bucket for persistence; returns null when nothing changed. */
    takeDirty() {
      if (!state.dirty) return null
      state.dirty = false
      return { ...state.today }
    },

    /** Force the next `takeDirty()` to persist (used after load/prune). */
    markDirty() { state.dirty = true },

    /** Seed the current session without a label (boot: no user text yet). */
    adopt(session) {
      if (!isRootSession(session)) return false
      const prev = state.session?.id === session.id ? state.session : null
      return adoptSession(session, prev?.label ?? null)
    },

    session() { return state.session ? { ...state.session } : null },
    currentDay() { return dayKey() },

    /** Read-only waiting-state observation (host wires pass-through listeners). */
    beginWait(session, kind, extra) {
      try { beginWait(session, kind, extra) } catch { /* observation must never fail the request */ }
    },
    endWait(sessionOrId, kind) {
      try { endWait(sessionOrId, kind) } catch { /* observation must never fail the request */ }
    },
    clearSession(sessionOrId) {
      try { clearSession(sessionOrId) } catch { /* observation must never fail the request */ }
    },
    waiting() { return waitingList() },

    onChange(fn) {
      state.listeners.add(fn)
      return () => { state.listeners.delete(fn) }
    },

    dispose() { state.listeners.clear() },
  }
}
