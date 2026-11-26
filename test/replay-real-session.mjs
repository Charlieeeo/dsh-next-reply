/**
 * Replay a REAL session log through the shipped reader and marker parser.
 *
 * Why this exists: the unit suite uses fixtures I wrote, which proves the parser
 * matches my assumptions — not that it matches what the kernel records. This
 * script decompresses a real `session.v4.jsonl.zstd`, rebuilds the assistant
 * steps the way the kernel's own projection does, and runs the shipped reader
 * over them.
 *
 * The log is ~1000 concatenated zstd frames (one per append); Node's decoder
 * stops after the first, so frames are split on the magic number. A torn tail
 * frame is skipped rather than fatal.
 *
 * Read-only. It never writes to the session store.
 *
 * Run: node test/replay-real-session.mjs [path-to-zstd]
 */
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const DEFAULT = join(
  homedir(),
  '.dsh/sessions/--E-Dsh_File--/session-9379a95a-050a-4f98-916a-94675ddb7d7d/session.v4.jsonl.zstd',
)
const file = process.argv[2] ?? DEFAULT
if (!existsSync(file)) {
  console.error(`no session log at ${file}`)
  process.exit(2)
}

const compressed = readFileSync(file)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const starts = []
for (let at = compressed.indexOf(MAGIC); at !== -1; at = compressed.indexOf(MAGIC, at + 4)) starts.push(at)

const decoded = []
let torn = 0
for (let index = 0; index < starts.length; index += 1) {
  const from = starts[index]
  const to = index + 1 < starts.length ? starts[index + 1] : compressed.length
  try {
    decoded.push(zstdDecompressSync(compressed.subarray(from, to)).toString('utf8'))
  } catch {
    torn += 1
  }
}

const records = []
for (const line of decoded.join('').split('\n')) {
  if (line.trim() === '') continue
  try {
    records.push(JSON.parse(line))
  } catch { /* partial line */ }
}
console.log(`log: ${starts.length} frames (${torn} torn), ${records.length} JSON records`)

// ---------------------------------------------------------- shipped logic

/** Copied verbatim from lib/client.js so this runs the real rules. */
const COMMENT_MARKER = /<!--\s*NEXT:\s*([\s\S]*?)-->/
const FENCE_MARKER = /```suggest[ \t]*\r?\n([\s\S]*?)```/
const MAX_CHIPS = 3
const MAX_CHIP_CHARS = 160
const WRAPPING = /^["'“”‘’「」『』《》]+|["'“”‘’「」『』《》]+$/g

function normalizeChip(raw) {
  let text = String(raw).replace(/\s+/g, ' ').trim()
  text = text.replace(/^[-*•·]+\s*/, '')
  text = text.replace(/^\d+[.)、]\s*/, '')
  text = text.replace(WRAPPING, '').trim()
  if (text.length > MAX_CHIP_CHARS) text = text.slice(0, MAX_CHIP_CHARS).trim()
  return text
}

function collectChips(raw) {
  const chips = []
  const seen = new Set()
  const push = (value) => {
    if (chips.length >= MAX_CHIPS) return
    const chip = normalizeChip(value)
    if (chip === '') return
    const key = chip.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    chips.push(chip)
  }
  const body = String(raw).trim()
  if (body.startsWith('[')) {
    try {
      const parsed = JSON.parse(body)
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === 'string' || typeof item === 'number') push(String(item))
        }
        if (chips.length > 0) return chips
      }
    } catch { /* fall through */ }
  }
  let parts = body.split('||')
  if (parts.length <= 1) parts = body.split(/\r?\n/)
  for (const part of parts) push(part)
  return chips
}

function parseChips(text) {
  if (typeof text !== 'string' || text === '') return []
  const match = FENCE_MARKER.exec(text) ?? COMMENT_MARKER.exec(text)
  if (match === null) return []
  return collectChips(match[1])
}

/** The shipped reader, including the reasoning exclusion. */
function textOf(node) {
  if (node === null || typeof node !== 'object') return ''
  const data = node.data !== null && typeof node.data === 'object' ? node.data : node
  const parts = []
  const take = (value) => {
    if (typeof value === 'string' && value !== '') parts.push(value)
  }
  if (Array.isArray(data.blocks)) {
    for (const block of data.blocks) {
      if (block === null || typeof block !== 'object') { take(block); continue }
      if (block.kind === 'text') take(block.text)
      else if (block.kind === undefined) take(block.text)
    }
    if (parts.length > 0) return parts.join('\n')
  }
  if (Array.isArray(data.content)) {
    for (const block of data.content) {
      if (block !== null && typeof block === 'object') {
        if (block.kind === undefined || block.kind === 'text') take(block.text)
      } else {
        take(block)
      }
    }
  }
  take(data.text)
  take(data.markdown)
  if (parts.length > 0) return parts.join('\n')
  const SKIP = new Set(['type', 'kind', 'role', 'id', 'key', 'name', 'messageId', 'mediaType', 'mimeType', 'attachment', 'attachments', 'images'])
  const walkValue = (value, depth) => {
    if (depth > 5 || value === null || value === undefined) return
    if (typeof value === 'string') { parts.push(value); return }
    if (Array.isArray(value)) { for (const item of value) walkValue(item, depth + 1); return }
    if (typeof value !== 'object') return
    for (const key of Object.keys(value)) {
      if (SKIP.has(key)) continue
      walkValue(value[key], depth + 1)
    }
  }
  walkValue(data, 0)
  return parts.join('\n')
}

// ------------------------------------------- rebuild the real projection

/**
 * Rebuild `data.blocks` from an `assistant/message` event the way the kernel's
 * `projectAssistant` does: the message's own `content[]` becomes blocks.
 * @param event - one assistant/message event.
 * @returns the blocks array, or [].
 */
function blocksOf(event) {
  const message = event?.data?.message
  if (message === null || typeof message !== 'object') return []
  const content = message.content
  if (!Array.isArray(content)) return []
  const blocks = []
  for (const part of content) {
    if (part === null || typeof part !== 'object') continue
    if (typeof part.type !== 'string') continue
    // `reasoning` stays reasoning; only text is the reply.
    blocks.push({ kind: part.type, text: typeof part.text === 'string' ? part.text : '' })
  }
  return blocks
}

/** Every assistant/message event, wherever nested. */
const events = []
const walk = (value, depth) => {
  if (depth > 8 || value === null || typeof value !== 'object') return
  if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1); return }
  if (value.type === 'assistant/message') events.push(value)
  for (const key of Object.keys(value)) walk(value[key], depth + 1)
}
for (const record of records) walk(record, 0)

console.log(`assistant/message events: ${events.length}`)

let withChips = 0
let reasoningOnly = 0
const samples = []

for (const event of events) {
  const blocks = blocksOf(event)
  if (blocks.length === 0) continue
  const node = { kind: 'assistant-step', data: { blocks } }
  const text = textOf(node)
  const chips = parseChips(text)
  if (chips.length > 0) {
    withChips += 1
    if (samples.length < 4) samples.push(chips)
  } else if (blocks.some((block) => block.kind === 'reasoning' && FENCE_MARKER.test(block.text))) {
    // A fence that lives only in reasoning: the reader must NOT surface it.
    reasoningOnly += 1
  }
}

console.log(`events whose reply text yields chips: ${withChips}`)
console.log(`fences found ONLY in reasoning (correctly ignored): ${reasoningOnly}`)

if (samples.length > 0) {
  console.log('\nreal suggestions recovered from this very session:')
  for (const chips of samples) console.log('  -', JSON.stringify(chips))
}

// Prove the exclusion matters: if reasoning were joined in, would anything change?
let wouldChange = 0
for (const event of events) {
  const blocks = blocksOf(event)
  const proseOnly = parseChips(textOf({ kind: 'assistant-step', data: { blocks } }))
  const withReasoning = parseChips(blocks.map((block) => block.text).join('\n'))
  if (JSON.stringify(proseOnly) !== JSON.stringify(withReasoning)) wouldChange += 1
}
console.log(`\nevents where including reasoning WOULD change the result: ${wouldChange}`)

if (events.length === 0) {
  console.error('FAIL: no assistant/message event found')
  process.exit(1)
}
const readable = events.filter((event) => textOf({ kind: 'assistant-step', data: { blocks: blocksOf(event) } }) !== '').length
console.log(`events with readable prose: ${readable}/${events.length}`)
if (readable === 0) {
  console.error('FAIL: the shipped reader finds no prose in real assistant messages')
  process.exit(1)
}
console.log('\nOK: the shipped reader handles real assistant payloads')
