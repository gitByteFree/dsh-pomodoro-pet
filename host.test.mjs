/**
 * Host integration tests — the real `apply()` from index.js on a mock context.
 *
 * The engine suites cannot see these two regressions, so they are pinned here:
 *  1. the Host/Origin trust fence is actually active on every /dsh-pomodoro/*
 *     route (resolving `connection` per request through ctx.get, failing closed
 *     when the service is absent);
 *  2. a settled break's `waiting` row is persisted, and re-applying the plugin
 *     (a host restart) never re-settles it — the old persist() skipped the write
 *     because break→waiting keeps both id and revision, so every restart added
 *     +2 EXP to the pet.
 *
 * No DSH runtime is needed: storageDomain / webServer / tools / timer /
 * connection are in-memory doubles, and Date.now is moved forward manually.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from './index.js'

const MIN = 60_000
const CONFIG = { focusMin: 25, breakMin: 5, longBreakMin: 15, roundsPerLong: 4, maxFocusMin: 120, maxSessionDays: 30 }

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

/** A storageDomain double: tables backed by Maps, values deep-cloned per call. */
function createStore() {
  const tables = new Map()
  const table = (name) => {
    if (!tables.has(name)) tables.set(name, new Map())
    const rows = tables.get(name)
    return {
      get: (id) => clone(rows.get(id)),
      put: async (id, value) => { rows.set(id, clone(value)) },
      delete: async (id) => { rows.delete(id) },
      entries: () => [...rows.entries()].map(([id, value]) => [id, clone(value)])[Symbol.iterator](),
    }
  }
  return {
    domain: { table, close: async () => {} },
    getRows: (name) => [...(tables.get(name) ?? new Map()).entries()].map(([id, value]) => [id, clone(value)]),
  }
}

/** In-memory context with the services index.js touches. */
function createHarness(store, { withConnection = true } = {}) {
  const routes = new Map()
  const timers = []
  const heard = { rejectionHeaders: null }
  const fence = { rejection: undefined }
  const services = {
    connection: withConnection
      ? {
          requestRejection(request) {
            heard.rejectionHeaders = request?.headers ?? null
            return fence.rejection
          },
        }
      : undefined,
    sessionTitle: { get: () => null },
    sessions: { get: () => undefined },
    agents: { roots: () => [] },
    skills: { list: async () => [] },
  }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get: (name) => services[name],
    on: () => () => {},
    emit: () => {},
    effect: (fn) => {
      try {
        const result = fn()
        if (result && typeof result.then === 'function') result.catch(() => {})
      } catch { /* optional effect */ }
      return () => {}
    },
    storageDomain: { open: async () => store.domain },
    webServer: {
      register: (route) => {
        const key = `${route.kind}:${route.path}`
        assert.ok(!routes.has(key), `duplicate route ${key}`)
        routes.set(key, route)
        return () => routes.delete(key)
      },
    },
    tools: {
      register: (definition) => {
        routes.set(`tool:${definition.name}`, definition)
        return () => routes.delete(`tool:${definition.name}`)
      },
    },
    timer: {
      timeout: (fn, delay) => {
        const handle = { fn, at: Date.now() + delay, canceled: false }
        timers.push(handle)
        return () => { handle.canceled = true }
      },
    },
  }
  return { ctx, routes, timers, fence, heard }
}

const flush = async (rounds = 10) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

function makeReq({ method = 'GET', url, headers = {}, body }) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
    on() {},
    resume() {},
  }
}

function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    chunks: [],
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value },
    write(chunk) { this.chunks.push(String(chunk)); return true },
    end(chunk) { if (chunk !== undefined && chunk !== null) this.chunks.push(String(chunk)); this.finished = true },
    json() { return JSON.parse(this.chunks.join('')) },
  }
  return res
}

/** Invoke one registered route by kind+path (the plugin has no HTTP client). */
async function callRoute(harness, path, options = {}) {
  const route = [...harness.routes.values()].find((candidate) =>
    candidate && candidate.kind && candidate.path === path
    && (!options.kind || candidate.kind === options.kind))
  assert.ok(route, `route ${options.kind ?? ''} ${path} not registered`)
  const req = makeReq({ ...options, url: options.url ?? path })
  const res = makeRes()
  await route.handler(req, res)
  return res
}

const getState = async (harness) => {
  const res = await callRoute(harness, '/dsh-pomodoro/state')
  assert.equal(res.statusCode, 200)
  return res.json()
}

/** Fire the last armed, not-yet-fired timer whose deadline has passed. */
async function fireNextDue(harness) {
  const due = [...harness.timers].reverse().find((timer) => !timer.canceled && timer.at <= Date.now())
  assert.ok(due, 'expected a due timer')
  due.canceled = true
  due.fn()
  await flush()
}

/** Run a body with Date.now pinned to a mutable clock. */
async function withClock(body) {
  const realNow = Date.now
  const clock = { now: 1_790_000_000_000 }
  Date.now = () => clock.now
  try { await body(clock) } finally { Date.now = realNow }
}

test('trust fence: every /dsh-pomodoro route rejects an untrusted request', async () => {
  await withClock(async () => {
    const store = createStore()
    const harness = createHarness(store)
    harness.fence.rejection = 403
    const dispose = apply(harness.ctx, CONFIG)
    await flush()

    const httpRoutes = [...harness.routes.values()].filter((route) => route.kind && route.path)
    assert.ok(httpRoutes.length >= 20, `expected the HTTP route table, got ${httpRoutes.length}`)
    for (const route of httpRoutes) {
      // /events holds the response open by design (SSE); its fence is the same call.
      const res = await callRoute(harness, route.path, route.kind === 'prefix' ? { url: `${route.path}x` } : {})
      assert.equal(res.statusCode, 403, `${route.kind} ${route.path} must be fenced`)
    }
    assert.ok(harness.heard.rejectionHeaders, 'requestRejection must receive the request headers')
    await dispose()
  })
})

test('trust fence: trusted requests still pass', async () => {
  await withClock(async () => {
    const store = createStore()
    const harness = createHarness(store)
    const dispose = apply(harness.ctx, CONFIG)
    await flush()

    const res = await callRoute(harness, '/dsh-pomodoro/state')
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().ok, true)
    await dispose()
  })
})

test('trust fence: a missing connection service fails closed', async () => {
  await withClock(async () => {
    const store = createStore()
    const harness = createHarness(store, { withConnection: false })
    const dispose = apply(harness.ctx, CONFIG)
    await flush()

    const res = await callRoute(harness, '/dsh-pomodoro/state')
    assert.equal(res.statusCode, 503)
    assert.equal(res.json().code, 'untrusted')
    await dispose()
  })
})

test('break→waiting persists, and a host restart never re-settles the break', async () => {
  await withClock(async (clock) => {
    const store = createStore()
    const first = createHarness(store)
    const disposeFirst = apply(first.ctx, CONFIG)
    await flush()

    // 1) start a real 5-minute focus round through the action route
    const started = await callRoute(first, '/dsh-pomodoro/action', {
      method: 'POST',
      body: { action: 'start', focusMinutes: 5 },
    })
    assert.equal(started.statusCode, 200)
    assert.equal(started.json().ok, true)
    assert.equal(started.json().snapshot.running.status, 'focus')

    // 2) focus deadline → automatic break
    clock.now += 5 * MIN
    await fireNextDue(first)
    const afterFocus = await getState(first)
    assert.equal(afterFocus.snapshot.running.status, 'break')

    // 3) break deadline → waiting (no clock left, reminder state)
    clock.now += 5 * MIN
    await fireNextDue(first)
    const waiting = await getState(first)
    assert.equal(waiting.snapshot.running.status, 'waiting')
    const expBefore = waiting.snapshot.pet.exp
    const today = waiting.snapshot.today
    const dayExpBefore = store.getRows('days').find(([id]) => id === today)?.[1]?.expGained
    assert.ok(Number.isFinite(expBefore) && Number.isFinite(dayExpBefore))

    // 4) simulate a host restart: dispose, then apply on the same storage again.
    //    The regression: the restart used to re-settle the finished break (+2 EXP).
    await disposeFirst()
    const second = createHarness(store)
    const disposeSecond = apply(second.ctx, CONFIG)
    await flush(15)

    const restored = await getState(second)
    assert.equal(restored.snapshot.running.status, 'waiting', 'restart restores the reminder state')
    assert.equal(restored.snapshot.pet.exp, expBefore, 'restart must not credit the break again')
    assert.equal(
      store.getRows('days').find(([id]) => id === today)?.[1]?.expGained,
      dayExpBefore,
      'restart must not touch today\'s EXP ledger',
    )
    assert.equal(second.timers.length, 0, 'a waiting row has no clock to re-arm')

    // 5) and the waiting row itself reached storage (it used to stay "break", settledAt null)
    const waitingRow = store.getRows('sessions').find(([, row]) => row.status === 'waiting')?.[1]
    assert.ok(waitingRow, 'waiting session row must be persisted')
    assert.ok(waitingRow.settledAt, 'waiting row carries the break settlement time')
    await disposeSecond()
  })
})

/* ---------------- settings validation (batch 2 regressions) -------- */

test('settings POST rejects an out-of-range numeric string and a bogus IANA zone, persisting nothing', async () => {
  await withClock(async () => {
    const store = createStore()
    const harness = createHarness(store)
    const dispose = apply(harness.ctx, CONFIG)
    await flush()

    const before = store.getRows('settings')
    const badFocus = await callRoute(harness, '/dsh-pomodoro/settings', {
      method: 'POST', body: { focusMin: '9999' },
    })
    assert.equal(badFocus.statusCode, 400)
    assert.deepEqual(badFocus.json(), { ok: false, code: 'invalid', field: 'focusMin' })

    const badZone = await callRoute(harness, '/dsh-pomodoro/settings', {
      method: 'POST', body: { statsTimeZone: 'Mars/Olympus' },
    })
    assert.equal(badZone.statusCode, 400)
    assert.deepEqual(badZone.json(), { ok: false, code: 'invalid', field: 'statsTimeZone' })

    // 整包拒绝：非法补丁一个字段都不落库（旧实现会把 "9999" 原样存进去）。
    assert.deepEqual(store.getRows('settings'), before)

    // 坏值没有污染运行态：/state、/settings 仍然 200，设置保持默认。
    const state = (await getState(harness)).snapshot
    assert.equal(state.settings.focusMin, 25)
    assert.equal(state.settings.statsTimeZone, null)
    const settings = await callRoute(harness, '/dsh-pomodoro/settings')
    assert.equal(settings.statusCode, 200)
    assert.equal(settings.json().settings.focusMin, 25)

    // 未知键 / 数组 body：400 且不写，不能把「拼错键」当成保存成功。
    const unknownKey = await callRoute(harness, '/dsh-pomodoro/settings', {
      method: 'POST', body: { focusMin: 30, focusmin: 40 },
    })
    assert.equal(unknownKey.statusCode, 400)
    assert.deepEqual(unknownKey.json(), { ok: false, code: 'invalid', field: 'focusmin' })
    const arrayBody = await callRoute(harness, '/dsh-pomodoro/settings', {
      method: 'POST', body: [1, 2, 3],
    })
    assert.equal(arrayBody.statusCode, 400)
    assert.deepEqual(store.getRows('settings'), before)

    // 友好的部分仍保留：范围内的数字字符串按 Number() 生效，越界真数字仍钳制。
    const coerced = await callRoute(harness, '/dsh-pomodoro/settings', {
      method: 'POST', body: { focusMin: '60', petScale: 99 },
    })
    assert.equal(coerced.statusCode, 200)
    assert.equal(coerced.json().snapshot.settings.focusMin, 60)
    assert.equal(coerced.json().snapshot.settings.petScale, 2)
    const focusRow = store.getRows('settings').find(([id]) => id === 'focusMin')?.[1]
    assert.deepEqual(focusRow, { value: 60 })
    await dispose()
  })
})

test('boot sanitizes corrupt persisted settings instead of bricking /state', async () => {
  await withClock(async () => {
    const store = createStore()
    // 模拟升级前/手工改坏的 settings 表：字符串数字、火星时区、未知 mode、字符串音量。
    const seeded = store.domain.table('settings')
    await seeded.put('focusMin', { value: 'oops' })
    await seeded.put('statsTimeZone', { value: 'Nowhere/Nope' })
    await seeded.put('mode', { value: 'turbo' })
    await seeded.put('volume', { value: 'loud' })
    // 能从字符串恢复的数字（旧版遗留）仍保留为数字，不丢配置。
    await seeded.put('breakMin', { value: '10' })

    const harness = createHarness(store)
    const dispose = apply(harness.ctx, CONFIG)
    await flush(15)

    const state = (await getState(harness)).snapshot // 旧实现这里直接 500（dayOf RangeError）
    assert.equal(state.settings.focusMin, 25, 'invalid number falls back to the default')
    assert.equal(state.settings.statsTimeZone, null, 'invalid IANA zone falls back to UTC default')
    assert.equal(state.settings.mode, 'standard', 'unknown mode falls back to the default')
    assert.equal(state.settings.volume, 0.5, 'non-numeric volume falls back to the default')
    assert.equal(state.settings.breakMin, 10, 'an in-range numeric string is recovered, not dropped')
    assert.equal(state.pet.level, 1, 'the rest of loadState still works')

    const settingsRes = await callRoute(harness, '/dsh-pomodoro/settings')
    assert.equal(settingsRes.statusCode, 200)
    assert.equal(settingsRes.json().settings.statsTimeZone, null)

    // 插件没有被坏文件卡死：修好的值可以继续写入并生效。
    const patched = await callRoute(harness, '/dsh-pomodoro/settings', {
      method: 'POST', body: { focusMin: 30, statsTimeZone: 'Asia/Shanghai' },
    })
    assert.equal(patched.statusCode, 200)
    assert.equal(patched.json().snapshot.settings.focusMin, 30)
    assert.equal(patched.json().snapshot.settings.statsTimeZone, 'Asia/Shanghai')
    await dispose()
  })
})

test('dailyFeedLimit 0 blocks feeding (0 must not collapse to the default 3)', async () => {
  await withClock(async () => {
    const store = createStore()
    const harness = createHarness(store)
    const dispose = apply(harness.ctx, CONFIG)
    await flush()

    const tool = harness.routes.get('tool:pomodoro_pet')
    assert.ok(tool && typeof tool.execute === 'function', 'pomodoro_pet tool is registered')
    const exec = { signal: { aborted: false } }

    const zero = await callRoute(harness, '/dsh-pomodoro/settings', {
      method: 'POST', body: { dailyFeedLimit: 0 },
    })
    assert.equal(zero.statusCode, 200)
    assert.equal(zero.json().snapshot.settings.dailyFeedLimit, 0)
    const blocked = await tool.execute({ action: 'pet', petAction: 'feed' }, exec)
    assert.equal(blocked.ok, false)
    assert.equal(blocked.code, 'daily-limit', 'limit 0 means zero feeds, not the default 3')
    assert.match(blocked.summary, /0 次/)

    // 对照：上限 1 时第一次喂食成功、第二次才被限（证明 0 与 1 真的不同）。
    const one = await callRoute(harness, '/dsh-pomodoro/settings', {
      method: 'POST', body: { dailyFeedLimit: 1 },
    })
    assert.equal(one.json().snapshot.settings.dailyFeedLimit, 1)
    const first = await tool.execute({ action: 'pet', petAction: 'feed' }, exec)
    assert.equal(first.ok, true)
    const second = await tool.execute({ action: 'pet', petAction: 'feed' }, exec)
    assert.equal(second.ok, false)
    assert.equal(second.code, 'daily-limit')
    await dispose()
  })
})

test('boot prunes settled sessions older than maxSessionDays (bounded file growth)', async () => {
  await withClock(async (clock) => {
    const store = createStore()
    const sessions = store.domain.table('sessions')
    const base = {
      kind: 'focus', status: 'done', startedAt: clock.now - 10 * MIN, endsAt: clock.now,
      remainingMs: null, pausedAt: null, outcome: 'completed', source: 'ui',
      focusMinutes: 25, revision: 1, roundIndex: 0, taskId: null, quadrant: null, mode: 'standard',
    }
    await sessions.put('settled-old', { ...base, id: 'settled-old', settledAt: clock.now - 40 * 86_400_000 })
    await sessions.put('settled-recent', { ...base, id: 'settled-recent', settledAt: clock.now - 5 * 86_400_000 })
    await sessions.put('waiting-old', {
      ...base, id: 'waiting-old', status: 'waiting', startedAt: clock.now - 40 * 86_400_000,
      settledAt: clock.now - 40 * 86_400_000,
    })

    const harness = createHarness(store)
    const dispose = apply(harness.ctx, CONFIG) // CONFIG.maxSessionDays = 30
    await flush()

    const ids = new Set(store.getRows('sessions').map(([id]) => id))
    assert.equal(ids.has('settled-old'), false, 'settled rows beyond retention are pruned')
    assert.equal(ids.has('settled-recent'), true, 'recent settled rows survive')
    assert.equal(ids.has('waiting-old'), true, 'a waiting row is never pruned (not terminal)')
    assert.equal((await getState(harness)).snapshot.running?.status, 'waiting')
    await dispose()
  })
})
