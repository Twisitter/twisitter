// The check: how a reply looks to the second account, set against how it
// looks to its author. Pure apart from the reads it's given, so the tests run
// it on recorded answers.
//
// As the second account:
//   1. the parent post's reply list, in Relevant order, following "Show
//      probable spam" (ShowMoreThreads) cursors and a few pages of more replies;
//   2. if the reply isn't there, <post>/hidden (ModeratedTimeline): replies the
//      post's author hid;
//   3. if it isn't there either, the reply opened directly: deleted or
//      unavailable, or there but missing from the list.
// Then, for any reply the second account doesn't see listed, the parent's
// list as the author, which says whether X shows the author something else.

import { classifyAnswer, describeAnswer, moderatedVariables, tweetDetailVariables, type AnswerKind, type OpName, type XAnswer } from './x-api'
import { isPromptCursor, parseTimeline, type TimelineCursor, type XTweet } from './timeline'

export type Read = (name: OpName, variables: object) => Promise<XAnswer>

export type ReplyState =
    | 'listed' // in the reply list as usual
    | 'probable_spam' // only behind "Show probable spam" (or a prompt like it)
    | 'hidden_by_author' // on <post>/hidden: the post's author hid it
    | 'missing' // in no list, though it opens directly
    | 'deleted' // its own page says it was deleted
    | 'unavailable' // its own page says it's unavailable
    | 'parent_unavailable' // the second account can't see the post it replies to
    | 'unknown' // the check couldn't finish (rate limit, sign-in, a big thread)

// The states where X shows others something other than the author's view
export const HIDDEN_STATES: ReadonlySet<ReplyState> = new Set(['probable_spam', 'hidden_by_author', 'missing', 'unavailable'])

export interface CheckOutcome {
    state: ReplyState
    // the heading X put over the reply, e.g. "Probable spam"
    section?: string
    // whether the author's own view lists it (not asked for listed replies)
    authorSees?: boolean
    reads: number
    // why the check stopped early
    stop?: Exclude<AnswerKind, 'ok'>
    detail: string
}

export interface ReplyRef {
    id: string
    parentId: string
}

// Small threads matter most; a long one isn't read to its end. The list
// itself: three pages of replies, and the page after them, where X puts "Show
// probable spam" when it keeps replies there.
export const MAX_THREAD_PAGES = 4
// The part behind "Show probable spam": its first page and one more
export const MAX_FOLD_PAGES = 2

interface ThreadWalk {
    found: boolean
    // found only by following a "Show probable spam" cursor
    behindPrompt: boolean
    section: string
    parent?: XTweet
    // the list went on past the pages read
    truncated: boolean
    reads: number
    stop?: Exclude<AnswerKind, 'ok'>
    stopDetail?: string
}

// Reads the parent's reply list until the reply turns up or the list ends.
// "Show probable spam" cursors go first: they cost one read and hold the
// replies X sets apart. A page that adds no tweets ends the paging, since a
// followed bottom cursor can return yet another bottom cursor. The list and
// the part behind the button each have their own page limit (maxPages,
// maxFoldPages), so the empty page that carries the button doesn't use up
// the reads the part behind it needs.
export async function walkThread(
    read: Read,
    parentId: string,
    replyId: string,
    maxPages = MAX_THREAD_PAGES,
    maxFoldPages = MAX_FOLD_PAGES,
): Promise<ThreadWalk> {
    const walk: ThreadWalk = { found: false, behindPrompt: false, section: '', truncated: false, reads: 0 }
    const seenTweets = new Set<string>()
    const seenCursors = new Set<string>()
    // fold: the page goes on with the part behind "Show probable spam";
    // action: that button's words
    const queue: Array<{ cursor?: TimelineCursor; fold?: boolean; action?: string }> = [{}]
    const pagesRead = { list: 0, fold: 0 }
    while (queue.length) {
        const entry = queue.shift()!
        const { cursor } = entry
        // the page goes on with the part behind "Show probable spam": reached
        // through that button, or through a bottom cursor found inside that
        // part (its later pages carry no heading)
        const pageFold = !!entry.fold || (!!cursor && isPromptCursor(cursor))
        // past the pages a check reads of that part: the list went on there
        if (pageFold ? pagesRead.fold >= maxFoldPages : pagesRead.list >= maxPages) {
            walk.truncated = true
            continue
        }
        const answer = await read('TweetDetail', tweetDetailVariables(parentId, cursor?.value))
        walk.reads++
        pagesRead[pageFold ? 'fold' : 'list']++
        const kind = classifyAnswer(answer)
        if (kind !== 'ok') {
            walk.stop = kind
            walk.stopDetail = describeAnswer(answer)
            return walk
        }
        const page = parseTimeline(answer.json)
        const fresh = page.tweets.filter(t => !seenTweets.has(t.id))
        fresh.forEach(t => seenTweets.add(t.id))
        if (!cursor) {
            walk.parent = page.tweets.find(t => t.id === parentId)
            // a reply list starts with its post: an answer without it is
            // something else, and says nothing about the replies
            if (!walk.parent) {
                walk.stop = 'error'
                walk.stopDetail = "the answer didn't hold the post"
                return walk
            }
            // a post that can't be seen has no reply list to read
            if (walk.parent.kind !== 'tweet') return walk
        }
        const hit = page.tweets.find(t => t.id === replyId && t.kind === 'tweet')
        if (hit) {
            walk.found = true
            // a heading such as "Probable spam" sets its part of the list apart too
            walk.behindPrompt = pageFold || !!hit.section
            // a heading ("Probable spam"), or the button's words without "Show"
            walk.section = hit.section || (walk.behindPrompt ? headingFrom(entry.action || cursor?.actionText || 'Show more replies') : '')
            return walk
        }
        const prompts = page.cursors.filter(c => isPromptCursor(c) && !seenCursors.has(c.value))
        // X closes the part behind the button with TimelineTerminateTimeline
        // Bottom. The list's own first page carries one too, beside a bottom
        // cursor that does go on, so only the button's part is taken at its word.
        const partEnds = pageFold && page.endsBelow
        const more = fresh.length && !partEnds ? page.cursors.filter(c => c.type === 'Bottom' && !seenCursors.has(c.value)) : []
        // a bottom cursor found behind the button goes on with that part. A
        // heading on a list page doesn't carry over: X may head other things
        // there, and a listed reply must never read as set apart.
        for (const c of [...prompts, ...more]) seenCursors.add(c.value)
        queue.unshift(...prompts.map(c => ({ cursor: c, fold: true, action: c.actionText })))
        queue.push(...more.map(c => ({ cursor: c, fold: pageFold, action: pageFold ? entry.action || cursor?.actionText : undefined })))
    }
    return walk
}

// <post>/hidden, as the reader sees it: one page holds 20, and a reply the
// author hid long ago may be further down, so two pages at most
async function onHiddenPage(read: Read, parentId: string, replyId: string) {
    let reads = 0
    let cursor: string | undefined
    for (let i = 0; i < 2; i++) {
        const answer = await read('ModeratedTimeline', moderatedVariables(parentId, cursor))
        reads++
        const kind = classifyAnswer(answer)
        if (kind !== 'ok') return { found: false, reads, stop: kind, stopDetail: describeAnswer(answer) }
        const page = parseTimeline(answer.json)
        if (page.tweets.some(t => t.id === replyId)) return { found: true, reads }
        const next = page.cursors.find(c => c.type === 'Bottom')
        if (!page.tweets.length || !next) break
        cursor = next.value
    }
    return { found: false, reads }
}

// The reply's own page: what anyone who follows a link to it sees
async function openDirectly(read: Read, replyId: string) {
    const answer = await read('TweetDetail', tweetDetailVariables(replyId))
    const kind = classifyAnswer(answer)
    if (kind !== 'ok') return { reads: 1, stop: kind, stopDetail: describeAnswer(answer) }
    const page = parseTimeline(answer.json)
    const own = page.tweets.find(t => t.id === replyId)
    // X answers a post's page with an entry for it even when it's deleted or
    // kept from the reader: one without it is something else
    if (!own) return { reads: 1, stop: 'error' as const, stopDetail: "the answer didn't hold the reply" }
    return { reads: 1, own }
}

const DELETED = /deleted/i
const headingFrom = (actionText: string) => {
    const words = actionText.replace(/^show\s+/i, '')
    return words.charAt(0).toUpperCase() + words.slice(1)
}

export async function checkReply(reply: ReplyRef, asViewer: Read, asAuthor?: Read): Promise<CheckOutcome> {
    let reads = 0
    const stopped = (stop: Exclude<AnswerKind, 'ok'>, detail: string): CheckOutcome => ({ state: 'unknown', stop, reads, detail })

    const walk = await walkThread(asViewer, reply.parentId, reply.id)
    reads += walk.reads
    if (walk.stop) return stopped(walk.stop, `reading the reply list: ${walk.stopDetail}`)
    if (walk.found && !walk.behindPrompt) return { state: 'listed', reads, detail: 'listed under the post' }
    // nobody can read the replies of a post they can't see
    if (walk.parent && walk.parent.kind !== 'tweet')
        return {
            state: 'parent_unavailable',
            reads,
            detail: walk.parent.note ? `the post it replies to says "${walk.parent.note}"` : "the post it replies to can't be seen",
        }

    let state: ReplyState
    let section: string | undefined
    let detail: string
    if (walk.found) {
        state = 'probable_spam'
        section = walk.section
        detail = `only behind "${walk.section}"`
    } else {
        const hidden = await onHiddenPage(asViewer, reply.parentId, reply.id)
        reads += hidden.reads
        if (hidden.stop) return stopped(hidden.stop, `reading the hidden replies: ${hidden.stopDetail}`)
        if (hidden.found) {
            state = 'hidden_by_author'
            detail = "on the post's hidden replies page"
        } else {
            const direct = await openDirectly(asViewer, reply.id)
            reads += direct.reads
            if (direct.stop) return stopped(direct.stop, `opening the reply: ${direct.stopDetail}`)
            const own = direct.own
            if (!own || own.kind !== 'tweet') {
                const note = own?.note || ''
                // a deleted reply is gone for everyone: nothing to compare
                if (DELETED.test(note)) return { state: 'deleted', reads, detail: `its page says "${note}"` }
                detail = note ? `its page says "${note}"` : 'its page shows no post'
                // X answers a deleted reply's page with an empty result, the
                // same as one it won't show: only the author's own look tells
                // them apart, so without it the check can't say
                if (!asAuthor) return { state: 'unknown', reads, detail: `${detail}: deleted, or kept from others, and only its author's view tells which` }
                const mine = await openDirectly(asAuthor, reply.id)
                reads += mine.reads
                if (mine.stop) return { state: 'unknown', stop: mine.stop, reads, detail: `${detail}; its author's view wasn't read (${mine.stopDetail})` }
                if (mine.own?.kind !== 'tweet') return { state: 'deleted', authorSees: false, reads, detail: 'its page shows no post, to its author too' }
                return { state: 'unavailable', authorSees: true, reads, detail }
            }
            // a long list read only in part says nothing about the rest
            if (walk.truncated) return { state: 'unknown', reads, detail: 'not in the pages a check reads of a long reply list' }
            state = 'missing'
            detail = 'in no part of the reply list, though it opens directly'
        }
    }

    if (asAuthor) {
        const mine = await walkThread(asAuthor, reply.parentId, reply.id)
        reads += mine.reads
        if (!mine.stop) return { state, section, authorSees: mine.found && !mine.behindPrompt, reads, detail }
        detail += `; the author's view wasn't read (${mine.stopDetail})`
    }
    return { state, section, reads, detail }
}

// Whether to tell the user: X shows the reply to its author but not, or not
// as usual, to others. Hide reply counts too: the writer is never told.
export const isFinding = (o: Pick<CheckOutcome, 'state' | 'authorSees'>): boolean =>
    HIDDEN_STATES.has(o.state) && (o.authorSees !== false || o.state === 'hidden_by_author')
