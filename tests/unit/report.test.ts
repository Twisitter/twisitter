// The diagnostic log (diaglog.ts) and the problem report (report.ts) against
// the stand-in browser: what a round, a read and an event leave in the log,
// the hour's one line, and that neither the log nor the report's status
// names an account.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { disconnectSecond } from '../../src/src/connect'
import { getLogLines, HOUR_KEY, LOG_KEY, logEvent, MAX_LINES, noteRead, noteRound } from '../../src/src/diaglog'
import { notePageUser, runTick } from '../../src/src/monitor'
import { browserName, FEEDBACK_URL, newestLines, openReport, reportUrl, statusSummary } from '../../src/src/report'
import { HOUR, MINUTE } from '../../src/src/store'
import { fakeBrowser, settle } from './browser'
import { fixture, IDS, ok } from './helpers'

const browser = fakeBrowser()
const TOKEN = '0123456789abcdef0123456789abcdef'
const cookie = (name: string, value: string) => ({ name, value, domain: '.x.com', path: '/', secure: true, httpOnly: name === 'auth_token', hostOnly: false })
// names no log line may hold
const me = { userId: IDS.authorUser, screenName: 'zzmine', at: 0 }
const second = { screenName: 'zzsecond', userId: IDS.viewerUser, token: TOKEN, cookies: [cookie('auth_token', 'second-session'), cookie('ct0', 'second-csrf')], connectedAt: 0 }
const SECRETS = [me.screenName, me.userId, second.screenName, second.userId, TOKEN, 'second-session', 'second-csrf', 'words that are never kept']

const missingAsSecond = {
    [`second TweetDetail:${IDS.missingParent}:`]: ok(fixture('missing_parent_page1')),
    [`second TweetDetail:${IDS.missingParent}:cursor-1`]: ok(fixture('missing_parent_bottom')),
    [`second ModeratedTimeline:${IDS.missingParent}:`]: ok(fixture('hidden_empty')),
    [`second TweetDetail:${IDS.missingReply}:`]: ok(fixture('missing_reply_direct')),
}
const tracked = (id: string, parentId: string, extra: object = {}) => ({
    id,
    parentId,
    authorId: me.userId,
    screenName: me.screenName,
    text: 'words that are never kept',
    capturedAt: Date.now() - 5 * MINUTE,
    nextCheckAt: Date.now() - 1000,
    checks: 0,
    source: 'posted',
    ...extra,
})

// an hour's start, and a time inside it
const H = Date.UTC(2026, 10, 16, 20)
const at = (min: number) => H + min * MINUTE

beforeEach(() => {
    vi.useFakeTimers()
    browser.reset()
})
afterEach(() => {
    vi.useRealTimers()
})

describe('the diagnostic log', () => {
    it('a quiet round only counts; one that finds something, changes or stops gets a line', async () => {
        await noteRound([], 'no_second_account', at(1))
        await noteRound([{ id: '1000000000000000005', state: 'listed', was: 'listed', reads: 1 }], undefined, at(2))
        expect(browser.store[LOG_KEY]).toBeUndefined()
        await noteRound([{ id: '1000000000000000005', state: 'missing', was: 'listed', reads: 4 }], undefined, at(3))
        await noteRound([{ id: '1000000000000000006', state: 'unknown', reads: 1, stop: 'rate_limited' }], 'read_budget', at(4))
        expect(browser.store[LOG_KEY]).toEqual([
            '11-16 20:03 round · #1000000000000000005 listed → missing (4 reads)',
            '11-16 20:04 round · #1000000000000000006 unknown (1 read, stopped: rate_limited) · then: read_budget',
        ])
        const hour = browser.store[HOUR_KEY]
        expect(hour).toMatchObject({ at: H, rounds: 4, checks: { listed: 1 }, skipped: { no_second_account: 1, read_budget: 1 } })
    })

    it('an hour that’s over is written out as one line, and the hour running shows last, so far', async () => {
        await noteRead('second', 'TweetDetail', 'ok', 200, at(5))
        await noteRead('second', 'TweetDetail', 'rate_limited', 429, at(6))
        await noteRead('user', 'TweetDetail', 'not_sent', 0, at(7))
        await noteRead('user', 'UserRepliesTimeline', 'error', 503, at(8))
        await noteRound([], undefined, at(9))
        await logEvent('browser started', at(70))
        const lines = await getLogLines()
        expect(lines).toEqual([
            '11-16 20:00–20:59 · 1 round · reads: second TweetDetail 2, user UserRepliesTimeline 1 · not ok: second TweetDetail rate_limited 1, user TweetDetail not_sent 1, user UserRepliesTimeline error 503 1',
            '11-16 21:10 browser started',
            '11-16 21:00–21:59 · 0 rounds so far',
        ])
    })

    it('keeps the newest lines, MAX_LINES of them', async () => {
        browser.store[LOG_KEY] = Array.from({ length: MAX_LINES }, (_, i) => `line ${i}`)
        await logEvent('the newest', at(1))
        const lines = browser.store[LOG_KEY]
        expect(lines).toHaveLength(MAX_LINES)
        expect(lines[0]).toBe('line 1')
        expect(lines.at(-1)).toBe('11-16 20:01 the newest')
    })

    it('a round, a sign-in’s end and the account’s comings and goings name no account', async () => {
        browser.store.me = structuredClone(me)
        browser.store.second_account = structuredClone(second)
        browser.store.tracked = { [IDS.missingReply]: tracked(IDS.missingReply, IDS.missingParent) }
        browser.answer(missingAsSecond)
        await settle(runTick())
        // x.com here signs in to the second account, then the user again
        await notePageUser({ userId: second.userId, screenName: second.screenName })
        await notePageUser({ userId: me.userId, screenName: me.screenName, graduated: false })
        await disconnectSecond()
        const lines = await getLogLines()
        const text = lines.join('\n')
        expect(text).toMatch(new RegExp(`round · #${IDS.missingReply} missing \\(\\d+ reads\\)`))
        expect(text).toContain('x.com here is signed in to the second account, so reads as you wait')
        expect(text).toContain('your account: an x.com page is signed in as you, after other_account')
        expect(text).toContain('second account disconnected')
        expect(text).toMatch(/reads: .*second TweetDetail \d/)
        for (const secret of SECRETS) expect(text).not.toContain(secret)
        expect(text).not.toContain('@')
    })
})

describe('when an x.com page last showed the account', () => {
    it('is noted at most hourly: a page an hour on rewrites it, one sooner writes nothing', async () => {
        browser.store.me = { ...me, at: Date.now() - 2 * HOUR }
        await notePageUser({ userId: me.userId, screenName: me.screenName })
        const noted = browser.store.me.at
        expect(noted).toBeGreaterThan(Date.now() - MINUTE)
        browser.store.me = { ...browser.store.me, at: noted - 10 * MINUTE }
        await notePageUser({ userId: me.userId, screenName: me.screenName })
        expect(browser.store.me.at).toBe(noted - 10 * MINUTE)
    })
})

describe('the problem report', () => {
    it('names the browser and system from the user agent', () => {
        expect(browserName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36')).toBe('Chrome 142, macOS')
        expect(browserName('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0')).toBe('Firefox 145, Windows')
        expect(browserName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0')).toBe('Edge 142, Windows')
        expect(browserName('')).toBe('unknown browser')
    })

    it('keeps the newest log lines that fit, and says how many older ones were left out', () => {
        expect(newestLines(['one', 'two', 'three'], 100)).toBe('one\ntwo\nthree')
        expect(newestLines(['one', 'two', 'three'], 11)).toBe('(1 older line left out)\ntwo\nthree')
        expect(newestLines(['one', 'two', 'three'], 7)).toBe('(2 older lines left out)\nthree')
    })

    it('opens the bare form, with nothing in its link, when the browser’s setting keeps the details', async () => {
        browser.store.diag_log = ['11-16 20:00 a line that must not leave']
        await openReport(false)
        expect(browser.tabCalls).toEqual([`create 100 ${FEEDBACK_URL}`])
    })

    it('carries the details in the link’s #fragment, as base64url JSON', () => {
        const d = { v: '0.0.1', b: 'Chrome 142, macOS', s: 'status ✓', l: 'a line\nanother', t: 1 }
        const url = reportUrl(d)
        expect(url.startsWith('https://twisitter.com/feedback#r=')).toBe(true)
        const b64 = url.split('#r=')[1]
        expect(b64).toMatch(/^[A-Za-z0-9_-]+$/)
        const json = new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)))
        expect(JSON.parse(json)).toEqual(d)
    })

    it('its status says how things stand, without naming an account', async () => {
        const now = Date.now()
        browser.store.me = { ...me, at: now - 2 * HOUR, graduated: false }
        browser.store.second_account = { ...second, connectedAt: now - 3 * HOUR }
        browser.store.second_status = { state: 'rate_limited', at: now, until: now + 10 * MINUTE }
        browser.store.tracked = {
            a: tracked('1000000000000000031', '1000000000000000030', { last: { state: 'listed', at: now, viewer: '@zzsecond' }, nextCheckAt: now + 30 * MINUTE }),
            b: tracked('1000000000000000041', '1000000000000000040', { source: 'link', nextCheckAt: now + 2 * HOUR }),
        }
        browser.store.last_tick = now - 4 * MINUTE
        browser.store.account_run = { userId: '200000077', screenName: 'zzwriter', tabId: 7, reader: 'user', readerId: me.userId, viewer: '@zzmine', startedAt: now - MINUTE, updatedAt: now - MINUTE, total: 3, done: 2, findings: 0, state: 'stopped', stop: 'read_limit' }
        const s = await statusSummary(now)
        expect(s).toContain('Your account: last noted on x.com 2 h ago (noted at most hourly) · X holds it back (no graduated access) · X answers normally')
        expect(s).toContain('Second account: connected 3 h ago · X asked for a pause, until')
        expect(s).toContain('Watching 2 replies (posted 1, link 1) · last checks: listed 1, not checked yet 1')
        expect(s).toContain('Rounds: last 4 min ago · next check due in 30 min · round timer missing')
        expect(s).toContain('Account check: last 1 min ago as you, 2 of 3 checked, stopped: read_limit · 0 results kept')
        for (const secret of [...SECRETS, 'zzwriter', '200000077']) expect(s).not.toContain(secret)
        expect(s).not.toContain('@')
    })
})
