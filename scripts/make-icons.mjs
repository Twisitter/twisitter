// Renders src/icons/icon.svg to the PNG sizes the manifest names, in headless
// Chromium (no image dependencies). The 128 icon keeps 16px of transparent
// padding around 96px of artwork, as the Chrome Web Store asks; the smaller
// sizes fill their square.
import { chromium } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'icons')
const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8')
const PADDED = new Set([128])
const browser = await chromium.launch({ channel: 'chromium' })
for (const size of [16, 24, 32, 48, 96, 128]) {
    // a fresh page per size: resizing one page between shots left tiled strips in the larger ones
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 })
    const sized = svg
        .replace('<svg ', `<svg width="${size}" height="${size}" `)
        .replace('viewBox="0 0 96 96"', PADDED.has(size) ? 'viewBox="-16 -16 128 128"' : 'viewBox="0 0 96 96"')
    await page.setContent(`<html><body style="margin:0;background:transparent">${sized}</body></html>`)
    await page.screenshot({ path: path.join(dir, `${size}.png`), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } })
    await page.close()
}
await browser.close()
console.log('icons written to', dir)
