// The words for a reply's state, shared by the popup and the in-page note

import type { ReplyState } from './check'

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

// One or two sentences: what others see, and that X doesn't say so
export function explain(state: ReplyState, viewer: string, section?: string, authorSees?: boolean): string {
    // only when the check read the author's view
    const you = authorSees === true ? ' X shows it to its author as normal.' : ''
    switch (state) {
        case 'listed':
            return `${viewer} sees it under the post.`
        case 'probable_spam':
            return `${viewer} sees it only after clicking "${showButton(section)}", in Relevant order, and not at all in Recent order.${you}`
        case 'missing':
            return `${viewer} doesn't see it under the post at all, in any order. It opens only from a direct link.${you}`
        case 'hidden_by_author':
            return `The post's author hid it. ${viewer} finds it only on the post's "hidden replies" page. X doesn't tell the reply's writer.`
        case 'unavailable':
            return `${viewer} gets "This Post is unavailable" instead of the reply.${you}`
        case 'deleted':
            return 'The reply was deleted.'
        case 'parent_unavailable':
            return `${viewer} can't see the post it replies to, so the check can't say.`
        default:
            return 'The check couldn’t finish; it will try again.'
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
