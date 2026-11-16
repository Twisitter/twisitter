import { dev, expect, fakeXPage, fixture, IDS, popupUrl, signInEnded, test } from './fixtures.js'

// X's own signals on a check, end to end: the background's check, the popup
// and the in-page note. The answers are the recorded ones, plus the two
// fields X sent in live answers on 2026-11-14: a thread item's
// conversationSection and a user record's has_graduated_access.

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

const entriesOf = a => a.data.threaded_conversation_with_injections_v2.instructions.find(i => Array.isArray(i.entries)).entries
const labelled = quality => ({ details: { conversationDetails: { conversationSection: quality } } })
const page = entries => ({ data: { threaded_conversation_with_injections_v2: { instructions: [{ type: 'TimelineAddEntries', entries }] } } })

// The second account finds the reply behind "Show probable spam", labelled
// LowQuality, from an author X holds back; the author sees it listed, HighQuality
function answers() {
    const reply = entriesOf(fixture('missing_reply_direct'))[1]
    reply.content.itemContent.tweet_results.result.core.user_results.result.has_graduated_access = false
    const first = fixture('missing_parent_page1')
    entriesOf(first).push({
        entryId: 'cursor-showmorethreads-1900000000000000099',
        content: {
            entryType: 'TimelineTimelineItem',
            itemContent: { itemType: 'TimelineTimelineCursor', value: 'cursor-spam', cursorType: 'ShowMoreThreads', displayTreatment: { actionText: 'Show probable spam' } },
        },
    })
    const spam = page([
        { entryId: 'label-0', content: { entryType: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineLabel', text: 'Probable spam' } } },
        {
            entryId: `conversationthread-${IDS.missingReply}`,
            content: {
                entryType: 'TimelineTimelineModule',
                items: [
                    {
                        entryId: `conversationthread-${IDS.missingReply}-tweet-${IDS.missingReply}`,
                        item: { itemContent: reply.content.itemContent, clientEventInfo: labelled('LowQuality') },
                    },
                ],
            },
        },
    ])
    const authorView = fixture('author_view_parent')
    entriesOf(authorView).find(e => e.content?.items).content.items[0].item.clientEventInfo = labelled('HighQuality')
    return {
        second: { [`TweetDetail:${IDS.missingParent}:`]: first, [`TweetDetail:${IDS.missingParent}:cursor-spam`]: spam },
        user: { [`TweetDetail:${IDS.missingParent}:`]: authorView },
    }
}

// X's API answered per account: the second account's reads carry the
// extension's marker, the user's own don't
async function routeEachAccount(context, tables) {
    await context.route(/^https:\/\/x\.com\/i\/api\/graphql\//, async route => {
        const url = new URL(route.request().url())
        const op = url.pathname.split('/').pop()
        const v = JSON.parse(url.searchParams.get('variables') || '{}')
        const key = `${op}:${v.focalTweetId || v.rootTweetId || v.userId || ''}:${v.cursor || ''}`
        const body = tables[url.searchParams.get('tw_as') === TOKEN ? 'second' : 'user'][key]
        if (body === undefined) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"errors":[{"message":"no route"}]}' })
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    })
}

test('X’s own signals reach the popup and the in-page note', async ({ context, worker, extensionId }) => {
    await routeEachAccount(context, answers())
    await dev(worker, 'set-local', {
        me,
        second_account: second,
        tracked: {
            [IDS.missingReply]: {
                id: IDS.missingReply,
                parentId: IDS.missingParent,
                authorId: IDS.authorUser,
                screenName: 'author',
                text: 'a reply X files as probable spam',
                capturedAt: Date.now(),
                source: 'link',
                nextCheckAt: 0,
                checks: 0,
            },
        },
    })
    const report = await dev(worker, 'tick', { only: IDS.missingReply })
    expect(report.checked).toEqual([expect.objectContaining({ id: IDS.missingReply, state: 'probable_spam' })])

    const popup = await context.newPage()
    await popup.goto(popupUrl(extensionId))
    const why = popup.locator('li.reply .why')
    await expect(why).toContainText(`X also holds its author's account back until it's sure a person runs it (X's "Unlock more on X" notice), a common reason for this.`)
    await expect(why).toContainText(`X's data files it as "LowQuality", and as "HighQuality" for its author.`)

    // the in-page note gives the same reason
    await context.route('https://x.com/poster/status/' + IDS.missingParent, route =>
        route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: fakeXPage({
                articles: [
                    { user: 'poster', id: IDS.missingParent, text: 'the post' },
                    { user: 'author', id: IDS.missingReply, text: 'my reply' },
                ],
            }),
        }),
    )
    const xPage = await context.newPage()
    await xPage.goto('https://x.com/poster/status/' + IDS.missingParent)
    const note = xPage.locator('.twisitter-note')
    await expect(note).toHaveCount(1)
    await expect(note).toContainText('Behind "Show probable spam"')
    await expect(note).toContainText(`(X's "Unlock more on X" notice), a common reason for this.`)
})

test('a change between checks shows as history, and a second account X holds back is named', async ({ context, worker, extensionId }) => {
    // two checks, a few reads each, paced like the real thing
    test.setTimeout(90000)
    const spam = answers()
    // first X leaves the reply out of the list; then it files it under "Probable spam"
    const tables = {
        second: {
            [`TweetDetail:${IDS.missingParent}:`]: fixture('missing_parent_page1'),
            [`TweetDetail:${IDS.missingParent}:cursor-1`]: fixture('missing_parent_bottom'),
            [`ModeratedTimeline:${IDS.missingParent}:`]: fixture('hidden_empty'),
            [`TweetDetail:${IDS.missingReply}:`]: fixture('missing_reply_direct'),
        },
        user: spam.user,
    }
    await routeEachAccount(context, tables)
    await dev(worker, 'set-local', {
        me,
        // as its sign-in page said: X holds this account back
        second_account: { ...second, graduated: false },
        tracked: {
            [IDS.missingReply]: {
                id: IDS.missingReply,
                parentId: IDS.missingParent,
                authorId: IDS.authorUser,
                screenName: 'author',
                text: 'a reply X moves around',
                capturedAt: Date.now(),
                source: 'link',
                nextCheckAt: 0,
                checks: 0,
            },
        },
    })
    const before = await dev(worker, 'tick', { only: IDS.missingReply })
    expect(before.checked).toEqual([expect.objectContaining({ id: IDS.missingReply, state: 'missing' })])
    tables.second = spam.second
    const after = await dev(worker, 'tick', { only: IDS.missingReply })
    expect(after.checked).toEqual([expect.objectContaining({ id: IDS.missingReply, state: 'probable_spam' })])

    const popup = await context.newPage()
    await popup.goto(popupUrl(extensionId))
    await expect(popup.getByText(/^When it signed in, X was holding @viewer back/)).toBeVisible()
    const item = popup.locator('li.reply')
    await expect(item).toContainText('History: Missing for others (')
    await expect(item).toContainText('→ Behind "Show probable spam" (')
    await expect(item).toContainText('1st of 1 behind "Show probable spam", as @viewer sees it.')
    await expect(item).toContainText("X was also holding @viewer back when it signed in, so its view may differ from most people's.")
})

// X's inline page state, with the signed-in account's has_graduated_access
const signedInWith = (userId, screenName, graduated) =>
    `<script>window.__INITIAL_STATE__=${JSON.stringify({ optimist: [], entities: { users: { entities: { [userId]: { screen_name: screenName, has_graduated_access: graduated } } } }, session: { user_id: userId } })};window.__META_DATA__={};</script>`

test('the pages an account signs in on say whether X holds it back', async ({ context, worker }) => {
    const cookie = (name, value) => ({ name, value, domain: '.x.com', path: '/', secure: true, httpOnly: name === 'auth_token', sameSite: 'None' })
    await context.route('https://x.com/i/flow/login', route => route.fulfill({ status: 200, contentType: 'text/html', body: fakeXPage({}) }))
    await context.route('https://x.com/home', route =>
        route.fulfill({ status: 200, contentType: 'text/html', body: fakeXPage({ head: signedInWith(IDS.viewerUser, 'viewer', false) }) }),
    )
    await context.route(/^https:\/\/x\.com\/i\/api\//, route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"data":{}}' }))
    await context.addCookies([cookie('auth_token', 'main-session'), cookie('ct0', 'main-csrf')])
    await dev(worker, 'set-local', { me: { userId: IDS.authorUser, screenName: 'author', at: Date.now() } })

    expect(await dev(worker, 'connect-start')).toEqual({ ok: true })
    const loginTab = () => context.pages().find(p => p.url() === 'https://x.com/i/flow/login')
    await expect.poll(loginTab, { timeout: 10000 }).toBeTruthy()
    await context.addCookies([cookie('auth_token', 'second-session'), cookie('ct0', 'second-csrf')])
    const tab = loginTab()
    await tab.goto('https://x.com/home')
    await tab.waitForURL(/\/src\/popup\.html#connected$/, { timeout: 10000 })
    await signInEnded(worker)
    const { second_account: saved } = await worker.evaluate(() => chrome.storage.local.get('second_account'))
    expect(saved).toMatchObject({ screenName: 'viewer', userId: IDS.viewerUser, graduated: false })

    // any x.com page signed in as the user brings the user's own flag
    await context.route('https://x.com/author', route =>
        route.fulfill({ status: 200, contentType: 'text/html', body: fakeXPage({ head: signedInWith(IDS.authorUser, 'author', true) }) }),
    )
    const page = await context.newPage()
    await page.goto('https://x.com/author')
    await expect.poll(async () => (await worker.evaluate(() => chrome.storage.local.get('me'))).me?.graduated, { timeout: 10000 }).toBe(true)
})
