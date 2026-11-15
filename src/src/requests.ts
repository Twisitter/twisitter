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
import { apiHeaders, DEFAULT_OPS, graphqlUrl, readAnswer, WEB_BEARER, type OpName, type Operation, type XAnswer } from './x-api'

export const MARKER = 'tw_as'
export const SECOND_RULE_ID = 7101

export interface SecondAccount {
    screenName: string
    userId: string
    token: string
    cookies: StoredCookie[]
    connectedAt: number
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
    const { [OPS_KEY]: learned } = (await api.storage.local.get(OPS_KEY)) as any
    return { ...DEFAULT_OPS, ...(learned && typeof learned === 'object' ? learned : {}) }
}
async function currentBearer(): Promise<string> {
    const { [BEARER_KEY]: b } = (await api.storage.local.get(BEARER_KEY)) as any
    return typeof b === 'string' && /^[A-Za-z0-9%_-]{40,200}$/.test(b) ? b : WEB_BEARER
}

// --- pacing: reads go one at a time, a few seconds apart ---

export const READ_GAP_MS = 2500
export const FETCH_TIMEOUT_MS = 20000
let lastReadAt = 0
let chain: Promise<unknown> = Promise.resolve()
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
function paced<T>(run: () => Promise<T>): Promise<T> {
    const next = chain.then(async () => {
        const wait = lastReadAt + READ_GAP_MS - Date.now()
        if (wait > 0) await sleep(wait)
        try {
            return await run()
        } finally {
            lastReadAt = Date.now()
        }
    })
    chain = next.catch(() => {})
    return next
}

// A read log per account, so a check can see how many reads the last 15
// minutes took. X allows 300 TweetDetail reads per 15 minutes; this stays far
// below that.
export const READ_WINDOW_MS = 15 * 60 * 1000
export const READS_PER_WINDOW = 60
const READ_LOG_KEY = 'read_log'
async function logRead(who: string) {
    const { [READ_LOG_KEY]: log = {} } = (await api.storage.local.get(READ_LOG_KEY)) as any
    const now = Date.now()
    const list: number[] = (Array.isArray(log[who]) ? log[who] : []).filter((t: number) => now - t < READ_WINDOW_MS)
    list.push(now)
    await api.storage.local.set({ [READ_LOG_KEY]: { ...log, [who]: list } })
}
export async function readsInWindow(who: string): Promise<number> {
    const { [READ_LOG_KEY]: log = {} } = (await api.storage.local.get(READ_LOG_KEY)) as any
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

export async function readAsUser(name: OpName, variables: object): Promise<XAnswer> {
    const ops = await currentOps()
    return paced(async () => {
        await logRead('user')
        return send(graphqlUrl(name, ops[name], variables), {
            credentials: 'include',
            headers: apiHeaders(await browserCsrf(), await currentBearer()),
        })
    })
}

export async function readAsSecond(account: SecondAccount, name: OpName, variables: object): Promise<XAnswer> {
    const ops = await currentOps()
    return paced(async () => {
        await logRead('second')
        // Chrome: the rule must carry the account's cookies as they are now
        await installSecondAccountRule(account)
        return send(markedUrl(graphqlUrl(name, ops[name], variables), account.token), {
            credentials: 'omit',
            headers: apiHeaders(csrfFrom(account.cookies), await currentBearer()),
        })
    })
}

// --- the header rules ---

// Chrome and Edge: the rule that puts the second account's cookies on the
// extension's own marked GETs (tabId -1: not from any tab). Session rules
// don't outlive the browser, so background.ts installs it on every start.
let installedFor = ''
export async function installSecondAccountRule(account: SecondAccount | null) {
    if (__BUILT_FOR__ !== 'chrome') return
    const dnr = (globalThis as any).chrome?.declarativeNetRequest
    if (!dnr?.updateSessionRules) return
    const header = account ? cookieHeaderFor(account.cookies, 'x.com') : ''
    const key = account && header ? `${account.token}:${header}` : ''
    if (key === installedFor) return
    await dnr.updateSessionRules({
        removeRuleIds: [SECOND_RULE_ID],
        addRules:
            account && header
                ? [
                      {
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
                      },
                  ]
                : [],
    })
    installedFor = key
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
