// The extension's own reads from X, as the signed-in user or as the second
// account. Only GETs: the extension never writes to X.
//
// As the user: the browser's own cookies (credentials: 'include'), as any
// x.com tab would send them.
//
// As the second account: its saved cookies, which never go back into the
// browser's cookie store. The request omits the browser's cookies and carries a
// marker (tw_as=<token>, a new token each time an account connects); a header
// rule puts the second account's cookies on marked requests only:
// declarativeNetRequest on Chrome and Edge, webRequest on Firefox. X's answers
// to those requests can't write into the browser's cookies, and pages can't
// borrow the login, since the rule matches only the extension's own GETs.

import api from './api'
import { browserCsrf, cookieHeaderFor, csrfFrom, type StoredCookie } from './cookies'
import { getLocal, KEYS, oneAtATime, setLocal } from './store'
import { apiHeaders, DEFAULT_OPS, graphqlUrl, readAnswer, WEB_BEARER, type OpName, type Operation, type XAnswer } from './x-api'

export const MARKER = 'tw_as'
export const SECOND_RULE_ID = 7101

export interface SecondAccount {
    screenName: string
    userId: string
    token: string
    cookies: StoredCookie[]
    connectedAt: number
    // its has_graduated_access, from the page it signed in on: false while X
    // holds it back, which may change what it sees
    graduated?: boolean
}

export const isToken = (t: unknown): t is string => typeof t === 'string' && /^[0-9a-f]{32}$/.test(t)
export const newToken = (): string =>
    Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('')
export const markedUrl = (url: string, token: string): string => `${url}${url.includes('?') ? '&' : '?'}${MARKER}=${token}`
// RE2 syntax, for Chrome's rule too. The token is hex, so it needs no escaping.
export const markerPattern = (token: string): string => `^https://x\\.com/[^#]*[?&]${MARKER}=${token}(&|$)`
export const isMarkedFor = (url: string, token: string): boolean => isToken(token) && new RegExp(markerPattern(token)).test(url)

// --- operations: the defaults, overridden by what the page hook learned ---

export const OPS_KEY = 'ops'
export const BEARER_KEY = 'bearer'
export async function currentOps(): Promise<Record<OpName, Operation>> {
    const learned = await getLocal<any>(OPS_KEY, null)
    return { ...DEFAULT_OPS, ...(learned && typeof learned === 'object' ? learned : {}) }
}
async function currentBearer(): Promise<string> {
    const b = await getLocal<unknown>(BEARER_KEY, null)
    return typeof b === 'string' && /^[A-Za-z0-9%_-]{40,200}$/.test(b) ? b : WEB_BEARER
}

// --- pacing: reads go one at a time, a few seconds apart ---

export const READ_GAP_MS = 2500
export const FETCH_TIMEOUT_MS = 20000
let lastReadAt = 0
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
function paced<T>(run: () => Promise<T>): Promise<T> {
    return oneAtATime('x-reads', async () => {
        const wait = lastReadAt + READ_GAP_MS - Date.now()
        if (wait > 0) await sleep(wait)
        try {
            return await run()
        } finally {
            lastReadAt = Date.now()
        }
    })
}

// A read log per account, so a check can see how many reads the last 15
// minutes took. X allows 300 TweetDetail reads per 15 minutes; this stays far
// below that.
export const READ_WINDOW_MS = 15 * 60 * 1000
export const READS_PER_WINDOW = 60
const READ_LOG_KEY = 'read_log'
async function logRead(who: string) {
    const log = await getLocal<any>(READ_LOG_KEY, {})
    const now = Date.now()
    const list: number[] = (Array.isArray(log[who]) ? log[who] : []).filter((t: number) => now - t < READ_WINDOW_MS)
    list.push(now)
    await setLocal(READ_LOG_KEY, { ...log, [who]: list })
}
export async function readsInWindow(who: string): Promise<number> {
    const log = await getLocal<any>(READ_LOG_KEY, {})
    const now = Date.now()
    return (Array.isArray(log[who]) ? log[who] : []).filter((t: number) => now - t < READ_WINDOW_MS).length
}

async function send(url: string, init: RequestInit): Promise<XAnswer> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
        return await readAnswer(await fetch(url, { ...init, signal: controller.signal }))
    } catch (e) {
        return { status: 0, failure: `no answer (${e instanceof Error ? e.name : 'error'})` }
    } finally {
        clearTimeout(timer)
    }
}

// Reads that were never sent, with why (a sign-in open, the second account
// changed). They classify as errors: the check stops and tries again later,
// and no account's status changes on their account.
const notSent = (why: string): XAnswer => ({ status: 0, failure: `not sent: ${why}` })

// A second account's sign-in in progress, as connect.ts saves it (its
// isConnecting reads the same record the same way)
export const pendingSignIn = async (): Promise<{ started: number; main: unknown[]; mainUserId: string; tabId?: number } | null> => {
    const p = await getLocal<any>(KEYS.connectPending, null)
    return p && Number(p.started) > 0 && Array.isArray(p.main) ? p : null
}
// While a second account signs in, the browser holds none of the user's X
// cookies, or that account's: a read with them says nothing about the user
const signInOpen = async (): Promise<boolean> => !!(await pendingSignIn())

export async function readAsUser(name: OpName, variables: object): Promise<XAnswer> {
    const ops = await currentOps()
    return paced(async () => {
        if (await signInOpen()) return notSent('a second account is signing in')
        await logRead('user')
        const answer = await send(graphqlUrl(name, ops[name], variables), {
            credentials: 'include',
            headers: apiHeaders(await browserCsrf(), await currentBearer()),
        })
        // a sign-in that began meanwhile may have taken the cookies it went with
        return (await signInOpen()) ? notSent('a second account began signing in') : answer
    })
}

// The second account as stored now (connect.ts saves it at a sign-in)
export const getSecondAccount = async (): Promise<SecondAccount | null> => {
    const a = await getLocal<any>(KEYS.second, null)
    return a && typeof a.screenName === 'string' && isToken(a.token) && Array.isArray(a.cookies) ? a : null
}

export async function readAsSecond(account: SecondAccount, name: OpName, variables: object): Promise<XAnswer> {
    const ops = await currentOps()
    return paced(async () => {
        // a round that began before a Disconnect or a new sign-in mustn't go
        // on reading as the account it began with
        if ((await getSecondAccount())?.token !== account.token) return notSent('the second account changed')
        // Chrome: the browser keeps the header rule only until it closes
        await syncSecondAccountRule()
        await logRead('second')
        return send(markedUrl(graphqlUrl(name, ops[name], variables), account.token), {
            credentials: 'omit',
            headers: apiHeaders(csrfFrom(account.cookies), await currentBearer()),
        })
    })
}

// --- the header rules ---

const ruleFor = (account: SecondAccount, header: string) => ({
    id: SECOND_RULE_ID,
    priority: 3,
    action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'cookie', operation: 'set', value: header }],
    },
    condition: {
        regexFilter: markerPattern(account.token),
        resourceTypes: ['xmlhttprequest', 'other'],
        tabIds: [-1],
        initiatorDomains: [chrome.runtime.id],
        requestMethods: ['get'],
    },
})
const sameRule = (a: any, b: any): boolean =>
    !a === !b && (!a || (a.condition?.regexFilter === b.condition?.regexFilter && a.action?.requestHeaders?.[0]?.value === b.action?.requestHeaders?.[0]?.value))

// Chrome and Edge: the session rule that puts the second account's cookies on
// the extension's own marked GETs (tabId -1: not from any tab), kept in step
// with the stored account one change at a time. It always follows the account
// stored now, never one a caller began with, so a round that began before a
// Disconnect can't bring the old account's rule back. Session rules outlive
// the worker but not the browser, so what's there is read, not remembered.
export function syncSecondAccountRule(): Promise<void> {
    return oneAtATime('second-account-rule', async () => {
        if (__BUILT_FOR__ !== 'chrome') return
        const dnr = (globalThis as any).chrome?.declarativeNetRequest
        if (!dnr?.updateSessionRules) return
        const account = await getSecondAccount()
        const header = account ? cookieHeaderFor(account.cookies, 'x.com') : ''
        const want = account && header ? ruleFor(account, header) : null
        const rules: any[] = (await dnr.getSessionRules?.().catch(() => null)) || []
        const have = rules.find(r => r?.id === SECOND_RULE_ID) || null
        if (dnr.getSessionRules && sameRule(have, want)) return
        await dnr.updateSessionRules({ removeRuleIds: [SECOND_RULE_ID], addRules: want ? [want] : [] })
    })
}

// Firefox: a blocking webRequest listener does what Chrome's rule does. It's
// registered synchronously when the background starts, and answers at once
// from the account it was last given (background.ts keeps it current).
let accountForHeaders: SecondAccount | null = null
export const setAccountForHeaders = (account: SecondAccount | null) => {
    accountForHeaders = account
}
export function installFirefoxHeaderListener() {
    if (__BUILT_FOR__ !== 'firefox') return
    const ownPrefix = api.runtime.getURL('')
    ;(api as any).webRequest.onBeforeSendHeaders.addListener(
        (details: any) => {
            const account = accountForHeaders
            if (
                !account ||
                details.tabId !== -1 ||
                details.method !== 'GET' ||
                !String(details.originUrl || '').startsWith(ownPrefix) ||
                !isMarkedFor(details.url, account.token)
            )
                return {}
            const host = new URL(details.url).host
            const headers = (details.requestHeaders || []).filter((h: any) => h.name.toLowerCase() !== 'cookie')
            const value = cookieHeaderFor(account.cookies, host)
            if (value) headers.push({ name: 'Cookie', value })
            return { requestHeaders: headers }
        },
        { urls: [`https://x.com/*${MARKER}=*`] },
        ['blocking', 'requestHeaders'],
    )
}
