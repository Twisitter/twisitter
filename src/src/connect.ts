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
// the second account no reads beyond X's own pages.

import api from './api'
import { clearXCookies, restoreCookies, xCookies, type StoredCookie } from './cookies'
import { getSecondAccount, newToken, pendingSignIn, setAccountForHeaders, syncSecondAccountRule, type SecondAccount } from './requests'
import { KEYS, getLocal, setLocal } from './store'

export { getSecondAccount }

export const CONNECT_KEY = KEYS.connectPending
export const CONNECT_RESULT_KEY = 'connect_result'
export const LOGIN_URL = 'https://x.com/i/flow/login'
export const CONNECT_TIMEOUT_MS = 15 * 60 * 1000
export const CONNECT_ALARM = 'connect-timeout'
// X's login flow may land on its next page without a full page load; then
// the login tab is reloaded after this long, so its page says who signed in
export const RELOAD_AFTER_LOGIN_MS = 4000

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

const leaveLoginTab = async (tabId: number | undefined) => {
    if (tabId == null) return
    try {
        await api.tabs.update(tabId, { url: api.runtime.getURL('src/popup.html#connected') })
    } catch {
        // the tab is gone
    }
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
    await clearXCookies()
    await restoreCookies(pending.main)
    await api.storage.local.remove(CONNECT_KEY)
    await setResult({ ok: false, error: why })
    await leaveLoginTab(pending.tabId)
}
export const cancelConnect = (why: string) => inTurn(() => endConnect(why))

// The login tab loaded a page signed in as `who`: unless that's the user's
// own account, it becomes the second account
export const finishConnect = (who: PageUser): Promise<void> =>
    inTurn(async () => {
        const pending = await readPending()
        if (!pending) return
        if (pending.mainUserId && who.userId === pending.mainUserId) {
            await endConnect('same_account')
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
        await clearXCookies()
        await restoreCookies(pending.main)
        await api.storage.local.remove(CONNECT_KEY)
        await setResult({ ok: true })
        await applySecondAccount()
        await leaveLoginTab(pending.tabId)
    })

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
