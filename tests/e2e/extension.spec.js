import { dev, expect, fakeXPage, fixture, IDS, popupUrl, signedInAs, test } from './fixtures.js'

const TOKEN = '0123456789abcdef0123456789abcdef'
const second = {
    screenName: 'viewer',
    userId: IDS.viewerUser,
    token: TOKEN,
    cookies: [
        { name: 'auth_token', value: 'second-session', domain: '.x.com', path: '/', secure: true, httpOnly: true, hostOnly: false },
        { name: 'ct0', value: 'second-csrf', domain: '.x.com', path: '/', secure: true, httpOnly: false, hostOnly: false },
    ],
    connectedAt: Date.now(),
}
const me = { userId: IDS.authorUser, screenName: 'author', at: Date.now() }

// Answers for X's API by operation and focal id, from the recorded fixtures
async function routeX(context, table, seen = []) {
    await context.route(/^https:\/\/x\.com\/i\/api\/graphql\//, async route => {
        const url = new URL(route.request().url())
        const op = url.pathname.split('/').pop()
        const v = JSON.parse(url.searchParams.get('variables') || '{}')
        const key = `${op}:${v.focalTweetId || v.rootTweetId || v.userId || ''}:${v.cursor || ''}`
        const headers = await route.request().allHeaders()
        seen.push({ key, marked: url.searchParams.get('tw_as') === TOKEN, cookie: headers.cookie || '', csrf: headers['x-csrf-token'] || '' })
        const body = table[key]
        if (body === undefined) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"errors":[{"message":"no route"}]}' })
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    })
    return seen
}

test('popup without an X session invites a sign-in and a second account', async ({ context, extensionId }) => {
    await routeX(context, {})
    const page = await context.newPage()
    await page.goto(popupUrl(extensionId))
    await expect(page.getByRole('heading', { name: 'Twisitter' })).toBeVisible()
    // step 1: x.com opens in a background tab and says who's signed in (setup.spec.js)
    await expect(page.getByRole('button', { name: 'Open x.com' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Connect a second account' })).toBeDisabled()
})

test('a check as the second account: a reply listed only for its author shows as missing for others', async ({ context, worker, extensionId }) => {
    const seen = await routeX(context, {
        [`TweetDetail:${IDS.missingParent}:`]: fixture('missing_parent_page1'),
        [`TweetDetail:${IDS.missingParent}:cursor-1`]: fixture('missing_parent_bottom'),
        [`ModeratedTimeline:${IDS.missingParent}:`]: fixture('hidden_empty'),
        [`TweetDetail:${IDS.missingReply}:`]: fixture('missing_reply_direct'),
    })
    await dev(worker, 'set-local', {
        me,
        second_account: second,
        tracked: {
            [IDS.missingReply]: {
                id: IDS.missingReply,
                parentId: IDS.missingParent,
                authorId: IDS.authorUser,
                screenName: 'author',
                text: 'a reply only its author sees',
                capturedAt: Date.now(),
                source: 'link',
                nextCheckAt: 0,
                checks: 0,
            },
        },
    })
    // the header rule follows the stored account (set when it's stored, and
    // put back by a read if the browser dropped it)
    const report = await dev(worker, 'tick', { only: IDS.missingReply })
    expect(report.checked).toEqual([expect.objectContaining({ id: IDS.missingReply, state: 'missing' })])

    // only reads X's own pages make: the post and its replies, its hidden
    // replies, the reply opened directly (no searches, no "who am I")
    expect(new Set(seen.map(s => s.key.split(':')[0]))).toEqual(new Set(['TweetDetail', 'ModeratedTimeline']))
    // every read as the second account carried its marker and its CSRF value
    const asSecond = seen.filter(s => s.marked)
    expect(asSecond.length).toBeGreaterThanOrEqual(4)
    expect(asSecond.every(s => s.csrf === 'second-csrf')).toBe(true)
    // the session rule that puts its cookies on those reads
    const rules = await worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules())
    expect(rules).toEqual([
        expect.objectContaining({
            action: expect.objectContaining({ requestHeaders: [{ header: 'cookie', operation: 'set', value: 'auth_token=second-session; ct0=second-csrf' }] }),
            condition: expect.objectContaining({ tabIds: [-1], requestMethods: ['get'] }),
        }),
    ])

    const page = await context.newPage()
    await page.goto(popupUrl(extensionId))
    await expect(page.getByText('Missing for others')).toBeVisible()
    await expect(page.getByText(/@viewer doesn't see it under the post at all/)).toBeVisible()
    await expect(page.getByText('Second account:')).toBeVisible()
})

test('the page hook catches a posted reply and learns the queryIds the page uses', async ({ context, worker, extensionId }) => {
    const created = fixture('missing_reply_direct').data.threaded_conversation_with_injections_v2.instructions[1].entries[1].content.itemContent.tweet_results.result
    await context.route('https://x.com/compose', route =>
        route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: fakeXPage({
                script: `
                addEventListener('load', () => setTimeout(() => {
                    const get = new XMLHttpRequest()
                    get.open('GET', '/i/api/graphql/NEWqueryId123/TweetDetail?variables=' + encodeURIComponent(JSON.stringify({ focalTweetId: '1' })) + '&features=' + encodeURIComponent(JSON.stringify({ a_flag: true })))
                    get.setRequestHeader('authorization', 'Bearer AAAAAAAAAAAAAAAAAAAAAPageBearer0000000000000000000000000000000000')
                    get.send()
                    const post = new XMLHttpRequest()
                    post.open('POST', '/i/api/graphql/someQuery/CreateTweet')
                    post.setRequestHeader('content-type', 'application/json')
                    post.send(JSON.stringify({ variables: { tweet_text: 'hello', reply: { in_reply_to_tweet_id: '${IDS.missingParent}' } } }))
                }, 300))`,
            }),
        }),
    )
    await context.route(/^https:\/\/x\.com\/i\/api\/graphql\//, route => {
        const op = new URL(route.request().url()).pathname.split('/').pop()
        if (op === 'CreateTweet') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { create_tweet: { tweet_results: { result: created } } } }) })
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{"data":{}}' })
    })
    const page = await context.newPage()
    await page.goto('https://x.com/compose')
    await expect(page.locator('html')).toHaveAttribute('data-twisitter', /^dev /)
    await expect.poll(async () => (await dev(worker, 'state')).tracked.map(t => t.id), { timeout: 10000 }).toContain(IDS.missingReply)
    const ops = await worker.evaluate(() => chrome.storage.local.get('ops'))
    expect(ops.ops.TweetDetail).toEqual({ queryId: 'NEWqueryId123', features: { a_flag: true } })
    const state = await dev(worker, 'state')
    expect(state.tracked[0]).toMatchObject({ id: IDS.missingReply, parentId: IDS.missingParent, source: 'posted', authorId: IDS.authorUser })
    // the author of a posted reply is who the page is signed in as
    expect(state.me).toMatchObject({ userId: IDS.authorUser, screenName: 'author' })

    const popup = await context.newPage()
    await popup.goto(popupUrl(extensionId))
    await expect(popup.getByText('Waiting for its first check')).toBeVisible()
})

test('the in-page note marks a reply X hides from others', async ({ context, worker }) => {
    await dev(worker, 'set-local', {
        tracked: {
            [IDS.missingReply]: {
                id: IDS.missingReply,
                parentId: IDS.missingParent,
                authorId: IDS.authorUser,
                capturedAt: Date.now(),
                source: 'posted',
                nextCheckAt: Date.now() + 3600000,
                checks: 1,
                last: { state: 'probable_spam', section: 'Probable spam', authorSees: true, reads: 3, detail: '', at: Date.now(), viewer: '@viewer' },
            },
        },
    })
    await context.route('https://x.com/poster/status/' + IDS.missingParent, route =>
        route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: fakeXPage({
                articles: [
                    { user: 'poster', id: IDS.missingParent, text: 'the post' },
                    { user: 'author', id: IDS.missingReply, text: 'my reply' },
                    { user: 'someone', id: '1900000000000000077', text: 'another reply' },
                ],
            }),
        }),
    )
    await context.route(/^https:\/\/x\.com\/i\/api\//, route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"data":{}}' }))
    const page = await context.newPage()
    await page.goto('https://x.com/poster/status/' + IDS.missingParent)
    const note = page.locator('.twisitter-note')
    await expect(note).toHaveCount(1)
    await expect(note).toContainText('Behind "Show probable spam"')
    await expect(note).toContainText('@viewer sees it only after clicking "Show probable spam"')
    // on the right article
    await expect(page.locator('article', { has: note })).toContainText('my reply')
})

test('an x.com page tells the extension who the user is', async ({ context, worker, extensionId }) => {
    await context.route('https://x.com/home', route =>
        route.fulfill({ status: 200, contentType: 'text/html', body: fakeXPage({ head: signedInAs(IDS.authorUser, 'author') }) }),
    )
    await context.route(/^https:\/\/x\.com\/i\/api\//, route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"data":{}}' }))
    const page = await context.newPage()
    await page.goto('https://x.com/home')
    await expect.poll(async () => (await dev(worker, 'state')).me?.screenName, { timeout: 10000 }).toBe('author')
    const popup = await context.newPage()
    await popup.goto(popupUrl(extensionId))
    await expect(popup.getByText('@author')).toBeVisible()
    await expect(popup.getByRole('button', { name: 'Connect a second account' })).toBeEnabled()
})

test('a message from the page can’t pass itself off as another kind', async ({ context, worker }) => {
    await context.route('https://x.com/home', route =>
        route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: fakeXPage({
                head: signedInAs(IDS.authorUser, 'author'),
                // a script in the page: a type the content script passes on,
                // with an action of its own beside it
                script: `addEventListener('load', () => setTimeout(() => window.postMessage({ source: 'twisitter-page', type: 'learned-op', action: 'page-user', userId: '999', screenName: 'mallory' }, location.origin), 300))`,
            }),
        }),
    )
    await context.route(/^https:\/\/x\.com\/i\/api\//, route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"data":{}}' }))
    const page = await context.newPage()
    await page.goto('https://x.com/home')
    await expect.poll(async () => (await dev(worker, 'state')).me?.screenName, { timeout: 10000 }).toBe('author')
    // time for the page's own message to arrive and be handled
    await page.waitForTimeout(1500)
    expect((await dev(worker, 'state')).me).toMatchObject({ userId: IDS.authorUser, screenName: 'author' })
})

const TYPED = 'https://x.com/someone/status/12'

test('the popup leaves a field alone while someone types in it', async ({ context, extensionId }) => {
    const page = await context.newPage()
    await page.goto(popupUrl(extensionId))
    // a focus change from here on would mean the field was redrawn under the typing
    await page.evaluate(() => document.addEventListener('focusin', () => window.focusChanges++))
    for (const label of ['Link to a reply', 'Post for the probe']) {
        const field = page.getByLabel(label)
        await field.fill(TYPED)
        await page.evaluate(() => (window.focusChanges = 0))
        // the popup redraws every 4 seconds
        await page.waitForTimeout(4500)
        await expect(field).toHaveValue(TYPED)
        await expect(field).toBeFocused()
        expect(await page.evaluate(() => window.focusChanges)).toBe(0)
    }
})

test('the popup’s fields share one look', async ({ context, extensionId }) => {
    const page = await context.newPage()
    await page.goto(popupUrl(extensionId))
    const look = field =>
        field.evaluate(f => {
            const s = getComputedStyle(f)
            return { background: s.backgroundColor, color: s.color, border: s.borderTopColor, radius: s.borderTopLeftRadius, padding: s.paddingLeft, grow: s.flexGrow }
        })
    expect(await look(page.getByLabel('Post for the probe'))).toEqual(await look(page.getByLabel('Link to a reply')))
})

test('a field keeps its focus, caret and text when its part of the popup changes', async ({ context, worker, extensionId }) => {
    const page = await context.newPage()
    await page.goto(popupUrl(extensionId))
    // the reply-link field, when a round ends and the line above it changes
    const link = page.getByLabel('Link to a reply')
    await link.fill(TYPED)
    await link.press('ArrowLeft')
    await dev(worker, 'set-local', { last_tick: Date.now() })
    await expect(page.getByText(/^Last round just now/)).toBeVisible({ timeout: 10000 })
    await expect(link).toBeFocused()
    await expect(link).toHaveValue(TYPED)
    expect(await link.evaluate(f => [f.selectionStart, f.selectionEnd])).toEqual([TYPED.length - 1, TYPED.length - 1])
    // the probe field, when the probe's answer shows below it (with no X
    // session here, the probe answers at once without reading X)
    const post = page.getByLabel('Post for the probe')
    await post.fill('12345678')
    await post.press('Enter')
    await expect(page.locator('pre.dev')).toContainText('skipped')
    await expect(post).toBeFocused()
    await expect(post).toHaveValue('12345678')
})

test('connecting a second account saves its cookies and puts the user’s own back', async ({ context, worker }) => {
    const cookie = (name, value) => ({ name, value, domain: '.x.com', path: '/', secure: true, httpOnly: name === 'auth_token', sameSite: 'None' })
    await context.route('https://x.com/i/flow/login', route => route.fulfill({ status: 200, contentType: 'text/html', body: fakeXPage({}) }))
    // after the sign-in, X's next page is signed in as the second account
    await context.route('https://x.com/home', route =>
        route.fulfill({ status: 200, contentType: 'text/html', body: fakeXPage({ head: signedInAs(IDS.viewerUser, 'viewer') }) }),
    )
    await context.route(/^https:\/\/x\.com\/i\/api\//, route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"data":{}}' }))
    await context.addCookies([cookie('auth_token', 'main-session'), cookie('ct0', 'main-csrf')])
    await dev(worker, 'set-local', { me: { userId: IDS.authorUser, screenName: 'author', at: Date.now() } })

    expect(await dev(worker, 'connect-start')).toEqual({ ok: true })
    // the tab the extension opened on X's login page (not its welcome tab)
    const loginTab = () => context.pages().find(p => p.url() === 'https://x.com/i/flow/login')
    await expect.poll(loginTab, { timeout: 10000 }).toBeTruthy()
    const tab = loginTab()
    // the user's own session is out of the browser while the second account signs in
    expect((await context.cookies('https://x.com')).map(c => c.name)).not.toContain('auth_token')

    // the sign-in: X sets the second account's cookies, and its next page loads
    await context.addCookies([cookie('auth_token', 'second-session'), cookie('ct0', 'second-csrf')])
    await tab.goto('https://x.com/home')
    await tab.waitForURL(/\/src\/popup\.html#connected$/, { timeout: 10000 })

    expect((await dev(worker, 'state')).second).toMatchObject({ screenName: 'viewer', userId: IDS.viewerUser })
    const { second_account: saved } = await worker.evaluate(() => chrome.storage.local.get('second_account'))
    expect(Object.fromEntries(saved.cookies.map(c => [c.name, c.value]))).toEqual({ auth_token: 'second-session', ct0: 'second-csrf' })
    // the user's own login is back in the browser
    const back = Object.fromEntries((await context.cookies('https://x.com')).map(c => [c.name, c.value]))
    expect(back).toEqual({ auth_token: 'main-session', ct0: 'main-csrf' })
    // and the second account's cookies ride only on the extension's marked reads
    const rules = await worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules())
    expect(rules[0].action.requestHeaders[0].value).toBe('auth_token=second-session; ct0=second-csrf')
})

test('the sign-in tab is left alone while X’s login flow moves on, and reloaded once it lands on /home', async ({ context, worker }) => {
    const cookie = (name, value) => ({ name, value, domain: '.x.com', path: '/', secure: true, httpOnly: name === 'auth_token', sameSite: 'None' })
    await context.route('https://x.com/i/flow/login', route => route.fulfill({ status: 200, contentType: 'text/html', body: fakeXPage({}) }))
    await context.route('https://x.com/home', route =>
        route.fulfill({ status: 200, contentType: 'text/html', body: fakeXPage({ head: signedInAs(IDS.viewerUser, 'viewer') }) }),
    )
    await context.route(/^https:\/\/x\.com\/i\/api\//, route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"data":{}}' }))
    await dev(worker, 'set-local', { me: { userId: IDS.authorUser, screenName: 'author', at: Date.now() } })
    expect(await dev(worker, 'connect-start')).toEqual({ ok: true })
    const loginTab = () => context.pages().find(p => p.url() === 'https://x.com/i/flow/login')
    await expect.poll(loginTab, { timeout: 10000 }).toBeTruthy()
    const tab = loginTab()

    // X moves its login page on without a page load (seen 2026-11-15), and its
    // code steps do the same: a reload here would start the sign-in over
    await tab.evaluate(() => {
        window.stillThisPage = true
        history.pushState({}, '', '/i/jf/onboarding/web?mode=login')
    })
    await tab.waitForTimeout(6000)
    expect(await tab.evaluate(() => window.stillThisPage)).toBe(true)

    // signed in: X lands on /home without a page load, and only a reload says who
    await context.addCookies([cookie('auth_token', 'second-session'), cookie('ct0', 'second-csrf')])
    await tab.evaluate(() => history.pushState({}, '', '/home'))
    await tab.waitForURL(/\/src\/popup\.html#connected$/, { timeout: 15000 })
    expect((await dev(worker, 'state')).second).toMatchObject({ screenName: 'viewer', userId: IDS.viewerUser })
})

test('the welcome page explains the three steps and ticks off what’s done', async ({ context, worker, extensionId }) => {
    await dev(worker, 'set-local', { me: { userId: IDS.authorUser, screenName: 'author', at: Date.now() } })
    const page = await context.newPage()
    await page.goto(popupUrl(extensionId) + '#welcome')
    await expect(page.getByRole('heading', { name: 'Welcome to Twisitter' })).toBeVisible()
    const steps = page.locator('.steps li')
    await expect(steps).toHaveCount(3)
    await expect(steps.nth(0)).toHaveClass(/done/)
    await expect(steps.nth(0)).toContainText('Signed in as @author')
    await expect(steps.nth(1)).not.toHaveClass(/done/)
    await expect(page.getByRole('button', { name: 'Connect a second account' })).toBeEnabled()
    if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true })
})
