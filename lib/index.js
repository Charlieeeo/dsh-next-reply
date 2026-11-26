/**
 * dsh-next-reply — Host half.
 *
 * Three jobs, all deliberately small:
 *
 *  1. Register one system-prompt section: the instruction that makes the model
 *     close every reply with a `suggest` code block carrying up to three likely
 *     next user replies. The browser half parses that block and hides it.
 *  2. Own the one preference — whether a clicked chip sends immediately or only
 *     fills the composer — and persist it under the DSH home so it survives
 *     restarts and Web-GUI port changes. The browser half reads and writes it
 *     through two tiny routes under `/plugins/dsh-next-reply/`.
 *  3. Keep a bounded in-memory ring of "why no chips appeared" reports so the
 *     settings page can answer the one support question this plugin class always
 *     gets, without asking the user to open a console.
 *
 * Why a JSON file instead of a plugin Config schema: a Config needs
 * `@deepseek-ai/schemastery`, and a `link:`-installed package resolves its bare
 * imports from its own directory, not the profile's node_modules. Builtins only
 * here, so the package stays installable from any path.
 *
 * The preference is owned by the Host (not `localStorage`) because the Web GUI
 * origin carries a port that can change between launches, which would silently
 * reset a browser-scoped value.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const inject = ['systemPrompt']

/**
 * `order: 118` places this section just after the AgentTeams usage section
 * (117), keeping related runtime guidance together near the end of the
 * assembled prompt without displacing the shipped sections.
 */
const SECTION_ORDER = 118

const SECTION_NAME = 'next-reply:format'

const ROUTE_PREFIX = '/plugins/dsh-next-reply'

/**
 * Where the preferences live. Deliberately the DSH home and never the installed
 * package: `dsh plugin add github:...` puts the package under `node_modules`,
 * where a write may be refused and an upgrade discards the file.
 * `DSH_NR_CONFIG_FILE` lets the test suite run against a scratch path instead
 * of the user's real preference.
 */
const CONFIG_DIR = join(homedir(), '.dsh')
const CONFIG_FILE = process.env.DSH_NR_CONFIG_FILE ?? join(CONFIG_DIR, 'next-reply.json')

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Older builds stored the preference somewhere else. Read them in order so an
 * upgrade never resets a choice the user already made:
 *
 *  - `~/.dsh/next-reply-chips.json` — 0.6.x, before the rename.
 *  - `<package>/config.json` — 0.5 and older wrote beside the package, which an
 *    upgrade over `node_modules` may discard.
 *
 * `DSH_NR_LEGACY_CONFIG_FILES` pins the list for the test suite.
 */
const LEGACY_CONFIG_FILES = (() => {
  const pinned = process.env.DSH_NR_LEGACY_CONFIG_FILES
  if (pinned !== undefined && pinned !== '') return pinned.split(delimiter).filter(Boolean)
  return [
    join(CONFIG_DIR, 'next-reply-chips.json'),
    join(PACKAGE_ROOT, 'config.json'),
  ]
})()

/** Cap on a config request body; the payload is a single boolean. */
const MAX_BODY_BYTES = 8 * 1024

const DEFAULT_CONFIG = { directSend: true }

/** How many "no chips" reports the settings page can see at once. */
const DIAG_LIMIT = 8

/**
 * Bounded, newest-last, in memory only. Nothing here is written to disk: the
 * reports are diagnostic and disposable, and a plugin that advertises "one file
 * on disk" should not grow a second one behind the user's back.
 */
const diagRing = []

const SECTION_TEXT = `【每轮结尾的下一步选项】
在每次回答的最后，追加且仅追加一个 suggest 代码块，列出用户接下来最可能发来的 3 句短话：

\`\`\`suggest
选项一 || 选项二 || 选项三
\`\`\`

要求：
1. 恰好 3 项，用 " || " 分隔，每项不超过 24 个汉字。
2. 用用户第一人称口吻，写成可以直接发给我的一句话指令或确认，例如「按方案 A 继续」「先看数据再定」「换成英文标题」。
3. 必须扣住本轮真正悬而未决的决策点；不要客套、不要复述已回答的内容、不要出现「还有什么可以帮您」这类空话。
4. 每项内部不得出现 "||"、换行、反引号或 Markdown 标记。
5. 这个代码块会被界面直接渲染成按钮，用户看不到源码；不要在正文里解释、复述或提及它。
6. 若本轮确实没有合理的下一步，可以只给 1-2 项。`

/**
 * Read one preference file, or undefined when it holds nothing authoritative.
 * @param {string} path - the file to read.
 * @returns {Promise<{ directSend: boolean } | undefined>} the parsed value.
 */
async function readOne(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.directSend === 'boolean') {
      return { directSend: parsed.directSend }
    }
  } catch {
    // Missing or unreadable: no opinion from this file.
  }
  return undefined
}

/**
 * Read the persisted preference, tolerating a missing or corrupt file and
 * migrating a value written by an older build under the old name.
 * @returns {Promise<{ directSend: boolean }>} the current preference.
 */
async function readConfig() {
  const current = await readOne(CONFIG_FILE)
  if (current !== undefined) return { ...DEFAULT_CONFIG, ...current }
  for (const path of LEGACY_CONFIG_FILES) {
    const legacy = await readOne(path)
    if (legacy !== undefined) return { ...DEFAULT_CONFIG, ...legacy }
  }
  return { ...DEFAULT_CONFIG }
}

/**
 * Persist the preference.
 * @param {{ directSend: boolean }} next - the complete preference to store.
 */
async function writeConfig(next) {
  await mkdir(dirname(CONFIG_FILE), { recursive: true })
  await writeFile(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
}

/**
 * Collect a small JSON request body.
 * @param req - the Node request.
 * @returns {Promise<unknown>} the parsed body.
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? {} : JSON.parse(text)
}

/**
 * Answer with a JSON body, never cached.
 * @param res - the Node response.
 * @param status - HTTP status.
 * @param value - JSON-serializable payload.
 */
function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(value))
}

/**
 * Append one "no chips" report, dropping the oldest past the bound.
 * @param {{ reason: unknown, turn: unknown }} body - the client's report.
 */
function recordDiag(body) {
  const reason = typeof body.reason === 'string' ? body.reason.slice(0, 32) : 'unknown'
  const turn = Number.isSafeInteger(body.turn) && body.turn >= 1 ? body.turn : undefined
  diagRing.push({ at: new Date().toISOString(), reason, turn })
  while (diagRing.length > DIAG_LIMIT) diagRing.shift()
}

/**
 * Mount the preference and diagnostic routes once a web server is available.
 * @param ctx - Host Cordis context.
 */
function mountRoutes(ctx) {
  const mount = (server) => {
    if (server === undefined || typeof server.register !== 'function') return
    /** Refuse cross-peer calls, and answer 401 when the Connection gate says so. */
    const allowed = (req, res) => {
      const gate = ctx.get('connection')
      if (gate !== undefined && typeof gate.requestRejection === 'function') {
        const rejection = gate.requestRejection(req)
        if (rejection !== undefined) {
          sendJson(res, rejection, { error: 'unauthorized' })
          return false
        }
      }
      return true
    }

    ctx.effect(
      () =>
        server.register({
          kind: 'exact',
          path: `${ROUTE_PREFIX}/config`,
          handler: async (req, res) => {
            if (!allowed(req, res)) return
            if (req.method === 'GET' || req.method === 'HEAD') {
              sendJson(res, 200, await readConfig())
              return
            }
            if (req.method !== 'POST') {
              res.writeHead(405, { allow: 'GET, HEAD, POST', 'cache-control': 'no-store' })
              res.end()
              return
            }
            let body
            try {
              body = await readJsonBody(req)
            } catch {
              sendJson(res, 400, { error: 'invalid body' })
              return
            }
            if (body === null || typeof body !== 'object') {
              sendJson(res, 400, { error: 'invalid body' })
              return
            }
            // A partial update is merged onto what is stored, so a stale client
            // cannot silently flip the switch back.
            if (typeof body.directSend !== 'boolean') {
              sendJson(res, 400, { error: 'directSend must be a boolean' })
              return
            }
            const next = { directSend: body.directSend }
            try {
              await writeConfig(next)
            } catch (error) {
              ctx.logger?.warn?.('next-reply: could not persist preference: %s', String(error))
              sendJson(res, 500, { error: 'could not persist preference' })
              return
            }
            sendJson(res, 200, next)
          },
        }),
      'next-reply: config route',
    )

    ctx.effect(
      () =>
        server.register({
          kind: 'exact',
          path: `${ROUTE_PREFIX}/diag`,
          handler: async (req, res) => {
            if (!allowed(req, res)) return
            if (req.method === 'GET' || req.method === 'HEAD') {
              sendJson(res, 200, { entries: diagRing.slice() })
              return
            }
            if (req.method !== 'POST') {
              res.writeHead(405, { allow: 'GET, HEAD, POST', 'cache-control': 'no-store' })
              res.end()
              return
            }
            let body
            try {
              body = await readJsonBody(req)
            } catch {
              sendJson(res, 400, { error: 'invalid body' })
              return
            }
            if (body === null || typeof body !== 'object') {
              sendJson(res, 400, { error: 'invalid body' })
              return
            }
            recordDiag(body)
            sendJson(res, 200, { entries: diagRing.slice() })
          },
        }),
      'next-reply: diagnostic route',
    )
  }

  const immediate = ctx.get('webServer')
  if (immediate !== undefined) {
    mount(immediate)
    return
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (sub) => mount(sub.webServer))
  }
}

/**
 * Mount the marker instruction and the preference routes.
 * @param ctx - Host Cordis context.
 */
export function apply(ctx) {
  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    // Delegated agents answer into a parent's tool result, where nobody renders a
    // chip row; giving them the marker would only add tokens and plant stray
    // blocks in output the parent consumes. The probe is read per call and fails
    // open, so a missing or changed service never suppresses a real turn.
    text: ({ agent }) => {
      if (agent === undefined) return SECTION_TEXT
      try {
        const subagents = ctx.get('subagents')
        if (subagents !== undefined && typeof subagents.rootOf === 'function') {
          if (subagents.rootOf(agent) !== agent) return ''
        }
      } catch {
        // Keep the instruction rather than risk silently disabling the feature.
      }
      return SECTION_TEXT
    },
  })
  mountRoutes(ctx)
}
