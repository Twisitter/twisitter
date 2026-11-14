// Playwright fixtures: Chromium with the real dev build (dist-chrome-dev)
// loaded. Nothing reaches X: x.com and api.x.com don't resolve, and every
// request a test needs is answered by a route, the extension's own
// background requests included.

import { test as base, chromium } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const extensionPath = path.join(__dirname, '..', '..', 'dist-chrome-dev')
export const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', `${name}.json`), 'utf8'))

export const IDS = {
    missingParent: '1000000000000000001',
    missingReply: '1000000000000000002',
    viewerUser: '200000001',
    authorUser: '200000002',
}

export const test = base.extend({
    // eslint-disable-next-line no-empty-pattern
    context: async ({}, use) => {
        const context = await chromium.launchPersistentContext('', {
            channel: 'chromium',
            headless: !process.env.HEADED,
            args: [
                `--disable-extensions-except=${extensionPath}`,
                `--load-extension=${extensionPath}`,
                '--no-first-run',
                '--host-resolver-rules=MAP x.com ~NOTFOUND, MAP *.x.com ~NOTFOUND, MAP twimg.com ~NOTFOUND, MAP *.twimg.com ~NOTFOUND',
            ],
        })
        await use(context)
        await context.close()
    },
    worker: async ({ context }, use) => {
        let sw = context.serviceWorkers()[0]
        if (!sw) sw = await context.waitForEvent('serviceworker')
        await use(sw)
    },
    extensionId: async ({ worker }, use) => {
        await use(worker.url().split('/')[2])
    },
})
export const expect = test.expect

// The background's dev actions (dev builds only)
export const dev = (worker, cmd, args) => worker.evaluate(([c, a]) => globalThis.twisitterDev.action(c, a), [cmd, args])

export const popupUrl = id => `chrome-extension://${id}/src/popup.html`

// A minimal x.com page: an <article> per tweet, the way X marks them up (a
// timestamp link to the status, the text under data-testid="tweetText")
export function fakeXPage({ articles = [], script = '', head = '' } = {}) {
    const items = articles
        .map(
            a => `<article data-testid="tweet"><div><a href="/${a.user}/status/${a.id}"><time datetime="2026-01-05T12:00:00.000Z">Jan 5</time></a></div><div><div data-testid="tweetText">${a.text}</div></div></article>`,
        )
        .join('')
    return `<!doctype html><html><head><meta charset="utf-8">${head}</head><body><main>${items}</main><script>${script}</script></body></html>`
}

// The inline script X's pages open with: the signed-in account (cut down)
export const signedInAs = (userId, screenName) =>
    `<script>window.__INITIAL_STATE__=${JSON.stringify({ optimist: [], entities: { users: { entities: { [userId]: { screen_name: screenName } } } }, session: { user_id: userId } })};window.__META_DATA__={};</script>`
