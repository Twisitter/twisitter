// The account check: another account's replies, as someone outside it sees
// them.
//
// The user scrolls that account's Replies tab on x.com. The page's own reads
// pass through the page hook (inject.ts), so listing the replies costs no read
// of Twisitter's. A click then checks the newest of them, each in its parent's
// reply list (checkReply), as the user: to another account's replies the user
// is already "others". A follow, mute or block changes what X shows the user,
// so then the second account reads instead, when one is connected.
//
// Who follows, mutes or blocks the writer comes from X's own answers: the
// Replies tab's, trusted only when its page was signed in as the user, and
// each check's, which say how the account that looked relates to the writer
// at that moment.
//
// There's no writer's view: a check can't say what the writer sees, or tell a
// deleted reply from one X keeps from everyone ("unknown"). One check per
// click, and nobody else's replies are checked again in the background.
// Results are kept 30 days, as ids, states and times.

import api from './api'
import type { Relation } from './capture'
import { checkReply, HIDDEN_STATES, type Position, type Read, type ReplyState } from './check'
import { getSecondAccount, isConnecting } from './connect'
import { accountTrouble, readAsSecondNoted, readAsUserNoted } from './monitor'
import { readsInWindow, type SecondAccount } from './requests'
import { DAY, getLocal, HOUR, KEYS, oneAtATime, setLocal, type Me } from './store'
import { createdAtMs } from './timeline'
import { isTweetId } from './x-api'

// Replies a click checks: the newest of what the user scrolled
export const MAX_CHECKED = 20
// What a tab scrolled is kept this long after its last page, and this much
export const SEEN_TTL_MS = 6 * HOUR
const SEEN_MAX = 200
const SEEN_TABS_MAX = 30
// Results, and the latest check's record, are kept this long
export const RESULTS_TTL_MS = 30 * DAY
const RESULTS_MAX = 2000
// A result this young stands when a click comes again, if the same account
// looked: a check stopped by the read limit goes on where it stopped
export const FRESH_MS = HOUR
// Reads per 15 minutes a check leaves room under. As the user it's a fifth of
// what X allows for TweetDetail (300). As the second account it keeps to half
// of the rounds' own window, so the user's own checks go on.
export const USER_READS_CAP = 60
export const SECOND_READS_CAP = 30
// a check reads at most this many times (check.ts: 4 + 2 + 2 + 1)
export const ONE_CHECK_READS = 9
// checks in a row that stopped early before a run gives up: X's errors or a
// network that's down fail every reply the same way
const FAILURES_TO_STOP = 2
// old data goes at most this often (pruneAccountChecks)
const PRUNE_EVERY_MS = HOUR

export interface SeenReply {
    id: string
    parentId: string
    createdAt?: number
}

export interface SeenTab {
    userId: string
    screenName: string
    // the last page seen
    at: number
    // the follow, mute and block X's answer gave, and the account the page was
    // signed in as: the relation is that account's
    relation: Relation
    viewerId?: string
    // the account's replies to other accounts, newest first
    replies: SeenReply[]
}

export interface OtherResult {
    id: string
    writerId: string
    parentId: string
    createdAt?: number
    state: ReplyState
    at: number
    // the account that looked, as a handle and an id, and whose session it was
    viewer: string
    readerId: string
    reader: 'user' | 'second'
    // the account that looked follows the writer
    follows?: boolean
    section?: string
    quality?: string
    graduated?: boolean
    position?: Position
    stop?: string
    detail: string
    // a later look that couldn't say: the answer above still stands
    lastTry?: { at: number; detail: string; stop?: string }
}

export type RunStop =
    | 'read_limit'
    | 'rate_limited'
    | 'signed_out'
    | 'stale_client'
    | 'connecting'
    | 'account_changed'
    | 'other_account'
    | 'cut_off'
    // checks in a row stopped early
    | 'failing'
    // X said the account that looked mutes or blocks the writer
    | 'reader_mutes'
    // X said the user follows the writer: the second account reads next time
    | 'reader_follows'

export interface AccountRun {
    userId: string
    screenName: string
    tabId: number
    reader: 'user' | 'second'
    readerId: string
    viewer: string
    follows?: boolean
    startedAt: number
    updatedAt: number
    // the replies this check covers, how many are done, and how many X hides
    total: number
    done: number
    findings: number
    state: 'running' | 'done' | 'stopped'
    stop?: RunStop
}

// Post ids grow with time: a longer id, or a larger one as long, is newer
export const newerFirst = (a: string, b: string): number => b.length - a.length || (b > a ? 1 : b < a ? -1 : 0)

const cleanRelation = (r: any): Relation => {
    const out: Relation = {}
    if (r && typeof r === 'object') for (const k of ['following', 'muting', 'blocking'] as const) if (typeof r[k] === 'boolean') out[k] = r[k]
    return out
}

// The account's replies to other accounts, from one Replies-tab page (the
// page's own fields, untrusted). Its replies in its own threads are left out:
// X's reply-spam scoring skips them.
export function repliesToOthers(userId: string, tweets: unknown[]): SeenReply[] {
    const out: SeenReply[] = []
    for (const t of tweets.slice(0, 100) as any[]) {
        if (!t || t.authorId !== userId || !isTweetId(t.id) || !isTweetId(t.inReplyTo)) continue
        if (!isTweetId(t.inReplyToUserId) || t.inReplyToUserId === userId) continue
        const createdAt = typeof t.createdAt === 'string' ? createdAtMs(t.createdAt.slice(0, 40)) : undefined
        out.push({ id: t.id, parentId: t.inReplyTo, ...(createdAt !== undefined ? { createdAt } : {}) })
    }
    return out
}

// What each tab scrolled, less what's older than SEEN_TTL_MS
async function getSeenTabs(now: number): Promise<Record<string, SeenTab>> {
    const all = await getLocal<Record<string, SeenTab>>(KEYS.seenTabs, {})
    const out: Record<string, SeenTab> = {}
    if (all && typeof all === 'object') for (const [k, v] of Object.entries(all)) if (v && now - v.at < SEEN_TTL_MS) out[k] = v
    return out
}

// The tab's follow, mute and block, if they're the user's: X's answer gives
// them for whoever the page was signed in as
export const relationFor = (seen: Pick<SeenTab, 'relation' | 'viewerId'>, me: Me | null): Relation =>
    me && seen.viewerId === me.userId ? seen.relation || {} : {}

// A Replies-tab page an x.com tab loaded (inject.ts, through content.ts, which
// adds the account the page is signed in as). A tab's first page starts what
// it scrolled; later pages of the same account add to it. The user's own tab
// adds replies to watch instead (background.ts).
export async function noteRepliesTab(tabId: number | undefined, msg: any, me: Me | null, now = Date.now()): Promise<void> {
    if (typeof tabId !== 'number' || !Number.isInteger(tabId) || tabId < 0) return
    if (!msg || !isTweetId(msg.userId) || !Array.isArray(msg.tweets)) return
    if (me && msg.userId === me.userId) return
    const userId: string = msg.userId
    const screenName = typeof msg.screenName === 'string' && /^\w{1,15}$/.test(msg.screenName) ? msg.screenName : ''
    const relation = cleanRelation(msg.relation)
    const viewerId = isTweetId(msg.viewerId) ? msg.viewerId : undefined
    const replies = repliesToOthers(userId, msg.tweets)
    await oneAtATime(KEYS.seenTabs, async () => {
        const all = await getSeenTabs(now)
        const key = String(tabId)
        const before = all[key]
        const going = msg.first !== true && before?.userId === userId ? before : null
        const byId = new Map((going?.replies || []).map(r => [r.id, r]))
        for (const r of replies) byId.set(r.id, r)
        // a page with no relation keeps the one before it, from the same account
        const fresh = Object.keys(relation).length > 0
        all[key] = {
            userId,
            screenName: screenName || going?.screenName || '',
            at: now,
            relation: fresh ? relation : going?.relation || {},
            ...((fresh ? viewerId : going?.viewerId) ? { viewerId: fresh ? viewerId : going?.viewerId } : {}),
            replies: [...byId.values()].sort((a, b) => newerFirst(a.id, b.id)).slice(0, SEEN_MAX),
        }
        // the tabs seen longest ago go first past the cap
        const keys = Object.keys(all)
        if (keys.length > SEEN_TABS_MAX)
            keys.sort((a, b) => all[a].at - all[b].at)
                .slice(0, keys.length - SEEN_TABS_MAX)
                .forEach(k => delete all[k])
        await setLocal(KEYS.seenTabs, all)
    })
}

// A check read how the user relates to the writer: the tab keeps that
async function noteRelation(tabId: number, writerId: string, viewerId: string, relation: Relation) {
    await oneAtATime(KEYS.seenTabs, async () => {
        const all = await getLocal<Record<string, SeenTab>>(KEYS.seenTabs, {})
        const seen = all?.[String(tabId)]
        if (!seen || seen.userId !== writerId) return
        seen.relation = cleanRelation(relation)
        seen.viewerId = viewerId
        await setLocal(KEYS.seenTabs, all)
    })
}

export const forgetTab = (tabId: number) =>
    oneAtATime(KEYS.seenTabs, async () => {
        const all = await getLocal<Record<string, SeenTab>>(KEYS.seenTabs, {})
        if (!all || !(String(tabId) in all)) return
        delete all[String(tabId)]
        await setLocal(KEYS.seenTabs, all)
    })

// The browser started: its tabs are new, so nothing any tab scrolled stands
export const forgetAllTabs = () => oneAtATime(KEYS.seenTabs, () => api.storage.local.remove(KEYS.seenTabs))

export type Refusal = 'unknown_user' | 'own_account' | 'needs_second'

export interface ReaderPlan {
    reader: 'user' | 'second'
    viewer: string
    // the user follows the writer and reads all the same: X may show the
    // user replies it hides from others
    follows?: boolean
    refuse?: Refusal
}

// Who looks. The user, unless a follow, mute or block makes the user's view
// not an outsider's: then the second account, when one is connected and isn't
// the writer. A mute or block with no such account can't be checked at all.
export function readerFor(seen: Pick<SeenTab, 'userId' | 'relation' | 'viewerId'>, me: Me | null, second: Pick<SecondAccount, 'userId' | 'screenName'> | null): ReaderPlan {
    if (!me) return { reader: 'user', viewer: 'your account', refuse: 'unknown_user' }
    const you = `@${me.screenName}`
    if (seen.userId === me.userId) return { reader: 'user', viewer: you, refuse: 'own_account' }
    const r = relationFor(seen, me)
    const close = !!(r.following || r.muting || r.blocking)
    if (close && second && second.userId !== seen.userId) return { reader: 'second', viewer: `@${second.screenName}` }
    if (r.muting || r.blocking) return { reader: 'user', viewer: you, refuse: 'needs_second' }
    return { reader: 'user', viewer: you, ...(r.following ? { follows: true } : {}) }
}

const getResults = async (): Promise<Record<string, OtherResult>> => {
    const all = await getLocal<Record<string, OtherResult>>(KEYS.otherResults, {})
    return all && typeof all === 'object' ? all : {}
}

// A look at one reply, kept. One that couldn't say leaves an earlier answer
// standing, as the rounds do (monitor.ts checkOne), and is noted beside it.
const saveResult = (r: OtherResult) =>
    oneAtATime(KEYS.otherResults, async () => {
        const all = await getResults()
        const now = Date.now()
        for (const [k, v] of Object.entries(all)) if (!v || now - v.at >= RESULTS_TTL_MS) delete all[k]
        const before = all[r.id]
        all[r.id] =
            r.state === 'unknown' && before && before.state !== 'unknown'
                ? { ...before, lastTry: { at: r.at, detail: r.detail, ...(r.stop ? { stop: r.stop } : {}) } }
                : r
        const keys = Object.keys(all)
        if (keys.length > RESULTS_MAX)
            keys.sort((a, b) => all[a].at - all[b].at)
                .slice(0, keys.length - RESULTS_MAX)
                .forEach(k => delete all[k])
        await setLocal(KEYS.otherResults, all)
    })

// Results and the latest check's record past 30 days, and tabs scrolled long
// ago, go. At most hourly, from the rounds' alarm and the background's start,
// so a Firefox background page that never restarts still clears them.
export async function pruneAccountChecks(now = Date.now(), force = false) {
    if (!force && now - (await getLocal<number>(KEYS.accountPrunedAt, 0)) < PRUNE_EVERY_MS) return
    await setLocal(KEYS.accountPrunedAt, now)
    await oneAtATime(KEYS.otherResults, async () => {
        const all = await getResults()
        const keep = Object.fromEntries(Object.entries(all).filter(([, v]) => v && now - v.at < RESULTS_TTL_MS))
        if (Object.keys(keep).length !== Object.keys(all).length) await setLocal(KEYS.otherResults, keep)
    })
    await oneAtATime(KEYS.seenTabs, async () => {
        const all = await getLocal<Record<string, SeenTab>>(KEYS.seenTabs, {})
        const keep = await getSeenTabs(now)
        if (Object.keys(keep).length !== Object.keys(all || {}).length) await setLocal(KEYS.seenTabs, keep)
    })
    const run = await getLocal<AccountRun | null>(KEYS.accountRun, null)
    if (run && !current && now - run.updatedAt >= RESULTS_TTL_MS) await api.storage.local.remove(KEYS.accountRun)
}

// The in-page notes for other accounts' replies X hides. The replies the user
// watches are left out (`watched`): their own checks decide their notes.
export async function otherNotes(now = Date.now(), watched: ReadonlySet<string> = new Set()) {
    const notes: Record<string, { state: ReplyState; section?: string; viewer: string; at: number; other: true; follows?: boolean; graduated?: boolean }> = {}
    for (const r of Object.values(await getResults())) {
        if (!r || watched.has(r.id) || now - r.at >= RESULTS_TTL_MS || !HIDDEN_STATES.has(r.state)) continue
        notes[r.id] = {
            state: r.state,
            ...(r.section ? { section: r.section } : {}),
            viewer: r.viewer,
            at: r.at,
            other: true,
            ...(r.follows ? { follows: true } : {}),
            ...(r.graduated !== undefined ? { graduated: r.graduated } : {}),
        }
    }
    return notes
}

// The check that runs now, in this background. A run stored as running with
// none here was cut off: a service worker stops, and its work with it.
let current: Promise<void> | null = null

async function finish(run: AccountRun, state: AccountRun['state'], stop?: RunStop) {
    run.state = state
    if (stop) run.stop = stop
    run.updatedAt = Date.now()
    await setLocal(KEYS.accountRun, run)
}

// Why the next reply shouldn't be read now, if there's a reason
async function whyStop(run: AccountRun, meId: string, token: string | undefined): Promise<RunStop | null> {
    if (await isConnecting()) return 'connecting'
    if (run.reader === 'second' && (await getSecondAccount())?.token !== token) return 'account_changed'
    if (run.reader === 'user' && (await getLocal<Me | null>(KEYS.me, null))?.userId !== meId) return 'account_changed'
    const trouble = await accountTrouble(run.reader)
    if (trouble) return trouble.state
    const cap = run.reader === 'user' ? USER_READS_CAP : SECOND_READS_CAP
    if ((await readsInWindow(run.reader)) > cap - ONE_CHECK_READS) return 'read_limit'
    return null
}

async function runChecks(run: AccountRun, targets: SeenReply[], read: Read, meId: string, second: SecondAccount | null, onResult: () => void) {
    // the second account can read in the user's place, unless it's the writer
    const secondUsable = !!second && second.userId !== run.userId
    let failures = 0
    for (const target of targets) {
        const prior = (await getResults())[target.id]
        // the same account looked within the hour, and could say
        const reuse = !!prior && prior.state !== 'unknown' && prior.readerId === run.readerId && prior.writerId === run.userId && Date.now() - prior.at < FRESH_MS
        if (reuse) {
            if (HIDDEN_STATES.has(prior.state)) run.findings++
            run.done++
        } else {
            const stop = await whyStop(run, meId, second?.token)
            if (stop) return finish(run, 'stopped', stop)
            run.updatedAt = Date.now()
            await setLocal(KEYS.accountRun, run)
            const outcome = await checkReply({ id: target.id, parentId: target.parentId }, read)
            // X's answers say how the account that looked relates to the writer now
            const rel = outcome.viewerRelation
            if (rel && run.reader === 'user') await noteRelation(run.tabId, run.userId, meId, rel)
            const muted = !!(rel?.muting || rel?.blocking)
            const follows = rel ? !!rel.following : !!run.follows
            await saveResult({
                id: target.id,
                writerId: run.userId,
                parentId: target.parentId,
                ...(target.createdAt !== undefined ? { createdAt: target.createdAt } : {}),
                // a muted or blocked writer's replies are kept from the looker
                // by its own choice: that says nothing about others
                state: muted ? 'unknown' : outcome.state,
                at: Date.now(),
                viewer: run.viewer,
                readerId: run.readerId,
                reader: run.reader,
                ...(follows && !muted ? { follows: true } : {}),
                ...(outcome.section && !muted ? { section: outcome.section } : {}),
                ...(outcome.quality ? { quality: outcome.quality } : {}),
                ...(outcome.graduated !== undefined ? { graduated: outcome.graduated } : {}),
                ...(outcome.position && !muted ? { position: outcome.position } : {}),
                ...(outcome.stop ? { stop: outcome.stop } : {}),
                detail: muted ? `${run.viewer} mutes or blocks its writer` : outcome.detail,
            })
            if (!muted && HIDDEN_STATES.has(outcome.state)) {
                run.findings++
                onResult()
            }
            run.done++
            // the reads noted whose session it was (accountTrouble)
            if (outcome.stop === 'rate_limited' || outcome.stop === 'signed_out' || outcome.stop === 'stale_client') return finish(run, 'stopped', outcome.stop)
            failures = outcome.stop ? failures + 1 : 0
            if (failures >= FAILURES_TO_STOP) return finish(run, 'stopped', 'failing')
            if (muted) return finish(run, 'stopped', 'reader_mutes')
            // the user turns out to follow the writer: the second account reads next time
            if (run.reader === 'user' && rel?.following && !run.follows) {
                if (secondUsable) return finish(run, 'stopped', 'reader_follows')
                run.follows = true
            }
        }
        run.updatedAt = Date.now()
        await setLocal(KEYS.accountRun, run)
    }
    return finish(run, 'done')
}

export type StartError = Refusal | 'no_tab' | 'already_checking' | 'connecting' | 'no_replies_tab' | 'no_replies' | 'user_trouble' | 'second_trouble'

// A click on "Check @name's replies" for the account the tab scrolled. It
// answers once the check has begun; `done` settles when it ends.
export async function startAccountCheck(tabId: number, onResult: () => void = () => {}): Promise<{ ok: boolean; error?: StartError; done?: Promise<void> }> {
    if (!Number.isInteger(tabId) || tabId < 0) return { ok: false, error: 'no_tab' }
    if (current) return { ok: false, error: 'already_checking' }
    if (await isConnecting()) return { ok: false, error: 'connecting' }
    const now = Date.now()
    const seen = (await getSeenTabs(now))[String(tabId)]
    if (!seen) return { ok: false, error: 'no_replies_tab' }
    const me = await getLocal<Me | null>(KEYS.me, null)
    const second = await getSecondAccount()
    const plan = readerFor(seen, me, second)
    if (plan.refuse || !me) return { ok: false, error: plan.refuse || 'unknown_user' }
    if (await accountTrouble(plan.reader)) return { ok: false, error: plan.reader === 'user' ? 'user_trouble' : 'second_trouble' }
    const targets = seen.replies.slice(0, MAX_CHECKED)
    if (!targets.length) return { ok: false, error: 'no_replies' }
    // checked again before any await of the run: one check at a time
    if (current) return { ok: false, error: 'already_checking' }
    const read: Read = plan.reader === 'second' && second ? readAsSecondNoted(second) : readAsUserNoted
    const run: AccountRun = {
        userId: seen.userId,
        screenName: seen.screenName,
        tabId,
        reader: plan.reader,
        readerId: plan.reader === 'second' && second ? second.userId : me.userId,
        viewer: plan.viewer,
        ...(plan.follows ? { follows: true } : {}),
        startedAt: now,
        updatedAt: now,
        total: targets.length,
        done: 0,
        findings: 0,
        state: 'running',
    }
    const done = (async () => {
        await setLocal(KEYS.accountRun, run)
        await runChecks(run, targets, read, me.userId, second, onResult)
    })()
        .catch(() => finish(run, 'stopped', 'cut_off').catch(() => {}))
        .finally(() => {
            current = null
            onResult()
        })
    current = done
    return { ok: true, done }
}

// The popup's view of a tab's account check
export async function accountState(tabId: number, now = Date.now()) {
    const seen = (await getSeenTabs(now))[String(tabId)] || null
    const me = await getLocal<Me | null>(KEYS.me, null)
    const second = await getSecondAccount()
    let run = await getLocal<AccountRun | null>(KEYS.accountRun, null)
    if (run?.state === 'running' && !current) {
        run = { ...run, state: 'stopped', stop: 'cut_off' }
        await setLocal(KEYS.accountRun, run)
    }
    const results = seen
        ? Object.values(await getResults())
              .filter(r => r && r.writerId === seen.userId && now - r.at < RESULTS_TTL_MS)
              .sort((a, b) => newerFirst(a.id, b.id))
        : []
    return {
        seen: seen && {
            userId: seen.userId,
            screenName: seen.screenName,
            count: seen.replies.length,
            at: seen.at,
            // X's answer said how the user relates to the account
            relationKnown: Object.keys(relationFor(seen, me)).length > 0,
        },
        plan: seen ? readerFor(seen, me, second) : null,
        run: run && seen && run.userId === seen.userId ? run : null,
        results: results.slice(0, 100),
        max: MAX_CHECKED,
    }
}

// "Open Replies tab": the tab loads the account's Replies tab, X's own page
export async function openRepliesTab(tabId: number, screenName: string): Promise<{ ok: boolean; error?: string }> {
    if (!Number.isInteger(tabId) || tabId < 0 || !/^\w{1,15}$/.test(screenName)) return { ok: false, error: 'no_tab' }
    const tab = await api.tabs.get(tabId).catch(() => null)
    if (!tab || !/^https:\/\/x\.com\//.test(String(tab.url || ''))) return { ok: false, error: 'no_tab' }
    await api.tabs.update(tabId, { url: `https://x.com/${screenName}/with_replies` })
    return { ok: true }
}
