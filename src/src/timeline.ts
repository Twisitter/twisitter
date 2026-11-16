// Reading X's timeline answers: a post's reply list (TweetDetail), its hidden
// replies (ModeratedTimeline) and a profile's Replies tab
// (UserRepliesTimeline). All three hold `instructions`: TimelineAddEntries
// with tweet items, modules (a conversation thread: a reply and the replies
// under it), labels (the "Probable spam" heading) and cursors (more replies;
// "Show probable spam" is a cursor of type ShowMoreThreads).

export interface XTweet {
    id: string
    // tombstone: X shows a stand-in ("This Post was deleted…"); unavailable:
    // X says the post can't be shown (TweetUnavailable)
    kind: 'tweet' | 'tombstone' | 'unavailable'
    authorId?: string
    screenName?: string
    inReplyTo?: string
    // the account the reply answers: another account's post, or its own thread
    inReplyToUserId?: string
    conversationId?: string
    text?: string
    createdAt?: string
    replyCount?: number
    // likes and reposts, for where a reply would sit by engagement
    likeCount?: number
    repostCount?: number
    // the stand-in's words, or X's reason
    note?: string
    // X sent it wrapped in visibility results (limited actions, a warning)
    limited?: boolean
    // its author's has_graduated_access, from the user record X sends with
    // every tweet: false while X holds an account back until it's sure a
    // person runs it ("Unlock more on X", /i/graduated-access)
    graduated?: boolean
    // how the account that read the answer relates to the author, from the
    // same record (relationship_perspectives, seen 2026-11-15)
    relation?: ReaderRelation
}

// The reading account's follow, mute and block of an author: each changes
// what X shows that account
export interface ReaderRelation {
    following?: boolean
    muting?: boolean
    blocking?: boolean
}
const RELATION_FIELDS = ['following', 'muting', 'blocking'] as const
// From an X user record: relationship_perspectives, or the older legacy fields
export function relationOf(user: any): ReaderRelation | undefined {
    const out: ReaderRelation = {}
    for (const k of RELATION_FIELDS) {
        const v = user?.relationship_perspectives?.[k] ?? user?.legacy?.[k]
        if (typeof v === 'boolean') out[k] = v
    }
    return Object.keys(out).length ? out : undefined
}

export interface TimelineTweet extends XTweet {
    entryId: string
    // the heading over this part of the list, e.g. "Probable spam"; '' for
    // the main list
    section: string
    // X's own name for that part of the list (clientEventInfo.details.
    // conversationDetails.conversationSection on each thread item):
    // HighQuality in the main list, LowQuality behind "Show probable spam"
    // (both seen 2026-11-14)
    quality?: string
}
export interface TimelineCursor {
    entryId: string
    // Top, Bottom, ShowMore (more of one thread), ShowMoreThreads ("Show
    // probable spam"), ShowMoreThreadsPrompt
    type: string
    value: string
    actionText?: string
}
export interface TimelinePage {
    tweets: TimelineTweet[]
    cursors: TimelineCursor[]
    labels: string[]
    // the answer held TimelineTerminateTimeline with direction Bottom
    endsBelow: boolean
}

// The instructions array, wherever this kind of answer keeps it
export function findInstructions(json: any): any[] | null {
    const known = [
        json?.data?.threaded_conversation_with_injections_v2?.instructions,
        json?.data?.tweet?.result?.timeline_response?.timeline?.instructions,
        json?.data?.user?.result?.timeline?.timeline?.instructions,
        json?.data?.user?.result?.timeline_v2?.timeline?.instructions,
    ].find(Array.isArray)
    if (known) return known
    // a new path: look a few levels down
    const visit = (o: any, depth: number): any[] | null => {
        if (!o || typeof o !== 'object' || depth > 8) return null
        if (Array.isArray(o.instructions)) return o.instructions
        for (const v of Object.values(o)) {
            const found = visit(v, depth + 1)
            if (found) return found
        }
        return null
    }
    return visit(json, 0)
}

const textOf = (t: any): string => (typeof t === 'string' ? t : typeof t?.text === 'string' ? t.text : '')

// The tweet in a tweet_results.result, unwrapped
export function readTweetResult(r: any): XTweet | null {
    if (!r || typeof r !== 'object') return null
    const typename = r.__typename
    if (typename === 'TweetWithVisibilityResults') {
        const inner = readTweetResult(r.tweet)
        return inner && { ...inner, limited: true }
    }
    if (typename === 'TweetTombstone') return { id: '', kind: 'tombstone', note: textOf(r.tombstone?.text) }
    if (typename === 'TweetUnavailable') return { id: '', kind: 'unavailable', note: String(r.reason || '') }
    if (typename !== 'Tweet' && !r.legacy) return null
    const legacy = r.legacy || {}
    const user = r.core?.user_results?.result || {}
    const graduated = [user.has_graduated_access, user.legacy?.has_graduated_access].find(v => typeof v === 'boolean')
    const relation = relationOf(user)
    return {
        id: String(r.rest_id || legacy.id_str || ''),
        kind: 'tweet',
        authorId: String(user.rest_id || legacy.user_id_str || '') || undefined,
        screenName: String(user.core?.screen_name || user.legacy?.screen_name || '') || undefined,
        inReplyTo: legacy.in_reply_to_status_id_str || undefined,
        inReplyToUserId: legacy.in_reply_to_user_id_str || undefined,
        conversationId: legacy.conversation_id_str || undefined,
        text: String(r.note_tweet?.note_tweet_results?.result?.text || legacy.full_text || ''),
        createdAt: legacy.created_at || undefined,
        replyCount: typeof legacy.reply_count === 'number' ? legacy.reply_count : undefined,
        ...(typeof legacy.favorite_count === 'number' ? { likeCount: legacy.favorite_count } : {}),
        ...(typeof legacy.retweet_count === 'number' ? { repostCount: legacy.retweet_count } : {}),
        ...(graduated !== undefined ? { graduated } : {}),
        ...(relation ? { relation } : {}),
    }
}

// "tweet-123", "conversationthread-1-tweet-2": the tweet the entry is about
const idFromEntryId = (entryId: string): string => {
    const all = [...String(entryId).matchAll(/tweet-(\d+)/g)]
    return all.length ? all[all.length - 1][1] : ''
}

// X's name for the part of the list an item sits in, when it sends one
const qualityOf = (clientEventInfo: any): string | undefined => {
    const q = clientEventInfo?.details?.conversationDetails?.conversationSection
    return typeof q === 'string' && q ? q : undefined
}

export function parseTimeline(json: any): TimelinePage {
    const page: TimelinePage = { tweets: [], cursors: [], labels: [], endsBelow: false }
    const instructions = findInstructions(json) || []
    let section = ''
    const readItem = (entryId: string, content: any, clientEventInfo?: any) => {
        if (!content || typeof content !== 'object') return
        const type = content.itemType || content.__typename
        const quality = qualityOf(clientEventInfo)
        const q = quality ? { quality } : {}
        if (type === 'TimelineTweet') {
            const t = readTweetResult(content.tweet_results?.result)
            const id = t?.id || idFromEntryId(entryId)
            if (t && id) page.tweets.push({ ...t, id, entryId, section, ...q })
            else if (id) page.tweets.push({ id, kind: 'unavailable', entryId, section, ...q })
        } else if (type === 'TimelineTombstone') {
            const id = idFromEntryId(entryId)
            if (id)
                page.tweets.push({
                    id,
                    kind: 'tombstone',
                    note: textOf(content.tombstoneInfo?.richText) || textOf(content.tombstoneInfo?.text),
                    entryId,
                    section,
                    ...q,
                })
        } else if (type === 'TimelineTimelineCursor') {
            readCursor(entryId, content)
        } else if (type === 'TimelineLabel') {
            section = textOf(content.text) || textOf(content.title) || 'label'
            page.labels.push(section)
        }
    }
    const readCursor = (entryId: string, c: any) => {
        if (typeof c?.value !== 'string') return
        page.cursors.push({
            entryId,
            type: String(c.cursorType || ''),
            value: c.value,
            ...(c.displayTreatment?.actionText ? { actionText: String(c.displayTreatment.actionText) } : {}),
        })
    }
    const readEntry = (entry: any) => {
        const content = entry?.content
        const entryId = String(entry?.entryId || '')
        if (!content) return
        const type = content.entryType || content.__typename
        if (type === 'TimelineTimelineItem') readItem(entryId, content.itemContent, content.clientEventInfo)
        else if (type === 'TimelineTimelineModule')
            for (const item of content.items || []) readItem(String(item?.entryId || entryId), item?.item?.itemContent, item?.item?.clientEventInfo)
        else if (type === 'TimelineTimelineCursor') readCursor(entryId, content)
    }
    for (const ins of instructions) {
        if (ins?.type === 'TimelineTerminateTimeline' && ins.direction === 'Bottom') page.endsBelow = true
        if (Array.isArray(ins?.entries)) ins.entries.forEach(readEntry)
        if (ins?.entry) readEntry(ins.entry)
        if (Array.isArray(ins?.moduleItems))
            for (const item of ins.moduleItems) readItem(String(item?.entryId || ''), item?.item?.itemContent, item?.item?.clientEventInfo)
    }
    return page
}

// "Show probable spam" and its kin: cursors that open a part of the list X
// keeps closed
export const isPromptCursor = (c: TimelineCursor) => /^ShowMoreThreads/.test(c.type)

// The conversationSection names that mean X set a reply apart from the main
// list. Only names seen in X's answers count: a new one is kept as evidence,
// never read as hidden.
export const LOWER_SECTIONS: ReadonlySet<string> = new Set(['LowQuality', 'AbusiveQuality'])

// X's created_at ("Tue Nov 01 15:05:12 +0000 2022") as a time
export const createdAtMs = (createdAt?: string): number | undefined => {
    const t = createdAt ? Date.parse(createdAt) : NaN
    return Number.isFinite(t) ? t : undefined
}
