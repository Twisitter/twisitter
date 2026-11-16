// The background's rounds against a stand-in browser (browser.ts): whose
// session each read carries, and what a round keeps when it can't finish.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isFinding } from '../../src/src/check'
import { applySecondAccount, disconnectSecond } from '../../src/src/connect'
import { accountTrouble, notePageUser, runTick, trackByLink } from '../../src/src/monitor'
import { readAsSecond, readAsUser, SECOND_RULE_ID } from '../../src/src/requests'
import { DAY, HOUR, MINUTE, retryAt } from '../../src/src/store'
import { tweetDetailVariables } from '../../src/src/x-api'
import { fakeBrowser, settle } from './browser'
import { fixture, IDS, ok } from './helpers'

const browser = fakeBrowser()
const TOKEN = '0123456789abcdef0123456789abcdef'
const cookie = (name: string, value: string) => ({ name, value, domain: '.x.com', path: '/', secure: true, httpOnly: name === 'auth_token', hostOnly: false })
const me = { userId: IDS.authorUser, screenName: 'author', at: 0 }
const second = { screenName: 'viewer', userId: IDS.viewerUser, token: TOKEN, cookies: [cookie('auth_token', 'second-session'), cookie('ct0', 'second-csrf')], connectedAt: 0 }
const signedOut = { status: 401, json: { errors: [{ code: 32, message: 'Could not authenticate you.' }] } }

const reply = (id: string, parentId: string, authorId: string, extra: object = {}) => ({
    id,
    parentId,
    authorId,
    capturedAt: Date.now() - 5 * MINUTE,
    nextCheckAt: Date.now() - 1000,
    checks: 0,
    source: 'posted',
    ...extra,
})
// a reply its author sees listed and no one else sees anywhere (check.test.ts)
const missingAsSecond = {
    [`second TweetDetail:${IDS.missingParent}:`]: ok(fixture('missing_parent_page1')),
    [`second TweetDetail:${IDS.missingParent}:cursor-1`]: ok(fixture('missing_parent_bottom')),
    [`second ModeratedTimeline:${IDS.missingParent}:`]: ok(fixture('hidden_empty')),
    [`second TweetDetail:${IDS.missingReply}:`]: ok(fixture('missing_reply_direct')),
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

describe('replies that can’t be checked now', () => {
    it('a reply the second account wrote waits while the user’s session is down, and doesn’t hold up the rest', async () => {
        browser.store.user_status = { state: 'signed_out', at: Date.now() }
        // added by link, written by the second account, due first
        const theirs = reply('1000000000000000077', '1000000000000000076', IDS.viewerUser, { source: 'link', nextCheckAt: Date.now() - 2000 })
        const mine = reply(IDS.listedReply, IDS.listedParent, IDS.authorUser)
        browser.store.tracked = { [theirs.id]: theirs, [mine.id]: mine }
        browser.answer({ [`second TweetDetail:${IDS.listedParent}:`]: ok(fixture('listed_thread')) })
        const report = await settle(runTick())
        expect(report.checked).toEqual([expect.objectContaining({ id: IDS.listedReply, state: 'listed' })])
        // nothing as the user, whose session X stopped taking
        expect(browser.fetched).toEqual([`second TweetDetail:${IDS.listedParent}:`])
        expect(browser.store.tracked[theirs.id].nextCheckAt).toBe(theirs.nextCheckAt)
    })
})

describe('who the user is', () => {
    it('a page signed in as the second account never becomes the user, and reads as the user wait until the user is back', async () => {
        await notePageUser({ userId: IDS.viewerUser, screenName: 'viewer' })
        expect(browser.store.me).toMatchObject({ userId: IDS.authorUser, screenName: 'author' })
        expect(await accountTrouble('user')).toMatchObject({ state: 'other_account', detail: '@viewer' })

        browser.store.tracked = { [IDS.listedReply]: reply(IDS.listedReply, IDS.listedParent, IDS.authorUser) }
        browser.answer({ [`second TweetDetail:${IDS.listedParent}:`]: ok(fixture('listed_thread')) })
        await settle(runTick({ force: true }))
        // no Replies-tab read and no author view: each would carry the second
        // account's session as if it were the user's
        expect(browser.fetched.filter(k => k.startsWith('user '))).toEqual([])

        await notePageUser({ userId: IDS.authorUser, screenName: 'author' })
        expect(await accountTrouble('user')).toBeNull()
    })

    it('meanwhile, a read with the browser’s cookies that X answers doesn’t end the wait: it carried the second account’s session', async () => {
        await notePageUser({ userId: IDS.viewerUser, screenName: 'viewer' })
        browser.answer({ [`user TweetDetail:${IDS.listedReply}:`]: ok(fixture('listed_thread')) })
        expect(await settle(trackByLink(`https://x.com/author/status/${IDS.listedReply}`))).toEqual({ ok: true, id: IDS.listedReply })
        expect(await accountTrouble('user')).toMatchObject({ state: 'other_account' })
    })
})

describe('Disconnect and the header rule', () => {
    it('a Disconnect during a round: the answer for the old account isn’t kept, nothing more is read as it, and its rule stays gone', async () => {
        await applySecondAccount()
        expect(browser.rules.map(r => r.id)).toEqual([SECOND_RULE_ID])
        browser.store.tracked = { [IDS.missingReply]: reply(IDS.missingReply, IDS.missingParent, IDS.authorUser) }
        browser.answer({
            ...missingAsSecond,
            [`second TweetDetail:${IDS.missingParent}:`]: async () => {
                // the user clicks Disconnect while X answers the first read
                await disconnectSecond()
                return signedOut
            },
        })
        const report = await settle(runTick({ only: IDS.missingReply }))
        expect(browser.fetched).toEqual([`second TweetDetail:${IDS.missingParent}:`])
        expect(report.checked).toEqual([expect.objectContaining({ state: 'unknown', stop: 'error' })])
        // that 401 was for an account no longer connected: no status for anyone
        expect(browser.store.second_status).toBeUndefined()
        expect(browser.rules).toEqual([])
    })

    it('a read for an account that’s no longer connected isn’t sent, and doesn’t bring its rule back', async () => {
        await applySecondAccount()
        await disconnectSecond()
        const answer = await settle(readAsSecond(second, 'TweetDetail', tweetDetailVariables(IDS.missingParent)))
        expect(answer.failure).toMatch(/^not sent/)
        expect(browser.fetched).toEqual([])
        expect(browser.rules).toEqual([])
    })

    it('a worker that starts with no account connected removes a rule left from before', async () => {
        browser.rules.push({ id: SECOND_RULE_ID, action: { type: 'modifyHeaders', requestHeaders: [{ header: 'cookie', operation: 'set', value: 'old' }] }, condition: { regexFilter: 'old' } })
        delete browser.store.second_account
        await applySecondAccount()
        expect(browser.rules).toEqual([])
    })

    it('the first read after the browser restarts puts the account’s rule back', async () => {
        // session rules end with the browser; the stored account doesn't
        browser.answer({ [`second TweetDetail:${IDS.listedParent}:`]: ok(fixture('listed_thread')) })
        await settle(readAsSecond(second, 'TweetDetail', tweetDetailVariables(IDS.listedParent)))
        expect(browser.fetched).toEqual([`second TweetDetail:${IDS.listedParent}:`])
        expect(browser.rules).toEqual([
            expect.objectContaining({
                id: SECOND_RULE_ID,
                action: expect.objectContaining({ requestHeaders: [{ header: 'cookie', operation: 'set', value: 'auth_token=second-session; ct0=second-csrf' }] }),
                condition: expect.objectContaining({ regexFilter: expect.stringContaining(TOKEN) }),
            }),
        ])
    })
})

describe('a second account’s sign-in', () => {
    const signingIn = () => ({ started: Date.now(), main: [], mainUserId: IDS.authorUser })

    it('reads as the user aren’t sent while it’s open', async () => {
        browser.store.connect_pending = signingIn()
        const answer = await settle(readAsUser('TweetDetail', tweetDetailVariables(IDS.listedParent)))
        expect(answer.failure).toMatch(/^not sent/)
        expect(browser.fetched).toEqual([])
        expect(browser.store.user_status).toBeUndefined()
    })

    it('one that opens during a round: the round’s reads as the user wait, and the user’s session isn’t marked signed out', async () => {
        browser.store.tracked = { [IDS.missingReply]: reply(IDS.missingReply, IDS.missingParent, IDS.authorUser) }
        browser.answer({
            ...missingAsSecond,
            [`second TweetDetail:${IDS.missingParent}:`]: () => {
                browser.store.connect_pending = signingIn()
                return ok(fixture('missing_parent_page1'))
            },
            // with the user's cookies out of the browser, X would say signed out
            [`user TweetDetail:${IDS.missingParent}:`]: signedOut,
        })
        await settle(runTick({ only: IDS.missingReply }))
        expect(browser.fetched.filter(k => k.startsWith('user '))).toEqual([])
        expect(browser.store.user_status).toBeUndefined()
    })

    it('a reply link added while it’s open waits', async () => {
        browser.store.connect_pending = signingIn()
        expect(await settle(trackByLink(`https://x.com/author/status/${IDS.listedReply}`))).toEqual({ ok: false, error: 'connecting' })
        expect(browser.fetched).toEqual([])
    })
})

describe('a check that can’t finish', () => {
    it('keeps the answer before it, and tries again less often each time in a row', async () => {
        const found = { state: 'probable_spam', section: 'Probable spam', authorSees: true, reads: 3, detail: 'only behind "Probable spam"', at: Date.now() - HOUR, viewer: '@viewer' }
        browser.store.tracked = { [IDS.missingReply]: reply(IDS.missingReply, IDS.missingParent, IDS.authorUser, { capturedAt: Date.now() - 2 * DAY, last: found }) }
        browser.answer({ [`second TweetDetail:${IDS.missingParent}:`]: { status: 503 } })

        await settle(runTick({ only: IDS.missingReply }))
        let t = browser.store.tracked[IDS.missingReply]
        expect(t.last).toEqual(found)
        expect(isFinding(t.last)).toBe(true)
        expect(t.lastTry).toMatchObject({ state: 'unknown', stop: 'error' })
        expect(t.stops).toBe(1)
        expect(t.nextCheckAt - t.lastTry.at).toBe(15 * MINUTE)

        await settle(runTick({ only: IDS.missingReply }))
        t = browser.store.tracked[IDS.missingReply]
        expect(t.stops).toBe(2)
        expect(t.nextCheckAt - t.lastTry.at).toBe(30 * MINUTE)

        // one that finishes takes over, and the retries are done
        browser.answer({ ...missingAsSecond, [`user TweetDetail:${IDS.missingParent}:`]: ok(fixture('author_view_parent')) })
        await settle(runTick({ only: IDS.missingReply }))
        t = browser.store.tracked[IDS.missingReply]
        expect(t.last).toMatchObject({ state: 'missing', authorSees: true })
        expect(t.lastTry).toBeUndefined()
        expect(t.stops).toBeUndefined()
    })

    it('retries go from a quarter hour to half a day, never past the next step, and end after the month', () => {
        const now = 10 * DAY
        expect(retryAt(0, 1, now) - now).toBe(15 * MINUTE)
        expect(retryAt(0, 2, now) - now).toBe(30 * MINUTE)
        expect(retryAt(0, 7, now) - now).toBe(12 * HOUR)
        // the two-week step comes first
        expect(retryAt(0, 7, 14 * DAY - HOUR)).toBe(14 * DAY)
        // past the month: seven tries in a row, then it's left
        expect(retryAt(0, 3, 40 * DAY) - 40 * DAY).toBe(HOUR)
        expect(retryAt(0, 8, 40 * DAY)).toBe(Number.MAX_SAFE_INTEGER)
    })
})

// A reply the user didn't write has no view of its writer's to go on, so its
// notification says nothing about what they see
describe('the notification a round sends', () => {
    it('calls the user’s own reply theirs', async () => {
        browser.store.tracked = { [IDS.missingReply]: reply(IDS.missingReply, IDS.missingParent, IDS.authorUser, { text: 'Mine.' }) }
        browser.answer({ ...missingAsSecond, [`user TweetDetail:${IDS.missingParent}:`]: ok(fixture('author_view_parent')) })
        await settle(runTick({ only: IDS.missingReply }))
        expect(browser.notes).toEqual([{ title: 'X is hiding one of your replies', message: 'Your reply "Mine." shows for you, but others don\'t see it under the post.' }])
    })

    it('calls a reply someone else wrote, added by its link, one the user watches', async () => {
        browser.store.tracked = {
            [IDS.missingReply]: reply(IDS.missingReply, IDS.missingParent, '300000003', { text: 'Theirs.', screenName: 'someone', source: 'link' }),
        }
        browser.answer(missingAsSecond)
        await settle(runTick({ only: IDS.missingReply }))
        expect(browser.notes).toEqual([{ title: 'X is hiding a reply you watch', message: 'Others don\'t see the reply "Theirs." by @someone under the post.' }])
    })
})
