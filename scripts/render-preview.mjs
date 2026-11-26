/**
 * Render the preview PNGs from assets/preview-template.html.
 *
 * Why a script instead of a checked-in screenshot: the drawing has to stay in
 * step with the component, so its styles are read from lib/client.js and
 * injected into the template before rendering. A hand-made picture would keep
 * showing the old pill row after the next layout change — which is exactly what
 * happened to the 0.6.1 previews.
 *
 * Usage: node scripts/render-preview.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const template = readFileSync(join(root, 'assets/preview-template.html'), 'utf8')
const client = readFileSync(join(root, 'lib/client.js'), 'utf8')

/**
 * Load playwright from wherever it lives.
 *
 * The plugin itself has zero dependencies and must stay that way, so playwright
 * is not a package dependency: this is a development-only script. Resolving it
 * from the global npm root keeps `npm install` out of the plugin's own tree.
 *
 * @returns the chromium launcher.
 */
async function loadChromium() {
  try {
    return (await import('playwright')).chromium
  } catch {
    // Fall through to the global install.
  }
  const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim()
  const entry = pathToFileURL(join(globalRoot, 'playwright', 'index.mjs')).href
  return (await import(entry)).chromium
}

/**
 * Pull one numeric/string style value out of the shipped component.
 *
 * Each read is anchored on a nearby unique marker rather than a bare pattern,
 * because `fontSize: "13px"` and `padding: "6px 10px"` each appear once but
 * `borderRadius` appears in both the label and the icon style — an unanchored
 * regex silently reads the wrong one.
 *
 * @param pattern - a regex with the value in group 1.
 * @param label - what is being checked, for the failure message.
 * @returns the value.
 */
function shipped(pattern, label) {
  const match = pattern.exec(client)
  if (match === null) {
    throw new Error(`could not read ${label} from lib/client.js — the template would drift`)
  }
  return match[1]
}

/** The `labelStyle` body, so label-only values cannot be read from the icon. */
const labelStyleBody = (() => {
  const at = client.indexOf('function labelStyle')
  if (at === -1) throw new Error('labelStyle() is missing from lib/client.js')
  return client.slice(at, client.indexOf('\n\t\t}', at))
})()

/** The `iconStyle` body. */
const iconStyleBody = (() => {
  const at = client.indexOf('function iconStyle')
  if (at === -1) throw new Error('iconStyle() is missing from lib/client.js')
  return client.slice(at, client.indexOf('\n\t\t}', at))
})()

/**
 * Read one value from a specific style body.
 * @param body - the style function's source.
 * @param pattern - a regex with the value in group 1.
 * @param label - what is being read.
 * @returns the value.
 */
function fromBody(body, pattern, label) {
  const match = pattern.exec(body)
  if (match === null) throw new Error(`could not read ${label} from its own style body`)
  return match[1]
}

// The numbers that decide the drawing's shape, each read from the right place.
const facts = {
  labelFontSize: fromBody(labelStyleBody, /fontSize: "(\d+px)"/, 'label font size'),
  labelPadding: fromBody(labelStyleBody, /padding: "(\d+px \d+px)"/, 'label padding'),
  labelRadius: fromBody(labelStyleBody, /borderRadius: "(\d+px)"/, 'label radius'),
  // The list container: `display: "flex", flexDirection: "column", gap: "6px"`.
  listGap: shipped(/flexDirection: "column", gap: "(\d+px)", margin: "10px 0 4px"/, 'list gap'),
  // The row itself: `display: "flex", alignItems: "stretch", gap: "6px"`.
  rowGap: shipped(/alignItems: "stretch", gap: "(\d+px)"/, 'row gap'),
  iconWidth: fromBody(iconStyleBody, /width: "(\d+px)"/, 'icon width'),
  iconMinHeight: fromBody(iconStyleBody, /minHeight: "(\d+px)"/, 'icon min height'),
  maxChars: shipped(/MAX_CHIP_CHARS = (\d+)/, 'character cap'),
  maxChips: shipped(/MAX_CHIPS = (\d+)/, 'suggestion cap'),
}
console.log('read from lib/client.js:', facts)

if (facts.maxChips !== '3') {
  throw new Error(`the drawing shows 3 rows but MAX_CHIPS is ${facts.maxChips}`)
}
if (facts.labelFontSize !== '13px') {
  throw new Error(`the template draws 13px text but the component uses ${facts.labelFontSize}`)
}
if (facts.listGap !== '6px' || facts.rowGap !== '6px') {
  throw new Error(`the template draws 6px gaps but the component uses list=${facts.listGap} row=${facts.rowGap}`)
}
if (facts.iconWidth !== '32px' || facts.iconMinHeight !== '34px') {
  throw new Error(`the template draws a 32x34 icon but the component uses ${facts.iconWidth} x ${facts.iconMinHeight}`)
}
if (facts.labelRadius !== '10px') {
  throw new Error(`the template draws a 10px radius but the component uses ${facts.labelRadius}`)
}

mkdirSync(join(root, 'assets'), { recursive: true })

const chromium = await loadChromium()
const browser = await chromium.launch({
  // Prefer the bundled Chromium; fall back to the system Edge on this machine.
  ...(process.env.PLAYWRIGHT_BROWSER_PATH === undefined
    ? {}
    : { executablePath: process.env.PLAYWRIGHT_BROWSER_PATH }),
})

try {
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 560 },
      deviceScaleFactor: 2,
    })
    await page.setContent(template, { waitUntil: 'load' })
    if (theme === 'dark') {
      await page.evaluate(() => document.documentElement.classList.add('dark'))
    }
    await page.waitForTimeout(120)

    const out = join(root, `preview-${theme}.png`)
    await page.screenshot({ path: out, omitBackground: false })
    const size = readFileSync(out).length
    console.log(`wrote ${theme}: ${out} (${(size / 1024).toFixed(1)} KiB)`)

    // The template is a drawing, not a page: it must fit exactly.
    const overflow = await page.evaluate(() => ({
      scrollH: document.documentElement.scrollHeight,
      clientH: document.documentElement.clientHeight,
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
    }))
    if (overflow.scrollH > overflow.clientH || overflow.scrollW > overflow.clientW) {
      throw new Error(`${theme} overflows the 1200x560 canvas: ${JSON.stringify(overflow)}`)
    }
    await page.close()
  }
} finally {
  await browser.close()
}

// screenshots.json tells storefronts which images to show, in order.
const screenshots = ['preview-light.png', 'preview-dark.png']
writeFileSync(
  join(root, 'screenshots.json'),
  `${JSON.stringify(screenshots, null, 2)}\n`,
  'utf8',
)
console.log('wrote screenshots.json:', screenshots.join(', '))
