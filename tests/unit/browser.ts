// A stand-in for the extension APIs the background uses (storage, the header
// rule, the badge), and for fetch, so a round can run here as it would in the
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
        answer(table: Record<string, Route>) {
            routes = table
        },
        reset() {
            for (const k of Object.keys(store)) delete store[k]
            rules.length = 0
            fetched.length = 0
            routes = {}
        },
    }
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
