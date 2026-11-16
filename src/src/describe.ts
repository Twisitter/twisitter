// The words for a reply's state, shared by the popup, the in-page note and the
// notification

import type { Position, ReplyState } from './check'
import type { HistoryEntry } from './store'

export const STATE_LABEL: Record<ReplyState, string> = {
    listed: 'Shown to others',
    probable_spam: 'Behind "Show probable spam"',
    hidden_by_author: "Hidden by the post's author",
    missing: 'Missing for others',
    deleted: 'Deleted',
    unavailable: 'Unavailable to others',
    parent_unavailable: "Post can't be seen",
    unknown: 'Not checked yet',
}

const showButton = (section?: string) => `Show ${(section || 'Probable spam').toLowerCase()}`
export const stateLabel = (state: ReplyState, section?: string): string =>
    state === 'probable_spam' ? `Behind "${showButton(section)}"` : STATE_LABEL[state]

// has_graduated_access as X's data gave it: for the reply's author, and for
// the account that looked (as of its sign-in)
export interface AccessFlags {
    author?: boolean
    viewer?: boolean
}

// One or two sentences: what others see, and that X doesn't say so
export function explain(state: ReplyState, viewer: string, section?: string, authorSees?: boolean, access: AccessFlags = {}): string {
    // only when the check read the author's view
    const you = authorSees === true ? ' X shows it to its author as normal.' : ''
    // the account that looked was held back too: its view may not be everyone's
    const looker = access.viewer === false ? ` X was also holding ${viewer} back when it signed in, so its view may differ from most people's.` : ''
    // has_graduated_access false in X's own data: a likely reason
    const held = access.author === false ? ` X also holds its author's account back until it's sure a person runs it (X's "Unlock more on X" notice)` : ''
    switch (state) {
        case 'listed':
            return `${viewer} sees it under the post.`
        case 'probable_spam':
            return `${viewer} sees it only after clicking "${showButton(section)}", in Relevant order, and not at all in Recent order.${you}${held && `${held}, a common reason for this.`}${looker}`
        case 'missing':
            return `${viewer} doesn't see it under the post at all, in any order. It opens only from a direct link.${you}${held && `${held}.`}${looker}`
        case 'hidden_by_author':
            return `The post's author hid it. ${viewer} finds it only on the post's "hidden replies" page. X doesn't tell the reply's writer.`
        case 'unavailable':
            return `${viewer} gets "This Post is unavailable" instead of the reply.${you}${held && `${held}.`}${looker}`
        case 'deleted':
            return 'The reply was deleted.'
        case 'parent_unavailable':
            return `${viewer} can't see the post it replies to, so the check can't say.`
        default:
            return 'The check couldn’t finish; it will try again.'
    }
}

// The notification for replies a round just found hidden, null for none. A
// reply's writer still sees it where they left it, except when the post's
// author hid it: then it's gone from the thread for them too.
// A reply the user didn't write (added by its link, or the second account's)
// is worded as watched, not theirs: nobody read its writer's view, so nothing
// is said about what they see. `me` is the user's id, when known.
export function notification(
    items: Array<{ text?: string; authorId?: string; screenName?: string; last?: { state: ReplyState; section?: string } }>,
    me?: string,
): { title: string; message: string } | null {
    if (!items.length) return null
    const mine = (t: { authorId?: string }) => !!me && t.authorId === me
    if (items.length > 1)
        return items.every(mine)
            ? { title: `X is hiding ${items.length} of your replies`, message: 'X hides them from others without telling you. Open Twisitter to see them.' }
            : { title: `X is hiding ${items.length} replies you watch`, message: 'X hides them from others. Open Twisitter to see them.' }
    const { text, last } = items[0]
    const reply = `"${(text || '').slice(0, 80)}"`
    if (!mine(items[0])) {
        const watched = `the reply ${reply}${items[0].screenName ? ` by @${items[0].screenName}` : ''}`
        const title = 'X is hiding a reply you watch'
        switch (last?.state) {
            case 'probable_spam':
                return { title, message: `X puts ${watched} under "${last.section || 'Probable spam'}".` }
            case 'missing':
                return { title, message: `Others don't see ${watched} under the post.` }
            case 'unavailable':
                return { title, message: `Others get "This Post is unavailable" instead of ${watched}.` }
            case 'hidden_by_author':
                return { title, message: `The post's author hid ${watched}. Others find it only on the post's hidden-replies page.` }
            default:
                return { title, message: `X hides ${watched} from others.` }
        }
    }
    const title = 'X is hiding one of your replies'
    switch (last?.state) {
        case 'probable_spam':
            return { title, message: `Your reply ${reply} shows for you, but X puts it under "${last.section || 'Probable spam'}".` }
        case 'missing':
            return { title, message: `Your reply ${reply} shows for you, but others don't see it under the post.` }
        case 'unavailable':
            return { title, message: `Your reply ${reply} shows for you, but others get "This Post is unavailable" instead.` }
        case 'hidden_by_author':
            return { title, message: `Your reply ${reply} was hidden by the post's author. Others find it only on the post's hidden-replies page.` }
        default:
            return { title, message: `X hides your reply ${reply} from others without telling you.` }
    }
}

export const ago = (t: number, now = Date.now()): string => {
    const s = Math.max(0, Math.round((now - t) / 1000))
    if (s < 60) return 'just now'
    const m = Math.round(s / 60)
    if (m < 60) return `${m} min ago`
    const h = Math.round(m / 60)
    if (h < 48) return `${h} h ago`
    return `${Math.round(h / 24)} days ago`
}

export const ordinal = (n: number): string => {
    const tens = n % 100
    const suffix = tens >= 11 && tens <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'
    return `${n}${suffix}`
}

const replies = (n: number) => `${n} ${n === 1 ? 'reply' : 'replies'}`

// Where the reply sat among the replies the account that looked saw; when it
// isn't listed, how many of X's count that account sees. '' with nothing to say.
export function positionText(p: Position | undefined, viewer: string, section?: string): string {
    if (!p) return ''
    const short = p.xCount !== undefined && p.xCount > p.of
    if (p.rank === undefined)
        return p.part === 'list' && p.complete && short ? `${viewer} sees ${p.of} of the ${replies(p.xCount!)} X counts under the post.` : ''
    const where = p.part === 'fold' ? `behind "${showButton(section)}"` : 'in the list'
    const expected = [
        p.byEngagement !== undefined ? `by likes, reposts and replies about ${ordinal(p.byEngagement)}` : '',
        p.byDate !== undefined ? `newest first ${ordinal(p.byDate)}` : '',
    ].filter(Boolean)
    const counted = short ? ` X counts ${replies(p.xCount!)} under the post.` : ''
    return `${ordinal(p.rank)} of ${p.complete ? '' : 'at least '}${p.of} ${where}, as ${viewer} sees it${expected.length ? `; ${expected.join(', ')}` : ''}.${counted}`
}

// The finished checks as runs of one state: what changed, and when
export function historyText(history: HistoryEntry[] | undefined, now = Date.now()): string {
    const done = history || []
    if (done.length < 2) return ''
    const runs: Array<{ label: string; at: number; n: number }> = []
    for (const h of done) {
        const label = stateLabel(h.state, h.section)
        const last = runs[runs.length - 1]
        if (last && last.label === label) last.n++
        else runs.push({ label, at: h.at, n: 1 })
    }
    if (runs.length === 1) return `The same in all ${done.length} checks since ${ago(runs[0].at, now)}.`
    return `History: ${runs.map(r => `${r.label} (${ago(r.at, now)}${r.n > 1 ? `, ${r.n} checks` : ''})`).join(' → ')}.`
}
