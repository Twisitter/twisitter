// First run. Twisitter learns the user's own X account from an x.com page,
// which says who's signed in (content.ts). So that nobody has to go looking
// for a tab:
//   - at install, x.com tabs already open get Twisitter's scripts, since
//     browsers load content scripts only into pages opened later;
//   - step 1 of the welcome page opens x.com/home in a background tab, and the
//     welcome page stays in front. Signed out, X sends that tab to its front
//     page instead (seen 2026-11-15). Step 1 then asks the user to sign in
//     there, and brings the welcome page back once a page says who they are.

import api from './api'
import { LOAD_AFTER_SESSION_MS, LOGIN_URL } from './connect'
import { getLocal, KEYS, setLocal } from './store'

export const SETUP_URL = 'https://x.com/home'

export type SetupState = 'opening' | 'signed_out' | 'signing_in'
export interface SetupTab {
    tabId: number
    // the welcome page, brought back once the user has signed in
    from?: number
    // opening: x.com loading in the background; signed_out: X sent it to its
    // front page; signing_in: X's login page, in front
    state: SetupState
    at: number
}
// the page that asked: x.com opens beside it, in its window
export interface Asker {
    tabId: number
    windowId?: number
}

const STATES: readonly string[] = ['opening', 'signed_out', 'signing_in']
const isSetupTab = (v: any): v is SetupTab => !!v && Number.isInteger(v.tabId) && STATES.includes(v.state) && typeof v.at === 'number'
async function getSetup(): Promise<SetupTab | null> {
    const v = await getLocal<unknown>(KEYS.setupTab, null)
    return isSetupTab(v) ? v : null
}
const isXUrl = (url: string | undefined) => /^https:\/\/x\.com\//.test(url || '')

// What step 1 shows while the account isn't known
export async function setupState(): Promise<{ state: SetupState; at: number } | null> {
    const setup = await getSetup()
    return setup && { state: setup.state, at: setup.at }
}

// Where X sends a signed-out browser that asks for /home: its front page
// (seen 2026-11-15), or its login and sign-up flows (/i/flow/login moves on
// to /i/jf/onboarding/web?mode=login at once, seen the same day)
export function isSignedOutUrl(url: string): boolean {
    let u: URL
    try {
        u = new URL(url)
    } catch {
        return false
    }
    return (
        u.origin === 'https://x.com' &&
        (u.pathname === '/' || u.pathname === '/login' || /^\/i\/flow\/(login|signup)\b/.test(u.pathname) || /^\/i\/jf\/onboarding\b/.test(u.pathname))
    )
}

// Step 1's tab, while it's still on x.com: one the user took elsewhere isn't
// step 1's any more
async function stepTab(setup: SetupTab | null): Promise<number | undefined> {
    if (!setup) return undefined
    const tab = await api.tabs.get(setup.tabId).catch(() => undefined)
    return tab?.id != null && isXUrl(tab.url) ? tab.id : undefined
}

// url in step 1's tab if it has one, else in a new tab beside the asker
async function openInStepTab(setup: SetupTab | null, url: string, active: boolean, asker?: Asker): Promise<number | undefined> {
    const reuse = await stepTab(setup)
    if (reuse != null) {
        const tab = await api.tabs.update(reuse, { url, ...(active && { active: true }) }).catch(() => undefined)
        if (tab?.id != null) return tab.id
    }
    const tab = await api.tabs
        .create({ url, active, ...(asker && { openerTabId: asker.tabId }), ...(asker?.windowId != null && { windowId: asker.windowId }) })
        .catch(() => undefined)
    return tab?.id
}

// Step 1's button: x.com/home in a background tab. The page there says who's
// signed in; signed out, X sends the tab to its front page (onSetupTabUrl).
export async function openX(asker?: Asker): Promise<{ ok: boolean; error?: string }> {
    const old = await getSetup()
    const tabId = await openInStepTab(old, SETUP_URL, false, asker)
    if (tabId == null) return { ok: false, error: 'no_x_tab' }
    await setLocal(KEYS.setupTab, { tabId, from: asker?.tabId ?? old?.from, state: 'opening', at: Date.now() })
    // X may have sent the tab on before it was saved as step 1's
    const tab = await api.tabs.get(tabId).catch(() => undefined)
    if (tab?.url) await onSetupTabUrl(tabId, tab.url)
    return { ok: true }
}

// "Sign in on x.com": X's login page in step 1's tab, brought to the front.
// Once the user is signing in there, it only brings that tab forward: loading
// the login page again would lose their place in X's login (a code X sent).
export async function signInOnX(asker?: Asker): Promise<{ ok: boolean; error?: string }> {
    const old = await getSetup()
    if (old?.state === 'signing_in') {
        const onX = await stepTab(old)
        if (onX != null && (await api.tabs.update(onX, { active: true }).then(Boolean, () => false))) return { ok: true }
    }
    const tabId = await openInStepTab(old, LOGIN_URL, true, asker)
    if (tabId == null) return { ok: false, error: 'no_x_tab' }
    await setLocal(KEYS.setupTab, { tabId, from: asker?.tabId ?? old?.from, state: 'signing_in', at: Date.now() })
    return { ok: true }
}

// A new address in step 1's tab. It only says whether X sent a signed-out
// browser away from /home, for step 1's wording; nothing is reloaded on an
// address (X changes them), and a wrong guess here leaves step 1 to its
// 15-second fallback.
export async function onSetupTabUrl(tabId: number, url: string) {
    const setup = await getSetup()
    if (!setup || setup.tabId !== tabId) return
    if (setup.state === 'opening' && isSignedOutUrl(url)) await setLocal(KEYS.setupTab, { ...setup, state: 'signed_out', at: Date.now() })
}

// X's session cookie was set while step 1 waits: someone signed in, in step
// 1's tab or another. Unless a page has said who by then (setupSignedIn),
// step 1's tab loads x.com/home, which does.
export async function setupSessionSet(): Promise<void> {
    const setup = await getSetup()
    if (!setup) return
    const { tabId, at } = setup
    setTimeout(() => {
        getSetup()
            .then(async now => {
                if (now?.tabId !== tabId || now.at !== at) return
                const onX = await stepTab(now)
                if (onX != null) await api.tabs.update(onX, { url: SETUP_URL })
            })
            .catch(() => {})
    }, LOAD_AFTER_SESSION_MS)
}

// Step 1's tab closed: step 1 starts over
export async function setupTabClosed(tabId: number) {
    const setup = await getSetup()
    if (setup?.tabId === tabId) await api.storage.local.remove(KEYS.setupTab)
}

// An x.com page said who the user is: step 1 is done. Someone who signed in
// from step 1 gets the welcome page back, for step 2.
export async function setupSignedIn() {
    const setup = await getSetup()
    if (!setup) return
    await api.storage.local.remove(KEYS.setupTab)
    if (setup.from != null && setup.state !== 'opening') await api.tabs.update(setup.from, { active: true }).catch(() => {})
}

// At install: the x.com tabs already open get the content script, the page
// hook and the note's style. A tab whose content script answers has them
// already (one opened in the meantime); a sleeping tab gets them when it wakes
// and loads. Returns how many tabs got them.
export async function addToOpenXTabs(): Promise<number> {
    const tabs = await api.tabs.query({ url: 'https://x.com/*' }).catch(() => [] as chrome.tabs.Tab[])
    let added = 0
    for (const tab of tabs) {
        if (tab.id == null || tab.discarded) continue
        const has = await api.tabs.sendMessage(tab.id, { action: 'ping' }).then(
            (r: any) => !!r?.ok,
            () => false,
        )
        if (has) continue
        try {
            await addScripts(tab.id)
            added++
        } catch {
            // a tab that takes no scripts (an error page, one closing): its next load does
        }
    }
    return added
}

async function addScripts(tabId: number) {
    if (__BUILT_FOR__ === 'firefox') {
        // Firefox: the content script puts the page hook in itself
        const tabsApi = api.tabs as any
        await tabsApi.insertCSS(tabId, { file: '/src/content.css' })
        await tabsApi.executeScript(tabId, { file: '/src/content.js' })
    } else {
        await api.scripting.insertCSS({ target: { tabId }, files: ['src/content.css'] })
        await api.scripting.executeScript({ target: { tabId }, files: ['src/inject.js'], world: 'MAIN' })
        await api.scripting.executeScript({ target: { tabId }, files: ['src/content.js'] })
    }
}
