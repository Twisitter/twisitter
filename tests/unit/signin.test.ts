// Sign-ins finish on X's session cookie (connect.ts, setup.ts), never on a
// page's address: X's login pages change addresses (they did on 2026-11-15),
// and a reload keyed to them started every sign-in over. The cookie only says
// when to look; who signed in still comes from X's own page.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectSessionSet, connectSignedInNow, HOME_URL, isXSessionSet, LOAD_AFTER_SESSION_MS, LOGIN_URL } from '../../src/src/connect'
import { onSetupTabUrl, openX, SETUP_URL, setupSessionSet, setupSignedIn, signInOnX } from '../../src/src/setup'
import { fakeBrowser } from './browser'

const browser = fakeBrowser()
const LOGIN_TAB = 50
// a second account's sign-in, open in LOGIN_TAB
const signingIn = (started = 1000) => ({ started, main: [], mainUserId: '200000002', tabId: LOGIN_TAB })
const lastCall = () => browser.tabCalls[browser.tabCalls.length - 1]

beforeEach(() => {
    browser.reset()
    vi.useFakeTimers()
    browser.openTabs.push({ id: LOGIN_TAB, url: 'https://x.com/i/jf/onboarding/web?mode=login', active: true, windowId: 1 })
})
afterEach(() => {
    vi.useRealTimers()
})

describe('X’s session cookie', () => {
    it('is auth_token set on x.com', () => {
        const change = (name: string, domain: string, removed = false) => ({ removed, cookie: { name, domain } })
        expect(isXSessionSet(change('auth_token', '.x.com'))).toBe(true)
        expect(isXSessionSet(change('auth_token', 'x.com'))).toBe(true)
        // taken out, as a sign-in starts
        expect(isXSessionSet(change('auth_token', '.x.com', true))).toBe(false)
        expect(isXSessionSet(change('ct0', '.x.com'))).toBe(false)
        expect(isXSessionSet(change('auth_token', '.twitter.com'))).toBe(false)
        expect(isXSessionSet(change('auth_token', '.notx.com'))).toBe(false)
    })
})

describe('the second account’s sign-in', () => {
    it('leaves the login tab alone until X’s session appears, then gives X a moment before loading x.com/home there', async () => {
        browser.store.connect_pending = signingIn()
        await connectSessionSet()
        await vi.advanceTimersByTimeAsync(LOAD_AFTER_SESSION_MS - 1)
        expect(browser.tabCalls).toEqual([])
        await vi.advanceTimersByTimeAsync(1)
        expect(browser.tabCalls).toEqual([`update ${LOGIN_TAB} ${HOME_URL}`])
    })

    it('loads nothing once the sign-in has ended (X’s own page said who, or the user’s login went back)', async () => {
        browser.store.connect_pending = signingIn()
        await connectSessionSet()
        delete browser.store.connect_pending
        await vi.advanceTimersByTimeAsync(LOAD_AFTER_SESSION_MS)
        expect(browser.tabCalls).toEqual([])
        // a new sign-in started meanwhile isn't this one either
        await connectSessionSet()
        browser.store.connect_pending = signingIn(2000)
        await vi.advanceTimersByTimeAsync(LOAD_AFTER_SESSION_MS)
        expect(browser.tabCalls).toEqual([])
    })

    it('does nothing with no sign-in open', async () => {
        await connectSessionSet()
        await vi.advanceTimersByTimeAsync(LOAD_AFTER_SESSION_MS)
        expect(browser.tabCalls).toEqual([])
    })

    it('“I’ve signed in” loads x.com/home at once with X’s session in the browser, and without one only at the user’s word', async () => {
        browser.store.connect_pending = signingIn()
        // no session yet: loading the page would lose the user's place on X's login page
        expect(await connectSignedInNow()).toEqual({ ok: false, error: 'no_session_yet' })
        expect(browser.tabCalls).toEqual([])
        expect(await connectSignedInNow(true)).toEqual({ ok: true })
        expect(lastCall()).toBe(`update ${LOGIN_TAB} ${HOME_URL}`)
        browser.cookieJar.set('auth_token', 'second-session')
        expect(await connectSignedInNow()).toEqual({ ok: true })
        expect(browser.tabCalls).toHaveLength(2)
        delete browser.store.connect_pending
        expect(await connectSignedInNow()).toEqual({ ok: false, error: 'not_connecting' })
    })
})

describe('step 1’s sign-in', () => {
    const welcome = { tabId: 7, windowId: 1 }
    beforeEach(() => {
        browser.openTabs.push({ id: 7, url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/src/popup.html#welcome', active: true, windowId: 1 })
    })
    const signInFromStep1 = async () => {
        await openX(welcome)
        await onSetupTabUrl(100, 'https://x.com/')
        await signInOnX(welcome)
        expect(lastCall()).toBe(`update 100 ${LOGIN_URL} front`)
    }

    it('never reloads or loads anything on an address, /home included', async () => {
        await signInFromStep1()
        const before = browser.tabCalls.length
        for (const url of ['https://x.com/i/flow/login', 'https://x.com/i/jf/onboarding/web?mode=login', SETUP_URL]) await onSetupTabUrl(100, url)
        await vi.advanceTimersByTimeAsync(10_000)
        expect(browser.tabCalls).toHaveLength(before)
    })

    it('loads x.com/home in its tab once X’s session appears, unless a page said who first', async () => {
        await signInFromStep1()
        await setupSessionSet()
        await vi.advanceTimersByTimeAsync(LOAD_AFTER_SESSION_MS)
        expect(lastCall()).toBe(`update 100 ${SETUP_URL}`)
        // a page said who first: the welcome page comes back, and nothing more loads
        const before = browser.tabCalls.length
        await setupSessionSet()
        await setupSignedIn()
        await vi.advanceTimersByTimeAsync(LOAD_AFTER_SESSION_MS)
        expect(browser.tabCalls.slice(before)).toEqual(['update 7 front'])
    })
})
