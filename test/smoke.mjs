/**
 * Smoke test for dsh-next-reply, run with `node test/smoke.mjs`.
 *
 * Exercises the REAL shipped files through minimal stubs:
 *  - Host half: `apply` registers one system-prompt section, the preference
 *    route and the diagnostic route; both round-trip end to end against scratch
 *    files, never the user's real preference.
 *  - Client half: boots the lazy-CJS factory with fake loader/React/ctx/fetch,
 *    captures every registered cell, and drives the chip row in BOTH click
 *    behaviours, the guarded-insert path, the draft-protection gates, the
 *    double-click guard, and the settings page.
 *
 * Not shipped: `package.json` `files` omits `test/`.
 */
import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')

// Scratch files, so the suite never reads or writes the user's real preference
// under the DSH home. The plugin exposes every path for exactly this reason.
const CONFIG_FILE = join(pkgRoot, '.smoke-config.json')
const LEGACY_FILE = join(pkgRoot, '.smoke-legacy.json')
process.env.DSH_NR_CONFIG_FILE = CONFIG_FILE
process.env.DSH_NR_LEGACY_CONFIG_FILES = LEGACY_FILE

const CONFIG_PATH = '/plugins/dsh-next-reply/config'
const DIAG_PATH = '/plugins/dsh-next-reply/diag'

let passed = 0
async function check(label, fn) {
  await fn()
  passed += 1
  console.log(`  ok  ${label}`)
}

// The suite owns these two scratch files outright.
rmSync(CONFIG_FILE, { force: true })
rmSync(LEGACY_FILE, { force: true })

// ---------------------------------------------------------------- Host half

console.log('Host half (lib/index.js)')
const host = await import(pathToFileURL(join(pkgRoot, 'lib/index.js')).href)

await check('injects the systemPrompt service', () => {
  assert.deepEqual(host.inject, ['systemPrompt'])
})

/** Host stub capturing sections and routes. */
function makeHostCtx() {
  const sections = []
  const routes = []
  const server = {
    register(route) {
      routes.push(route)
      return () => {}
    },
  }
  const ctx = {
    systemPrompt: { section: (section) => sections.push(section) },
    get: (key) => (key === 'webServer' ? server : undefined),
    effect: (fn) => {
      fn()
      return () => {}
    },
    logger: { warn: () => {} },
  }
  return { ctx, sections, routes }
}

const hostStub = makeHostCtx()
host.apply(hostStub.ctx)

await check('apply() registers exactly one section with the marker template', () => {
  assert.equal(hostStub.sections.length, 1)
  const [section] = hostStub.sections
  assert.equal(section.name, 'next-reply:format')
  assert.equal(section.order, 118)
  assert.equal(typeof section.text, 'function')
  const text = section.text({ agent: undefined })
  assert.match(text, /```suggest/)
  assert.match(text, /\|\|/)
})

await check('keeps the instruction for a root agent and drops it for a delegated one', () => {
  const sections = []
  const rootAgent = { id: 'root' }
  const childAgent = { id: 'child' }
  const ctx = {
    systemPrompt: { section: (section) => sections.push(section) },
    get: (key) =>
      key === 'subagents'
        ? { rootOf: (agent) => (agent === childAgent ? rootAgent : agent) }
        : undefined,
    effect: () => () => {},
    logger: { warn: () => {} },
  }
  host.apply(ctx)
  const [section] = sections
  assert.match(section.text({ agent: rootAgent }), /```suggest/)
  assert.equal(section.text({ agent: childAgent }), '', 'a delegated agent must not receive the marker')
})

await check('apply() registers the preference and diagnostic routes', () => {
  assert.equal(hostStub.routes.length, 2)
  for (const route of hostStub.routes) assert.equal(route.kind, 'exact')
  assert.deepEqual(
    hostStub.routes.map((route) => route.path).sort(),
    [CONFIG_PATH, DIAG_PATH],
  )
})

/** Invoke one route handler with a fake request/response pair. */
async function callRoute(path, { method, body }) {
  const route = hostStub.routes.find((candidate) => candidate.path === path)
  assert.ok(route, `no route registered for ${path}`)
  let status
  let payload
  const res = {
    writeHead(nextStatus) {
      status = nextStatus
    },
    end(chunk) {
      payload = chunk
    },
  }
  const req = {
    method,
    url: path,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  }
  await route.handler(req, res)
  return { status, json: payload === undefined ? undefined : JSON.parse(payload) }
}

await check('GET returns the default (send) on a fresh install', async () => {
  const { status, json } = await callRoute(CONFIG_PATH, { method: 'GET' })
  assert.equal(status, 200)
  assert.deepEqual(json, { directSend: true })
})

await check('POST persists "draft" and a later GET reads it back', async () => {
  const write = await callRoute(CONFIG_PATH, { method: 'POST', body: { directSend: false } })
  assert.equal(write.status, 200)
  assert.deepEqual(write.json, { directSend: false })
  assert.deepEqual(JSON.parse(readFileSync(CONFIG_FILE, 'utf8')), { directSend: false })

  const read = await callRoute(CONFIG_PATH, { method: 'GET' })
  assert.deepEqual(read.json, { directSend: false })
})

await check('POST rejects a non-boolean payload without touching the file', async () => {
  const before = readFileSync(CONFIG_FILE, 'utf8')
  const { status } = await callRoute(CONFIG_PATH, { method: 'POST', body: { directSend: 'nope' } })
  assert.equal(status, 400)
  assert.equal(readFileSync(CONFIG_FILE, 'utf8'), before)
})

await check('an unsupported method is refused', async () => {
  const { status } = await callRoute(CONFIG_PATH, { method: 'DELETE' })
  assert.equal(status, 405)
})

await check('migrates a value an older build wrote under the previous name', async () => {
  rmSync(CONFIG_FILE, { force: true })
  writeFileSync(LEGACY_FILE, JSON.stringify({ directSend: false }), 'utf8')
  const { json } = await callRoute(CONFIG_PATH, { method: 'GET' })
  assert.deepEqual(json, { directSend: false })
  rmSync(LEGACY_FILE, { force: true })
})

await check('the diagnostic ring accepts a report and returns it newest-last', async () => {
  const first = await callRoute(DIAG_PATH, { method: 'POST', body: { reason: 'no-marker', turn: 3 } })
  assert.equal(first.status, 200)
  assert.deepEqual(first.json.entries.at(-1).reason, 'no-marker')
  await callRoute(DIAG_PATH, { method: 'POST', body: { reason: 'no-text', turn: 4 } })
  const { json } = await callRoute(DIAG_PATH, { method: 'GET' })
  assert.deepEqual(json.entries.slice(-2).map((entry) => entry.reason), ['no-marker', 'no-text'])
  assert.match(json.entries.at(-1).at, /^\d{4}-\d{2}-\d{2}T/)
})

await check('the diagnostic ring stays bounded and sanitises junk', async () => {
  for (let index = 0; index < 20; index += 1) {
    await callRoute(DIAG_PATH, { method: 'POST', body: { reason: `r${index}`, turn: 'not-a-turn' } })
  }
  const { json } = await callRoute(DIAG_PATH, { method: 'GET' })
  assert.ok(json.entries.length <= 8, 'the ring must stay bounded')
  assert.equal(json.entries.at(-1).turn, undefined, 'a junk turn is dropped, not stored')
  assert.equal((await callRoute(DIAG_PATH, { method: 'DELETE' })).status, 405)
})

// -------------------------------------------------------------- Client half

console.log('Client half (lib/client.js)')

/** A fetch stub standing in for the Host routes. */
let serverSide = { directSend: true }
let fetchCalls = []
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url, method: init?.method ?? 'GET' })
  if (init?.method === 'POST') {
    serverSide = JSON.parse(init.body)
    return { ok: true, json: async () => serverSide }
  }
  return { ok: true, json: async () => serverSide }
}

/** Minimal React stand-in: enough for the components' hooks and elements. */
const react = {
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
}

/** Boot the shipped client file and capture what it registers. */
function bootClient() {
  const source = readFileSync(join(pkgRoot, 'lib/client.js'), 'utf8')
  let mod
  const window = { __ModuleLoader__: { load: (m) => { mod = m } }, __NR_DIAG__: false }
  new Function('window', 'console', 'fetch', source)(window, console, globalThis.fetch)
  assert.ok(mod, 'module loader was not called')
  assert.equal(mod.id, 'dsh-next-reply')

  const exportsObj = mod.factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require: ${name}`)
  })

  const cells = []
  const ctx = {
    slots: {
      inject: (key, cb) => cb(),
      register: (definition, component) => {
        cells.push({ definition, component })
        return () => {}
      },
    },
  }
  exportsObj.apply(ctx)
  return { exportsObj, cells }
}

/** Build a chat snapshot with one assistant step for `turn`. */
function chatWith(turn, textBlocks) {
  const nodes = new Map()
  nodes.set(`a${turn}`, {
    kind: 'assistant-step',
    location: { turn },
    data: { content: textBlocks.map((text) => ({ type: 'text', text })) },
  })
  return { order: [`a${turn}`], nodes }
}

/** The button elements of a rendered row, flattened past React's nesting. */
function chipsOf(tree) {
  return tree.children.flat()
}

/** Render the chip row with a given session and composer state. */
function renderChips(component, { turn, chat, running = false, inputActions, input, sessionId }) {
  return component({
    turn,
    sessionId,
    useChat: (select) => select(chat),
    useSession: (select) => select({ running }),
    useInput: input === undefined ? undefined : (select) => select(input),
    inputActions,
  })
}

/** InputActions stand-in carrying the guarded-insert contract. */
function guardedActions(calls, { insertResult = true } = {}) {
  return {
    captureInsertion: () => {
      calls.push(['captureInsertion'])
      return { draftRev: 7, from: 0, to: 0 }
    },
    insertText: (text, span) => {
      calls.push(['insertText', text, span.draftRev])
      return insertResult
    },
    setDraft: (text) => calls.push(['setDraft', text]),
    submit: () => calls.push(['submit']),
  }
}

const { exportsObj, cells } = bootClient()
const chipsCell = cells.find((cell) => cell.definition.name === 'conversation.chat.turnTail')
const settingsCell = cells.find((cell) => cell.definition.name === 'settings.section')
const fenceCell = cells.find((cell) => cell.definition.name === 'conversation.chat.markdown.fence')

/**
 * Flip the shared preference the way the settings page does.
 *
 * `usePreference` loads through `useEffect`, which the React stand-in never
 * runs, so the store only moves when a real setting is written. Going through
 * the settings cell is also what a user does.
 * @param directSend - the behaviour to select.
 */
function selectMode(directSend) {
  const tree = settingsCell.component({})
  const radios = tree.children.filter((child) => child && child.props && typeof child.props.onSelect === 'function')
  radios[directSend ? 0 : 1].props.onSelect()
  serverSide = { directSend }
}

await check('exports inject=["slots"] and an apply function', () => {
  assert.deepEqual(exportsObj.inject, ['slots'])
  assert.equal(typeof exportsObj.apply, 'function')
})

await check('registers a fresh turnTail cell ordered before the action row', () => {
  assert.ok(chipsCell, 'the turnTail cell was not registered')
  assert.equal(chipsCell.definition.id, 'next-reply')
  assert.equal(chipsCell.definition.order, 60)
})

await check('registers a settings page labelled 下一步建议', () => {
  assert.ok(settingsCell, 'the settings cell was not registered')
  assert.equal(settingsCell.definition.id, 'next-reply')
  assert.equal(settingsCell.definition.order, 55)
  assert.equal(settingsCell.definition.label, '下一步建议')
})

await check('parses three options out of a marker', () => {
  const chat = chatWith(3, ['好的。\n<!--NEXT: 按方案 A 继续 || 先看数据再定 || 换成英文标题 -->'])
  const tree = renderChips(chipsCell.component, { turn: 3, chat, inputActions: {} })
  assert.deepEqual(chipsOf(tree).map((chip) => chip.children[0]), ['按方案 A 继续', '先看数据再定', '换成英文标题'])
})

await check('a marker split across text blocks still parses', () => {
  const chat = chatWith(3, ['前言 <!--NEXT: 甲', ' || 乙 || 丙 --> 尾巴'])
  const tree = renderChips(chipsCell.component, { turn: 3, chat, inputActions: {} })
  assert.deepEqual(chipsOf(tree).map((chip) => chip.children[0]), ['甲', '乙', '丙'])
})

await check('a turn without a marker renders nothing (no gap)', () => {
  assert.equal(renderChips(chipsCell.component, { turn: 3, chat: chatWith(3, ['纯文本']), inputActions: {} }), null)
})

await check('chips are turn-scoped: another turn renders nothing', () => {
  const chat = chatWith(3, ['<!--NEXT: 甲 || 乙 || 丙 -->'])
  assert.equal(renderChips(chipsCell.component, { turn: 4, chat, inputActions: {} }), null)
})

await check('more than three options truncate to three', () => {
  const chat = chatWith(3, ['<!--NEXT: 甲 || 乙 || 丙 || 丁 -->'])
  const tree = renderChips(chipsCell.component, { turn: 3, chat, inputActions: {} })
  assert.deepEqual(chipsOf(tree).map((chip) => chip.children[0]), ['甲', '乙', '丙'])
})

await check('duplicates and blanks are dropped', () => {
  const chat = chatWith(3, ['<!--NEXT: 甲 ||  || 甲 || 乙 -->'])
  const tree = renderChips(chipsCell.component, { turn: 3, chat, inputActions: {} })
  assert.deepEqual(chipsOf(tree).map((chip) => chip.children[0]), ['甲', '乙'])
})

await check('location.turn.turn shape is accepted too', () => {
  const nodes = new Map()
  nodes.set('x', {
    kind: 'assistant-step',
    location: { turn: { turn: 7 } },
    data: { content: [{ type: 'text', text: '<!--NEXT: 甲 || 乙 || 丙 -->' }] },
  })
  const tree = renderChips(chipsCell.component, { turn: 7, chat: { order: ['x'], nodes }, inputActions: {} })
  assert.deepEqual(chipsOf(tree).map((chip) => chip.children[0]), ['甲', '乙', '丙'])
})

await check('SEND mode on an empty composer: setDraft + submit', () => {
  selectMode(true)
  const calls = []
  const inputActions = {
    setDraft: (text) => calls.push(['setDraft', text]),
    submit: () => calls.push(['submit']),
  }
  const tree = renderChips(chipsCell.component, { turn: 3, chat: chatWith(3, ['<!--NEXT: 甲 || 乙 -->']), inputActions })
  chipsOf(tree)[1].props.onClick()
  assert.deepEqual(calls, [['setDraft', '乙'], ['submit']])
})

await check('SEND mode prefers the revision-guarded insert over setDraft', () => {
  selectMode(true)
  const calls = []
  const inputActions = guardedActions(calls)
  const input = { draft: '', attachmentIds: [], phase: 'plain', draftRev: 7 }
  const tree = renderChips(chipsCell.component, {
    turn: 3,
    chat: chatWith(3, ['```suggest\n护甲 || 护乙\n```']),
    inputActions,
    input,
  })
  chipsOf(tree)[0].props.onClick()
  assert.deepEqual(calls, [['captureInsertion'], ['insertText', '护甲', 7], ['submit']])
})

await check('SEND mode refuses to overwrite a draft and says so', () => {
  selectMode(true)
  const calls = []
  const inputActions = guardedActions(calls)
  const input = { draft: '我打到一半的话', attachmentIds: [], phase: 'plain', draftRev: 7 }
  const tree = renderChips(chipsCell.component, {
    turn: 3,
    chat: chatWith(3, ['```suggest\n草稿甲 || 草稿乙\n```']),
    inputActions,
    input,
  })
  assert.equal(chipsOf(tree)[0].props.disabled, true)
  assert.match(chipsOf(tree)[0].props.title, /已有草稿/)
  chipsOf(tree)[0].props.onClick()
  assert.deepEqual(calls, [], 'a send-mode chip must never clear a draft')
})

await check('an attachment alone also counts as a draft', () => {
  selectMode(true)
  const input = { draft: '', attachmentIds: ['a1'], phase: 'plain', draftRev: 3 }
  const tree = renderChips(chipsCell.component, {
    turn: 3,
    chat: chatWith(3, ['```suggest\n附件甲 || 附件乙\n```']),
    inputActions: guardedActions([]),
    input,
  })
  assert.equal(chipsOf(tree)[0].props.disabled, true)
})

await check('DRAFT mode inserts at the caret and never submits', () => {
  selectMode(false)
  const calls = []
  const inputActions = guardedActions(calls)
  const input = { draft: '前缀 ', attachmentIds: [], phase: 'plain', draftRev: 7 }
  const tree = renderChips(chipsCell.component, {
    turn: 3,
    chat: chatWith(3, ['```suggest\n丙 || 丁\n```']),
    inputActions,
    input,
  })
  chipsOf(tree)[0].props.onClick()
  assert.deepEqual(calls, [['captureInsertion'], ['insertText', '丙', 7]], 'draft mode must not submit')
})

await check('DRAFT mode refuses when a stale insert cannot be retried safely', () => {
  selectMode(false)
  const calls = []
  const inputActions = guardedActions(calls, { insertResult: false })
  const input = { draft: '不能被覆盖', attachmentIds: [], phase: 'plain', draftRev: 7 }
  const tree = renderChips(chipsCell.component, {
    turn: 3,
    chat: chatWith(3, ['```suggest\n拒绝甲 || 拒绝乙\n```']),
    inputActions,
    input,
  })
  chipsOf(tree)[0].props.onClick()
  assert.deepEqual(calls, [['captureInsertion'], ['insertText', '拒绝甲', 7]], 'a failed insert must not fall back to setDraft over a live draft')
})

await check('DRAFT mode still fills an empty composer through setDraft on older builds', () => {
  selectMode(false)
  const calls = []
  const inputActions = {
    setDraft: (text) => calls.push(['setDraft', text]),
    submit: () => calls.push(['submit']),
  }
  const tree = renderChips(chipsCell.component, {
    turn: 3,
    chat: chatWith(3, ['```suggest\n旧甲 || 旧乙\n```']),
    inputActions,
  })
  chipsOf(tree)[0].props.onClick()
  assert.deepEqual(calls, [['setDraft', '旧甲']])
})

await check('DRAFT mode annotates the chip tooltip', () => {
  selectMode(false)
  const tree = renderChips(chipsCell.component, { turn: 3, chat: chatWith(3, ['<!--NEXT: 甲 -->']), inputActions: {} })
  assert.match(chipsOf(tree)[0].props.title, /填入输入框/)
})

await check('a repeated click on the same label sends once', () => {
  selectMode(true)
  const calls = []
  const inputActions = guardedActions(calls)
  const input = { draft: '', attachmentIds: [], phase: 'plain', draftRev: 7 }
  const tree = renderChips(chipsCell.component, {
    turn: 3,
    chat: chatWith(3, ['```suggest\n戊 || 己\n```']),
    inputActions,
    input,
  })
  const first = chipsOf(tree)[0]
  first.props.onClick()
  first.props.onClick()
  assert.deepEqual(calls, [['captureInsertion'], ['insertText', '戊', 7], ['submit']], 'a double click must not send twice')
})

await check('a non-plain submit phase renders chips disabled', () => {
  selectMode(true)
  for (const phase of ['sending', 'adjudicating', 'claimed']) {
    const input = { draft: '', attachmentIds: [], phase, draftRev: 1 }
    const calls = []
    const tree = renderChips(chipsCell.component, {
      turn: 3,
      chat: chatWith(3, ['```suggest\n相位甲 || 相位乙\n```']),
      inputActions: guardedActions(calls),
      input,
    })
    assert.equal(chipsOf(tree)[0].props.disabled, true, `phase ${phase} must disable the row`)
    chipsOf(tree)[0].props.onClick()
    assert.deepEqual(calls, [])
  }
})

await check('hovering expands the pill to its whole label and restores it', () => {
  selectMode(true)
  const tree = renderChips(chipsCell.component, {
    turn: 3,
    chat: chatWith(3, ['```suggest\n悬停甲 || 悬停乙\n```']),
    inputActions: guardedActions([]),
  })
  const button = chipsOf(tree)[0]
  const style = { maxWidth: '260px', whiteSpace: 'nowrap', textAlign: '' }
  button.props.onMouseEnter({ currentTarget: { style } })
  assert.equal(style.maxWidth, 'min(420px, 100%)')
  assert.equal(style.whiteSpace, 'normal')
  assert.equal(style.background, 'var(--dsw-alias-bg-layer-1)')
  button.props.onMouseLeave({ currentTarget: { style } })
  assert.equal(style.maxWidth, '260px')
  assert.equal(style.whiteSpace, 'nowrap')
  assert.equal(style.background, 'transparent')
})

await check('a running session renders chips disabled and inert', () => {
  selectMode(true)
  const calls = []
  const inputActions = {
    setDraft: (text) => calls.push(['setDraft', text]),
    submit: () => calls.push(['submit']),
  }
  const tree = renderChips(chipsCell.component, {
    turn: 3,
    chat: chatWith(3, ['<!--NEXT: 甲 || 乙 -->']),
    running: true,
    inputActions,
  })
  assert.equal(chipsOf(tree)[0].props.disabled, true)
  chipsOf(tree)[0].props.onClick()
  assert.deepEqual(calls, [], 'a disabled chip must not act')
})

await check('a missing inputActions renders chips disabled instead of throwing', () => {
  const tree = renderChips(chipsCell.component, { turn: 3, chat: chatWith(3, ['<!--NEXT: 甲 -->']), inputActions: undefined })
  assert.equal(chipsOf(tree)[0].props.disabled, true)
  chipsOf(tree)[0].props.onClick() // must not throw
})

await check('a malformed chat snapshot renders nothing instead of throwing', () => {
  for (const chat of [undefined, null, {}, { order: 'nope' }, { order: [], nodes: {} }]) {
    assert.equal(renderChips(chipsCell.component, { turn: 1, chat, inputActions: {} }), null)
  }
})

await check('the settings page offers both behaviours with distinct copy', () => {
  const tree = settingsCell.component({})
  const radios = tree.children.filter((child) => child && child.props && typeof child.props.onSelect === 'function')
  assert.equal(radios.length, 2)
  assert.equal(radios[0].props.label, '直接发送')
  assert.equal(radios[1].props.label, '填入输入框，待我确认')
})

/** Every string in a rendered tree, joined — the stub keeps children nested. */
function textOfTree(node) {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOfTree).join('\n')
  if (node === null || typeof node !== 'object') return ''
  return textOfTree(node.children)
}

await check('the settings page carries the miss list', () => {
  const tree = settingsCell.component({})
  const block = tree.children.at(-1)
  assert.equal(typeof block.type, 'function', 'the miss list must be the last settings block')
  const rendered = block.type({})
  assert.match(textOfTree(rendered), /暂无记录/, 'an empty ring must say so plainly')
})

await check('the settings page flip still reaches the Host route', () => {
  serverSide = { directSend: false }
  const tree = settingsCell.component({})
  const radios = tree.children.filter((child) => child && child.props && typeof child.props.onSelect === 'function')
  radios[1].props.onSelect()
  assert.deepEqual(serverSide, { directSend: false })
})

// ------------------------------------------- fenced format and Turn coercion

await check('registers a hidden layer for the suggest fence', () => {
  assert.ok(fenceCell, 'the fence cell was not registered')
  assert.equal(fenceCell.definition.key, 'suggest')
  assert.equal(fenceCell.component({}), null, 'the layer must swallow the block')
})

await check('parses a `suggest` fenced block', () => {
  const chat = chatWith(3, ['好的。\n```suggest\n按方案 A 继续 || 先看数据再定 || 换成英文标题\n```\n'])
  const tree = renderChips(chipsCell.component, { turn: 3, chat, inputActions: {} })
  assert.deepEqual(chipsOf(tree).map((chip) => chip.children[0]), ['按方案 A 继续', '先看数据再定', '换成英文标题'])
})

await check('tolerates one option per line inside the fence', () => {
  const chat = chatWith(3, ['```suggest\n- 甲\n- 乙\n- 丙\n```'])
  const tree = renderChips(chipsCell.component, { turn: 3, chat, inputActions: {} })
  assert.deepEqual(chipsOf(tree).map((chip) => chip.children[0]), ['甲', '乙', '丙'])
})

await check('still parses the legacy HTML comment', () => {
  const chat = chatWith(3, ['正文 <!--NEXT: 甲 || 乙 --> 尾巴'])
  const tree = renderChips(chipsCell.component, { turn: 3, chat, inputActions: {} })
  assert.deepEqual(chipsOf(tree).map((chip) => chip.children[0]), ['甲', '乙'])
})

await check('a TurnLocation-shaped turn prop still matches', () => {
  const chat = chatWith(3, ['```suggest\n甲 || 乙\n```'])
  for (const turn of [3, { turn: 3 }, { kind: 'turn', turn: 3 }, { turn: { turn: 3 } }]) {
    const tree = renderChips(chipsCell.component, { turn, chat, inputActions: {} })
    assert.ok(tree !== null, `chips missing for turn prop ${JSON.stringify(turn)}`)
    assert.deepEqual(chipsOf(tree).map((chip) => chip.children[0]), ['甲', '乙'])
  }
})

await check('unresolvable turn falls back to the closing answer only', () => {
  const nodes = new Map()
  nodes.set('old', { kind: 'assistant-step', location: { turn: 3 }, data: { content: [{ type: 'text', text: '```suggest\n旧 || 旧2\n```' }] } })
  nodes.set('later', { kind: 'user', location: { turn: 4 } })
  nodes.set('tail', { kind: 'turn-tail', location: { turn: 4 } })
  const older = { order: ['old', 'later', 'tail'], nodes }
  assert.equal(
    renderChips(chipsCell.component, { turn: undefined, chat: older, inputActions: {} }),
    null,
    'a non-closing answer must not show chips',
  )

  const fresh = new Map()
  fresh.set('ans', { kind: 'assistant-step', location: { turn: 9 }, data: { content: [{ type: 'text', text: '```suggest\n新 || 新2\n```' }] } })
  fresh.set('tail', { kind: 'turn-tail', location: { turn: 9 } })
  const tree = renderChips(chipsCell.component, { turn: undefined, chat: { order: ['ans', 'tail'], nodes: fresh }, inputActions: {} })
  assert.deepEqual(chipsOf(tree).map((chip) => chip.children[0]), ['新', '新2'])
})

await check('a session snapshot supplies chat when useChat is absent', () => {
  const chat = chatWith(3, ['```suggest\n甲 || 乙\n```'])
  const tree = chipsCell.component({
    turn: 3,
    useChat: undefined,
    useSession: (select) => select({ running: false, chat }),
    inputActions: {},
  })
  assert.deepEqual(chipsOf(tree).map((chip) => chip.children[0]), ['甲', '乙'])
})

// ------------------------------------------------- parser hardening (adopted
// from the two reference plugins: normalise, de-dupe, cap, salvage)

/** Parse one fenced body through the real component. */
function chipsFromBody(body) {
  const chat = chatWith(3, [`\`\`\`suggest\n${body}\n\`\`\``])
  const tree = renderChips(chipsCell.component, { turn: 3, chat, inputActions: {} })
  return tree === null ? null : chipsOf(tree).map((chip) => chip.children[0])
}

await check('salvages a JSON array instead of the delimiter convention', () => {
  assert.deepEqual(chipsFromBody('["按方案 A 继续", "先看数据", "换英文标题"]'), ['按方案 A 继续', '先看数据', '换英文标题'])
})

await check('peels wrapping quotes and list markers', () => {
  assert.deepEqual(chipsFromBody('「按方案 A 继续」\n- “先看数据”\n1. 『换英文标题』'), ['按方案 A 继续', '先看数据', '换英文标题'])
})

await check('collapses internal whitespace inside one option', () => {
  assert.deepEqual(chipsFromBody('按方案   A   继续 ||  先看数据 '), ['按方案 A 继续', '先看数据'])
})

await check('de-duplicates case-insensitively', () => {
  assert.deepEqual(chipsFromBody('Run tests || run tests || RUN TESTS'), ['Run tests'])
})

await check('caps an over-long suggestion', () => {
  const long = '很长的一条建议'.repeat(40)
  const [only] = chipsFromBody(long)
  assert.equal(only.length, 80)
})

await check('chips carry an accessible label', () => {
  const chat = chatWith(3, ['```suggest\n甲 || 乙\n```'])
  const tree = renderChips(chipsCell.component, { turn: 3, chat, inputActions: {} })
  assert.equal(chipsOf(tree)[0].props['aria-label'], '第 1 个下一步建议：甲')
})

// Nothing real was touched: the suite only ever owned the scratch paths.
serverSide = { directSend: true }
rmSync(CONFIG_FILE, { force: true })
rmSync(LEGACY_FILE, { force: true })

console.log(`\n${passed} checks passed.`)
