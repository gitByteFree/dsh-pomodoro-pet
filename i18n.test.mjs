/**
 * i18n guard rails:
 *  1. `i18n-en.mjs` must be byte-identical to the dictionary inlined in
 *     client.js (the only table the browser executes). This is what stops the
 *     "source file" from drifting or silently rotting again.
 *  2. Both tables stay well-formed (no sparse PATTERNS entries, string values).
 *  3. `raw()` data bypasses translation, and `trf(template, params)` only
 *     interpolates data after translating — the corruption fix.
 *
 * client.js is loaded in a VM with a minimal React + browser stub; its `__test`
 * hooks are the only API used here.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { buildI18nSource } from './scripts/sync-i18n.mjs'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const CLIENT_SOURCE = fs.readFileSync(`${ROOT}client.js`, 'utf8')

test('i18n-en.mjs is generated from client.js (run `node scripts/sync-i18n.mjs` when it fails)', () => {
  const expected = buildI18nSource(CLIENT_SOURCE)
  const actual = fs.readFileSync(`${ROOT}i18n-en.mjs`, 'utf8')
  assert.equal(actual, expected)
})

test('generated dictionary is loadable and well-formed', async () => {
  const generated = await import(`${ROOT}i18n-en.mjs`)
  const text = generated.EN_TEXT
  const patterns = generated.EN_PATTERNS
  assert.ok(Object.keys(text).length > 400, 'EN_TEXT has the full dictionary')
  for (const [key, value] of Object.entries(text)) {
    assert.ok(key.length > 0)
    assert.equal(typeof value, 'string', `EN_TEXT[${JSON.stringify(key)}] must be a string`)
  }
  assert.ok(patterns.length > 80, 'EN_PATTERNS has the pattern table')
  for (const [index, entry] of patterns.entries()) {
    assert.ok(Array.isArray(entry) && entry.length === 2, `PATTERNS[${index}] must be [RegExp, string]`)
    assert.equal(Object.prototype.toString.call(entry[0]), '[object RegExp]', `PATTERNS[${index}][0] must be a RegExp`)
    assert.equal(typeof entry[1], 'string', `PATTERNS[${index}][1] must be a string`)
  }
})

/** Load client.js with a minimal browser + React stub and return its __test hooks. */
function loadClient() {
  let captured
  const noop = () => {}
  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    isValidElement: (node) => node !== null && typeof node === 'object' && 'type' in node,
    cloneElement: (node, patch) => ({ ...node, props: { ...node.props, ...patch } }),
    useState: (init) => [typeof init === 'function' ? init() : init, noop],
    useEffect: noop,
    useRef: (value) => ({ current: value }),
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useReducer: (reducer, init) => [init, noop],
  }
  const sandbox = {
    console: { log: noop, error: noop, warn: noop, info: noop },
    setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    document: {
      visibilityState: 'visible',
      addEventListener: noop, removeEventListener: noop,
      getElementById: () => null,
      createElement: () => ({ setAttribute: noop, append: noop }),
      head: { append: noop },
    },
    navigator: {},
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  sandbox.__ModuleLoader__ = {
    load: ({ factory }) => { captured = factory((id) => {
      if (id === 'react') return fakeReact
      throw new Error(`unexpected client require: ${id}`)
    }) },
  }
  vm.runInNewContext(CLIENT_SOURCE, sandbox, { filename: 'client.js' })
  assert.ok(captured?.__test, 'client.js must expose __test hooks')
  return captured.__test
}

test('raw() keeps user data out of the translation pipeline', () => {
  const { h, raw, trf, setLocale } = loadClient()
  setLocale('en')
  // data passed as a child is rendered verbatim...
  assert.equal(h('span', null, raw('连续 3 天复盘')).children[0], '连续 3 天复盘')
  assert.equal(h('span', null, raw('专注')).children[0], '专注')
  // ...while UI copy still goes through tr()
  assert.equal(h('span', null, '专注').children[0], 'Focus')
  // ...and data interpolated into a UI template is only substituted after translation
  assert.equal(
    trf('删除任务「{title}」?', { title: '连续 3 天复盘' }),
    'Delete task “连续 3 天复盘”?',
  )
  // raw() in a text prop is unwrapped to a plain string too
  assert.equal(h('button', { title: raw('连续 3 天复盘') }, 'x').props.title, '连续 3 天复盘')
})

test('trf() fills params in Chinese mode as well', () => {
  const { trf, setLocale } = loadClient()
  setLocale('zh')
  assert.equal(trf('本轮任务:{title}', { title: '写周报' }), '本轮任务:写周报')
  assert.equal(trf('专注'), '专注')
})

test('Chinese mode keeps the h() fast path (raw() is a plain string)', () => {
  const { h, raw, setLocale } = loadClient()
  setLocale('zh')
  assert.equal(typeof raw('连续 3 天复盘'), 'string')
  assert.equal(h('span', null, raw('连续 3 天复盘')).children[0], '连续 3 天复盘')
  // A marker created while English was active (e.g. a persisted pet bubble) must
  // still be unwrapped if the language flips back to Chinese before it is rendered.
  setLocale('en')
  const stale = raw('连续 3 天复盘')
  assert.equal(typeof stale, 'object')
  setLocale('zh')
  assert.equal(h('span', null, stale).children[0], '连续 3 天复盘')
})

test('trRaw() survives the h() render pass without a second translation', () => {
  const { h, trRaw, trf, setLocale } = loadClient()
  setLocale('en')
  // h() would otherwise re-run tr() on the finished English string, handing the
  // interpolated Chinese title to PATTERNS again.
  const node = h('span', null, trRaw('本轮任务:{title}', { title: '连续 3 天复盘' }))
  assert.equal(node.children[0], 'Current task: 连续 3 天复盘')
  const aria = h('button', { 'aria-label': trRaw('删除任务 {title}', { title: '连续 3 天复盘' }) }, 'x')
  assert.equal(aria.props['aria-label'], 'Delete task 连续 3 天复盘')
  // plain trf output is still a string for non-h consumers (confirm/canvas/templates)
  assert.equal(typeof trf('删除任务「{title}」?', { title: '复盘' }), 'string')
})
