// Runs in the PAGE's world (a MAIN-world content script on Chrome, a script
// tag on Firefox), so it can see the page's own XHR traffic. It reads:
//   - CreateTweet answers: the replies the user posts here;
//   - the page's TweetDetail, ModeratedTimeline and UserRepliesTimeline
//     requests: their queryIds and feature flags, which X changes with each
//     new web client, and the web app's token;
//   - UserRepliesTimeline answers: a Replies tab the user opened.
// It sends what it finds to the content script with window.postMessage. It
// makes no requests and changes nothing on the page.

import { createdTweet, tweetsIn } from './capture'
import { MSG_SOURCE } from './constants'

export {}

const WATCHED_OPS = ['TweetDetail', 'ModeratedTimeline', 'UserRepliesTimeline']

function send(msg: Record<string, unknown>) {
    window.postMessage({ source: MSG_SOURCE, ...msg }, window.location.origin)
}

const parseJson = (s: unknown): any => {
    try {
        return typeof s === 'string' && s ? JSON.parse(s) : null
    } catch {
        return null
    }
}

// /i/api/graphql/<queryId>/<Operation>
const graphqlOp = (url: string): { queryId: string; name: string; params: URLSearchParams } | null => {
    try {
        const u = new URL(url, location.origin)
        const m = u.pathname.match(/\/graphql\/([A-Za-z0-9_-]+)\/([A-Za-z]+)$/)
        return m ? { queryId: m[1], name: m[2], params: u.searchParams } : null
    } catch {
        return null
    }
}

const learnedOps = new Set<string>()
function learnOp(op: { queryId: string; name: string; params: URLSearchParams }) {
    if (!WATCHED_OPS.includes(op.name)) return
    const features = parseJson(op.params.get('features'))
    const fieldToggles = parseJson(op.params.get('fieldToggles'))
    const key = `${op.name}:${op.queryId}:${op.params.get('features')}:${op.params.get('fieldToggles')}`
    if (learnedOps.has(key) || !features) return
    learnedOps.add(key)
    send({ type: 'learned-op', name: op.name, queryId: op.queryId, features, ...(fieldToggles && { fieldToggles }) })
}

let bearerSent = ''
function learnBearer(value: string) {
    const m = /^Bearer (\S+)$/.exec(value)
    if (m && m[1] !== bearerSent) {
        bearerSent = m[1]
        send({ type: 'bearer', value: m[1] })
    }
}

function onCreateTweet(requestBody: any, responseJson: any) {
    const tweet = createdTweet(requestBody, responseJson)
    if (tweet) send({ type: 'created-reply', ...tweet })
}

function onRepliesTab(params: URLSearchParams, responseJson: any) {
    const userId = parseJson(params.get('variables'))?.userId
    if (typeof userId !== 'string') return
    const tweets = tweetsIn(responseJson)
    if (tweets.length) send({ type: 'replies-tab', userId, tweets })
}

function onAnswer(url: string, method: string, requestBody: any, responseText: string) {
    const op = graphqlOp(url)
    if (!op) return
    if (op.name === 'CreateTweet' && method === 'POST') onCreateTweet(parseJson(requestBody), parseJson(responseText))
    else if (op.name === 'UserRepliesTimeline') onRepliesTab(op.params, parseJson(responseText))
}

declare global {
    interface Window {
        __twisitter_hooked?: boolean
    }
}
// One set of hooks per page, even if this runs again (an extension reload
// with the tab open): the old hooks keep posting, and the new content script
// hears them.
if (!window.__twisitter_hooked) {
    window.__twisitter_hooked = true
    installHooks()
}

function installHooks() {
    const proto = XMLHttpRequest.prototype
    const open = proto.open
    const setHeader = proto.setRequestHeader
    const sendXhr = proto.send
    proto.open = function (this: any, ...args: any[]) {
        this.__twisitter = { method: String(args[0] || 'GET').toUpperCase(), url: String(args[1] || '') }
        return (open as any).apply(this, args)
    }
    proto.setRequestHeader = function (this: any, name: string, value: string) {
        try {
            const lower = String(name).toLowerCase()
            if (lower === 'authorization' && this.__twisitter && graphqlOp(this.__twisitter.url)) learnBearer(String(value))
            if (__DEV__ && lower === 'x-client-transaction-id' && this.__twisitter) {
                const op = graphqlOp(this.__twisitter.url)
                if (op?.name === 'TweetDetail') send({ type: 'dev-txid', path: new URL(this.__twisitter.url, location.origin).pathname, value: String(value) })
            }
        } catch {
            /* never disturb the page */
        }
        return setHeader.call(this, name, value)
    }
    proto.send = function (this: any, body?: any) {
        const info = this.__twisitter
        try {
            const op = info && graphqlOp(info.url)
            if (op) {
                learnOp(op)
                if (op.name === 'CreateTweet' || op.name === 'UserRepliesTimeline')
                    this.addEventListener('load', () => {
                        try {
                            if (this.status === 200) onAnswer(info.url, info.method, body, String(this.responseText || ''))
                        } catch {
                            /* ignore */
                        }
                    })
            }
        } catch {
            /* ignore */
        }
        return sendXhr.call(this, body)
    }

    // X's client uses XHR; fetch is watched too in case that changes
    const origFetch = window.fetch
    window.fetch = async function (this: unknown, ...args: Parameters<typeof fetch>) {
        const [input, init] = args
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
        const method = String(init?.method || (input as Request)?.method || 'GET').toUpperCase()
        const op = url ? graphqlOp(url) : null
        if (op) {
            try {
                learnOp(op)
            } catch {
                /* ignore */
            }
        }
        const res = await origFetch.apply(this, args as any)
        if (op && (op.name === 'CreateTweet' || op.name === 'UserRepliesTimeline') && res.ok) {
            res.clone()
                .text()
                .then(text => onAnswer(url, method, init?.body, text))
                .catch(() => {})
        }
        return res
    }
}
