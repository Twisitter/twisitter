// The log a problem report carries (report.ts): a line for each thing worth
// knowing about what the background did. Only the background writes it, to
// storage.local.
//
// What it never holds: an account's name or id (the user's, the second
// account's, or one an account check looked at), cookies, tokens, or what a
// post says. Post ids go in as #<id>, which the report form on twisitter.com
// can swap for stand-ins (always, in a public report).
//
// A quiet round (nothing due, or a reply listed as before) only adds to its
// hour's totals, kept in a key of their own and written out as one line once
// the hour is over. So a quiet hour is one line, and MAX_LINES holds days.
import api from './api'
import { getLocal, HOUR, oneAtATime } from './store'

export const LOG_KEY = 'diag_log'
export const HOUR_KEY = 'diag_hour'
export const MAX_LINES = 400
const MAX_LINE_CHARS = 400
const LOG_LOCK = 'diag-log'

export interface Hour {
    at: number // when the hour began
    rounds: number
    // routine checks by state, rounds that stopped short or read nothing (by
    // why), reads by account and kind ('user TweetDetail'), and reads X didn't
    // answer well ('second TweetDetail rate_limited')
    checks: Record<string, number>
    skipped: Record<string, number>
    reads: Record<string, number>
    failed: Record<string, number>
}

// "11-16 20:05", in UTC, as the report's header says
export const stamp = (t: number): string => new Date(t).toISOString().slice(5, 16).replace('T', ' ')
// An error's message for the log: no query strings, and short
export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/\?\S*/g, '').slice(0, 160)

const clip = (s: string) => (s.length > MAX_LINE_CHARS ? `${s.slice(0, MAX_LINE_CHARS - 1)}…` : s)
const listed = (c: Record<string, number>) =>
    Object.entries(c)
        .map(([k, n]) => `${k} ${n}`)
        .join(', ')
const add = (c: Record<string, number>, k: string) => (c[k] = (c[k] || 0) + 1)
const isHour = (h: any): h is Hour => !!h && typeof h === 'object' && typeof h.at === 'number' && ['checks', 'skipped', 'reads', 'failed'].every(k => h[k] && typeof h[k] === 'object')
const storedLines = async (): Promise<string[]> => {
    const lines = await getLocal<unknown>(LOG_KEY, [])
    return Array.isArray(lines) ? lines.filter((l): l is string => typeof l === 'string') : []
}

export function hourLine(h: Hour): string {
    const parts = [`${stamp(h.at)}–${stamp(h.at + HOUR - 60_000).slice(6)} · ${h.rounds} round${h.rounds === 1 ? '' : 's'}`]
    if (Object.keys(h.checks).length) parts.push(`checks: ${listed(h.checks)}`)
    if (Object.keys(h.skipped).length) parts.push(`skipped: ${listed(h.skipped)}`)
    if (Object.keys(h.reads).length) parts.push(`reads: ${listed(h.reads)}`)
    if (Object.keys(h.failed).length) parts.push(`not ok: ${listed(h.failed)}`)
    return clip(parts.join(' · '))
}

// The hour now gets `change`, and the log gets `line`. An hour that's over is
// written out as its line first.
function write(now: number, change: (h: Hour) => void, line?: string): Promise<void> {
    return oneAtATime(LOG_LOCK, async () => {
        const at = now - (now % HOUR)
        const stored = await getLocal<unknown>(HOUR_KEY, null)
        let hour = isHour(stored) ? stored : null
        const lines: string[] = []
        if (hour && hour.at !== at) {
            lines.push(hourLine(hour))
            hour = null
        }
        hour ||= { at, rounds: 0, checks: {}, skipped: {}, reads: {}, failed: {} }
        change(hour)
        if (line) lines.push(clip(`${stamp(now)} ${line}`))
        const writes: Record<string, unknown> = { [HOUR_KEY]: hour }
        if (lines.length) writes[LOG_KEY] = [...(await storedLines()), ...lines].slice(-MAX_LINES)
        await api.storage.local.set(writes)
    })
}

// Every read (monitor.ts's noted readers), and how X answered it. A read held
// back (a sign-in open) wasn't sent, so it's no read, only a "not ok".
export const noteRead = (who: 'user' | 'second', op: string, kind: string, status: number, now = Date.now()) =>
    write(now, h => {
        const k = `${who} ${op}`
        if (kind !== 'not_sent') add(h.reads, k)
        if (kind !== 'ok') add(h.failed, `${k} ${kind}${kind === 'error' ? ` ${status}` : ''}`)
    })

export interface RoundCheck {
    id: string
    state: string
    // the state its check before this one came to
    was?: string
    reads: number
    stop?: string
}

// A round's end (monitor.ts runTick). It gets a line when a check found
// something, changed, or stopped early; a quiet one only counts.
export function noteRound(checked: RoundCheck[], skipped: string | undefined, now = Date.now()): Promise<void> {
    const changed = (c: RoundCheck) => !!c.was && c.was !== c.state
    const notable = checked.some(c => c.state !== 'listed' || changed(c) || c.stop)
    const line = notable
        ? `round · ${checked
              .map(c => `#${c.id} ${changed(c) ? `${c.was} → ` : ''}${c.state} (${c.reads} read${c.reads === 1 ? '' : 's'}${c.stop ? `, stopped: ${c.stop}` : ''})`)
              .join(' · ')}${skipped ? ` · then: ${skipped}` : ''}`
        : undefined
    return write(
        now,
        h => {
            h.rounds++
            if (!notable) for (const c of checked) add(h.checks, c.state)
            if (skipped) add(h.skipped, skipped)
        },
        line,
    )
}

// Something worth a line of its own: an install, a sign-in, an account's
// trouble, an account check
export const logEvent = (text: string, now = Date.now()): Promise<void> => write(now, () => {}, text)

// The log, oldest first, with the hour still running as its last line
export async function getLogLines(): Promise<string[]> {
    const [lines, hour] = await Promise.all([storedLines(), getLocal<unknown>(HOUR_KEY, null)])
    return isHour(hour) ? [...lines, `${hourLine(hour)} so far`] : lines
}
