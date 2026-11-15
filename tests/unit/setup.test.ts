// First run (setup.ts): x.com tabs already open get Twisitter's scripts at
// install, and step 1's background tab follows a signed-out user to X's login
// page and brings the welcome page back after.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isAfterSignIn, LOGIN_URL, RELOAD_AFTER_LOGIN_MS } from '../../src/src/connect'
import { addToOpenXTabs, isSignedOutUrl, onSetupTabUrl, openX, SETUP_URL, setupSignedIn, setupState, setupTabClosed, signInOnX } from '../../src/src/setup'
import { fakeBrowser } from './browser'

const browser = fakeBrowser()
// the welcome page, in a tab of its own
const welcome = { tabId: 7, windowId: 1 }
const lastCall = () => browser.tabCalls[browser.tabCalls.length - 1]

beforeEach(() => {
    browser.reset()
    browser.openTabs.push({ id: 7, url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/src/popup.html#welcome', active: true, windowId: 1 })
})
afterEach(() => {
    vi.useRealTimers()
})

describe('a signed-out answer', () => {
    it('is where X sends a signed-out browser that asks for /home', () => {
        for (const url of [
            'https://x.com/',
            'https://x.com/login',
            'https://x.com/i/flow/login?redirect_after_login=%2Fhome',
            'https://x.com/i/flow/signup',
            // where /i/flow/login moves on to at once (seen 2026-11-15)
            'https://x.com/i/jf/onboarding/web?mode=login',
        ])
            expect(isSignedOutUrl(url), url).toBe(true)
        for (const url of ['https://x.com/home', 'https://x.com/someone/status/1', 'https://x.com/i/flow/loginx', 'https://twitter.com/', 'https://x.com.example/', 'not a url'])
            expect(isSignedOutUrl(url), url).toBe(false)
    })
})

describe('a sign-in that has landed', () => {
    // a login tab is reloaded only here: a reload anywhere in X's login flow
    // starts the sign-in over (it did, 11-15, at /i/jf/onboarding)
    it('is X’s /home, and no address of its login flow', () => {
        for (const url of ['https://x.com/home', 'https://x.com/home?lang=en']) expect(isAfterSignIn(url), url).toBe(true)
        for (const url of [
            'https://x.com/i/flow/login',
            'https://x.com/i/jf/onboarding/web?mode=login',
            'https://x.com/i/jf/onboarding/web?mode=login&step=email_code',
            'https://x.com/account/access',
            'https://x.com/',
            'https://x.com/homes',
            'https://twitter.com/home',
            'not a url',
        ])
            expect(isAfterSignIn(url), url).toBe(false)
    })
})

describe('at install', () => {
    it('adds the scripts to x.com tabs that don’t have them, and leaves the others alone', async () => {
        browser.openTabs.push(
            { id: 1, url: 'https://x.com/home', active: false, windowId: 1 }, // open before the install
            { id: 2, url: 'https://x.com/someone', active: false, windowId: 1 }, // opened since: has them
            { id: 3, url: 'https://x.com/explore', active: false, windowId: 1, discarded: true }, // asleep: gets them when it loads
            { id: 4, url: 'https://x.com/i/bookmarks', active: false, windowId: 1 }, // takes no scripts
            { id: 5, url: 'https://example.com/', active: false, windowId: 1 },
        )
        browser.pinged.add(2)
        browser.refusing.add(4)
        expect(await addToOpenXTabs()).toBe(1)
        // the note's style, then the page hook in the page's own world, then the content script
        expect(browser.tabCalls).toEqual(['css 1 src/content.css', 'script 1 src/inject.js MAIN', 'script 1 src/content.js'])
    })
})

describe('step 1 of the welcome page', () => {
    it('opens x.com in a background tab beside the welcome page; a second press reuses that tab while it’s on x.com', async () => {
        expect(await openX(welcome)).toEqual({ ok: true })
        expect(browser.tabCalls).toEqual([`create 100 ${SETUP_URL} background`])
        expect(browser.openTabs.find(t => t.id === 100)).toMatchObject({ active: false, windowId: 1, openerTabId: 7 })
        expect(await setupState()).toMatchObject({ state: 'opening' })
        await openX(welcome)
        expect(lastCall()).toBe(`update 100 ${SETUP_URL}`)
        // a tab the user took elsewhere isn't step 1's any more
        browser.openTabs.find(t => t.id === 100)!.url = 'https://example.com/'
        await openX(welcome)
        expect(lastCall()).toBe(`create 101 ${SETUP_URL} background`)
    })

    it('signed in already: done where it stands, with no tab brought forward', async () => {
        await openX(welcome)
        // /home itself says nothing either way
        await onSetupTabUrl(100, SETUP_URL)
        expect(await setupState()).toMatchObject({ state: 'opening' })
        await setupSignedIn()
        expect(await setupState()).toBeNull()
        expect(browser.tabCalls).toEqual([`create 100 ${SETUP_URL} background`])
    })

    it('signed out: X’s front page turns it into a sign-in, in front, and the welcome page comes back after', async () => {
        await openX(welcome)
        // another tab's address is no business of step 1's
        await onSetupTabUrl(55, 'https://x.com/')
        expect(await setupState()).toMatchObject({ state: 'opening' })
        await onSetupTabUrl(100, 'https://x.com/')
        expect(await setupState()).toMatchObject({ state: 'signed_out' })
        expect(await signInOnX(welcome)).toEqual({ ok: true })
        expect(lastCall()).toBe(`update 100 ${LOGIN_URL} front`)
        expect(await setupState()).toMatchObject({ state: 'signing_in' })
        await setupSignedIn()
        expect(await setupState()).toBeNull()
        expect(lastCall()).toBe('update 7 front')
    })

    it('a sign-in that lands on /home without a page load gets one, once', async () => {
        vi.useFakeTimers()
        await openX(welcome)
        await onSetupTabUrl(100, 'https://x.com/')
        await signInOnX(welcome)
        // still in X's login flow, wherever it goes: nothing to reload
        await onSetupTabUrl(100, 'https://x.com/i/flow/login')
        await onSetupTabUrl(100, 'https://x.com/i/jf/onboarding/web?mode=login')
        await vi.advanceTimersByTimeAsync(RELOAD_AFTER_LOGIN_MS)
        expect(lastCall()).toBe(`update 100 ${LOGIN_URL} front`)
        await onSetupTabUrl(100, SETUP_URL)
        await vi.advanceTimersByTimeAsync(RELOAD_AFTER_LOGIN_MS)
        expect(lastCall()).toBe('reload 100')
        // a page that said who signed in first leaves nothing to reload
        await onSetupTabUrl(100, SETUP_URL)
        await setupSignedIn()
        await vi.advanceTimersByTimeAsync(RELOAD_AFTER_LOGIN_MS)
        expect(browser.tabCalls.filter(c => c === 'reload 100')).toHaveLength(1)
    })

    it('starts over when its tab closes, and only then', async () => {
        await openX(welcome)
        await setupTabClosed(55)
        expect(await setupState()).not.toBeNull()
        await setupTabClosed(100)
        expect(await setupState()).toBeNull()
    })

    it('from the toolbar popup, which has no tab: opens x.com all the same, and brings nothing back', async () => {
        expect(await openX()).toEqual({ ok: true })
        await onSetupTabUrl(100, 'https://x.com/')
        await signInOnX()
        await setupSignedIn()
        expect(browser.tabCalls).toEqual([`create 100 ${SETUP_URL} background`, `update 100 ${LOGIN_URL} front`])
    })
})
