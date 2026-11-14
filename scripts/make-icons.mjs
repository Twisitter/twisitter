// Renders src/icons/icon.svg to the PNG sizes the manifest names, in headless
// Chromium (no image dependencies).
import { chromium } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'icons')
const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8')
const browser = await chromium.launch({ channel: 'chromium' })
const page = await browser.newPage()
for (const size of [16, 24, 32, 48, 128]) {
    await page.setViewportSize({ width: size, height: size })
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`)
    await page.screenshot({ path: path.join(dir, `${size}.png`), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } })
}
await browser.close()
console.log('icons written to', dir)
