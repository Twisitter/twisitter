// Dev builds only: the transport test for the request the design rests on, a
// TweetDetail GET from the extension's background with a second account's
// cookies (Origin chrome-extension://… or moz-extension://…), with and
// without x-client-transaction-id.
//
// The browser's own session stands in for the second account: its cookies are
// read, put on a marked request by a header rule, and the browser's cookies
// are left off the request, which is how a connected second account's
// requests go. Nothing is written to X, and the stand-in rule is removed after.

import { browserCsrf, csrfFrom, cookieHeaderFor, xCookies } from './cookies'
import { markedUrl, markerPattern, newToken } from './requests'
import { parseTimeline } from './timeline'
import { apiHeaders, classifyAnswer, DEFAULT_OPS, describeAnswer, graphqlUrl, readAnswer, tweetDetailVariables, WEB_BEARER, type XAnswer } from './x-api'

const PROBE_RULE_ID = 7199

export interface ProbeRow {
    variant: string
    status: number
    kind: string
    detail: string
    rateRemaining?: number
    tweets?: number
    focalSeen?: boolean
    replyListed?: boolean
}

async function installProbeRule(token: string, cookieHeader: string, removeOrigin: boolean) {
    const dnr = (globalThis as any).chrome?.declarativeNetRequest
    if (__BUILT_FOR__ !== 'chrome' || !dnr?.updateSessionRules) return false
    await dnr.updateSessionRules({
        removeRuleIds: [PROBE_RULE_ID],
        addRules: [
            {
                id: PROBE_RULE_ID,
                priority: 4,
                action: {
                    type: 'modifyHeaders',
                    requestHeaders: [
                        { header: 'cookie', operation: 'set', value: cookieHeader },
                        ...(removeOrigin ? [{ header: 'origin', operation: 'remove' }] : []),
                    ],
                },
                condition: {
                    regexFilter: markerPattern(token),
                    resourceTypes: ['xmlhttprequest', 'other'],
                    tabIds: [-1],
                    initiatorDomains: [chrome.runtime.id],
                    requestMethods: ['get'],
                },
            },
        ],
    })
    return true
}
const removeProbeRule = async () => {
    const dnr = (globalThis as any).chrome?.declarativeNetRequest
    if (dnr?.updateSessionRules) await dnr.updateSessionRules({ removeRuleIds: [PROBE_RULE_ID] }).catch(() => {})
}

async function row(variant: string, run: () => Promise<XAnswer>, focalId: string, replyId?: string): Promise<ProbeRow> {
    const a = await run().catch(e => ({ status: 0, failure: String(e) }) as XAnswer)
    const kind = classifyAnswer(a)
    const out: ProbeRow = { variant, status: a.status, kind, detail: describeAnswer(a), rateRemaining: a.rateRemaining }
    if (kind === 'ok') {
        const page = parseTimeline(a.json)
        out.tweets = page.tweets.length
        out.focalSeen = page.tweets.some(t => t.id === focalId && t.kind === 'tweet')
        if (replyId) out.replyListed = page.tweets.some(t => t.id === replyId && t.kind === 'tweet')
    }
    return out
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function runProbe(opts: { focalId: string; replyId?: string; txid?: string; guest?: boolean }): Promise<ProbeRow[]> {
    const url = graphqlUrl('TweetDetail', DEFAULT_OPS.TweetDetail, tweetDetailVariables(opts.focalId))
    const rows: ProbeRow[] = []
    const get = async (u: string, init: RequestInit) => readAnswer(await fetch(u, init))
    const cookies = await xCookies()
    const signedIn = cookies.some(c => c.name === 'auth_token')

    if (signedIn) {
        // 1. the browser's own session, its cookies sent by the browser
        rows.push(
            await row('user, credentials include', async () => get(url, { credentials: 'include', headers: apiHeaders(await browserCsrf()) }), opts.focalId, opts.replyId),
        )
        await sleep(1500)
        // 2. the same with a marker no rule matches: does X mind the extra parameter?
        rows.push(
            await row(
                'user, include, extra marker parameter',
                async () => get(markedUrl(url, newToken()), { credentials: 'include', headers: apiHeaders(await browserCsrf()) }),
                opts.focalId,
                opts.replyId,
            ),
        )
        const token = newToken()
        const header = cookieHeaderFor(cookies, 'x.com')
        const csrf = csrfFrom(cookies)
        if (await installProbeRule(token, header, false)) {
            await sleep(1500)
            // 3. the second account's way: cookies by the rule, the browser's left off
            rows.push(
                await row('stand-in, omit + rule, no transaction id', () => get(markedUrl(url, token), { credentials: 'omit', headers: apiHeaders(csrf) }), opts.focalId, opts.replyId),
            )
            if (opts.txid) {
                await sleep(1500)
                rows.push(
                    await row(
                        'stand-in, omit + rule, page transaction id',
                        () => get(markedUrl(url, token), { credentials: 'omit', headers: { ...apiHeaders(csrf), 'x-client-transaction-id': opts.txid! } }),
                        opts.focalId,
                        opts.replyId,
                    ),
                )
            }
            await sleep(1500)
            await installProbeRule(token, header, true)
            rows.push(
                await row('stand-in, omit + rule, Origin removed', () => get(markedUrl(url, token), { credentials: 'omit', headers: apiHeaders(csrf) }), opts.focalId, opts.replyId),
            )
            await removeProbeRule()
        } else {
            rows.push({ variant: 'stand-in rule', status: 0, kind: 'skipped', detail: 'no declarativeNetRequest here (Firefox uses webRequest)' })
        }
    }

    if (opts.guest || !signedIn) {
        // 4. no session at all: X's guest token, as the logged-out web client gets one
        rows.push(
            await row(
                'guest token, omit',
                async () => {
                    const act = await fetch('https://api.x.com/1.1/guest/activate.json', {
                        method: 'POST',
                        credentials: 'omit',
                        headers: { authorization: `Bearer ${WEB_BEARER}` },
                    })
                    const gt = (await act.json().catch(() => null))?.guest_token
                    if (!gt) return { status: act.status, failure: `guest activate: HTTP ${act.status}` }
                    return get(url, {
                        credentials: 'omit',
                        headers: {
                            authorization: `Bearer ${WEB_BEARER}`,
                            'x-guest-token': String(gt),
                            'x-twitter-active-user': 'yes',
                            'x-twitter-client-language': 'en',
                            'content-type': 'application/json',
                        },
                    })
                },
                opts.focalId,
                opts.replyId,
            ),
        )
    }
    return rows
}
