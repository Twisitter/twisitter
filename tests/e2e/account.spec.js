import { dev, expect, fakeXPage, fixture, IDS, popupUrl, signedInAs, test } from './fixtures.js'

// The account check end to end: another account's profile, its Replies tab as
// the page loads it, the popup's button, the check as the user, and the note
// on X's page. The answers are the recorded ones; the Replies tab's is built
// the way X's answer is laid out, with the relation X sent live (2026-11-15).

const LISTED_PARENT = '1000000000000000011'
const LISTED_REPLY = '1900000000000000006'
// the user, who doesn't follow the account checked
const me = { userId: '200000009', screenName: 'you', at: Date.now() }

const entriesOf = a => a.data.threaded_conversation_with_injections_v2.instructions.find(i => Array.isArray(i.entries)).entries
const page = entries => ({ data: { threaded_conversation_with_injections_v2: { instructions: [{ type: 'TimelineAddEntries', entries }] } } })

// The author's Replies tab: two replies to other accounts
function repliesTab() {
    const author = {
        __typename: 'User',
        rest_id: IDS.authorUser,
        core: { screen_name: 'author' },
        relationship_perspectives: { following: false, followed_by: false, muting: false, blocking: false },
    }
    const tweet = (id, parentId) => ({
        entryId: `tweet-${id}`,
        content: {
            entryType: 'TimelineTimelineItem',
            itemContent: {
                itemType: 'TimelineTweet',
                tweet_results: {
                    result: {
                        __typename: 'Tweet',
                        rest_id: id,
                        core: { user_results: { result: author } },
                        legacy: {
                            full_text: 'a reply',
                            created_at: 'Mon Jan 05 12:00:00 +0000 2026',
                            in_reply_to_status_id_str: parentId,
                            in_reply_to_user_id_str: '200000077',
                            conversation_id_str: parentId,
                        },
                    },
                },
            },
        },
    })
    return {
        data: {
            user: {
                result: {
                    timeline: {
                        timeline: {
                            instructions: [{ type: 'TimelineAddEntries', entries: [tweet(IDS.missingReply, IDS.missingParent), tweet(LISTED_REPLY, LISTED_PARENT)] }],
                        },
                    },
                },
            },
        },
    }
}

// As the user: one reply under its post, the other behind "Show probable spam"
function threads() {
    const reply = entriesOf(fixture('missing_reply_direct'))[1]
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
                        item: { itemContent: reply.content.itemContent, clientEventInfo: { details: { conversationDetails: { conversationSection: 'LowQuality' } } } },
                    },
                ],
            },
        },
    ])
    return {
        [`TweetDetail:${IDS.missingParent}:`]: first,
        [`TweetDetail:${IDS.missingParent}:cursor-spam`]: spam,
        [`TweetDetail:${LISTED_PARENT}:`]: fixture('listed_thread'),
    }
}

// x.com's profile pages: the posts tab, and the Replies tab, which loads its
// first page the way X's web app does (an XHR the page hook sees)
async function routeProfile(context) {
    const articles = [
        { user: 'author', id: IDS.missingReply, text: 'a folded reply' },
        { user: 'author', id: LISTED_REPLY, text: 'a listed reply' },
    ]
    // the pages are signed in as the user: the relation in X's answers is theirs
    const head = signedInAs(me.userId, me.screenName)
    await context.route('https://x.com/author', route => route.fulfill({ status: 200, contentType: 'text/html', body: fakeXPage({ articles, head }) }))
    await context.route('https://x.com/author/with_replies', route =>
        route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: fakeXPage({
                articles,
                head,
                script: `
                addEventListener('load', () => setTimeout(() => {
                    const get = new XMLHttpRequest()
                    get.open('GET', '/i/api/graphql/RepliesQuery12/UserRepliesTimeline?variables=' + encodeURIComponent(JSON.stringify({ userId: '${IDS.authorUser}', count: 20 })) + '&features=' + encodeURIComponent(JSON.stringify({ a_flag: true })))
                    get.send()
                }, 300))`,
            }),
        }),
    )
    const tables = threads()
    const reads = []
    await context.route(/^https:\/\/x\.com\/i\/api\/graphql\//, route => {
        const url = new URL(route.request().url())
        const op = url.pathname.split('/').pop()
        const v = JSON.parse(url.searchParams.get('variables') || '{}')
        if (op === 'UserRepliesTimeline') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(repliesTab()) })
        const key = `${op}:${v.focalTweetId || v.rootTweetId || ''}:${v.cursor || ''}`
        reads.push(`${url.searchParams.has('tw_as') ? 'second' : 'user'} ${key}`)
        const body = tables[key]
        if (body === undefined) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"errors":[{"message":"no route"}]}' })
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    })
    return reads
}

test('an account check from the popup: the Replies tab, the check as the user, the popup and the note', async ({ context, worker, extensionId }) => {
    test.setTimeout(90000)
    const reads = await routeProfile(context)
    await dev(worker, 'set-local', { me })

    const xPage = await context.newPage()
    await xPage.goto('https://x.com/author')
    await expect(xPage.locator('html')).toHaveAttribute('data-twisitter', /^dev /)
    const [tab] = await worker.evaluate(() => chrome.tabs.query({ url: 'https://x.com/*' }))

    // nothing scrolled yet: the popup offers the Replies tab, and opens it
    const popup = await context.newPage()
    await popup.goto(`${popupUrl(extensionId)}?tab=${tab.id}`)
    await expect(popup.getByText("@author's replies", { exact: true })).toBeVisible()
    await popup.getByRole('button', { name: 'Open Replies tab' }).click()
    await expect.poll(() => xPage.url(), { timeout: 10000 }).toBe('https://x.com/author/with_replies')

    // the page's own read of the tab lists the replies; the check reads as the user
    const check = popup.getByRole('button', { name: "Check @author's replies" })
    await expect(check).toBeEnabled({ timeout: 10000 })
    await expect(popup.getByText('2 replies to other accounts on the Replies tab so far')).toBeVisible()
    await expect(popup.getByText("Reads as @you, who doesn't follow @author, like anyone else browsing.")).toBeVisible()
    await check.click()
    await expect(popup.getByText(/^Checked 2 replies .* as @you\.$/)).toBeVisible({ timeout: 45000 })
    await expect(popup.getByText('Of 2 checked: 1 shown under the post, 1 behind "Show probable spam".')).toBeVisible()
    const item = popup.locator('li.reply')
    await expect(item).toHaveCount(1)
    await expect(item).toContainText('@you sees it only after clicking "Show probable spam", in Relevant order, and not at all in Recent order.')
    expect(reads.length).toBeGreaterThan(0)
    expect(reads.every(r => r.startsWith('user '))).toBe(true)

    // the note on X's page, on the folded reply only
    const note = xPage.locator('.twisitter-note')
    await expect(note).toHaveCount(1, { timeout: 10000 })
    await expect(note).toContainText('Behind "Show probable spam"')
    await expect(xPage.locator('article', { has: note })).toContainText('a folded reply')
})

test('the popup over the user’s own profile has no account check', async ({ context, worker, extensionId }) => {
    await dev(worker, 'set-local', { me: { userId: IDS.authorUser, screenName: 'author', at: Date.now() } })
    await context.route('https://x.com/author', route => route.fulfill({ status: 200, contentType: 'text/html', body: fakeXPage({}) }))
    await context.route(/^https:\/\/x\.com\/i\/api\//, route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"data":{}}' }))
    const xPage = await context.newPage()
    await xPage.goto('https://x.com/author')
    const [tab] = await worker.evaluate(() => chrome.tabs.query({ url: 'https://x.com/*' }))
    const popup = await context.newPage()
    await popup.goto(`${popupUrl(extensionId)}?tab=${tab.id}`)
    await expect(popup.getByText('You: ')).toBeVisible()
    await expect(popup.getByText("@author's replies", { exact: true })).toHaveCount(0)
})
