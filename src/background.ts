// Twisitter's background: messages, alarms, the second account's sign-in and
// the checks. Listeners register synchronously, before the first await, so a
// service worker woken by an event hears it.

import api from './src/api'
import { HIDDEN_STATES, isFinding } from './src/check'
import {
    applySecondAccount,
    cancelConnect,
    CONNECT_ALARM,
    CONNECT_RESULT_KEY,
    disconnectSecond,
    finishConnect,
    getSecondAccount,
    isConnecting,
    isLoginTab,
    LOGIN_URL,
    RELOAD_AFTER_LOGIN_MS,
    recoverConnect,
    startConnect,
} from './src/connect'
import { accountTrouble, ensureAlarms, forget, notePageUser, recentReplies, runTick, SOON_ALARM, TICK_ALARM, tickSoon, toNewReply, trackByLink, updateBadge } from './src/monitor'
import { BEARER_KEY, installFirefoxHeaderListener, OPS_KEY, readsInWindow } from './src/requests'
import { getLocal, getTracked, KEYS, setLocal, trackReplies, type Me } from './src/store'
import { runProbe } from './src/probe'
import { isOpName, isQueryId, isTweetId } from './src/x-api'

installFirefoxHeaderListener()

const isXTab = (sender: chrome.runtime.MessageSender) =>
    !!sender.tab && /^https:\/\/x\.com\//.test(String(sender.url || sender.tab.url || ''))
const isOwnPage = (sender: chrome.runtime.MessageSender) => String(sender.url || '').startsWith(api.runtime.getURL(''))

// The extension reads as the user with the browser's main cookies. A private
// window or a Firefox container keeps cookies of its own, so who its pages are
// signed in as says nothing about whose session those reads carry.
const inMainCookieStore = (tab: chrome.tabs.Tab | undefined): boolean => {
    const store = (tab as { cookieStoreId?: string } | undefined)?.cookieStoreId
    return !!tab && !tab.incognito && (store === undefined || store === 'firefox-default' || store === '0')
}

const isFlags = (o: unknown): o is Record<string, boolean> =>
    !!o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length < 200 && Object.values(o).every(v => typeof v === 'boolean')

// --- what the page hook found (content.ts) ---

async function learnOp(msg: any) {
    if (!isOpName(msg.name) || !isQueryId(msg.queryId) || !isFlags(msg.features)) return
    if (msg.fieldToggles !== undefined && !isFlags(msg.fieldToggles)) return
    const ops = await getLocal<Record<string, unknown>>(OPS_KEY, {})
    const op = { queryId: msg.queryId, features: msg.features, ...(msg.fieldToggles && { fieldToggles: msg.fieldToggles }) }
    if (JSON.stringify(ops[msg.name]) !== JSON.stringify(op)) await setLocal(OPS_KEY, { ...ops, [msg.name]: op })
}

const pageTweet = (t: any) =>
    t && isTweetId(t.id) && (!t.inReplyTo || isTweetId(t.inReplyTo))
        ? {
              id: t.id,
              kind: 'tweet' as const,
              inReplyTo: t.inReplyTo || undefined,
              authorId: isTweetId(t.authorId) ? t.authorId : undefined,
              screenName: typeof t.screenName === 'string' ? t.screenName.slice(0, 15) : undefined,
              text: typeof t.text === 'string' ? t.text.slice(0, 500) : '',
              createdAt: typeof t.createdAt === 'string' ? t.createdAt.slice(0, 40) : undefined,
          }
        : null

async function onCreatedReply(msg: any, sender: chrome.runtime.MessageSender) {
    if (await isConnecting()) return
    const t = pageTweet(msg)
    if (!t?.inReplyTo) return
    const me = await getLocal<Me | null>(KEYS.me, null)
    // the page posts as whoever is signed in; that's the user unless X says otherwise
    if (me && t.authorId && me.userId !== t.authorId) return
    if (!me && t.authorId && t.screenName) {
        // never the second account, and only a page on the browser's main cookies
        const second = await getSecondAccount()
        if (second?.userId === t.authorId || !inMainCookieStore(sender.tab)) return
        await setLocal(KEYS.me, { userId: t.authorId, screenName: t.screenName, at: 0 })
    }
    const reply = toNewReply(t, 'posted')
    if (reply && (await trackReplies([reply])).length) tickSoon()
}

async function onRepliesTab(msg: any) {
    if (await isConnecting()) return
    const me = await getLocal<Me | null>(KEYS.me, null)
    if (!me || msg.userId !== me.userId || !Array.isArray(msg.tweets)) return
    const replies = recentReplies(msg.tweets.slice(0, 100).map(pageTweet).filter(Boolean), me.userId)
    if ((await trackReplies(replies)).length) tickSoon()
}

// An x.com page said who it's signed in as. During a sign-in, the login
// tab's page names the second account; otherwise a page on the browser's main
// cookies names the user, or says the browser is signed in to the second
// account for now (notePageUser).
async function onPageUser(msg: any, sender: chrome.runtime.MessageSender) {
    if (!isTweetId(msg.userId) || typeof msg.screenName !== 'string' || !/^\w{1,15}$/.test(msg.screenName)) return
    // has_graduated_access, when the page's account record carries it
    const graduated = typeof msg.graduated === 'boolean' ? (msg.graduated as boolean) : undefined
    const who = { userId: msg.userId, screenName: msg.screenName, graduated }
    if (await isConnecting()) {
        if (await isLoginTab(sender.tab?.id)) await finishConnect(who)
        return
    }
    if (!inMainCookieStore(sender.tab)) return
    await notePageUser(who)
}

// The in-page notes: replies X hides from others, by id
async function pageNotes() {
    const tracked = await getTracked()
    const notes: Record<string, unknown> = {}
    for (const t of Object.values(tracked)) {
        if (t.last && HIDDEN_STATES.has(t.last.state) && isFinding(t.last))
            notes[t.id] = { state: t.last.state, section: t.last.section, viewer: t.last.viewer, at: t.last.at, authorSees: t.last.authorSees, graduated: t.last.graduated, viewerGraduated: t.last.viewerGraduated }
    }
    return { notes }
}

async function tellXTabs() {
    const tabs = await api.tabs.query({ url: 'https://x.com/*' }).catch(() => [] as chrome.tabs.Tab[])
    for (const tab of tabs) if (tab.id != null) api.tabs.sendMessage(tab.id, { action: 'notes-changed' }).catch(() => {})
}

// --- the popup's view of things ---

async function getState() {
    const tracked = Object.values(await getTracked()).sort((a, b) => (b.createdAt || b.capturedAt) - (a.createdAt || a.capturedAt))
    const second = await getSecondAccount()
    return {
        version: __VERSION__,
        dev: __DEV__,
        me: await getLocal<Me | null>(KEYS.me, null),
        second: second && { screenName: second.screenName, userId: second.userId, connectedAt: second.connectedAt, graduated: second.graduated },
        secondStatus: await accountTrouble('second'),
        userStatus: await accountTrouble('user'),
        connecting: await isConnecting(),
        connectResult: await getLocal(CONNECT_RESULT_KEY, null),
        lastTick: await getLocal(KEYS.lastTick, 0),
        reads: { user: await readsInWindow('user'), second: await readsInWindow('second') },
        tracked,
    }
}

const afterChecks = async <T>(work: Promise<T>): Promise<T> => {
    const result = await work
    await tellXTabs()
    return result
}

// --- messages ---

let devTxid = ''
api.runtime.onMessage.addListener((msg: any, sender, sendResponse) => {
    const reply = (p: Promise<unknown>) => {
        p.then(sendResponse, e => sendResponse({ ok: false, error: String(e?.message || e) }))
        return true
    }
    if (!msg || typeof msg.action !== 'string') return
    ensureAlarms().catch(() => {})
    if (isXTab(sender)) {
        switch (msg.action) {
            case 'learned-op':
                return reply(learnOp(msg).then(() => ({ ok: true })))
            case 'bearer':
                if (typeof msg.value === 'string' && /^[A-Za-z0-9%_-]{40,200}$/.test(msg.value)) return reply(setLocal(BEARER_KEY, msg.value).then(() => ({ ok: true })))
                return
            case 'created-reply':
                return reply(onCreatedReply(msg, sender).then(() => ({ ok: true })))
            case 'replies-tab':
                return reply(onRepliesTab(msg).then(() => ({ ok: true })))
            case 'page-user':
                return reply(onPageUser(msg, sender).then(() => ({ ok: true })))
            case 'page-notes':
                return reply(pageNotes())
            case 'dev-txid':
                if (__DEV__ && typeof msg.value === 'string') devTxid = msg.value.slice(0, 200)
                return
            case 'dev':
                if (__DEV__) return reply(devAction(msg.cmd, msg.args))
                return
        }
        return
    }
    if (!isOwnPage(sender)) return
    switch (msg.action) {
        case 'get-state':
            return reply(getState())
        case 'connect-start':
            return reply(getLocal<Me | null>(KEYS.me, null).then(me => startConnect(me?.userId || '')))
        case 'connect-cancel':
            return reply(cancelConnect('cancelled').then(() => ({ ok: true })))
        case 'disconnect':
            return reply(disconnectSecond().then(() => ({ ok: true })))
        case 'check-now':
            return reply(afterChecks(runTick({ force: true })))
        case 'check-one':
            if (!isTweetId(msg.id)) return
            return reply(afterChecks(runTick({ only: msg.id })))
        case 'add-link':
            return reply(
                trackByLink(String(msg.url || '')).then(async r => (r.ok && r.id ? { ...r, report: await afterChecks(runTick({ only: r.id })) } : r)),
            )
        case 'forget':
            if (!isTweetId(msg.id)) return
            return reply(forget(msg.id).then(updateBadge).then(() => ({ ok: true })))
        case 'mark-seen':
            return reply(updateBadge().then(() => ({ ok: true })))
        case 'dev':
            if (__DEV__) return reply(devAction(msg.cmd, msg.args))
            return
    }
})

// Dev builds: actions a test (or a person) can run from an x.com tab or an
// extension page. Production builds leave this out.
async function devAction(cmd: string, args: any): Promise<unknown> {
    if (!__DEV__) return null
    switch (cmd) {
        case 'probe': {
            return runProbe({ focalId: String(args?.focalId || ''), replyId: args?.replyId, txid: args?.useTxid ? devTxid : undefined })
        }
        case 'state':
            return getState()
        case 'tick':
            return afterChecks(runTick({ force: !!args?.force, only: args?.only }))
        case 'track-link':
            return trackByLink(String(args?.url || ''))
        case 'forget':
            return forget(String(args?.id || ''))
        case 'set-local':
            // seeds for tests: only the extension's own keys
            if (args && typeof args === 'object' && Object.keys(args).every(k => /^[a-z_]+$/.test(k))) {
                await api.storage.local.set(args)
                // as a sign-in does: the header rules follow the stored account
                if (KEYS.second in args) await applySecondAccount()
            }
            return { ok: true }
        case 'disconnect':
            return disconnectSecond().then(() => ({ ok: true }))
        case 'connect-start':
            // the same as the popup's button; the person still signs in on X's page
            return getLocal<Me | null>(KEYS.me, null).then(me => startConnect(me?.userId || ''))
        case 'reload':
            setTimeout(() => api.runtime.reload(), 100)
            return { ok: true }
        default:
            return { error: `unknown dev action ${cmd}` }
    }
}

// a test's handle on the dev actions, from the worker's own console
if (__DEV__) (globalThis as any).twisitterDev = { action: devAction }

// --- alarms ---

api.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === TICK_ALARM || alarm.name === SOON_ALARM) {
        recoverConnect()
            .catch(() => {})
            .then(() => afterChecks(runTick()))
            .catch(() => {})
    } else if (alarm.name === CONNECT_ALARM) {
        recoverConnect().catch(() => {})
    }
})

// --- the second account's sign-in (connect.ts) ---

// The login tab's next full page load names who signed in (onPageUser). X's
// login flow can move on without one; then the tab is reloaded.
api.tabs.onUpdated.addListener((tabId, changeInfo) => {
    const url = changeInfo.url
    if (!url || !/^https:\/\/x\.com\//.test(url) || url.startsWith(LOGIN_URL) || /\/i\/flow\//.test(url)) return
    isLoginTab(tabId)
        .then(isIt => {
            if (isIt)
                setTimeout(() => {
                    isLoginTab(tabId)
                        .then(still => (still ? api.tabs.reload(tabId) : undefined))
                        .catch(() => {})
                }, RELOAD_AFTER_LOGIN_MS)
        })
        .catch(() => {})
})
api.tabs.onRemoved.addListener(tabId => {
    isLoginTab(tabId)
        .then(isIt => (isIt ? cancelConnect('not_signed_in') : undefined))
        .catch(() => {})
})

api.notifications.onClicked.addListener(id => {
    if (!id.startsWith('twisitter-')) return
    api.tabs.create({ url: api.runtime.getURL('src/popup.html') }).catch(() => {})
    api.notifications.clear(id).catch(() => {})
})

api.runtime.onInstalled.addListener(details => {
    if (details.reason === 'install') api.tabs.create({ url: api.runtime.getURL('src/popup.html#welcome') }).catch(() => {})
})

// --- start ---

applySecondAccount().catch(() => {})
recoverConnect().catch(() => {})
ensureAlarms().catch(() => {})
updateBadge().catch(() => {})

// a reply posted moments ago with an alarm lost to a worker restart
getTracked()
    .then(tracked => {
        if (Object.values(tracked).some(t => t.nextCheckAt <= Date.now())) tickSoon()
    })
    .catch(() => {})

