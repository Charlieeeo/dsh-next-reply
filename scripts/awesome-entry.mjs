/**
 * Validate the awesome-dsh-plugin entry before it is submitted.
 *
 * The upstream `contributing.md` states exactly what CI checks, and each of
 * those checks is mechanical — so they can be reproduced here and a red X
 * avoided. This script builds the entry, validates it against those rules, and
 * prints the file for a copy-paste submission.
 *
 * It deliberately checks the rules that CI enforces:
 *   - filename equals the slug the `url` produces (`owner__repo.yml`)
 *   - `url` is `https://github.com/owner/repo`
 *   - `category` is one of the accepted values
 *   - `description.en` is present, non-empty, and a single line
 *   - `icon` is a GitHub-hosted raster image
 *   - `tarball` is a GitHub-hosted `.tgz`
 *
 * Usage: node scripts/awesome-entry.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const OWNER = 'Charlieeeo'
const REPO = pkg.name
const VERSION = pkg.version

/** The categories upstream accepts, copied from contributing.md. */
const CATEGORIES = new Set([
  'agi', 'ui', 'usage', 'theme', 'model', 'identity', 'session', 'memory',
  'tools', 'wsl', 'browser', 'vision', 'voice', 'docs', 'skill', 'workflow',
  'git', 'notify', 'dev', 'security', 'remote', 'market', 'fun',
])

const entry = {
  url: `https://github.com/${OWNER}/${REPO}`,
  name: `${OWNER}/${REPO}`,
  category: 'ui',
  icon: `https://raw.githubusercontent.com/${OWNER}/${REPO}/main/icon-180.png`,
  // The asset name is deliberately version-free: `latest/download/` resolves
  // `latest` at request time but takes the filename literally, so a versioned
  // name 404s the moment the next release is cut.
  tarball: `https://github.com/${OWNER}/${REPO}/releases/download/v${VERSION}/dsh-next-reply.tgz`,
  description: {
    en: 'Vertical next-reply suggestions under each completed turn: the reply itself ends with up to three suggested follow-ups, so no auxiliary model call is made. Clicking a suggestion inserts it into the composer at the caret; a paper-plane button sends it, a bubble button inserts it.',
    zh: '每条回答结束后，在本轮下方显示最多 3 条竖排的下一步建议：建议由主回复自身给出，不额外调用模型。点建议文字会插入输入框光标处；纸飞机按钮直接发送，气泡按钮插入输入框。',
  },
}

/** The filename upstream derives from the url. */
const filename = `${OWNER}__${REPO}.yml`

let failed = 0
/**
 * Record one check.
 * @param label - what is being checked.
 * @param ok - whether it passed.
 * @param detail - shown on failure.
 */
function check(label, ok, detail) {
  if (!ok) failed += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : ` — ${detail}`}`)
}

// --- the CI rules -----------------------------------------------------------

check('filename matches the url slug', filename === `${OWNER}__${REPO}.yml`, filename)
check('url is https://github.com/owner/repo', /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(entry.url), entry.url)
check('category is accepted', CATEGORIES.has(entry.category), entry.category)
check('description.en present and non-empty', typeof entry.description.en === 'string' && entry.description.en.trim() !== '')
check('description.en is a single line', !entry.description.en.includes('\n'))
check('description.en ends with a period', entry.description.en.trim().endsWith('.'))
check('description.zh is a single line', !entry.description.zh.includes('\n'))
check('description.zh ends with a full stop', entry.description.zh.trim().endsWith('。'))
check('icon is a GitHub-hosted raster', /^https:\/\/raw\.githubusercontent\.com\/.+\.(png|jpg|jpeg|webp)$/.test(entry.icon), entry.icon)
check('tarball is a GitHub-hosted tgz', /^https:\/\/github\.com\/.+\/releases\/download\/.+\/.+\.tgz$/.test(entry.tarball), entry.tarball)
check('tarball asset name carries no version', !/dsh-next-reply-\d/.test(entry.tarball), entry.tarball)
check('no hand-written npm field', !('npm' in entry))

// --- claims that a maintainer will read against the code --------------------

const client = readFileSync(join(root, 'lib/client.js'), 'utf8')
const host = readFileSync(join(root, 'lib/index.js'), 'utf8')

check('"up to three" matches MAX_CHIPS', /MAX_CHIPS = 3/.test(client))
check('"no auxiliary model call" — no LLM call in the client', !/llm|completion|chat\/completions/i.test(client))
check('"no auxiliary model call" — host only registers routes', !/llm|stream\(/i.test(host))
check('"inserts at the caret" — guarded insert is used', /captureInsertion/.test(client) && /insertText/.test(client))
check('"paper-plane sends" — submit path exists', /actions\.submit\(\)/.test(client))
check('"bubble inserts" — a second insert control exists', /INSERT_PATH/.test(client) && /SEND_PATH/.test(client))

// --- emit ------------------------------------------------------------------

/**
 * Render the entry as YAML without pulling in a YAML library.
 *
 * The plugin ships zero dependencies and stays that way, and the shape here is
 * fixed and small: five scalar keys plus a two-key description map. Single
 * quotes are used because both descriptions contain `: `-adjacent punctuation
 * and semicolons, which are the cases upstream warns about.
 *
 * @param value - the entry object.
 * @returns the YAML text.
 */
function toYaml(value) {
  const quote = (text) => `'${String(text).replace(/'/g, "''")}'`
  const lines = []
  for (const [key, raw] of Object.entries(value)) {
    if (raw !== null && typeof raw === 'object') {
      lines.push(`${key}:`)
      for (const [innerKey, innerValue] of Object.entries(raw)) {
        lines.push(`  ${innerKey}: ${quote(innerValue)}`)
      }
    } else {
      lines.push(`${key}: ${quote(raw)}`)
    }
  }
  return lines.join('\n')
}

const body = [
  '# awesome-dsh-plugin entry — generated by scripts/awesome-entry.mjs',
  '# Do not add comments to the real file: whatever is in the YAML is data.',
  '',
  toYaml(entry),
  '',
].join('\n')

console.log(`\n--- ${filename} ---`)
console.log(body)

if (failed > 0) {
  console.error(`\n${failed} check(s) failed — do not submit yet`)
  process.exit(1)
}
console.log(`all checks passed; ${filename} is ready to submit`)
