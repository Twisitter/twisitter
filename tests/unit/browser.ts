// A stand-in for the extension APIs the background uses (storage, the header
// rule, the badge, tabs and scripts), and for fetch, so a round can run here as it would in the
// worker. X's answers come from a table keyed like fakeRead's, with who asked:
// "second TweetDetail:<focal>:<cursor>" for a marked read, "user ..." for one
// with the browser's own cookies.

import { vi } from 'vitest'
import type { XAnswer } from '../../src/src/x-api'

export const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop'

export type Route = XAnswer | ((key: string) => XAnswer | Promise<XAnswer>)

export function fakeBrowser() {
    const store: Record<string, any> = {}
    const rules: any[] = []
    const fetched: string[] = []
    let routes: Record<string, Route> = {}
    // tabs a test lays out, and each call made on tabs and scripts
    const openTabs: FakeTab[] = []
    const tabCalls: string[] = []
    // tabs whose content script answers a ping, and tabs that take no scripts
    const pinged = new Set<number>()
    const refusing = new Set<number>()
    // x.com's cookies in the browser, by name
    const cookieJar = new Map<string, string>()
    let nextTab = 100
    const tabById = (id: number) => {
        const t = openTabs.find(x => x.id === id)
        if (!t) throw new Error(`No tab with id: ${id}.`)
        return t
    }
    const scriptInto = (tabId: number, call: string) => {
        if (refusing.has(tabId)) throw new Error('Cannot access contents of the page.')
        tabCalls.push(call)
    }
    ;(globalThis as any).chrome = {
        runtime: { id: EXTENSION_ID, getURL: (p: string) => `chrome-extension://${EXTENSION_ID}/${p}` },
        storage: {
            local: {
                get: async (k: string | string[]) => {
                    const keys = Array.isArray(k) ? k : [k]
                    return Object.fromEntries(keys.filter(x => x in store).map(x => [x, structuredClone(store[x])]))
                },
                set: async (o: Record<string, unknown>) => void Object.assign(store, structuredClone(o)),
                remove: async (k: string | string[]) => void (Array.isArray(k) ? k : [k]).forEach(x => delete store[x]),
            },
        },
        action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
        notifications: { create: async () => {} },
        declarativeNetRequest: {
            getSessionRules: async () => structuredClone(rules),
            updateSessionRules: async ({ removeRuleIds = [], addRules = [] }: { removeRuleIds?: number[]; addRules?: any[] }) => {
                for (let i = rules.length - 1; i >= 0; i--) if (removeRuleIds.includes(rules[i].id)) rules.splice(i, 1)
                rules.push(...structuredClone(addRules))
            },
        },
        tabs: {
            query: async ({ url }: { url?: string } = {}) => structuredClone(openTabs.filter(t => !url || t.url.startsWith(url.replace(/\*$/, '')))),
            get: async (id: number) => structuredClone(tabById(id)),
            create: async ({ url, active, openerTabId, windowId }: { url: string; active?: boolean; openerTabId?: number; windowId?: number }) => {
                const t: FakeTab = { id: nextTab++, url, active: active !== false, windowId: windowId ?? 1, ...(openerTabId != null && { openerTabId }) }
                openTabs.push(t)
                tabCalls.push(`create ${t.id} ${url}${active === false ? ' background' : ''}`)
                return structuredClone(t)
            },
            update: async (id: number, { url, active }: { url?: string; active?: boolean }) => {
                const t = tabById(id)
                if (url) t.url = url
                if (active) t.active = true
                tabCalls.push(`update ${id}${url ? ` ${url}` : ''}${active ? ' front' : ''}`)
                return structuredClone(t)
            },
            reload: async (id: number) => void tabCalls.push(`reload ${tabById(id).id}`),
            sendMessage: async (id: number, msg: any) => {
                if (!pinged.has(id)) throw new Error('Could not establish connection. Receiving end does not exist.')
                return msg?.action === 'ping' ? { ok: true } : undefined
            },
        },
        cookies: {
            get: async ({ name }: { url: string; name: string }) => (cookieJar.has(name) ? { name, value: cookieJar.get(name), domain: '.x.com' } : null),
        },
        scripting: {
            executeScript: async ({ target, files, world }: { target: { tabId: number }; files: string[]; world?: string }) =>
                void scriptInto(target.tabId, `script ${target.tabId} ${files.join(',')}${world ? ` ${world}` : ''}`),
            insertCSS: async ({ target, files }: { target: { tabId: number }; files: string[] }) => void scriptInto(target.tabId, `css ${target.tabId} ${files.join(',')}`),
        },
    }
    ;(globalThis as any).fetch = async (url: string) => {
        const u = new URL(url)
        const v = JSON.parse(u.searchParams.get('variables') || '{}')
        const who = u.searchParams.has('tw_as') ? 'second' : 'user'
        const key = `${who} ${u.pathname.split('/').pop()}:${v.focalTweetId || v.rootTweetId || v.userId || ''}:${v.cursor || ''}`
        fetched.push(key)
        const route = routes[key]
        const answer: XAnswer = route === undefined ? { status: 404 } : typeof route === 'function' ? await route(key) : route
        // what readAnswer reads of a Response
        return { status: answer.status, headers: { get: () => null }, text: async () => (answer.json === undefined ? '' : JSON.stringify(answer.json)) }
    }
    return {
        store,
        rules,
        fetched,
        openTabs,
        tabCalls,
        pinged,
        refusing,
        cookieJar,
        answer(table: Record<string, Route>) {
            routes = table
        },
        reset() {
            for (const k of Object.keys(store)) delete store[k]
            rules.length = 0
            fetched.length = 0
            routes = {}
            openTabs.length = 0
            tabCalls.length = 0
            pinged.clear()
            refusing.clear()
            cookieJar.clear()
            nextTab = 100
        },
    }
}

export interface FakeTab {
    id: number
    url: string
    active: boolean
    windowId: number
    discarded?: boolean
    openerTabId?: number
}

// Runs `work` with fake timers moving on, so the reads' 2.5 s pacing and the
// rounds' waits pass at once
export async function settle<T>(work: Promise<T>): Promise<T> {
    let done = false
    work.then(
        () => (done = true),
        () => (done = true),
    )
    for (let i = 0; i < 1000 && !done; i++) await vi.advanceTimersByTimeAsync(500)
    return work
}
