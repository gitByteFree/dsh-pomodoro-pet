#!/usr/bin/env node
/**
 * Regenerate `i18n-en.mjs` from the dictionary inlined in `client.js`.
 *
 * `client.js` is the single source of truth (it is what the browser actually
 * runs); `i18n-en.mjs` exists only as a readable, editable-checkable view of the
 * same tables. Run this after touching the inline dictionary:
 *
 *   node scripts/sync-i18n.mjs
 *
 * `i18n.test.mjs` fails when the generated file is stale, so drift is caught by
 * `npm test` instead of shipping a "source" nobody executes.
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLIENT_PATH = `${ROOT}client.js`
const OUTPUT_PATH = `${ROOT}i18n-en.mjs`

const HEADER = `/**
 * zh → en dictionary for the Pomodoro Pet client (v0.9).
 *
 * GENERATED FILE — do not edit by hand.
 * Source of truth: the inlined EN_TEXT / PATTERNS tables in client.js.
 * Regenerate with \`node scripts/sync-i18n.mjs\`; \`node --test i18n.test.mjs\`
 * fails when this file is stale.
 */`

const MARKERS = {
  text: ['// >>> i18n:EN_TEXT', '// <<< i18n:EN_TEXT'],
  patterns: ['// >>> i18n:PATTERNS', '// <<< i18n:PATTERNS'],
}

/** Slice the lines between two marker comments (markers excluded). */
function sliceBetween(source, [startMarker, endMarker]) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker)
  if (start < 0 || end < 0 || end < start) throw new Error(`i18n markers not found: ${startMarker} / ${endMarker}`)
  const firstLineEnd = source.indexOf('\n', start) + 1
  // The end marker's own indentation sits between the block and the marker; drop
  // it together with the trailing newline so the generated file has one EOF \n.
  return source.slice(firstLineEnd, end).replace(/\s+$/, '')
}

const dedent = (block) => block.split('\n').map((line) => (line.startsWith('    ') ? line.slice(4) : line)).join('\n')

/** Build the exact expected content of i18n-en.mjs from client.js source. */
export function buildI18nSource(clientSource) {
  const text = dedent(sliceBetween(clientSource, MARKERS.text))
    .replace(/^const EN_TEXT = /m, 'export const EN_TEXT = ')
  const patterns = dedent(sliceBetween(clientSource, MARKERS.patterns))
    .replace(/^const PATTERNS = /m, 'export const EN_PATTERNS = ')
  if (!text.includes('export const EN_TEXT = {')) throw new Error('EN_TEXT block not found in client.js')
  if (!patterns.includes('export const EN_PATTERNS = [')) throw new Error('PATTERNS block not found in client.js')
  return `${HEADER}\n${text}\n\n${patterns}\n`
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const clientSource = fs.readFileSync(CLIENT_PATH, 'utf8')
  const next = buildI18nSource(clientSource)
  const prev = fs.existsSync(OUTPUT_PATH) ? fs.readFileSync(OUTPUT_PATH, 'utf8') : ''
  if (next === prev) {
    console.log('i18n-en.mjs is up to date')
  } else {
    fs.writeFileSync(OUTPUT_PATH, next)
    console.log(`i18n-en.mjs regenerated (${next.length} bytes)`)
  }
}
