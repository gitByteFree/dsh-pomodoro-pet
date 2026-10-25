/**
 * agent-bridge unit tests — v0.8 context folding.
 * Run: node --test pomodoro-pet/agent-bridge.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createAgentBridge, normalizeLabel, basenameOf, isRootSession, firstText, sanitizeSessionLabel,
  LABEL_MAX, TOOL_RING_MAX, LAST_TOOLS_MAX,
} from './agent-bridge.js'

const clock = (start = 1_700_000_000_000) => {
  let t = start
  return { now: () => t, advance: ms => { t += ms }, set: v => { t = v } }
}
const rootSession = (id = 'sess-1', cwd = '/home/si/2t/code/dsh-chajian') => ({ id, header: { id, cwd } })
const subSession = (id = 'sub-1') => ({ id, header: { id, cwd: '/tmp', origin: 'subagent', delegationDepth: 1 } })
const userMessage = (text) => ({ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } })
const injectedMessage = (text, kind) => ({ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }], source: { kind } } })

test('normalizeLabel: whitespace collapse + truncation', () => {
  assert.equal(normalizeLabel('  hello\n\tworld  '), 'hello world')
  assert.equal(normalizeLabel(''), null)
  assert.equal(normalizeLabel('   '), null)
  const long = '这是一个非常非常长的会话标题用来测试截断行为是否正常工作以及更多更多的文字内容'
  const out = normalizeLabel(long)
  assert.ok(out.length <= LABEL_MAX)
  assert.ok(out.endsWith('…'))
})

test('sanitizeSessionLabel drops injected context, keeps real titles', () => {
  assert.equal(sanitizeSessionLabel('Time sampled while preparing turn 15'), null)
  assert.equal(sanitizeSessionLabel('<system-reminder> The available skills'), null)
  assert.equal(sanitizeSessionLabel('  '), null)
  assert.equal(sanitizeSessionLabel('番茄精灵 × DSH Agent 联动'), '番茄精灵 × DSH Agent 联动')
  assert.equal(sanitizeSessionLabel('a'.repeat(40)).endsWith('…'), true)
})

test('basenameOf: posix, windows, empty', () => {
  assert.equal(basenameOf('/home/si/2t/code/dsh-chajian'), 'dsh-chajian')
  assert.equal(basenameOf('C:\\work\\pomodoro'), 'pomodoro')
  assert.equal(basenameOf(''), null)
  assert.equal(basenameOf(null), null)
})

test('isRootSession filters subagent children', () => {
  assert.equal(isRootSession(rootSession()), true)
  assert.equal(isRootSession(subSession()), false)
  assert.equal(isRootSession({ header: { delegationDepth: 2 } }), false)
})

test('firstText picks the first text block', () => {
  assert.equal(firstText({ content: [{ type: 'image' }, { type: 'text', text: 'hi' }] }), 'hi')
  assert.equal(firstText({ content: [] }), null)
})

test('user/message adopts current session + label', () => {
  const c = clock()
  const bridge = createAgentBridge({ now: c.now, dayOf: () => '2026-10-21' })
  bridge.onSessionEvent(rootSession(), userMessage('  设计番茄精灵 UI  '))
  const snap = bridge.snapshot()
  assert.equal(snap.session.id, 'sess-1')
  assert.equal(snap.session.label, '设计番茄精灵 UI')
  assert.equal(snap.session.cwdName, 'dsh-chajian')
})

test('injected context messages never become the session label', () => {
  const c = clock()
  const bridge = createAgentBridge({ now: c.now, dayOf: () => '2026-10-21' })
  bridge.onSessionEvent(rootSession(), injectedMessage('Time sampled while preparing turn 15', 'time-context'))
  bridge.onSessionEvent(rootSession(), injectedMessage('skill catalog…', 'skill-catalog'))
  assert.equal(bridge.snapshot().session, null)
  bridge.onSessionEvent(rootSession(), userMessage('真的用户消息'))
  assert.equal(bridge.snapshot().session.label, '真的用户消息')
})

test('titleOf wins over user text; falls back to text when absent', () => {
  const c = clock()
  const titled = createAgentBridge({ now: c.now, dayOf: () => '2026-10-21', titleOf: () => '番茄精灵 × Agent 联动' })
  titled.onSessionEvent(rootSession(), userMessage('帮我改一下界面'))
  assert.equal(titled.snapshot().session.label, '番茄精灵 × Agent 联动')

  const plain = createAgentBridge({ now: c.now, dayOf: () => '2026-10-21', titleOf: () => null })
  plain.onSessionEvent(rootSession(), userMessage('帮我改一下界面'))
  assert.equal(plain.snapshot().session.label, '帮我改一下界面')
})

test('adopt seeds the current session without a label; subagents ignored', () => {
  const c = clock()
  const bridge = createAgentBridge({ now: c.now, dayOf: () => '2026-10-21' })
  assert.equal(bridge.adopt(subSession()), false)
  assert.equal(bridge.snapshot().session, null)
  assert.equal(bridge.adopt(rootSession('sess-9', '/repo/app')), true)
  const snap = bridge.snapshot()
  assert.equal(snap.session.id, 'sess-9')
  assert.equal(snap.session.label, null)
  assert.equal(snap.session.cwdName, 'app')
})

test('subagent events never become the current session', () => {
  const c = clock()
  const bridge = createAgentBridge({ now: c.now, dayOf: () => '2026-10-21' })
  bridge.onSessionEvent(subSession(), userMessage('sub work'))
  assert.equal(bridge.snapshot().session, null)
})

test('tool results count, label, exclude pomodoro_pet, cap lastTools', () => {
  const c = clock()
  const bridge = createAgentBridge({ now: c.now, dayOf: () => '2026-10-21' })
  bridge.onToolResult({ name: 'bash' }, { isError: false })
  c.advance(10)
  bridge.onToolResult({ name: 'edit' }, { isError: true })
  bridge.onToolResult({ name: 'pomodoro_pet' }, { isError: false })
  const snap = bridge.snapshot()
  assert.equal(snap.agent.today.tools, 2)
  assert.equal(snap.agent.lastTools[0].name, 'edit')
  assert.equal(snap.agent.lastTools[0].ok, false)
  assert.equal(snap.toolCount, 2)

  for (let i = 0; i < LAST_TOOLS_MAX + 3; i++) bridge.onToolResult({ name: `t${i}` }, { isError: false })
  assert.equal(bridge.snapshot().agent.lastTools.length, LAST_TOOLS_MAX)
})

test('tool ring trims to TOOL_RING_MAX', () => {
  const c = clock()
  const bridge = createAgentBridge({ now: c.now, dayOf: () => '2026-10-21' })
  for (let i = 0; i < TOOL_RING_MAX + 50; i++) bridge.onToolResult({ name: 'bash' }, { isError: false })
  assert.equal(bridge.snapshot().toolCount, TOOL_RING_MAX)
})

test('countTools respects the [start, end] window', () => {
  const c = clock(1000)
  const bridge = createAgentBridge({ now: c.now, dayOf: () => '2026-10-21' })
  c.set(1000); bridge.onToolResult({ name: 'a' }, { isError: false })
  c.set(2000); bridge.onToolResult({ name: 'b' }, { isError: false })
  c.set(3000); bridge.onToolResult({ name: 'c' }, { isError: false })
  assert.equal(bridge.countTools(1500, 2500), 1)
  assert.equal(bridge.countTools(1000, 3000), 3)
  assert.equal(bridge.countTools(4000, 5000), 0)
})

test('runningTools counts recent tool results', () => {
  const c = clock()
  const bridge = createAgentBridge({ now: c.now, dayOf: () => '2026-10-21' })
  bridge.onToolResult({ name: 'bash' }, { isError: false })
  assert.equal(bridge.snapshot().agent.runningTools, 1)
  c.advance(9_000)
  assert.equal(bridge.snapshot().agent.runningTools, 0)
})

test('agent/status toggles running and adopts the session', () => {
  const c = clock()
  const bridge = createAgentBridge({ now: c.now, dayOf: () => '2026-10-21' })
  const session = rootSession('sess-2', '/repo/pomodoro-pet')
  bridge.onAgentStatus({ agent: { session }, status: 'running' })
  let snap = bridge.snapshot()
  assert.equal(snap.agent.running, true)
  assert.equal(snap.session.id, 'sess-2')
  assert.equal(snap.session.cwdName, 'pomodoro-pet')
  bridge.onAgentStatus({ agent: { session }, status: 'idle' })
  assert.equal(bridge.snapshot().agent.running, false)
})

test('step/end increments steps; day rollover resets counters', () => {
  const c = clock()
  let day = '2026-10-21'
  const bridge = createAgentBridge({ now: c.now, dayOf: () => day })
  bridge.onSessionEvent(rootSession(), { type: 'step/end', data: null })
  bridge.onToolResult({ name: 'bash' }, { isError: false })
  assert.equal(bridge.snapshot().agent.today.steps, 1)
  assert.equal(bridge.snapshot().agent.today.tools, 1)
  day = '2026-10-22'
  bridge.onToolResult({ name: 'bash' }, { isError: false })
  const snap = bridge.snapshot()
  assert.equal(snap.agent.today.day, '2026-10-22')
  assert.equal(snap.agent.today.tools, 1)
})

test('loadBucket only applies for the current day; takeDirty clears the flag', () => {
  const c = clock()
  const bridge = createAgentBridge({ now: c.now, dayOf: () => '2026-10-21' })
  bridge.loadBucket('2026-10-20', { tools: 99, steps: 9 })
  assert.equal(bridge.snapshot().agent.today.tools, 0)
  bridge.loadBucket('2026-10-21', { tools: 7, steps: 3 })
  assert.equal(bridge.snapshot().agent.today.tools, 7)

  assert.equal(bridge.takeDirty(), null)
  bridge.onToolResult({ name: 'bash' }, { isError: false })
  const dirty = bridge.takeDirty()
  assert.equal(dirty.tools, 8)
  assert.equal(bridge.takeDirty(), null)
})

test('onChange listeners fire and dispose cleanly', () => {
  const c = clock()
  const bridge = createAgentBridge({ now: c.now, dayOf: () => '2026-10-21' })
  let n = 0
  const off = bridge.onChange(() => { n += 1 })
  bridge.onToolResult({ name: 'bash' }, { isError: false })
  assert.ok(n > 0)
  const before = n
  off()
  bridge.onToolResult({ name: 'bash' }, { isError: false })
  assert.equal(n, before)
  bridge.dispose()
})
