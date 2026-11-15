// Renders the store graphics into graphics/: four 1280x800 screenshots, the
// 440x280 and 1400x560 promo tiles, and a 300x300 logo (Edge). The popup and
// the welcome page in them are the real ones: a production build loaded in
// Chromium with made-up accounts and replies, none of them real. x.com doesn't
// resolve, so nothing reaches X. The layouts are in graphics/templates.
//
//   node scripts/store-graphics.mjs [production build folder, default dist-chrome]
//
// Chromium needs the Bash sandbox off here.
import { chromium } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const build = path.resolve(process.argv[2] || path.join(root, 'dist-chrome'))
const outDir = path.join(root, 'graphics')
const templates = path.join(outDir, 'templates')

if (!fs.existsSync(path.join(build, 'manifest.json'))) throw new Error(`No build at ${build}: run yarn build-chrome, or pass a build folder.`)
if (fs.readFileSync(path.join(build, 'background.js'), 'utf8').includes('twisitterDev'))
    throw new Error(`${build} is a dev build, whose popup has a dev section. Use a production build.`)

// --- the made-up state: one account, its second account, five replies ---

const now = Date.now()
const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const viewer = '@yoursecond'

function reply(n, fields) {
    const history = fields.history || []
    return {
        id: `19900000000000${n}01`,
        parentId: `19900000000000${n}00`,
        authorId: '300000001',
        screenName: 'you',
        source: 'posted',
        capturedAt: fields.createdAt,
        checks: history.length,
        ...fields,
    }
}
const runs = (createdAt, steps) => steps.map(([after, entry]) => ({ at: createdAt + after, viewer, ...entry }))

const spamAt = now - 7 * HOUR
const hiddenAt = now - 26 * HOUR
const missingAt = now - 51 * HOUR
const listedAt = now - 3 * DAY
const replies = [
    reply(1, {
        text: 'Speaking from day one. Mistakes are how you learn, and an online tutor costs less than a textbook.',
        createdAt: spamAt,
        nextCheckAt: spamAt + DAY,
        last: {
            state: 'probable_spam',
            section: 'Probable spam',
            authorSees: true,
            quality: 'LowQuality',
            graduated: false,
            position: { part: 'fold', rank: 1, of: 2, complete: true, xCount: 9, byEngagement: 2 },
            reads: 5,
            detail: '',
            at: now - HOUR,
            viewer,
            viewerGraduated: true,
        },
        history: runs(spamAt, [
            [2 * MIN, { state: 'missing', of: 6 }],
            [HOUR, { state: 'probable_spam', section: 'Probable spam', quality: 'LowQuality', rank: 1, of: 2 }],
            [6 * HOUR, { state: 'probable_spam', section: 'Probable spam', quality: 'LowQuality', rank: 1, of: 2 }],
        ]),
    }),
    reply(2, {
        text: 'Source? The report you linked says the opposite.',
        createdAt: hiddenAt,
        nextCheckAt: hiddenAt + 3 * DAY,
        last: { state: 'hidden_by_author', reads: 4, detail: '', at: now - 2 * HOUR, viewer, viewerGraduated: true },
        history: runs(hiddenAt, [
            [2 * MIN, { state: 'listed', rank: 2, of: 5 }],
            [HOUR, { state: 'hidden_by_author' }],
            [6 * HOUR, { state: 'hidden_by_author' }],
            [DAY, { state: 'hidden_by_author' }],
        ]),
    }),
    reply(3, {
        text: "The second chart leaves out last year's numbers, which changes the trend.",
        createdAt: missingAt,
        nextCheckAt: missingAt + 3 * DAY,
        last: {
            state: 'missing',
            authorSees: true,
            position: { part: 'list', of: 14, complete: true, xCount: 15 },
            reads: 6,
            detail: '',
            at: now - 3 * HOUR,
            viewer,
            viewerGraduated: true,
        },
        history: runs(missingAt, [
            [2 * MIN, { state: 'missing', of: 12 }],
            [HOUR, { state: 'missing', of: 13 }],
            [6 * HOUR, { state: 'missing', of: 14 }],
            [DAY, { state: 'missing', of: 14 }],
        ]),
    }),
    reply(4, {
        text: 'Is the hidden-replies page public, or only for the author?',
        createdAt: now - MIN,
        // its first check is "due" well after the capture, so no check runs meanwhile
        nextCheckAt: now + 2 * HOUR,
    }),
    reply(5, {
        text: 'Congrats on the launch. The new map view is great.',
        createdAt: listedAt,
        nextCheckAt: listedAt + 7 * DAY,
        last: { state: 'listed', position: { part: 'list', rank: 3, of: 12, complete: true }, reads: 2, detail: '', at: now - 20 * MIN, viewer, viewerGraduated: true },
        history: runs(listedAt, [
            [2 * MIN, { state: 'listed', rank: 2, of: 4 }],
            [HOUR, { state: 'listed', rank: 2, of: 7 }],
            [6 * HOUR, { state: 'listed', rank: 3, of: 11 }],
            [DAY, { state: 'listed', rank: 3, of: 12 }],
            [3 * DAY - 20 * MIN, { state: 'listed', rank: 3, of: 12 }],
        ]),
    }),
]

const storage = {
    me: { userId: '300000001', screenName: 'you', at: now },
    second_account: {
        screenName: 'yoursecond',
        userId: '300000002',
        token: 'a3f1c2e4b5d6978a0b1c2d3e4f5a6b7c',
        cookies: [],
        connectedAt: listedAt - HOUR,
        graduated: true,
    },
    tracked: Object.fromEntries(replies.map(r => [r.id, r])),
    notified: Object.fromEntries(replies.filter(r => r.last && r.last.state !== 'listed').map(r => [`${r.id}:hidden`, r.last.at])),
    last_tick: now - 2 * MIN,
    replies_tab_at: now - 10 * MIN,
    read_log: { user: [], second: [now - 13 * MIN, now - 9 * MIN, now - 5 * MIN, now - 2 * MIN] },
}

// --- capture the real popup and welcome page ---

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'twisitter-graphics-'))
const context = await chromium.launchPersistentContext(path.join(work, 'profile'), {
    channel: 'chromium',
    headless: true,
    // twice the pixels, so the text stays sharp when the layouts scale it
    deviceScaleFactor: 2,
    args: [
        `--disable-extensions-except=${build}`,
        `--load-extension=${build}`,
        '--no-first-run',
        '--host-resolver-rules=MAP x.com ~NOTFOUND, MAP *.x.com ~NOTFOUND, MAP twimg.com ~NOTFOUND, MAP *.twimg.com ~NOTFOUND',
    ],
})
try {
    const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'))
    const id = worker.url().split('/')[2]
    await worker.evaluate(async data => {
        await chrome.storage.local.clear()
        await chrome.storage.local.set(data)
    }, storage)

    const capture = async (url, width, height, file, opts = {}) => {
        const page = await context.newPage()
        await page.setViewportSize({ width, height })
        await page.goto(url)
        await page.waitForSelector(opts.waitFor)
        await page.waitForTimeout(300)
        await page.screenshot({ path: path.join(work, file), fullPage: !!opts.fullPage, clip: opts.clip })
        await page.close()
    }
    // the popup at its own width (the toolbar popup, not the wide tab layout)
    await capture(`chrome-extension://${id}/src/popup.html`, 380, 700, 'popup.png', { waitFor: '.replies li:nth-child(5)', fullPage: true })
    await capture(`chrome-extension://${id}/src/popup.html#welcome`, 600, 800, 'welcome.png', { waitFor: '.welcome .steps li.done:nth-child(3)', fullPage: true })
} finally {
    await context.close()
}

// --- lay out the graphics, at the stores' exact sizes ---

const sharp = await chromium.launch({ channel: 'chromium' })
async function render(html, width, height, file) {
    const page = await sharp.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
    await page.goto('file://' + html)
    await page.waitForTimeout(150)
    await page.screenshot({ path: file, clip: { x: 0, y: 0, width, height } })
    await page.close()
}

for (const f of fs.readdirSync(templates).filter(f => /\.(html|css)$/.test(f))) fs.copyFileSync(path.join(templates, f), path.join(work, f))
fs.copyFileSync(path.join(root, 'src', 'icons', 'icon.svg'), path.join(work, 'mark.svg'))
fs.copyFileSync(path.join(build, 'icons', '48.png'), path.join(work, 'icon-48.png'))
fs.copyFileSync(path.join(build, 'src', 'content.css'), path.join(work, 'content.css'))

const out = (name, w, h, file) => render(path.join(work, name), w, h, path.join(outDir, file))
await out('shot-1.html', 1280, 800, 'screenshot-1-two-views.png')
await out('shot-2.html', 1280, 800, 'screenshot-2-popup.png')
await out('shot-3.html', 1280, 800, 'screenshot-3-second-account.png')
await out('shot-4.html', 1280, 800, 'screenshot-4-privacy.png')
await out('promo-440x280.html', 440, 280, 'promo-440x280.png')
await out('promo-1400x560.html', 1400, 560, 'promo-1400x560.png')

const logo = path.join(work, 'logo.html')
fs.writeFileSync(logo, `<html><body style="margin:0;background:transparent">${fs.readFileSync(path.join(work, 'mark.svg'), 'utf8').replace('<svg ', '<svg width="300" height="300" ')}</body></html>`)
const page = await sharp.newPage({ viewport: { width: 300, height: 300 } })
await page.goto('file://' + logo)
await page.screenshot({ path: path.join(outDir, 'logo-300.png'), omitBackground: true, clip: { x: 0, y: 0, width: 300, height: 300 } })
await sharp.close()

fs.rmSync(work, { recursive: true, force: true })
console.log('graphics written to', outDir)
