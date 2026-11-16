// The account check (account-check.ts): another account's replies, as someone
// outside it sees them. What the page hook passes on, what a tab scrolled, who
// reads, and the check itself against the stand-in browser (browser.ts) and
// the recorded answers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    accountState,
    forgetAllTabs,
    forgetTab,
    FRESH_MS,
    MAX_CHECKED,
    noteRepliesTab,
    ONE_CHECK_READS,
    openRepliesTab,
    otherNotes,
    pruneAccountChecks,
    readerFor,
    RESULTS_TTL_MS,
    SECOND_READS_CAP,
    SEEN_TTL_MS,
    startAccountCheck,
    USER_READS_CAP,
} from '../../src/src/account-check'
import { repliesTabCapture } from '../../src/src/capture'
import { explainOther } from '../../src/src/describe'
import { DAY, HOUR } from '../../src/src/store'
import { profileFromUrl } from '../../src/src/x-api'
import { fakeBrowser, settle } from './browser'
import { fixture, IDS, ok } from './helpers'

const browser = fakeBrowser()
const TOKEN = '0123456789abcdef0123456789abcdef'
const cookie = (name: string, value: string) => ({ name, value, domain: '.x.com', path: '/', secure: true, httpOnly: name === 'auth_token', hostOnly: false })
// the user, someone other than the writer of the replies checked
const me = { userId: '200000009', screenName: 'you', at: 0 }
const second = { screenName: 'viewer', userId: IDS.viewerUser, token: TOKEN, cookies: [cookie('auth_token', 'second-session'), cookie('ct0', 'second-csrf')], connectedAt: 0 }
const WRITER = IDS.authorUser
const SOMEONE = '200000077'
const TAB = 7

// A Replies-tab page as the page hook passes it on (capture.ts), from a page
// signed in as the user (content.ts adds viewerId)
const page = (replies: Array<{ id: string; parentId: string; to?: string; by?: string }>, extra: object = {}) => ({
    userId: WRITER,
    screenName: 'author',
    first: true,
    viewerId: me.userId,
    relation: { following: false, muting: false, blocking: false },
    tweets: replies.map(r => ({
        id: r.id,
        inReplyTo: r.parentId,
        inReplyToUserId: r.to ?? SOMEONE,
        authorId: r.by ?? WRITER,
        screenName: 'author',
        text: 'words that are never kept',
        createdAt: 'Mon Jan 05 12:00:00 +0000 2026',
    })),
    ...extra,
})
// the two recorded cases: a reply listed under its post, and one missing from it
const two = [
    { id: IDS.missingReply, parentId: IDS.missingParent },
    { id: IDS.listedReply, parentId: IDS.listedParent },
]
const answersAs = (who: 'user' | 'second') => ({
    [`${who} TweetDetail:${IDS.listedParent}:`]: ok(fixture('listed_thread')),
    [`${who} TweetDetail:${IDS.missingParent}:`]: ok(fixture('missing_parent_page1')),
    [`${who} TweetDetail:${IDS.missingParent}:cursor-1`]: ok(fixture('missing_parent_bottom')),
    [`${who} ModeratedTimeline:${IDS.missingParent}:`]: ok(fixture('hidden_empty')),
    [`${who} TweetDetail:${IDS.missingReply}:`]: ok(fixture('missing_reply_direct')),
})

// A recorded answer with the reading account's relation to one tweet's author
// on that author's record, the way live answers carry it (the scrubber drops it)
function withRelation(json: any, tweetId: string, relation: object) {
    const visit = (o: any) => {
        if (!o || typeof o !== 'object') return
        if (o.rest_id === tweetId && o.core?.user_results?.result) o.core.user_results.result.relationship_perspectives = relation
        Object.values(o).forEach(visit)
    }
    visit(json)
    return json
}

async function checkTab(tabId = TAB) {
    const started = await startAccountCheck(tabId)
    if (started.done) await settle(started.done)
    return started
}

beforeEach(() => {
    vi.useFakeTimers()
    browser.reset()
    browser.store.me = structuredClone(me)
    browser.store.second_account = structuredClone(second)
})
afterEach(() => {
    vi.useRealTimers()
})

describe('what the page hook passes on', () => {
    it('a Replies-tab page carries its profile, whether it is the first page, and how the user relates to the account', () => {
        const json = fixture('replies_tab')
        // X's record for the profile, with the relation live answers carried (2026-11-15)
        const visit = (o: any) => {
            if (!o || typeof o !== 'object') return
            if (o.__typename === 'User' && o.rest_id === IDS.viewerUser) o.relationship_perspectives = { following: true, followed_by: false, muting: false, blocking: false }
            Object.values(o).forEach(visit)
        }
        visit(json)
        const first = repliesTabCapture({ userId: IDS.viewerUser, count: 20 }, json)
        expect(first).toMatchObject({ userId: IDS.viewerUser, screenName: 'viewer', first: true })
        // only the follow, mute and block: whether the account follows the user isn't kept
        expect(first!.relation).toEqual({ following: true, muting: false, blocking: false })
        // each tweet says which account it answers
        expect(first!.tweets.find(t => t.id === '1900000000000000005')).toMatchObject({ inReplyTo: '1900000000000000004', inReplyToUserId: '1900000000000000006' })
        expect(repliesTabCapture({ userId: IDS.viewerUser, cursor: 'next' }, json)!.first).toBe(false)
        expect(repliesTabCapture({ userId: 'not an id' }, json)).toBeNull()
    })
})

describe('what a tab scrolled', () => {
    it('a first page starts the list and later pages add to it, newest first; a first page starts it over', async () => {
        await noteRepliesTab(TAB, page([{ id: '1900000000000000101', parentId: '1900000000000000100' }]), me)
        await noteRepliesTab(TAB, page([{ id: '1900000000000000103', parentId: '1900000000000000102' }], { first: false }), me)
        expect(browser.store.seen_tabs[TAB].replies.map((r: any) => r.id)).toEqual(['1900000000000000103', '1900000000000000101'])
        await noteRepliesTab(TAB, page([{ id: '1900000000000000105', parentId: '1900000000000000104' }]), me)
        expect(browser.store.seen_tabs[TAB].replies.map((r: any) => r.id)).toEqual(['1900000000000000105'])
    })

    it('keeps only the account’s replies to other accounts, as ids and times', async () => {
        await noteRepliesTab(
            TAB,
            page([
                { id: '1900000000000000201', parentId: '1900000000000000200' },
                // in its own thread, and a post by someone else on the page
                { id: '1900000000000000203', parentId: '1900000000000000202', to: WRITER },
                { id: '1900000000000000205', parentId: '1900000000000000204', by: SOMEONE },
            ]),
            me,
        )
        const seen = browser.store.seen_tabs[TAB]
        expect(seen.replies).toEqual([{ id: '1900000000000000201', parentId: '1900000000000000200', createdAt: Date.parse('Mon Jan 05 12:00:00 +0000 2026') }])
        expect(JSON.stringify(seen)).not.toContain('never kept')
    })

    it('the user’s own Replies tab isn’t kept here, and a closed tab or six hours ends what a tab scrolled', async () => {
        await noteRepliesTab(TAB, page(two, { userId: me.userId }), me)
        expect(browser.store.seen_tabs).toBeUndefined()
        await noteRepliesTab(TAB, page(two), me)
        await forgetTab(TAB)
        expect(browser.store.seen_tabs[TAB]).toBeUndefined()
        // a browser start: every tab is new
        await noteRepliesTab(TAB, page(two), me)
        await forgetAllTabs()
        expect(browser.store.seen_tabs).toBeUndefined()
        await noteRepliesTab(TAB, page(two), me, Date.now() - SEEN_TTL_MS - 1000)
        expect((await accountState(TAB)).seen).toBeNull()
    })
})

describe('who reads', () => {
    const seen = (relation: object, userId = WRITER, viewerId = me.userId) => ({ userId, relation, viewerId })
    it('a page signed in as another account says nothing of the user’s follows', () => {
        expect(readerFor(seen({ following: true }, WRITER, IDS.viewerUser), me, second)).toEqual({ reader: 'user', viewer: '@you' })
        expect(readerFor({ userId: WRITER, relation: { muting: true } }, me, null)).toEqual({ reader: 'user', viewer: '@you' })
    })
    it('the user, an outsider to another account’s replies, unless a follow, mute or block says otherwise', () => {
        expect(readerFor(seen({ following: false }), me, second)).toEqual({ reader: 'user', viewer: '@you' })
        expect(readerFor(seen({ following: true }), me, second)).toEqual({ reader: 'second', viewer: '@viewer' })
        expect(readerFor(seen({ muting: true }), me, second)).toEqual({ reader: 'second', viewer: '@viewer' })
        expect(readerFor(seen({ blocking: true }), me, second)).toEqual({ reader: 'second', viewer: '@viewer' })
    })
    it('with no second account, a follow reads as the user with a caveat, and a mute or block can’t be checked', () => {
        expect(readerFor(seen({ following: true }), me, null)).toEqual({ reader: 'user', viewer: '@you', follows: true })
        expect(readerFor(seen({ muting: true }), me, null)).toMatchObject({ refuse: 'needs_second' })
        expect(readerFor(seen({ blocking: true }), me, null)).toMatchObject({ refuse: 'needs_second' })
    })
    it('the second account is never the outsider to its own replies, and the user’s own aren’t checked here', () => {
        expect(readerFor(seen({ following: true }, IDS.viewerUser), me, second)).toEqual({ reader: 'user', viewer: '@you', follows: true })
        expect(readerFor(seen({}, me.userId), me, second)).toMatchObject({ refuse: 'own_account' })
        expect(readerFor(seen({}), null, second)).toMatchObject({ refuse: 'unknown_user' })
    })
})

describe('a check', () => {
    it('reads as the user, each reply in its parent’s list, and keeps ids, states and times', async () => {
        await noteRepliesTab(TAB, page(two), me)
        browser.answer(answersAs('user'))
        expect((await checkTab()).ok).toBe(true)
        expect(browser.fetched.every(k => k.startsWith('user '))).toBe(true)
        const results = browser.store.other_results
        expect(results[IDS.missingReply]).toMatchObject({ state: 'missing', writerId: WRITER, viewer: '@you', reader: 'user' })
        expect(results[IDS.listedReply]).toMatchObject({ state: 'listed', viewer: '@you' })
        expect(JSON.stringify(results)).not.toContain('never kept')
        expect(browser.store.account_run).toMatchObject({ state: 'done', total: 2, done: 2, findings: 1 })
        // the note on the page: the one X hides, as another account's reply
        expect(await otherNotes()).toEqual({ [IDS.missingReply]: expect.objectContaining({ state: 'missing', viewer: '@you', other: true }) })
    })

    it('a follow sends the reads through the second account', async () => {
        await noteRepliesTab(TAB, page(two, { relation: { following: true } }), me)
        browser.answer(answersAs('second'))
        await checkTab()
        expect(browser.fetched.length).toBeGreaterThan(0)
        expect(browser.fetched.every(k => k.startsWith('second '))).toBe(true)
        expect(browser.store.other_results[IDS.missingReply]).toMatchObject({ state: 'missing', viewer: '@viewer', reader: 'second' })
    })

    it('a click within the hour reads nothing again: a check stopped part way goes on where it stopped', async () => {
        await noteRepliesTab(TAB, page(two), me)
        browser.answer(answersAs('user'))
        await checkTab()
        const reads = browser.fetched.length
        await checkTab()
        expect(browser.fetched.length).toBe(reads)
        expect(browser.store.account_run).toMatchObject({ state: 'done', done: 2, findings: 1 })
        // after the hour, a click looks again (the results aged, not the
        // clock: the reads' pacing keeps the time of the last read)
        for (const r of Object.values<any>(browser.store.other_results)) r.at -= FRESH_MS + 1000
        await checkTab()
        expect(browser.fetched.length).toBeGreaterThan(reads)
    })

    it('covers the newest replies scrolled, up to its limit', async () => {
        const many = Array.from({ length: MAX_CHECKED + 5 }, (_, i) => ({ id: String(1900000000000000300n + BigInt(2 * i + 1)), parentId: String(1900000000000000300n + BigInt(2 * i)) }))
        await noteRepliesTab(TAB, page(many), me)
        // every read fails: two checks in a row that stop early end the run,
        // after the two newest replies
        browser.answer({})
        const started = await startAccountCheck(TAB)
        await settle(started.done!)
        expect(browser.store.account_run).toMatchObject({ total: MAX_CHECKED, done: 2, state: 'stopped', stop: 'failing' })
        expect(browser.fetched.map(k => k.split(':')[1])).toEqual([many[many.length - 1].parentId, many[many.length - 2].parentId])
    })

    it('a check that can’t say leaves an earlier answer standing, noted beside it', async () => {
        await noteRepliesTab(TAB, page([two[0]]), me)
        browser.store.other_results = {
            [IDS.missingReply]: { id: IDS.missingReply, writerId: WRITER, parentId: IDS.missingParent, state: 'missing', at: Date.now() - FRESH_MS - 1000, viewer: '@you', readerId: me.userId, reader: 'user', detail: '' },
        }
        browser.answer({ [`user TweetDetail:${IDS.missingParent}:`]: { status: 503 } })
        await checkTab()
        expect(browser.store.other_results[IDS.missingReply]).toMatchObject({ state: 'missing', lastTry: { detail: expect.stringContaining('HTTP 503') } })
        expect(Object.keys(await otherNotes())).toEqual([IDS.missingReply])
    })

    it('the hour’s reuse is for the same account only', async () => {
        await noteRepliesTab(TAB, page(two), me)
        browser.answer(answersAs('user'))
        await checkTab()
        const reads = browser.fetched.length
        // x.com in this browser is another of the user's accounts now
        const other = { userId: '200000010', screenName: 'other', at: 0 }
        browser.store.me = other
        await noteRepliesTab(TAB, page(two, { viewerId: other.userId }), other)
        await checkTab()
        expect(browser.fetched.length).toBeGreaterThan(reads)
        expect(browser.store.other_results[IDS.listedReply]).toMatchObject({ viewer: '@other', readerId: other.userId })
    })

    it('X’s answer says the user follows the writer after all: the check stops, and the next one reads as the second account', async () => {
        await noteRepliesTab(TAB, page([two[1]]), me)
        browser.answer({ [`user TweetDetail:${IDS.listedParent}:`]: ok(withRelation(fixture('listed_thread'), IDS.listedReply, { following: true })) })
        await checkTab()
        expect(browser.store.account_run).toMatchObject({ state: 'stopped', stop: 'reader_follows' })
        // that one reply, as a follower saw it
        expect(browser.store.other_results[IDS.listedReply]).toMatchObject({ state: 'listed', follows: true })
        expect((await accountState(TAB)).plan).toEqual({ reader: 'second', viewer: '@viewer' })
    })

    it('X’s answer says the account that looked mutes the writer: no verdict, and the check stops', async () => {
        await noteRepliesTab(TAB, page(two, { relation: { following: true } }), me)
        browser.answer({ ...answersAs('second'), [`second TweetDetail:${IDS.listedParent}:`]: ok(withRelation(fixture('listed_thread'), IDS.listedReply, { muting: true })) })
        await checkTab()
        expect(browser.store.account_run).toMatchObject({ state: 'stopped', stop: 'reader_mutes', done: 1 })
        expect(browser.store.other_results[IDS.listedReply]).toMatchObject({ state: 'unknown', detail: '@viewer mutes or blocks its writer' })
        expect(await otherNotes()).toEqual({})
    })

    it('a second account that follows the writer gets the follower’s caveat', async () => {
        await noteRepliesTab(TAB, page([two[1]], { relation: { following: true } }), me)
        browser.answer({ [`second TweetDetail:${IDS.listedParent}:`]: ok(withRelation(fixture('listed_thread'), IDS.listedReply, { following: true })) })
        await checkTab()
        expect(browser.store.other_results[IDS.listedReply]).toMatchObject({ state: 'listed', viewer: '@viewer', follows: true })
        expect(browser.store.account_run).toMatchObject({ state: 'done' })
    })

    it('a reply the user watches gets its note from its own check, not an account check', async () => {
        browser.store.other_results = {
            [IDS.missingReply]: { id: IDS.missingReply, writerId: WRITER, parentId: IDS.missingParent, state: 'missing', at: Date.now(), viewer: '@you', readerId: me.userId, reader: 'user', detail: '' },
        }
        expect(Object.keys(await otherNotes())).toEqual([IDS.missingReply])
        expect(await otherNotes(Date.now(), new Set([IDS.missingReply]))).toEqual({})
    })

    it('the latest check’s record goes after 30 days too, and clearing runs at most hourly', async () => {
        const old = Date.now() - RESULTS_TTL_MS - 1000
        browser.store.account_run = { userId: WRITER, screenName: 'author', tabId: TAB, reader: 'user', readerId: me.userId, viewer: '@you', startedAt: old, updatedAt: old, total: 2, done: 2, findings: 0, state: 'done' }
        await pruneAccountChecks()
        expect(browser.store.account_run).toBeUndefined()
        browser.store.other_results = { [IDS.missingReply]: { id: IDS.missingReply, writerId: WRITER, parentId: IDS.missingParent, state: 'missing', at: old, viewer: '@you', readerId: me.userId, reader: 'user', detail: '' } }
        // within the hour: left for the next clearing
        await pruneAccountChecks()
        expect(Object.keys(browser.store.other_results)).toEqual([IDS.missingReply])
        await pruneAccountChecks(Date.now() + HOUR + 1000)
        expect(browser.store.other_results).toEqual({})
    })

    it('stops at its own read limit, before a check that might pass it', async () => {
        await noteRepliesTab(TAB, page(two), me)
        browser.answer(answersAs('user'))
        browser.store.read_log = { user: Array(USER_READS_CAP - ONE_CHECK_READS + 1).fill(Date.now()) }
        await checkTab()
        expect(browser.fetched).toEqual([])
        expect(browser.store.account_run).toMatchObject({ state: 'stopped', stop: 'read_limit', done: 0 })
    })

    it('as the second account, it leaves the rounds most of that account’s reads', async () => {
        await noteRepliesTab(TAB, page(two, { relation: { following: true } }), me)
        browser.answer(answersAs('second'))
        browser.store.read_log = { second: Array(SECOND_READS_CAP - ONE_CHECK_READS + 1).fill(Date.now()) }
        await checkTab()
        expect(browser.fetched).toEqual([])
        expect(browser.store.account_run).toMatchObject({ state: 'stopped', stop: 'read_limit' })
    })

    it('a pause X asks for stops it, and the user’s status says so', async () => {
        await noteRepliesTab(TAB, page(two), me)
        browser.answer({ [`user TweetDetail:${IDS.listedParent}:`]: { status: 429, json: { errors: [{ code: 88, message: 'Rate limit exceeded' }] } } })
        await checkTab()
        expect(browser.fetched).toEqual([`user TweetDetail:${IDS.listedParent}:`])
        expect(browser.store.account_run).toMatchObject({ state: 'stopped', stop: 'rate_limited', done: 1 })
        expect(browser.store.user_status).toMatchObject({ state: 'rate_limited' })
        // and the next click waits for the pause to end
        expect(await startAccountCheck(TAB)).toMatchObject({ ok: false, error: 'user_trouble' })
    })

    it('one check at a time', async () => {
        await noteRepliesTab(TAB, page(two), me)
        browser.answer(answersAs('user'))
        const first = await startAccountCheck(TAB)
        expect(await startAccountCheck(TAB)).toMatchObject({ ok: false, error: 'already_checking' })
        await settle(first.done!)
    })

    it('says why it can’t begin', async () => {
        expect(await startAccountCheck(TAB)).toMatchObject({ ok: false, error: 'no_replies_tab' })
        await noteRepliesTab(TAB, page(two, { relation: { muting: true } }), me)
        delete browser.store.second_account
        expect(await startAccountCheck(TAB)).toMatchObject({ ok: false, error: 'needs_second' })
        browser.store.connect_pending = { started: Date.now(), main: [], mainUserId: me.userId }
        expect(await startAccountCheck(TAB)).toMatchObject({ ok: false, error: 'connecting' })
    })

    it('a check the background lost shows as cut off', async () => {
        await noteRepliesTab(TAB, page(two), me)
        browser.store.account_run = { userId: WRITER, screenName: 'author', tabId: TAB, reader: 'user', viewer: '@you', startedAt: 0, updatedAt: 0, total: 2, done: 1, findings: 0, state: 'running' }
        expect((await accountState(TAB)).run).toMatchObject({ state: 'stopped', stop: 'cut_off' })
    })

    it('results go after 30 days, with their notes', async () => {
        const old = Date.now() - RESULTS_TTL_MS - 1000
        browser.store.other_results = {
            [IDS.missingReply]: { id: IDS.missingReply, writerId: WRITER, parentId: IDS.missingParent, state: 'missing', at: old, viewer: '@you', reader: 'user', detail: '' },
            [IDS.listedReply]: { id: IDS.listedReply, writerId: WRITER, parentId: IDS.listedParent, state: 'probable_spam', at: Date.now() - DAY, viewer: '@you', reader: 'user', detail: '' },
        }
        expect(Object.keys(await otherNotes())).toEqual([IDS.listedReply])
        await pruneAccountChecks()
        expect(Object.keys(browser.store.other_results)).toEqual([IDS.listedReply])
    })

    it('rule: a check sends only TweetDetail and ModeratedTimeline reads, as the account its plan names', async () => {
        for (const relation of [{ following: false }, { following: true }]) {
            browser.fetched.length = 0
            browser.store.other_results = {}
            await noteRepliesTab(TAB, page(two, { relation }), me)
            browser.answer({ ...answersAs('user'), ...answersAs('second') })
            await checkTab()
            const who = relation.following ? 'second' : 'user'
            expect(browser.fetched.length).toBeGreaterThan(0)
            for (const k of browser.fetched) expect(k).toMatch(new RegExp(`^${who} (TweetDetail|ModeratedTimeline):`))
        }
    })
})

describe('the Replies tab, opened for the user', () => {
    it('only an x.com tab, and only to an account’s Replies tab', async () => {
        browser.openTabs.push({ id: 5, url: 'https://x.com/author', active: true, windowId: 1 }, { id: 6, url: 'https://example.com/', active: false, windowId: 1 })
        expect(await openRepliesTab(5, 'author')).toEqual({ ok: true })
        expect(browser.tabCalls).toEqual(['update 5 https://x.com/author/with_replies'])
        expect(await openRepliesTab(6, 'author')).toMatchObject({ ok: false })
        expect(await openRepliesTab(5, 'not/a name')).toMatchObject({ ok: false })
    })
})

describe('words', () => {
    it('an account check says what the account that looked saw, and nothing of what the writer sees', () => {
        const all = (['listed', 'probable_spam', 'missing', 'hidden_by_author', 'unavailable', 'deleted', 'parent_unavailable', 'unknown'] as const).map(s =>
            explainOther(s, '@you', { section: 'Probable spam' }),
        )
        for (const text of all) expect(text).not.toMatch(/its author sees|shows it to its author|for you,/i)
        expect(explainOther('missing', '@you')).toBe(
            "@you doesn't see it under the post at all, in any order, though its writer's Replies tab lists it and it opens from a direct link.",
        )
    })
    it('a follower’s caveat goes on a listed reply only', () => {
        expect(explainOther('listed', '@you', { follows: true })).toContain('X may show followers replies it hides from others')
        expect(explainOther('probable_spam', '@you', { follows: true })).not.toContain('followers')
    })
    it('a profile’s address, and x.com’s own pages that look like one', () => {
        expect(profileFromUrl('https://x.com/author')).toBe('author')
        expect(profileFromUrl('https://x.com/author/with_replies')).toBe('author')
        expect(profileFromUrl('https://x.com/author/with_replies?x=1')).toBe('author')
        expect(profileFromUrl('https://x.com/home')).toBeNull()
        expect(profileFromUrl('https://x.com/author/status/1')).toBeNull()
        expect(profileFromUrl('https://example.com/author')).toBeNull()
        expect(profileFromUrl(undefined)).toBeNull()
        // six hours, for the record of what a tab scrolled
        expect(SEEN_TTL_MS).toBe(6 * HOUR)
    })
})
