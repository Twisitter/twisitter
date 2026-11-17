// "Report a problem": the report form on twisitter.com, opened with the
// version, a status summary and the diagnostic log (diaglog.ts) filled in.
// They travel in the link's #fragment, which the browser never sends to a
// server, so nothing leaves the machine until the person presses Send there.
// The form can also post the report as a public GitHub issue. It can hide the
// post ids, and always does in a public one.
//
// What goes in never names an account: no names or ids (the user's, the
// second account's, or one an account check looked at), no cookies or tokens,
// and nothing a post says.
import api from './api'
import { getResults, type AccountRun } from './account-check'
import { ago } from './describe'
import { getLogLines } from './diaglog'
import { accountTrouble, TICK_ALARM, type AccountStatus } from './monitor'
import { getSecondAccount, pendingSignIn, readsInWindow } from './requests'
import { getLocal, getTracked, KEYS, type Me } from './store'

export const FEEDBACK_URL = 'https://twisitter.com/feedback'
// The link carries the log, so it keeps the newest lines that fit: a link of a
// few tens of KB opens fine in every browser Twisitter runs in.
export const REPORT_LOG_MAX_CHARS = 16000

export interface ReportDetails {
    v: string // version
    b: string // browser and system
    s: string // status summary
    l: string // diagnostic log, oldest first
    t: number // when this was put together
}

export function browserName(ua: string): string {
    const name = [
        ['Firefox', 'Firefox'],
        ['Edg', 'Edge'],
        ['OPR', 'Opera'],
        ['HeadlessChrome', 'Headless Chrome'],
        ['Chrome', 'Chrome'],
    ]
        .map(([token, label]) => {
            const m = ua.match(new RegExp(`\\b${token}/(\\d+)`))
            return m ? `${label} ${m[1]}` : ''
        })
        .find(Boolean)
    const os = /Windows/.test(ua)
        ? 'Windows'
        : /CrOS/.test(ua)
          ? 'ChromeOS'
          : /Android/.test(ua)
            ? 'Android'
            : /Mac OS X|Macintosh/.test(ua)
              ? 'macOS'
              : /Linux/.test(ua)
                ? 'Linux'
                : ''
    return [name, os].filter(Boolean).join(', ') || 'unknown browser'
}

const when = (t: number | undefined, now: number) => (t ? ago(t, now) : 'never')
const inTime = (ms: number) => {
    const m = Math.round(ms / 60000)
    return m < 1 ? 'in under a minute' : m < 60 ? `in ${m} min` : m < 48 * 60 ? `in ${Math.round(m / 60)} h` : `in ${Math.round(m / 1440)} days`
}
const trouble = (s: AccountStatus | null, now: number) =>
    !s ? 'X answers normally' : s.state === 'rate_limited' ? `X asked for a pause, until ${new Date(s.until || now).toISOString().slice(11, 16)} UTC` : s.state === 'signed_out' ? `X says it's signed out (${ago(s.at, now)})` : 'x.com here is on the second account'
const tally = (states: string[]) => {
    const counts: Record<string, number> = {}
    for (const s of states) counts[s] = (counts[s] || 0) + 1
    return Object.entries(counts)
        .map(([k, n]) => `${k} ${n}`)
        .join(', ')
}

// The status summary: the accounts (never by name), what's watched and how
// it last looked, the rounds, the reads, and the last account check.
export async function statusSummary(now = Date.now()): Promise<string> {
    const [me, second, pending, userStatus, secondStatus, tracked, lastTick, alarm, readsUser, readsSecond, run, results] = await Promise.all([
        getLocal<Me | null>(KEYS.me, null),
        getSecondAccount(),
        pendingSignIn(),
        accountTrouble('user'),
        accountTrouble('second'),
        getTracked(),
        getLocal<number>(KEYS.lastTick, 0),
        (async () => api.alarms.get(TICK_ALARM))().catch(() => null),
        readsInWindow('user'),
        readsInWindow('second'),
        getLocal<AccountRun | null>(KEYS.accountRun, null),
        getResults(),
    ])
    const replies = Object.values(tracked)
    const due = replies.map(t => t.nextCheckAt).filter(t => t < Number.MAX_SAFE_INTEGER)
    const next = due.length ? Math.min(...due) : 0
    let bytes = 0
    try {
        bytes = (await (api.storage.local as any).getBytesInUse?.(null)) || 0
    } catch {
        /* not in every browser */
    }
    return [
        me
            ? `Your account: ${me.at ? `last noted on x.com ${ago(me.at, now)} (noted at most hourly)` : 'known from a posted reply, not yet from an x.com page'}${me.graduated === false ? ' · X holds it back (no graduated access)' : ''} · ${trouble(userStatus, now)}`
            : 'Your account: not seen on x.com yet',
        second
            ? `Second account: connected ${ago(second.connectedAt, now)}${second.graduated === false ? ' · X holds it back (no graduated access)' : ''} · ${trouble(secondStatus, now)}`
            : `Second account: not connected${pending ? ' · a sign-in is open' : ''}`,
        `Watching ${replies.length} repl${replies.length === 1 ? 'y' : 'ies'}` +
            (replies.length ? ` (${tally(replies.map(t => t.source))}) · last checks: ${tally(replies.map(t => t.last?.state || 'not checked yet'))}` : ''),
        `Rounds: last ${when(lastTick, now)} · next check due ${next ? (next <= now ? 'now' : inTime(next - now)) : 'none'} · round timer ${alarm ? 'set' : 'missing'}`,
        `Reads in the last 15 min: as you ${readsUser}, as the second account ${readsSecond}`,
        run
            ? `Account check: last ${ago(run.updatedAt, now)} as ${run.reader === 'user' ? 'you' : 'the second account'}, ${run.done} of ${run.total} checked, ${run.state}${run.stop ? `: ${run.stop}` : ''} · ${Object.keys(results).length} results kept`
            : 'Account check: none yet',
        ...(bytes ? [`Storage: ${(bytes / 1048576).toFixed(1)} MB used`] : []),
    ].join('\n')
}

// The newest lines that fit in `max` characters, with a note when older ones
// were left out
export function newestLines(lines: string[], max: number): string {
    const kept: string[] = []
    let size = 0
    for (let i = lines.length - 1; i >= 0; i--) {
        if (size + lines[i].length + 1 > max) {
            kept.unshift(`(${i + 1} older line${i ? 's' : ''} left out)`)
            break
        }
        kept.unshift(lines[i])
        size += lines[i].length + 1
    }
    return kept.join('\n')
}

export async function buildReportDetails(now = Date.now()): Promise<ReportDetails> {
    return {
        v: api.runtime.getManifest().version,
        b: browserName(navigator.userAgent),
        s: await statusSummary(now),
        l: newestLines(await getLogLines(), REPORT_LOG_MAX_CHARS),
        t: now,
    }
}

// base64url of the details' JSON, as the form's `#r=` reads it
export function reportUrl(d: ReportDetails): string {
    const bytes = new TextEncoder().encode(JSON.stringify(d))
    let bin = ''
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return `${FEEDBACK_URL}#r=${btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
}

// The form, with the details, or bare when the browser's setting keeps them
export async function openReport(withDetails = true): Promise<{ ok: boolean }> {
    await api.tabs.create({ url: withDetails ? reportUrl(await buildReportDetails()) : FEEDBACK_URL })
    return { ok: true }
}
