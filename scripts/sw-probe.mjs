// Step one of the plan: can the extension's service worker read X at all?
// Loads the dev build in Chromium with a throwaway profile (no X account) and
// runs the transport probe's guest variant: X's anonymous guest token, the
// request from the worker (Origin chrome-extension://…), no
// x-client-transaction-id. The signed-in variants need a profile with an X
// session: run the probe from the popup's dev section there.
import { chromium } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'

const ext = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist-chrome-dev')
const ctx = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--no-first-run'],
})
try {
    let sw = ctx.serviceWorkers()[0]
    if (!sw) sw = await ctx.waitForEvent('serviceworker')
    const focalId = process.argv[2]
    if (!/^\d+$/.test(focalId || '')) throw new Error('usage: node scripts/sw-probe.mjs <post id>')
    const rows = await sw.evaluate(id => globalThis.twisitterDev.action('probe', { focalId: id, guest: true }), focalId)
    console.log(JSON.stringify(rows, null, 1))
} finally {
    await ctx.close()
}
