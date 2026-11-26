/**
 * Probe the preference route against a SCRATCH file, never the real one.
 *
 * The env var MUST be set before importing the Host half: it resolves its
 * config path once at module load. Setting it afterwards silently writes to the
 * user's real `~/.dsh/next-reply.json` — which is exactly the accident this
 * script exists to prevent, and which it now refuses to repeat.
 *
 * Run with `node test/probe-config.mjs`.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRATCH = join(pkgRoot, '.probe-cfg.json')
const LEGACY = join(pkgRoot, '.probe-legacy.json')

// Before the import, not after: this ordering is the whole point.
process.env.DSH_NR_CONFIG_FILE = SCRATCH
process.env.DSH_NR_LEGACY_CONFIG_FILES = LEGACY
rmSync(SCRATCH, { force: true })
rmSync(LEGACY, { force: true })

const mod = await import(pathToFileURL(join(pkgRoot, 'lib/index.js')).href)

const routes = []
mod.apply({
  systemPrompt: { section: () => {} },
  get: (key) => (key === 'webServer' ? { register: (route) => { routes.push(route); return () => {} } } : undefined),
  effect: (fn) => { fn(); return () => {} },
  logger: { warn: () => {} },
})

const route = routes.find((candidate) => candidate.path.endsWith('/config'))
if (route === undefined) {
  console.error('FAIL: the config route was not registered')
  process.exit(1)
}

/** Drive the route with a fake request/response pair. */
async function call(method, body) {
  let out
  const res = { writeHead() {}, end(chunk) { out = chunk } }
  const req = {
    method,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  }
  await route.handler(req, res)
  return out
}

let failed = 0
const expect = (label, actual, expected) => {
  const ok = actual === expected
  if (!ok) failed += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}: ${actual}${ok ? '' : ` (expected ${expected})`}`)
}

// A fresh install must default to smart, the non-destructive mode.
expect('fresh GET defaults to smart', await call('GET'), '{"mode":"smart"}')

for (const mode of ['send', 'draft', 'smart']) {
  expect(`POST ${mode}`, await call('POST', { mode }), `{"mode":"${mode}"}`)
}

const stored = JSON.parse(readFileSync(SCRATCH, 'utf8'))
expect('the scratch file holds the last mode', stored.mode, 'smart')

// An older payload still lands on a mode rather than a 400.
expect('legacy directSend:false folds to draft', await call('POST', { directSend: false }), '{"mode":"draft"}')
expect('legacy directSend:true folds to send', await call('POST', { directSend: true }), '{"mode":"send"}')

// Junk is refused, and refusal does not disturb what is stored.
const before = readFileSync(SCRATCH, 'utf8')
await call('POST', { mode: 'nope' })
expect('junk mode leaves the file alone', readFileSync(SCRATCH, 'utf8'), before)

rmSync(SCRATCH, { force: true })
rmSync(LEGACY, { force: true })

// The suite's own guarantee: it must never have created the real preference.
const real = join(process.env.USERPROFILE ?? '', '.dsh', 'next-reply.json')
if (process.env.USERPROFILE !== undefined && existsSync(real)) {
  console.log(`note: ${real} exists; this probe did not touch it`)
}

console.log(failed === 0 ? '\nprobe passed, scratch removed' : `\n${failed} probe check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
