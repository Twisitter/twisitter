// Connecting the second account.
//
// The user signs in on X's own login page, so the password, two-factor codes
// and Google or Apple sign-in all stay with X. Before that, the user's own X
// cookies are saved and taken out of the browser (locally: X's log-out would
// end that session on X's side). Once the second account is signed in, its
// cookies are saved for the extension, taken out of the browser in turn, and
// the user's own cookies go back. Checks stand still meanwhile
// (isConnecting), so nothing mistakes the second account for the user.
//
// Who signed in comes from the login tab's next page load: every x.com page
// carries its signed-in account (content.ts reads it), so the sign-in costs
// the second account no reads beyond X's own pages. The sign-in counts as gone
// through when X sets its session cookie (the browser had none: the user's own
// is out), and only then is the login tab touched, to load a page that says
// who. The login pages' addresses are never read: X changes them (it did on
// 2026-11-15, and a reload keyed to them broke every sign-in).

import api from './api'
import { clearXCookies, restoreCookies, xCookies, type StoredCookie } from './cookies'
import { getSecondAccount, newToken, pendingSignIn, setAccountForHeaders, syncSecondAccountRule, type SecondAccount } from './requests'
import { KEYS, getLocal, setLocal } from './store'

export { getSecondAccount }

export const CONNECT_KEY = KEYS.connectPending
export const CONNECT_RESULT_KEY = KEYS.connectResult
export const LOGIN_URL = 'https://x.com/i/flow/login'
export const CONNECT_TIMEOUT_MS = 15 * 60 * 1000
export const CONNECT_ALARM = 'connect-timeout'
export const HOME_URL = 'https://x.com/home'
// X's session cookie, set once a sign-in goes through. Its name is the one
// thing the sign-in watches. If X ever renamed it, the sign-in would stand
// still, never reload anything, and "I've signed in" would still finish it
// (connectSignedInNow).
export const SESSION_COOKIE = 'auth_token'
// how long X gets to load a page of its own after a sign-in goes through,
// before Twisitter loads x.com/home in that tab
export const LOAD_AFTER_SESSION_MS = 2000

// X's session cookie set on x.com (not taken out)
export const isXSessionSet = (change: { removed: boolean; cookie: { name: string; domain: string } }): boolean =>
    !change.removed && change.cookie.name === SESSION_COOKIE && /(^|\.)x\.com$/.test(change.cookie.domain)

const hasXSession = async (): Promise<boolean> => !!(await api.cookies.get({ url: 'https://x.com/', name: SESSION_COOKIE }).catch(() => null))

interface Pending {
    started: number
    main: StoredCookie[]
    mainUserId: string
    tabId?: number
}
export interface ConnectResult {
    ok: boolean
    // same_account, not_signed_in, unconfirmed, cancelled, timed_out, no_tab
    error?: string
    // own_login_lost: the user's own X login didn't come back
    warning?: string
    t: number
}
// The account an x.com page says is signed in
export interface PageUser {
    userId: string
    screenName: string
    // has_graduated_access, when the page says
    graduated?: boolean
}

const readPending = pendingSignIn as () => Promise<Pending | null>
export const isConnecting = async (): Promise<boolean> => !!(await readPending())
export const isLoginTab = async (tabId: number | undefined) => tabId != null && (await readPending())?.tabId === tabId

// Keep both header rules in step with the stored account
export async function applySecondAccount() {
    const account = await getSecondAccount()
    setAccountForHeaders(account)
    await syncSecondAccountRule().catch(() => {})
}

const setResult = (r: Omit<ConnectResult, 't'>) => setLocal(CONNECT_RESULT_KEY, { ...r, t: Date.now() })

// One step of a sign-in at a time, so a cancel never lands in the middle of a
// finish saving the second account's cookies
let step: Promise<void> = Promise.resolve()
const inTurn = (run: () => Promise<void>): Promise<void> => {
    const next = step.then(run, run)
    step = next.catch(() => {})
    return next
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// The login tab leaves X for Twisitter's page, and this returns once X's page
// there is gone (3 s at most). Cookies change only after that: a page still
// running keeps talking to X with whatever cookies are there mid-change.
const leaveLoginTab = async (tabId: number | undefined) => {
    if (tabId == null) return
    try {
        await api.tabs.update(tabId, { url: api.runtime.getURL('src/popup.html#connected') })
    } catch {
        return // the tab is gone
    }
    for (let i = 0; i < 30; i++) {
        const tab = await api.tabs.get(tabId).catch(() => null)
        if (!tab || !/^https:\/\/x\.com\//.test(tab.url || '')) return
        await sleep(100)
    }
}

// The user's own login back in the browser, as saved when the sign-in began.
// False when it hasn't come back, as far as the browser shows: the saved
// cookies had X's session cookie and the browser still lacks it after a
// second try. Without one saved (or should X rename it), there's nothing to
// check.
async function putUserLoginBack(main: StoredCookie[]): Promise<boolean> {
    await clearXCookies()
    await restoreCookies(main)
    if (!main.some(c => c.name === SESSION_COOKIE) || (await hasXSession())) return true
    await restoreCookies(main)
    return hasXSession()
}

export async function startConnect(mainUserId: string): Promise<{ ok: boolean; error?: string }> {
    if (await readPending()) return { ok: false, error: 'already_connecting' }
    const main = await xCookies()
    const started = Date.now()
    // saved before anything leaves the browser, so a worker that stops halfway
    // can put the user's login back (recoverConnect)
    await setLocal(CONNECT_KEY, { started, main, mainUserId })
    await api.storage.local.remove(CONNECT_RESULT_KEY)
    try {
        api.alarms.create(CONNECT_ALARM, { delayInMinutes: CONNECT_TIMEOUT_MS / 60000 + 0.5 })
    } catch {
        /* the next tick ends it instead */
    }
    await clearXCookies()
    try {
        const tab = await api.tabs.create({ url: LOGIN_URL, active: true })
        await inTurn(async () => {
            const pending = await readPending()
            if (pending?.started === started) await setLocal(CONNECT_KEY, { ...pending, tabId: tab.id })
            else await leaveLoginTab(tab.id)
        })
    } catch {
        await cancelConnect('no_tab')
        return { ok: false, error: 'no_tab' }
    }
    return { ok: true }
}

const endConnect = async (why: string) => {
    const pending = await readPending()
    if (!pending) return
    await leaveLoginTab(pending.tabId)
    const back = await putUserLoginBack(pending.main)
    await api.storage.local.remove(CONNECT_KEY)
    await setResult({ ok: false, error: why, ...(!back && { warning: 'own_login_lost' }) })
}
export const cancelConnect = (why: string) => inTurn(() => endConnect(why))

// The login tab loaded a page signed in as `who`: unless that's the user's
// own account, it becomes the second account
export const finishConnect = (who: PageUser): Promise<void> =>
    inTurn(async () => {
        const pending = await readPending()
        if (!pending) return
        await leaveLoginTab(pending.tabId)
        if (pending.mainUserId && who.userId === pending.mainUserId) {
            // The user signed in as themselves. That fresh sign-in is theirs and
            // works, while the one saved at the start may not any more (X can
            // end it when a browser it doesn't know signs in with a code), so
            // the fresh one stays.
            await api.storage.local.remove(CONNECT_KEY)
            await setResult({ ok: false, error: 'same_account' })
            return
        }
        const account: SecondAccount = {
            screenName: who.screenName,
            userId: who.userId,
            token: newToken(),
            cookies: await xCookies(),
            connectedAt: Date.now(),
            ...(who.graduated !== undefined ? { graduated: who.graduated } : {}),
        }
        await setLocal(KEYS.second, account)
        await api.storage.local.remove(KEYS.secondStatus)
        const back = await putUserLoginBack(pending.main)
        await api.storage.local.remove(CONNECT_KEY)
        await setResult({ ok: true, ...(!back && { warning: 'own_login_lost' }) })
        await applySecondAccount()
    })

// X's session cookie was set. During a sign-in, that's the second account
// signing in, wherever X's pages are, and the login tab is touched only now.
// X's own next page load says who signed in (onPageUser); if X loads none in
// time, the login tab loads x.com/home.
let loadFor = 0
export async function connectSessionSet(): Promise<void> {
    const pending = await readPending()
    if (!pending || pending.tabId == null || loadFor === pending.started) return
    const { started, tabId } = pending
    loadFor = started
    setTimeout(() => {
        loadFor = 0
        // in turn: a finish under way (putting the user's cookies back) runs
        // to its end first, and then there's no sign-in left to load for
        inTurn(async () => {
            const now = await readPending()
            if (now?.started === started && now.tabId === tabId) await api.tabs.update(tabId, { url: HOME_URL })
        }).catch(() => {})
    }, LOAD_AFTER_SESSION_MS)
}

// "I've signed in": the login tab loads x.com/home, whose page says who. With
// no X session in the browser yet, a page load would take the user off X's
// login page and lose their place there (a code X sent, say), so that takes
// `anyway`: the user's word that X already shows the account.
export async function connectSignedInNow(anyway = false): Promise<{ ok: boolean; error?: string }> {
    let result: { ok: boolean; error?: string } = { ok: false, error: 'not_connecting' }
    // in turn, like the load above: never in the middle of a finish
    await inTurn(async () => {
        const pending = await readPending()
        if (!pending || pending.tabId == null) return
        if (!anyway && !(await hasXSession())) {
            result = { ok: false, error: 'no_session_yet' }
            return
        }
        await api.tabs.update(pending.tabId, { url: HOME_URL }).catch(() => {})
        result = { ok: true }
    })
    return result
}

// When the worker starts, on the timeout alarm and on each tick: a sign-in
// whose tab is gone, or that has run too long, ends now
export async function recoverConnect() {
    const pending = await readPending()
    if (!pending) return
    if (Date.now() - pending.started > CONNECT_TIMEOUT_MS) return cancelConnect('timed_out')
    if (pending.tabId != null) {
        const tab = await api.tabs.get(pending.tabId).catch(() => null)
        if (!tab) return cancelConnect('not_signed_in')
    }
}

export async function disconnectSecond() {
    await api.storage.local.remove([KEYS.second, KEYS.secondStatus, CONNECT_RESULT_KEY])
    await applySecondAccount()
}
