// What the extension keeps, all in storage.local, all written by the
// background (extension pages and content scripts ask it by message). One
// read-and-write of a key at a time: the background is one thread, but its
// awaits interleave.

import api from './api'
import type { CheckOutcome, ReplyState } from './check'

export type ReplySource = 'posted' | 'replies_tab' | 'link'

export interface CheckRecord extends CheckOutcome {
    at: number
    // whose view the check read as "others"
    viewer: string
    // that account's has_graduated_access, as of its sign-in
    viewerGraduated?: boolean
}

// One finished check, kept so a change shows (missing, then "Probable spam")
export interface HistoryEntry {
    at: number
    state: ReplyState
    viewer: string
    section?: string
    quality?: string
    rank?: number
    of?: number
}
export const HISTORY_MAX = 20

// The reply's history with a check added: only checks that said something
// (not stopped, not "unknown"), the newest 20
export const withCheck = (history: HistoryEntry[] | undefined, r: CheckRecord): HistoryEntry[] =>
    r.stop || r.state === 'unknown'
        ? history || []
        : [
              ...(history || []),
              {
                  at: r.at,
                  state: r.state,
                  viewer: r.viewer,
                  ...(r.section ? { section: r.section } : {}),
                  ...(r.quality ? { quality: r.quality } : {}),
                  ...(r.position?.rank !== undefined ? { rank: r.position.rank } : {}),
                  ...(r.position ? { of: r.position.of } : {}),
              },
          ].slice(-HISTORY_MAX)

export interface Tracked {
    id: string
    parentId: string
    authorId?: string
    screenName?: string
    text?: string
    createdAt?: number
    capturedAt: number
    source: ReplySource
    nextCheckAt: number
    checks: number
    last?: CheckRecord
    // the latest check, when it couldn't say ("unknown"): `last` keeps the
    // answer before it
    lastTry?: CheckRecord
    // checks in a row that stopped early (a rate limit, a sign-in, an error)
    stops?: number
    // checks that said something, oldest first (withCheck)
    history?: HistoryEntry[]
}

export interface Me {
    userId: string
    screenName: string
    at: number
    // has_graduated_access, from x.com's page, when it says
    graduated?: boolean
}

export const KEYS = {
    tracked: 'tracked',
    me: 'me',
    second: 'second_account',
    secondStatus: 'second_status',
    userStatus: 'user_status',
    notified: 'notified',
    lastTick: 'last_tick',
    repliesTabAt: 'replies_tab_at',
    // a second account's sign-in in progress (connect.ts)
    connectPending: 'connect_pending',
} as const

export const MINUTE = 60 * 1000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR
// After a reply is first seen: a quick first look (X can file a reply away the
// moment it's posted), then less and less often for a month
export const SCHEDULE_MS = [2 * MINUTE, HOUR, 6 * HOUR, DAY, 3 * DAY, 7 * DAY, 14 * DAY, 30 * DAY]
export const MAX_TRACKED = 300

export const nextCheckAt = (capturedAt: number, now: number): number => {
    const step = SCHEDULE_MS.find(ms => capturedAt + ms > now + 30 * 1000)
    return step === undefined ? Number.MAX_SAFE_INTEGER : capturedAt + step
}

// After a check that stopped early: a quarter hour, then twice as long each
// time in a row, up to half a day, and never later than the next step. Past
// the month, a reply that keeps stopping is left after seven tries in a row.
export const RETRY_FIRST_MS = 15 * MINUTE
export const RETRY_MAX_MS = 12 * HOUR
const RETRIES_PAST_SCHEDULE = 7
export const retryAt = (capturedAt: number, stops: number, now: number): number => {
    const scheduled = nextCheckAt(capturedAt, now)
    if (scheduled === Number.MAX_SAFE_INTEGER && stops > RETRIES_PAST_SCHEDULE) return scheduled
    return Math.min(now + Math.min(RETRY_FIRST_MS * 2 ** Math.max(0, stops - 1), RETRY_MAX_MS), scheduled)
}

const locks = new Map<string, Promise<unknown>>()
export function oneAtATime<T>(name: string, task: () => Promise<T>): Promise<T> {
    const next = (locks.get(name) || Promise.resolve()).then(task, task)
    locks.set(
        name,
        next.catch(() => {}),
    )
    return next
}

export async function getLocal<T>(key: string, fallback: T): Promise<T> {
    try {
        const got = (await api.storage.local.get(key)) as any
        return got && got[key] !== undefined ? (got[key] as T) : fallback
    } catch {
        return fallback
    }
}
export const setLocal = (key: string, value: unknown) => api.storage.local.set({ [key]: value })

export const getTracked = () => getLocal<Record<string, Tracked>>(KEYS.tracked, {})

export const updateTracked = <T>(change: (tracked: Record<string, Tracked>) => T | Promise<T>): Promise<T> =>
    oneAtATime(KEYS.tracked, async () => {
        const tracked = await getTracked()
        const result = await change(tracked)
        // the oldest captures go first past the cap
        const ids = Object.keys(tracked)
        if (ids.length > MAX_TRACKED)
            ids.sort((a, b) => tracked[a].capturedAt - tracked[b].capturedAt)
                .slice(0, ids.length - MAX_TRACKED)
                .forEach(id => delete tracked[id])
        await setLocal(KEYS.tracked, tracked)
        return result
    })

export interface NewReply {
    id: string
    parentId: string
    authorId?: string
    screenName?: string
    text?: string
    createdAt?: number
    source: ReplySource
}

// Adds replies not tracked yet; returns the ones it added
export const trackReplies = (replies: NewReply[], now = Date.now()) =>
    updateTracked(tracked => {
        const added: Tracked[] = []
        for (const r of replies) {
            if (!r.id || !r.parentId || tracked[r.id]) continue
            tracked[r.id] = { ...r, capturedAt: now, nextCheckAt: nextCheckAt(now, now), checks: 0 }
            added.push(tracked[r.id])
        }
        return added
    })

// Notified once per reply and state, ever (capped)
export const takeUnnotified = (keys: string[]) =>
    oneAtATime(KEYS.notified, async () => {
        const seen = new Set(await getLocal<string[]>(KEYS.notified, []))
        const fresh = keys.filter(k => !seen.has(k))
        if (fresh.length) await setLocal(KEYS.notified, [...seen, ...fresh].slice(-2000))
        return fresh
    })
