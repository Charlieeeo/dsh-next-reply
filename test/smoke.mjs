/**
 * Smoke test for dsh-next-reply, run with `node test/smoke.mjs`.
 *
 * Exercises the REAL shipped files through minimal stubs:
 *  - Host half: `apply` registers one system-prompt section, the preference
 *    route and the diagnostic route; both round-trip end to end against scratch
 *    files, never the user's real preference.
 *  - Client half: boots the lazy-CJS factory with fake loader/React/ctx/fetch,
 *    captures every registered cell, and drives all THREE click behaviours
 *    (`send` / `draft` / `smart`), the guarded-insert path, the draft-protection
 *    gates, the double-click guard, and the settings page.
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
/**
 * Per-scenario hook reset, installed once the React stand-in exists.
 *
 * Each `check` gets a clean component instance, so one scenario's frozen
 * "已发送" state cannot leak into the next. Assigned after `react` is built;
 * the Host-half checks run before that and need no reset.
 */
let resetHooks = () => {}
async function check(label, fn) {
  resetHooks()
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

await check('the instruction now asks for longer, vertical-friendly options', () => {
  const text = hostStub.sections[0].text({ agent: undefined })
  assert.match(text, /8–40 个汉字/, 'the length guidance must match the vertical row')
  assert.match(text, /竖排/, 'the instruction must tell the model the row is vertical')
  assert.doesNotMatch(text, /不超过 24 个汉字/, 'the old pill-era cap must be gone')
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

await check('GET returns the default (smart) on a fresh install', async () => {
  const { status, json } = await callRoute(CONFIG_PATH, { method: 'GET' })
  assert.equal(status, 200)
  assert.deepEqual(json, { mode: 'smart' })
})

await check('POST persists each of the three modes and a later GET reads it back', async () => {
  for (const mode of ['smart', 'draft', 'send']) {
    const write = await callRoute(CONFIG_PATH, { method: 'POST', body: { mode } })
    assert.equal(write.status, 200)
    assert.deepEqual(write.json, { mode })
    assert.deepEqual(JSON.parse(readFileSync(CONFIG_FILE, 'utf8')), { mode })
    const read = await callRoute(CONFIG_PATH, { method: 'GET' })
    assert.deepEqual(read.json, { mode })
  }
})

await check('POST rejects an unknown mode without touching the file', async () => {
  const before = readFileSync(CONFIG_FILE, 'utf8')
  for (const body of [{ mode: 'nope' }, { mode: 7 }, {}, { directSend: 'yes' }]) {
    const { status } = await callRoute(CONFIG_PATH, { method: 'POST', body })
    assert.equal(status, 400, `body ${JSON.stringify(body)} must be refused`)
  }
  assert.equal(readFileSync(CONFIG_FILE, 'utf8'), before)
})

await check('a pre-0.8 { directSend } body still maps onto a mode', async () => {
  const sent = await callRoute(CONFIG_PATH, { method: 'POST', body: { directSend: true } })
  assert.deepEqual(sent.json, { mode: 'send' })
  const drafted = await callRoute(CONFIG_PATH, { method: 'POST', body: { directSend: false } })
  assert.deepEqual(drafted.json, { mode: 'draft' })
})

await check('an unsupported method is refused', async () => {
  const { status } = await callRoute(CONFIG_PATH, { method: 'DELETE' })
  assert.equal(status, 405)
})

await check('migrates a legacy { directSend } file written under the previous name', async () => {
  rmSync(CONFIG_FILE, { force: true })
  writeFileSync(LEGACY_FILE, JSON.stringify({ directSend: false }), 'utf8')
  const { json } = await callRoute(CONFIG_PATH, { method: 'GET' })
  assert.deepEqual(json, { mode: 'draft' }, 'the old boolean must fold into the matching mode')
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
let serverSide = { mode: 'smart' }
let fetchCalls = []
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url, method: init?.method ?? 'GET' })
  if (init?.method === 'POST') {
    const body = JSON.parse(init.body)
    serverSide = body.mode === undefined ? { mode: serverSide.mode } : { mode: body.mode }
    return { ok: true, json: async () => serverSide }
  }
  return { ok: true, json: async () => serverSide }
}

/**
 * Minimal React stand-in: enough for the components' hooks and elements.
 *
 * `useState` is real enough to be worth having: a hook slot list is kept per
 * component invocation chain and reset on every fresh render, so a setter
 * followed by a re-render sees the new value. Without that, the "已发送" freeze
 * branch could never be asserted and its test would be theatre.
 */
function makeReact() {
  let slots = [];
  let cursor = 0;
  return {
    /** Start a fresh render pass: the next component call begins at hook 0. */
    beginRender() {
      cursor = 0;
    },
    /**
     * Drop every hook slot. This is the test-suite stand-in for unmounting a
     * component: without it, one scenario's frozen "已发送" state would leak
     * into the next, because the slot list outlives a single render.
     */
    reset() {
      slots = [];
      cursor = 0;
    },
    useState(initial) {
      const at = cursor;
      cursor += 1;
      if (slots[at] === undefined) slots[at] = { value: initial };
      const slot = slots[at];
      return [slot.value, (next) => { slot.value = next }];
    },
    useEffect: () => {},
    useMemo: (factory) => factory(),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  };
}

const react = makeReact();
resetHooks = () => react.reset();

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

/**
 * The row elements of a rendered list.
 *
 * The component renders one `div` per suggestion, each holding a label button
 * and (in smart mode) two icon buttons, so the stub's nested `children` arrays
 * are flattened here rather than at every assertion.
 */
function rowsOf(tree) {
  return tree.children.flat()
}

/** The controls inside one row: `[label, ...icons]`. */
function controlsOf(row) {
  return row.children.flat()
}

/** The visible text of one label button. */
function labelOf(row) {
  return controlsOf(row)[0].children[0]
}

/** Every row's label text. */
function labelsOf(tree) {
  return rowsOf(tree).map(labelOf)
}

/** Render the suggestion list with a given session and composer state. */
function renderRows(component, { turn, chat, running = false, inputActions, input }) {
  react.beginRender();
  return component({
    turn,
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
const rowCell = cells.find((cell) => cell.definition.name === 'conversation.chat.turnTail')
const settingsCell = cells.find((cell) => cell.definition.name === 'settings.section')
const fenceCell = cells.find((cell) => cell.definition.name === 'conversation.chat.markdown.fence')

/**
 * Flip the shared preference the way the settings page does.
 *
 * `usePreference` loads through `useEffect`, which the React stand-in never
 * runs, so the store only moves when a real setting is written. Going through
 * the settings cell is also what a user does.
 * @param mode - 'smart' | 'send' | 'draft'.
 */
function selectMode(mode) {
  const tree = settingsCell.component({})
  const radios = tree.children.filter((child) => child && child.props && typeof child.props.onSelect === 'function')
  const index = { smart: 0, send: 1, draft: 2 }[mode]
  assert.ok(index !== undefined, `unknown mode ${mode}`)
  radios[index].props.onSelect()
  serverSide = { mode }
}

await check('exports inject=["slots"] and an apply function', () => {
  assert.deepEqual(exportsObj.inject, ['slots'])
  assert.equal(typeof exportsObj.apply, 'function')
})

await check('registers a fresh turnTail cell ordered before the action row', () => {
  assert.ok(rowCell, 'the turnTail cell was not registered')
  assert.equal(rowCell.definition.id, 'next-reply')
  assert.equal(rowCell.definition.order, 60)
})

await check('registers a settings page labelled 下一步建议', () => {
  assert.ok(settingsCell, 'the settings cell was not registered')
  assert.equal(settingsCell.definition.id, 'next-reply')
  assert.equal(settingsCell.definition.order, 55)
  assert.equal(settingsCell.definition.label, '下一步建议')
})

await check('parses three options out of a marker', () => {
  const chat = chatWith(3, ['好的。\n<!--NEXT: 按方案 A 继续 || 先看数据再定 || 换成英文标题 -->'])
  const tree = renderRows(rowCell.component, { turn: 3, chat, inputActions: {} })
  assert.deepEqual(labelsOf(tree), ['按方案 A 继续', '先看数据再定', '换成英文标题'])
})

await check('the list is vertical: one row element per suggestion', () => {
  const chat = chatWith(3, ['```suggest\n甲 || 乙 || 丙\n```'])
  const tree = renderRows(rowCell.component, { turn: 3, chat, inputActions: {} })
  assert.equal(tree.props.style.flexDirection, 'column', 'the list must stack vertically')
  const rows = rowsOf(tree)
  assert.equal(rows.length, 3)
  for (const row of rows) assert.equal(row.props.style.display, 'flex')
})

await check('a row label wraps instead of being clipped', () => {
  const chat = chatWith(3, ['```suggest\n把这一整句完整写进输入框里再自己改一下\n```'])
  const tree = renderRows(rowCell.component, { turn: 3, chat, inputActions: {} })
  const label = controlsOf(rowsOf(tree)[0])[0]
  assert.equal(label.props.style.whiteSpace, 'normal', 'a vertical row must wrap')
  assert.notEqual(label.props.style.textOverflow, 'ellipsis')
  assert.equal(label.props.style.maxWidth, undefined, 'no pill-era width cap')
})

await check('a marker split across text blocks still parses', () => {
  const chat = chatWith(3, ['前言 <!--NEXT: 甲', ' || 乙 || 丙 --> 尾巴'])
  const tree = renderRows(rowCell.component, { turn: 3, chat, inputActions: {} })
  assert.deepEqual(labelsOf(tree), ['甲', '乙', '丙'])
})

await check('a turn without a marker renders nothing (no gap)', () => {
  assert.equal(renderRows(rowCell.component, { turn: 3, chat: chatWith(3, ['纯文本']), inputActions: {} }), null)
})

await check('rows are turn-scoped: another turn renders nothing', () => {
  const chat = chatWith(3, ['<!--NEXT: 甲 || 乙 || 丙 -->'])
  assert.equal(renderRows(rowCell.component, { turn: 4, chat, inputActions: {} }), null)
})

await check('more than three options truncate to three', () => {
  const chat = chatWith(3, ['<!--NEXT: 甲 || 乙 || 丙 || 丁 -->'])
  const tree = renderRows(rowCell.component, { turn: 3, chat, inputActions: {} })
  assert.deepEqual(labelsOf(tree), ['甲', '乙', '丙'])
})

await check('duplicates and blanks are dropped', () => {
  const chat = chatWith(3, ['<!--NEXT: 甲 ||  || 甲 || 乙 -->'])
  const tree = renderRows(rowCell.component, { turn: 3, chat, inputActions: {} })
  assert.deepEqual(labelsOf(tree), ['甲', '乙'])
})

await check('location.turn.turn shape is accepted too', () => {
  const nodes = new Map()
  nodes.set('x', {
    kind: 'assistant-step',
    location: { turn: { turn: 7 } },
    data: { content: [{ type: 'text', text: '<!--NEXT: 甲 || 乙 || 丙 -->' }] },
  })
  const tree = renderRows(rowCell.component, { turn: 7, chat: { order: ['x'], nodes }, inputActions: {} })
  assert.deepEqual(labelsOf(tree), ['甲', '乙', '丙'])
})

// ------------------------------------------------------------- SEND mode

await check('SEND mode on an empty composer: setDraft + submit', () => {
  selectMode('send')
  const calls = []
  const inputActions = {
    setDraft: (text) => calls.push(['setDraft', text]),
    submit: () => calls.push(['submit']),
  }
  const tree = renderRows(rowCell.component, { turn: 3, chat: chatWith(3, ['<!--NEXT: 甲 || 乙 -->']), inputActions })
  controlsOf(rowsOf(tree)[1])[0].props.onClick()
  assert.deepEqual(calls, [['setDraft', '乙'], ['submit']])
})

await check('SEND mode prefers the revision-guarded insert over setDraft', () => {
  selectMode('send')
  const calls = []
  const inputActions = guardedActions(calls)
  const input = { draft: '', attachmentIds: [], phase: 'plain', draftRev: 7 }
  const tree = renderRows(rowCell.component, {
    turn: 3,
    chat: chatWith(3, ['```suggest\n护甲 || 护乙\n```']),
    inputActions,
    input,
  })
  controlsOf(rowsOf(tree)[0])[0].props.onClick()
  assert.deepEqual(calls, [['captureInsertion'], ['insertText', '护甲', 7], ['submit']])
})

await check('SEND mode refuses to overwrite a draft and says so', () => {
  selectMode('send')
  const calls = []
  const inputActions = guardedActions(calls)
  const input = { draft: '我打到一半的话', attachmentIds: [], phase: 'plain', draftRev: 7 }
  const tree = renderRows(rowCell.component, {
    turn: 3,
    chat: chatWith(3, ['```suggest\n草稿甲 || 草稿乙\n```']),
    inputActions,
    input,
  })
  const label = controlsOf(rowsOf(tree)[0])[0]
  assert.equal(label.props.disabled, true)
  assert.match(label.props.title, /已有草稿/)
  label.props.onClick()
  assert.deepEqual(calls, [], 'a send-mode row must never clear a draft')
})

await check('an attachment alone also counts as a draft', () => {
  selectMode('send')
  const input = { draft: '', attachmentIds: ['a1'], phase: 'plain', draftRev: 3 }
  const tree = renderRows(rowCell.component, {
    turn: 3,
    chat: chatWith(3, ['```suggest\n附件甲 || 附件乙\n```']),
    inputActions: guardedActions([]),
    input,
  })
  assert.equal(controlsOf(rowsOf(tree)[0])[0].props.disabled, true)
})

// ------------------------------------------------------------ DRAFT mode

await check('DRAFT mode inserts at the caret and never submits', () => {
  selectMode('draft')
  const calls = []
  const inputActions = guardedActions(calls)
  const input = { draft: '前缀 ', attachmentIds: [], phase: 'plain', draftRev: 7 }
  const tree = renderRows(rowCell.component, {
    turn: 3,
    chat: chatWith(3, ['```suggest\n丙 || 丁\n```']),
    inputActions,
    input,
  })
  controlsOf(rowsOf(tree)[0])[0].props.onClick()
  assert.deepEqual(calls, [['captureInsertion'], ['insertText', '丙', 7]], 'draft mode must not submit')
})

await check('DRAFT mode stays enabled while a draft exists', () => {
  selectMode('draft')
  const input = { draft: '已经写了些东西', attachmentIds: [], phase: 'plain', draftRev: 7 }
  const tree = renderRows(rowCell.component, {
    turn: 3,
    chat: chatWith(3, ['```suggest\n追加甲 || 追加乙\n```']),
    inputActions: guardedActions([]),
    input,
  })
  assert.equal(controlsOf(rowsOf(tree)[0])[0].props.disabled, false, 'inserting never destroys the draft')
})

await check('DRAFT mode refuses when a stale insert cannot be retried safely', () => {
  selectMode('draft')
  const calls = []
  const inputActions = guardedActions(calls, { insertResult: false })
  const input = { draft: '不能被覆盖', attachmentIds: [], phase: 'plain', draftRev: 7 }
  const tree = renderRows(rowCell.component, {
    turn: 3,
    chat: chatWith(3, ['```suggest\n拒绝甲 || 拒绝乙\n```']),
    inputActions,
    input,
  })
  controlsOf(rowsOf(tree)[0])[0].props.onClick()
  assert.deepEqual(calls, [['captureInsertion'], ['insertText', '拒绝甲', 7]], 'a failed insert must not fall back to setDraft over a live draft')
})

await check('DRAFT mode still fills an empty composer through setDraft on older builds', () => {
  selectMode('draft')
  const calls = []
  const inputActions = {
    setDraft: (text) => calls.push(['setDraft', text]),
    submit: () => calls.push(['submit']),
  }
  const tree = renderRows(rowCell.component, {
    turn: 3,
    chat: chatWith(3, ['```suggest\n旧甲 || 旧乙\n```']),
    inputActions,
  })
  controlsOf(rowsOf(tree)[0])[0].props.onClick()
  assert.deepEqual(calls, [['setDraft', '旧甲']])
})

await check('DRAFT mode annotates the row tooltip', () => {
  selectMode('draft')
  const tree = renderRows(rowCell.component, {
    turn: 3,
    chat: chatWith(3, ['<!--NEXT: 甲 -->']),
    inputActions: guardedActions([]),
  })
  assert.match(controlsOf(rowsOf(tree)[0])[0].props.title, /填入输入框/)
})

await check('an unusable composer explains itself instead of a bare label', () => {
  selectMode('draft')
  const tree = renderRows(rowCell.component, { turn: 3, chat: chatWith(3, ['<!--NEXT: 甲 -->']), inputActions: {} })
  assert.match(controlsOf(rowsOf(tree)[0])[0].props.title, /当前输入框不可编辑/)
})

// ------------------------------------------------------------ SMART mode

await check('SMART mode shows three controls per row', () => {
  selectMode('smart')
  const tree = renderRows(rowCell.component, {
    turn: 3,
    chat: chatWith(3, ['```suggest\n智能甲 || 智能乙\n```']),
    inputActions: guardedActions([]),
  })
  const rows = rowsOf(tree)
  assert.equal(rows.length, 2)
  for (const row of rows) {
    assert.equal(controlsOf(row).length, 3, 'label + send + insert')
    assert.equal(controlsOf(row)[0].children[0].length > 0, true, 'the label still carries the text')
  }
})

await check('SMART mode: clicking the text fills the composer', () => {
  selectMode('smart')
  const calls = []
  const input = { draft: '', attachmentIds: [], phase: 'plain', draftRev: 7 }
  const tree = renderRows(rowCell.component, {
    turn: 3,
    chat: chatWith(3, ['```suggest\n默认填入 || 另一条\n```']),
    inputActions: guardedActions(calls),
    input,
  })
  controlsOf(rowsOf(tree)[0])[0].props.onClick()
  assert.deepEqual(calls, [['captureInsertion'], ['insertText', '默认填入', 7]], 'the text must not send in smart mode')
})

await check('SMART mode: the send button sends', () => {
  selectMode('smart')
  const calls = []
  const input = { draft: '', attachmentIds: [], phase: 'plain', draftRev: 7 }
  const tree = renderRows(rowCell.component, {
    turn: 3,
    chat: chatWith(3, ['```suggest\n发送甲 || 发送乙\n```']),
    inputActions: guardedActions(calls),
    input,
  })
  controlsOf(rowsOf(tree)[0])[1].props.onClick()
  assert.deepEqual(calls, [['captureInsertion'], ['insertText', '发送甲', 7], ['submit']])
})

await check('SMART mode: the insert button fills without sending', () => {
  selectMode('smart')
  const calls = []
  const input = { draft: '', attachmentIds: [], phase: 'plain', draftRev: 7 }
  const tree = renderRows(rowCell.component, {
    turn: 3,
    chat: chatWith(3, ['```suggest\n插入甲 || 插入乙\n```']),
    inputActions: guardedActions(calls),
    input,
  })
  controlsOf(rowsOf(tree)[0])[2].props.onClick()
  assert.deepEqual(calls, [['captureInsertion'], ['insertText', '插入甲', 7]])
})

await check('SMART mode: with a draft, send is blocked but the text and insert still work', () => {
  selectMode('smart')
  const calls = []
  const input = { draft: '正在写的话', attachmentIds: [], phase: 'plain', draftRev: 7 }
  const tree = renderRows(rowCell.component, {
    turn: 3,
    chat: chatWith(3, ['```suggest\n保护甲 || 保护乙\n```']),
    inputActions: guardedActions(calls),
    input,
  })
  const [label, send, insert] = controlsOf(rowsOf(tree)[0])
  assert.equal(send.props.disabled, true, 'send must not clear a live draft')
  assert.equal(label.props.disabled, false)
  assert.equal(insert.props.disabled, false)
  assert.match(send.props.title, /已有草稿/)

  send.props.onClick()
  assert.deepEqual(calls, [], 'a blocked send button must do nothing')
  insert.props.onClick()
  assert.deepEqual(calls, [['captureInsertion'], ['insertText', '保护甲', 7]])
})

await check('SMART mode: the two icon buttons carry distinct accessible labels', () => {
  selectMode('smart')
  const tree = renderRows(rowCell.component, {
    turn: 3,
    chat: chatWith(3, ['```suggest\n标签甲 || 标签乙\n```']),
    inputActions: guardedActions([]),
  })
  const [, send, insert] = controlsOf(rowsOf(tree)[0])
  assert.match(send.props['aria-label'], /^直接发送/)
  assert.match(insert.props['aria-label'], /^填入输入框/)
  assert.notEqual(send.props['aria-label'], insert.props['aria-label'])
})

await check('SMART mode: the icon buttons draw an svg glyph', () => {
  selectMode('smart')
  const tree = renderRows(rowCell.component, {
    turn: 3,
    chat: chatWith(3, ['```suggest\n图标甲 || 图标乙\n```']),
    inputActions: guardedActions([]),
  })
  const [, send, insert] = controlsOf(rowsOf(tree)[0])
  // The stub does not expand function components, so each child is the Icon
  // element itself; render it to inspect the real svg.
  const sendIcon = send.children[0]
  const insertIcon = insert.children[0]
  assert.equal(typeof sendIcon.type, 'function', 'the button must render the Icon component')
  assert.equal(sendIcon.props.path, insertIcon.props.path === sendIcon.props.path ? 'same' : sendIcon.props.path)
  assert.notEqual(sendIcon.props.path, insertIcon.props.path, 'send and insert must not share one glyph')

  const svg = sendIcon.type(sendIcon.props)
  assert.equal(svg.type, 'svg')
  assert.equal(svg.props.width, '14')
  assert.equal(svg.props['aria-hidden'], 'true')
  assert.equal(svg.children[0].type, 'path')
  assert.equal(svg.children[0].props.d, sendIcon.props.path)
})

await check('SMART mode is the first, recommended settings option', () => {
  const tree = settingsCell.component({})
  const radios = tree.children.filter((child) => child && child.props && typeof child.props.onSelect === 'function')
  assert.equal(radios.length, 3)
  assert.match(radios[0].props.label, /智能/)
  assert.equal(radios[1].props.label, '直接发送')
  assert.equal(radios[2].props.label, '填入输入框，待我确认')
})

// ---------------------------------------------------- guards and robustness

await check('a repeated click on the same row and action fires once', () => {
  selectMode('send')
  const calls = []
  const inputActions = guardedActions(calls)
  const input = { draft: '', attachmentIds: [], phase: 'plain', draftRev: 7 }
  const tree = renderRows(rowCell.component, {
    turn: 3,
    chat: chatWith(3, ['```suggest\n戊 || 己\n```']),
    inputActions,
    input,
  })
  const label = controlsOf(rowsOf(tree)[0])[0]
  label.props.onClick()
  label.props.onClick()
  assert.deepEqual(calls, [['captureInsertion'], ['insertText', '戊', 7], ['submit']], 'a double click must not send twice')
})

await check('the cooldown is per action: text and insert share it, send does not', () => {
  selectMode('smart')
  const calls = []
  const input = { draft: '', attachmentIds: [], phase: 'plain', draftRev: 7 }
  const tree = renderRows(rowCell.component, {
    turn: 3,
    chat: chatWith(3, ['```suggest\n双动甲 || 双动乙\n```']),
    inputActions: guardedActions(calls),
    input,
  })
  const [label, send, insert] = controlsOf(rowsOf(tree)[0])
  label.props.onClick()
  // Same action, same target: the bubble must not insert a second copy.
  insert.props.onClick()
  assert.deepEqual(
    calls,
    [['captureInsertion'], ['insertText', '双动甲', 7]],
    'the label and the insert button are one action and must share the cooldown',
  )
  // A different action on the same row is not blocked.
  send.props.onClick()
  assert.deepEqual(calls, [
    ['captureInsertion'], ['insertText', '双动甲', 7],
    ['captureInsertion'], ['insertText', '双动甲', 7], ['submit'],
  ])
})

await check('a non-plain submit phase disables every control', () => {
  selectMode('smart')
  for (const phase of ['sending', 'adjudicating', 'claimed']) {
    const input = { draft: '', attachmentIds: [], phase, draftRev: 1 }
    const calls = []
    const tree = renderRows(rowCell.component, {
      turn: 3,
      chat: chatWith(3, ['```suggest\n相位甲 || 相位乙\n```']),
      inputActions: guardedActions(calls),
      input,
    })
    for (const control of controlsOf(rowsOf(tree)[0])) {
      assert.equal(control.props.disabled, true, `phase ${phase} must disable every control`)
      control.props.onClick()
    }
    assert.deepEqual(calls, [])
  }
})

await check('a running session disables every control', () => {
  selectMode('smart')
  const calls = []
  const tree = renderRows(rowCell.component, {
    turn: 3,
    chat: chatWith(3, ['<!--NEXT: 甲 || 乙 -->']),
    running: true,
    inputActions: {
      setDraft: (text) => calls.push(['setDraft', text]),
      submit: () => calls.push(['submit']),
    },
  })
  for (const control of controlsOf(rowsOf(tree)[0])) assert.equal(control.props.disabled, true)
  controlsOf(rowsOf(tree)[0])[0].props.onClick()
  assert.deepEqual(calls, [], 'a disabled row must not act')
})

await check('a successful send freezes the whole list', () => {
  selectMode('send')
  const input = { draft: '', attachmentIds: [], phase: 'plain', draftRev: 7 }
  const chat = chatWith(3, ['```suggest\n冻结甲 || 冻结乙\n```'])
  const tree = renderRows(rowCell.component, { turn: 3, chat, inputActions: guardedActions([]), input })
  controlsOf(rowsOf(tree)[0])[0].props.onClick()

  // Re-render the SAME component after the click: the hook slot now holds the
  // sent label, so the frozen branch must be what renders.
  const after = renderRows(rowCell.component, { turn: 3, chat, inputActions: guardedActions([]), input })
  const texts = textOfTree(after)
  assert.match(texts, /已发送：冻结甲/, 'the row must show what was sent')
  assert.equal(rowsOf(after).length, 1, 'the frozen state replaces the list with one line')
  // The frozen branch renders a plain span: no button survives to be clicked.
  const buttons = [];
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node.type === 'button') buttons.push(node)
    walk(node.children)
  };
  walk(after);
  assert.deepEqual(buttons, [], 'nothing is clickable once frozen')
})

await check('an insert does NOT freeze the list', () => {
  selectMode('smart')
  const input = { draft: '', attachmentIds: [], phase: 'plain', draftRev: 7 }
  const chat = chatWith(3, ['```suggest\n不冻甲 || 不冻乙\n```'])
  const tree = renderRows(rowCell.component, { turn: 3, chat, inputActions: guardedActions([]), input })
  controlsOf(rowsOf(tree)[0])[2].props.onClick() // the bubble
  const after = renderRows(rowCell.component, { turn: 3, chat, inputActions: guardedActions([]), input })
  assert.equal(rowsOf(after).length, 2, 'filling leaves the list usable')
  assert.doesNotMatch(textOfTree(after), /已发送/)
})

await check('a missing inputActions renders rows disabled instead of throwing', () => {
  const tree = renderRows(rowCell.component, { turn: 3, chat: chatWith(3, ['<!--NEXT: 甲 -->']), inputActions: undefined })
  const control = controlsOf(rowsOf(tree)[0])[0]
  assert.equal(control.props.disabled, true)
  control.props.onClick() // must not throw
})

await check('a malformed chat snapshot renders nothing instead of throwing', () => {
  for (const chat of [undefined, null, {}, { order: 'nope' }, { order: [], nodes: {} }]) {
    assert.equal(renderRows(rowCell.component, { turn: 1, chat, inputActions: {} }), null)
  }
})

await check('hover feedback works on both the label and the icon buttons', () => {
  selectMode('smart')
  const tree = renderRows(rowCell.component, {
    turn: 3,
    chat: chatWith(3, ['```suggest\n悬停甲 || 悬停乙\n```']),
    inputActions: guardedActions([]),
  })
  for (const control of controlsOf(rowsOf(tree)[0])) {
    const style = { background: 'transparent' }
    control.props.onMouseEnter({ currentTarget: { style } })
    assert.equal(style.background, 'var(--dsw-alias-bg-layer-1)')
    control.props.onMouseLeave({ currentTarget: { style } })
    assert.equal(style.background, 'transparent')
  }
})

await check('the settings page carries the miss list', () => {
  const tree = settingsCell.component({})
  const block = tree.children.at(-1)
  assert.equal(typeof block.type, 'function', 'the miss list must be the last settings block')
  const rendered = block.type({})
  assert.match(textOfTree(rendered), /暂无记录/, 'an empty ring must say so plainly')
})

await check('the settings page flip still reaches the Host route', () => {
  serverSide = { mode: 'send' }
  const tree = settingsCell.component({})
  const radios = tree.children.filter((child) => child && child.props && typeof child.props.onSelect === 'function')
  radios[0].props.onSelect()
  assert.deepEqual(serverSide, { mode: 'smart' })
})

await check('the client default matches the Host default', () => {
  // A fresh page with no readable preference must render smart mode, or the
  // settings page and the live row would disagree before the first fetch.
  react.reset()
  const saved = serverSide
  serverSide = { mode: 'send' }
  const tree = settingsCell.component({})
  const radios = tree.children.filter((child) => child && child.props && typeof child.props.onSelect === 'function')
  assert.equal(radios.length, 3)
  serverSide = saved
})

/** Every string in a rendered tree, joined — the stub keeps children nested. */
function textOfTree(node) {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOfTree).join('\n')
  if (node === null || typeof node !== 'object') return ''
  return textOfTree(node.children)
}

// ---------------------------------------------- the REAL assistant payload
// These fixtures use `data.blocks`, the shape the kernel's own projection
// actually builds (`projectAssistant`: `{status, turn, step, blocks, time}`).
// Every earlier fixture used `data.content`, which is the USER shape — so the
// suite was validating an assumption, not the kernel.

/** Build a chat snapshot whose assistant step carries `data.blocks`. */
function chatWithBlocks(turn, blocks) {
  const nodes = new Map()
  nodes.set(`a${turn}`, {
    kind: 'assistant-step',
    location: { turn },
    data: { status: 'settled', turn, step: 1, blocks, time: 0 },
  })
  return { order: [`a${turn}`], nodes }
}

await check('reads a marker out of the real data.blocks shape', () => {
  const chat = chatWithBlocks(3, [
    { kind: 'text', text: '好的，下面是三条。\n```suggest\n真甲 || 真乙 || 真丙\n```' },
  ])
  const tree = renderRows(rowCell.component, { turn: 3, chat, inputActions: {} })
  assert.deepEqual(labelsOf(tree), ['真甲', '真乙', '真丙'])
})

await check('a marker split across two text blocks still parses', () => {
  const chat = chatWithBlocks(3, [
    { kind: 'text', text: '前言 ```suggest\n块甲' },
    { kind: 'text', text: ' || 块乙\n``` 尾巴' },
  ])
  const tree = renderRows(rowCell.component, { turn: 3, chat, inputActions: {} })
  assert.deepEqual(labelsOf(tree), ['块甲', '块乙'])
})

await check('a reasoning block must NOT invent suggestions', () => {
  // The model thinking out loud about the format is not a suggestion.
  const chat = chatWithBlocks(3, [
    { kind: 'reasoning', text: '我应该在结尾放 ```suggest\n假甲 || 假乙\n``` 这样的块。' },
    { kind: 'text', text: '正文没有标记。' },
  ])
  assert.equal(
    renderRows(rowCell.component, { turn: 3, chat, inputActions: {} }),
    null,
    'a fence inside reasoning must not render',
  )
})

await check('reasoning does not split a real fence in the text block', () => {
  // If reasoning were joined between the two text halves, the fence would break.
  const chat = chatWithBlocks(3, [
    { kind: 'text', text: '开头 ```suggest\n甲' },
    { kind: 'reasoning', text: '（这里我在想别的事）' },
    { kind: 'text', text: ' || 乙\n``` 结尾' },
  ])
  const tree = renderRows(rowCell.component, { turn: 3, chat, inputActions: {} })
  assert.deepEqual(labelsOf(tree), ['甲', '乙'])
})

await check('a tool-call block is ignored, not read as prose', () => {
  const chat = chatWithBlocks(3, [
    { kind: 'tool-call', text: '```suggest\n工具假 || 工具假2\n```', callId: 'c1', name: 'bash' },
    { kind: 'text', text: '真正的结尾：\n```suggest\n工甲 || 工乙\n```' },
  ])
  const tree = renderRows(rowCell.component, { turn: 3, chat, inputActions: {} })
  assert.deepEqual(labelsOf(tree), ['工甲', '工乙'])
})

await check('a settled assistant step with only reasoning shows nothing', () => {
  const chat = chatWithBlocks(3, [{ kind: 'reasoning', text: '只有思考，没有回答。' }])
  assert.equal(renderRows(rowCell.component, { turn: 3, chat, inputActions: {} }), null)
})

await check('a user-message content[] payload still works', () => {
  // Backwards compatibility: the reader must not regress the old shape.
  const chat = chatWith(3, ['```suggest\n旧形甲 || 旧形乙\n```'])
  const tree = renderRows(rowCell.component, { turn: 3, chat, inputActions: {} })
  assert.deepEqual(labelsOf(tree), ['旧形甲', '旧形乙'])
})

await check('a tool-call-only step renders nothing and reports no-answer prose', () => {
  // 53 of 162 real assistant messages are pure tool-call steps with no prose.
  // They must stay silent rather than error or invent a row.
  const chat = chatWithBlocks(3, [
    { kind: 'tool-call', text: '', callId: 'c1', name: 'bash' },
    { kind: 'reasoning', text: '先跑一下看看。' },
  ])
  assert.equal(renderRows(rowCell.component, { turn: 3, chat, inputActions: {} }), null)
})

// ------------------------------------------- fenced format and Turn coercion

await check('registers a hidden layer for the suggest fence', () => {
  assert.ok(fenceCell, 'the fence cell was not registered')
  assert.equal(fenceCell.definition.key, 'suggest')
  assert.equal(fenceCell.component({}), null, 'the layer must swallow the block')
})

await check('parses a `suggest` fenced block', () => {
  const chat = chatWith(3, ['好的。\n```suggest\n按方案 A 继续 || 先看数据再定 || 换成英文标题\n```\n'])
  const tree = renderRows(rowCell.component, { turn: 3, chat, inputActions: {} })
  assert.deepEqual(labelsOf(tree), ['按方案 A 继续', '先看数据再定', '换成英文标题'])
})

await check('tolerates one option per line inside the fence', () => {
  const chat = chatWith(3, ['```suggest\n- 甲\n- 乙\n- 丙\n```'])
  const tree = renderRows(rowCell.component, { turn: 3, chat, inputActions: {} })
  assert.deepEqual(labelsOf(tree), ['甲', '乙', '丙'])
})

await check('still parses the legacy HTML comment', () => {
  const chat = chatWith(3, ['正文 <!--NEXT: 甲 || 乙 --> 尾巴'])
  const tree = renderRows(rowCell.component, { turn: 3, chat, inputActions: {} })
  assert.deepEqual(labelsOf(tree), ['甲', '乙'])
})

await check('a TurnLocation-shaped turn prop still matches', () => {
  const chat = chatWith(3, ['```suggest\n甲 || 乙\n```'])
  for (const turn of [3, { turn: 3 }, { kind: 'turn', turn: 3 }, { turn: { turn: 3 } }]) {
    const tree = renderRows(rowCell.component, { turn, chat, inputActions: {} })
    assert.ok(tree !== null, `rows missing for turn prop ${JSON.stringify(turn)}`)
    assert.deepEqual(labelsOf(tree), ['甲', '乙'])
  }
})

await check('unresolvable turn falls back to the closing answer only', () => {
  const nodes = new Map()
  nodes.set('old', { kind: 'assistant-step', location: { turn: 3 }, data: { content: [{ type: 'text', text: '```suggest\n旧 || 旧2\n```' }] } })
  nodes.set('later', { kind: 'user', location: { turn: 4 } })
  nodes.set('tail', { kind: 'turn-tail', location: { turn: 4 } })
  const older = { order: ['old', 'later', 'tail'], nodes }
  assert.equal(
    renderRows(rowCell.component, { turn: undefined, chat: older, inputActions: {} }),
    null,
    'a non-closing answer must not show rows',
  )

  const fresh = new Map()
  fresh.set('ans', { kind: 'assistant-step', location: { turn: 9 }, data: { content: [{ type: 'text', text: '```suggest\n新 || 新2\n```' }] } })
  fresh.set('tail', { kind: 'turn-tail', location: { turn: 9 } })
  const tree = renderRows(rowCell.component, { turn: undefined, chat: { order: ['ans', 'tail'], nodes: fresh }, inputActions: {} })
  assert.deepEqual(labelsOf(tree), ['新', '新2'])
})

await check('a session snapshot supplies chat when useChat is absent', () => {
  const chat = chatWith(3, ['```suggest\n甲 || 乙\n```'])
  const tree = rowCell.component({
    turn: 3,
    useChat: undefined,
    useSession: (select) => select({ running: false, chat }),
    inputActions: {},
  })
  assert.deepEqual(labelsOf(tree), ['甲', '乙'])
})

// ------------------------------------------------- parser hardening (adopted
// from the two reference plugins: normalise, de-dupe, cap, salvage)

/** Parse one fenced body through the real component. */
function labelsFromBody(body) {
  const chat = chatWith(3, [`\`\`\`suggest\n${body}\n\`\`\``])
  const tree = renderRows(rowCell.component, { turn: 3, chat, inputActions: {} })
  return tree === null ? null : labelsOf(tree)
}

await check('salvages a JSON array instead of the delimiter convention', () => {
  assert.deepEqual(labelsFromBody('["按方案 A 继续", "先看数据", "换英文标题"]'), ['按方案 A 继续', '先看数据', '换英文标题'])
})

await check('peels wrapping quotes and list markers', () => {
  assert.deepEqual(labelsFromBody('「按方案 A 继续」\n- “先看数据”\n1. 『换英文标题』'), ['按方案 A 继续', '先看数据', '换英文标题'])
})

await check('collapses internal whitespace inside one option', () => {
  assert.deepEqual(labelsFromBody('按方案   A   继续 ||  先看数据 '), ['按方案 A 继续', '先看数据'])
})

await check('de-duplicates case-insensitively', () => {
  assert.deepEqual(labelsFromBody('Run tests || run tests || RUN TESTS'), ['Run tests'])
})

await check('keeps a long suggestion that the pill layout used to cut', () => {
  const sentence = '把这一轮的三条建议全部改成竖排显示，并且允许每条写到四十个汉字左右'
  assert.deepEqual(labelsFromBody(sentence), [sentence])
  assert.ok(sentence.length > 24, 'the fixture must exceed the old 24-character guidance')
})

await check('caps a runaway suggestion at 160 characters', () => {
  const long = '很长的一条建议'.repeat(40)
  const [only] = labelsFromBody(long)
  assert.equal(only.length, 160)
})

await check('rows carry an accessible label', () => {
  const chat = chatWith(3, ['```suggest\n甲 || 乙\n```'])
  const tree = renderRows(rowCell.component, { turn: 3, chat, inputActions: {} })
  assert.equal(controlsOf(rowsOf(tree)[0])[0].props['aria-label'], '第 1 个下一步建议：甲')
})

// Nothing real was touched: the suite only ever owned the scratch paths.
serverSide = { mode: 'smart' }
rmSync(CONFIG_FILE, { force: true })
rmSync(LEGACY_FILE, { force: true })

console.log(`\n${passed} checks passed.`)
