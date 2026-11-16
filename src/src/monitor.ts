// The background's rounds: new replies on the user's Replies tab, and the
// checks that are due, a few per round.
//
// Every read is one an x.com page makes in ordinary browsing (x-api.ts): the
// extension never asks X anything just to learn who is signed in. The user's
// account comes from x.com's own pages (content.ts); whether a session still
// works, or X wants a pause, comes from the checks' own answers.

import api from './api'
import { checkReply, isFinding, type CheckOutcome, type Read } from './check'
import { getSecondAccount, isConnecting } from './connect'
import { notification } from './describe'
import { readAsSecond, readAsUser, readsInWindow, READS_PER_WINDOW, type SecondAccount } from './requests'
import {
    getLocal,
    getTracked,
    KEYS,
    MINUTE,
    nextCheckAt,
    retryAt,
    setLocal,
    takeUnnotified,
    trackReplies,
    updateTracked,
    withCheck,
    type Me,
    type NewReply,
    type Tracked,
} from './store'
import { createdAtMs, parseTimeline, type XTweet } from './timeline'
import { classifyAnswer, describeAnswer, repliesTabVariables, tweetDetailVariables, type XAnswer } from './x-api'

export const TICK_ALARM = 'tick'
export const TICK_MINUTES = 5
export const SOON_ALARM = 'soon'
const REPLIES_TAB_EVERY_MS = 30 * MINUTE
// one reply per five-minute round: a check is a few reads, often one
const CHECKS_PER_TICK = 1
// the Replies tab adds what's recent; an older reply comes in by its link
const REPLIES_TAB_MAX_AGE_MS = 30 * 24 * 60 * MINUTE
// a check reads at most about ten times; leave room for that
const READS_KEPT_FREE = 12

// What X's answers said about an account's session lately: none stored means
// all's well
export interface AccountStatus {
    // signed_out: X no longer takes the session; rate_limited: X asked for a
    // pause, until `until`; other_account (the user only): x.com in this
    // browser is signed in to the second account, named in `detail`
    state: 'signed_out' | 'rate_limited' | 'other_account'
    until?: number
    at: number
    detail?: string
}
type Who = 'user' | 'second'
const STATUS_KEY: Record<Who, string> = { user: KEYS.userStatus, second: KEYS.secondStatus }

async function noteAnswer(who: Who, answer: XAnswer): Promise<XAnswer> {
    const kind = classifyAnswer(answer)
    const key = STATUS_KEY[who]
    const now = Date.now()
    // while x.com is on the second account, a refusal is about that session,
    // not the user's: the status that says so stays
    const otherAccount = (await getLocal<AccountStatus | null>(key, null))?.state === 'other_account'
    if (kind === 'signed_out') {
        if (!otherAccount) await setLocal(key, { state: 'signed_out', at: now, detail: describeAnswer(answer) })
    }
    else if (kind === 'rate_limited') {
        // X says when the window resets; a quarter hour if it doesn't
        const reset = (answer.rateReset || 0) * 1000
        await setLocal(key, { state: 'rate_limited', at: now, until: reset > now && reset < now + 30 * MINUTE ? reset : now + 15 * MINUTE })
    } else if (kind === 'ok' && !otherAccount) {
        // a good answer ends X's trouble with a session, but not the browser
        // being signed in to the second account: that read carried its
        // session, and only a page signed in as the user ends it (notePageUser)
        if (await getLocal(key, null)) await api.storage.local.remove(key)
    }
    return answer
}
export const readAsUserNoted: Read = async (name, variables) => noteAnswer('user', await readAsUser(name, variables))
const readAsSecondNoted =
    (second: SecondAccount): Read =>
    async (name, variables) => {
        const answer = await readAsSecond(second, name, variables)
        // an answer for an account disconnected or replaced during the read
        // says nothing about the account connected now
        if ((await getSecondAccount())?.token !== second.token) return { status: 0, failure: 'not kept: the second account changed' }
        return noteAnswer('second', answer)
    }

// An x.com page said who it's signed in as, outside a sign-in. That's the
// user, unless it's the second account: then this browser's X session is the
// second account's for now, and reads as the user wait (they would carry that
// session) until a page signed in as the user loads again.
export async function notePageUser(who: { userId: string; screenName: string; graduated?: boolean }) {
    const second = await getSecondAccount()
    if (second && who.userId === second.userId) {
        await setLocal(KEYS.userStatus, { state: 'other_account', at: Date.now(), detail: `@${who.screenName}` })
        return
    }
    const me = await getLocal<Me | null>(KEYS.me, null)
    if (!me || me.userId !== who.userId || me.screenName !== who.screenName || me.graduated !== who.graduated) await setLocal(KEYS.me, { ...who, at: Date.now() })
    // a page signed in is a session X takes
    await api.storage.local.remove(KEYS.userStatus)
}

// The account's trouble, if any; a pause that has run out is over
export async function accountTrouble(who: Who): Promise<AccountStatus | null> {
    const status = await getLocal<AccountStatus | null>(STATUS_KEY[who], null)
    if (status?.state === 'rate_limited' && (status.until || 0) <= Date.now()) {
        await api.storage.local.remove(STATUS_KEY[who])
        return null
    }
    return status
}

export const toNewReply = (t: XTweet, source: NewReply['source']): NewReply | null =>
    t.kind === 'tweet' && t.inReplyTo
        ? {
              id: t.id,
              parentId: t.inReplyTo,
              authorId: t.authorId,
              screenName: t.screenName,
              text: (t.text || '').slice(0, 500),
              createdAt: createdAtMs(t.createdAt),
              source,
          }
        : null

// The user's own recent replies on a Replies tab page (the background's read,
// or the page's own when the user opens the tab)
export const recentReplies = (tweets: XTweet[], userId: string, now = Date.now()): NewReply[] =>
    tweets
        .filter(t => t.authorId === userId)
        .map(t => toNewReply(t, 'replies_tab'))
        .filter((r): r is NewReply => !!r && now - (r.createdAt ?? 0) < REPLIES_TAB_MAX_AGE_MS)

// The user's Replies tab, for replies posted anywhere, the phone apps included
async function refreshRepliesTab(me: Me, force: boolean) {
    const at = await getLocal<number>(KEYS.repliesTabAt, 0)
    if (!force && Date.now() - at < REPLIES_TAB_EVERY_MS) return
    await setLocal(KEYS.repliesTabAt, Date.now())
    const answer = await readAsUserNoted('UserRepliesTimeline', repliesTabVariables(me.userId))
    if (classifyAnswer(answer) !== 'ok') return
    await trackReplies(recentReplies(parseTimeline(answer.json).tweets, me.userId))
}

// The roles for one reply. Usually the user wrote it and the second account is
// "others". A reply the second account wrote (added by link) swaps them.
// userOk: the user's own session works, as far as X last said
export function rolesFor(reply: Tracked, me: Me | null, second: SecondAccount, userOk = true) {
    const asSecond = readAsSecondNoted(second)
    if (reply.authorId && reply.authorId === second.userId)
        return userOk ? { asViewer: readAsUserNoted, asAuthor: asSecond, viewer: me ? `@${me.screenName}` : 'your account', viewerGraduated: me?.graduated } : null
    return {
        asViewer: asSecond,
        asAuthor: userOk && me && reply.authorId === me.userId ? readAsUserNoted : undefined,
        viewer: `@${second.screenName}`,
        viewerGraduated: second.graduated,
    }
}

async function checkOne(reply: Tracked, me: Me | null, second: SecondAccount, userOk: boolean): Promise<CheckOutcome | null> {
    const roles = rolesFor(reply, me, second, userOk)
    if (!roles) return null
    const outcome = await checkReply(reply, roles.asViewer, roles.asAuthor)
    const now = Date.now()
    await updateTracked(tracked => {
        const t = tracked[reply.id]
        if (!t) return
        t.checks++
        const record = { ...outcome, at: now, viewer: roles.viewer, ...(roles.viewerGraduated !== undefined ? { viewerGraduated: roles.viewerGraduated } : {}) }
        // a check that couldn't say leaves the answer before it standing
        if (outcome.state === 'unknown' && t.last && t.last.state !== 'unknown') t.lastTry = record
        else {
            t.last = record
            delete t.lastTry
            t.history = withCheck(t.history, record)
        }
        // one that stopped early tries again, less often each time in a row
        if (outcome.stop) {
            t.stops = (t.stops || 0) + 1
            t.nextCheckAt = retryAt(t.capturedAt, t.stops, now)
        } else {
            delete t.stops
            t.nextCheckAt = nextCheckAt(t.capturedAt, now)
        }
    })
    return outcome
}

export interface TickReport {
    skipped?: string
    checked: Array<{ id: string; state: string; reads: number; stop?: string }>
    findings: number
}

let ticking: Promise<TickReport> | null = null
// One round at a time: a second request while one runs waits for it
export function runTick(opts: { force?: boolean; only?: string } = {}): Promise<TickReport> {
    const run = async (): Promise<TickReport> => {
        const report: TickReport = { checked: [], findings: 0 }
        await setLocal(KEYS.lastTick, Date.now())
        if (await isConnecting()) return { ...report, skipped: 'connecting' }
        const me = await getLocal<Me | null>(KEYS.me, null)
        const userOk = !(await accountTrouble('user'))
        if (me && userOk && !opts.only) await refreshRepliesTab(me, !!opts.force).catch(() => {})
        const second = await getSecondAccount()
        if (!second) return { ...report, skipped: 'no_second_account' }
        const trouble = await accountTrouble('second')
        if (trouble) return { ...report, skipped: `second_${trouble.state}` }
        const tracked = await getTracked()
        const now = Date.now()
        const due = Object.values(tracked)
            .filter(t => (opts.only ? t.id === opts.only : opts.force || t.nextCheckAt <= now))
            // a reply the second account wrote waits while the user's session
            // can't be read; it mustn't hold up the replies behind it
            .filter(t => rolesFor(t, me, second, userOk))
            .sort((a, b) => a.nextCheckAt - b.nextCheckAt)
            .slice(0, opts.only ? 1 : opts.force ? 5 : CHECKS_PER_TICK)
        const findings: string[] = []
        for (const reply of due) {
            if ((await readsInWindow('second')) > READS_PER_WINDOW - READS_KEPT_FREE) {
                report.skipped = 'read_budget'
                break
            }
            // a sign-in, a Disconnect or a new second account since the round began
            if (await isConnecting()) {
                report.skipped = 'connecting'
                break
            }
            if ((await getSecondAccount())?.token !== second.token) {
                report.skipped = 'second_account_changed'
                break
            }
            const outcome = await checkOne(reply, me, second, userOk)
            if (!outcome) continue
            report.checked.push({ id: reply.id, state: outcome.state, reads: outcome.reads, ...(outcome.stop && { stop: outcome.stop }) })
            // once per reply: X can file a new reply away before it labels it
            if (isFinding(outcome)) findings.push(`${reply.id}:hidden`)
            // the reads noted whose session it was (accountTrouble)
            if (outcome.stop === 'rate_limited' || outcome.stop === 'signed_out') break
        }
        report.findings = findings.length
        await notify(await takeUnnotified(findings))
        await updateBadge()
        return report
    }
    const next = (ticking || Promise.resolve()).then(run, run)
    ticking = next.finally(() => {
        if (ticking === next) ticking = null
    }) as Promise<TickReport>
    return next
}

const actionApi = () => (__BUILT_FOR__ === 'firefox' ? (api as any).browserAction : api.action)

export async function updateBadge() {
    const tracked = await getTracked()
    const n = Object.values(tracked).filter(t => t.last && isFinding(t.last)).length
    try {
        await actionApi().setBadgeText({ text: n ? String(n) : '' })
        await actionApi().setBadgeBackgroundColor({ color: '#b3261e' })
    } catch {
        /* no badge here */
    }
}

async function notify(keys: string[]) {
    if (!keys.length) return
    const tracked = await getTracked()
    const me = await getLocal<Me | null>(KEYS.me, null)
    // none, when every reply named was dropped in the meantime
    const words = notification(
        keys.map(k => tracked[k.split(':')[0]]).filter(Boolean),
        me?.userId,
    )
    if (!words) return
    try {
        await api.notifications.create(`twisitter-${Date.now()}`, {
            type: 'basic',
            iconUrl: api.runtime.getURL('icons/128.png'),
            ...words,
        })
    } catch {
        /* notifications off */
    }
}

// A reply named by its link: one read of its page says what it replies to
export async function trackByLink(url: string): Promise<{ ok: boolean; error?: string; id?: string }> {
    const m = String(url).match(/^https:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:[A-Za-z0-9_]{1,15}|i\/web)\/status\/(\d{1,25})/)
    if (!m) return { ok: false, error: 'not_a_post_link' }
    const id = m[1]
    if ((await getTracked())[id]) return { ok: true, id }
    // its first read is as the user, which waits while a second account signs in
    if (await isConnecting()) return { ok: false, error: 'connecting' }
    const second = await getSecondAccount()
    const me = await getLocal<Me | null>(KEYS.me, null)
    // the reply opened directly, as the user, or as the second account when
    // nobody is known to be signed in here
    const answer =
        me || !second
            ? await readAsUserNoted('TweetDetail', tweetDetailVariables(id))
            : await readAsSecondNoted(second)('TweetDetail', tweetDetailVariables(id))
    const kind = classifyAnswer(answer)
    if (kind !== 'ok') return { ok: false, error: kind === 'signed_out' ? 'signed_out' : describeAnswer(answer) }
    const tweet = parseTimeline(answer.json).tweets.find(t => t.id === id)
    if (!tweet || tweet.kind !== 'tweet') return { ok: false, error: 'not_found' }
    const reply = toNewReply(tweet, 'link')
    if (!reply) return { ok: false, error: 'not_a_reply' }
    await trackReplies([reply])
    return { ok: true, id }
}

export const forget = (id: string) =>
    updateTracked(tracked => {
        delete tracked[id]
    })

export const ensureAlarms = async () => {
    const tick = await api.alarms.get(TICK_ALARM).catch(() => null)
    if (!tick) api.alarms.create(TICK_ALARM, { periodInMinutes: TICK_MINUTES, delayInMinutes: 1 })
}
// a check soon after a reply is posted (its first look is due in two minutes)
export const tickSoon = () => api.alarms.create(SOON_ALARM, { delayInMinutes: 2.2 })

