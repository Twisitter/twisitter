import { describe, expect, it } from 'vitest'
import { pageUserFrom } from '../../src/src/capture'
import { checkReply, positionOf, walkThread } from '../../src/src/check'
import { explain, historyText, ordinal, positionText } from '../../src/src/describe'
import { HISTORY_MAX, withCheck, type CheckRecord, type HistoryEntry } from '../../src/src/store'
import type { XTweet } from '../../src/src/timeline'
import { fakeRead, fixture, IDS, ok } from './helpers'

// Context around a check: where the reply sat among the replies the second
// account saw, the history of finished checks, and the signed-in accounts'
// has_graduated_access from x.com's pages.

const entriesOf = (answer: any): any[] => answer.data.threaded_conversation_with_injections_v2.instructions.find((i: any) => Array.isArray(i.entries)).entries
const page = (entries: any[]) => ({ data: { threaded_conversation_with_injections_v2: { instructions: [{ type: 'TimelineAddEntries', entries }] } } })
// a reply to the 2022 post as a thread module, under another id when given
const replyModule = (id = IDS.missingReply) => {
    const itemContent = entriesOf(fixture('missing_reply_direct'))[1].content.itemContent
    itemContent.tweet_results.result.rest_id = id
    return { entryId: `conversationthread-${id}`, content: { entryType: 'TimelineTimelineModule', items: [{ entryId: `conversationthread-${id}-tweet-${id}`, item: { itemContent } }] } }
}
const heading = { entryId: 'label-0', content: { entryType: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineLabel', text: 'Probable spam' } } }
const cursorEntry = (entryId: string, cursorType: string, value: string, actionText?: string) => ({
    entryId,
    content: { entryType: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineTimelineCursor', value, cursorType, ...(actionText ? { displayTreatment: { actionText } } : {}) } },
})
const missing = { id: IDS.missingReply, parentId: IDS.missingParent }
const tweet = (id: string, likes: number | undefined, createdAt: string): XTweet => ({ id, kind: 'tweet', inReplyTo: '1', replyCount: 0, createdAt, ...(likes !== undefined ? { likeCount: likes } : {}) })

describe('position: from the pages the check reads anyway', () => {
    it('a listed reply: its rank among the direct replies, with X’s own count, at no extra read', async () => {
        const viewer = fakeRead({ [`TweetDetail:${IDS.listedParent}:`]: ok(fixture('listed_thread')) })
        const outcome = await checkReply({ id: IDS.listedReply, parentId: IDS.listedParent }, viewer.read)
        // three direct replies (the author's answer to one of them isn't), and
        // a bottom cursor goes on, so only "at least", even with X's count (2) behind
        expect(outcome.position).toMatchObject({ part: 'list', rank: 3, of: 3, complete: false, xCount: 2 })
        expect(viewer.calls).toHaveLength(1)
    })

    it('a missing reply: how many of the replies X counts others see', async () => {
        const viewer = fakeRead({
            [`TweetDetail:${IDS.missingParent}:`]: ok(fixture('missing_parent_page1')),
            [`TweetDetail:${IDS.missingParent}:cursor-1`]: ok(fixture('missing_parent_bottom')),
            [`ModeratedTimeline:${IDS.missingParent}:`]: ok(fixture('hidden_empty')),
            [`TweetDetail:${IDS.missingReply}:`]: ok(fixture('missing_reply_direct')),
        })
        const outcome = await checkReply(missing, viewer.read)
        expect(outcome).toMatchObject({ state: 'missing', position: { part: 'list', of: 0, complete: true, xCount: 1 } })
        expect(outcome.position).not.toHaveProperty('rank')
        expect(positionText(outcome.position, '@viewer')).toBe('@viewer sees 0 of the 1 reply X counts under the post.')
    })

    it('the fold’s later pages count as the fold, though they carry no heading', async () => {
        const first = fixture('missing_parent_page1')
        entriesOf(first).push(cursorEntry('cursor-showmorethreads-1900000000000000099', 'ShowMoreThreads', 'cursor-spam', 'Show probable spam'))
        const viewer = fakeRead({
            [`TweetDetail:${IDS.missingParent}:`]: ok(first),
            // the fold's first page: its heading, another reply, and a bottom cursor going on with it
            [`TweetDetail:${IDS.missingParent}:cursor-spam`]: ok(page([heading, replyModule('1900000000000000077'), cursorEntry('cursor-bottom-1900000000000000098', 'Bottom', 'cursor-fold-2')])),
            // the main list's own next page comes first in the queue: it ends the list
            [`TweetDetail:${IDS.missingParent}:cursor-1`]: ok(fixture('missing_parent_bottom')),
            // the fold's second page: the reply, with no heading (as X sent it on 2026-11-14)
            [`TweetDetail:${IDS.missingParent}:cursor-fold-2`]: ok(page([replyModule()])),
        })
        const walk = await walkThread(viewer.read, IDS.missingParent, IDS.missingReply, 4)
        expect(walk).toMatchObject({ found: true, behindPrompt: true, section: 'Probable spam', reads: 4, position: { part: 'fold', rank: 2, of: 2, complete: true } })
        expect(viewer.calls.slice(-1)).toEqual([`TweetDetail:${IDS.missingParent}:cursor-fold-2`])
        expect(positionText(walk.position, '@viewer', walk.section)).toBe('2nd of 2 behind "Show probable spam", as @viewer sees it; newest first 1st.')
    })

    it('where it would sit by engagement and newest first, among the other replies seen', () => {
        const seen = [
            tweet('a', 50, 'Mon Jan 05 10:00:00 +0000 2026'),
            tweet('b', 0, 'Mon Jan 05 13:00:00 +0000 2026'),
            tweet('mine', 9, 'Mon Jan 05 12:00:00 +0000 2026'),
            tweet('c', 9, 'Mon Jan 05 11:00:00 +0000 2026'),
        ]
        expect(positionOf(seen[2], seen, 'list', false, 10)).toEqual({ part: 'list', of: 4, complete: false, xCount: 10, rank: 3, byEngagement: 2, byDate: 2 })
        // alone, or without counts: no expected ranks
        expect(positionOf(seen[2], [seen[2]], 'list', true)).toEqual({ part: 'list', of: 1, complete: true, rank: 1 })
        const bare = tweet('mine', undefined, 'Mon Jan 05 12:00:00 +0000 2026')
        expect(positionOf(bare, [seen[0], bare], 'list', true)).not.toHaveProperty('byEngagement')
    })

    it('says it in words', () => {
        expect(positionText({ part: 'list', rank: 12, of: 40, complete: false, xCount: 45, byEngagement: 3, byDate: 30 }, '@viewer')).toBe(
            '12th of at least 40 in the list, as @viewer sees it; by likes, reposts and replies about 3rd, newest first 30th. X counts 45 replies under the post.',
        )
        // a list read only in part says nothing about a reply it didn't reach
        expect(positionText({ part: 'list', of: 40, complete: false, xCount: 45 }, '@viewer')).toBe('')
        expect(positionText(undefined, '@viewer')).toBe('')
        expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111, 112].map(ordinal)).toEqual([
            '1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th', '112th',
        ])
    })
})

describe('history', () => {
    const rec = (state: CheckRecord['state'], at: number, extra: Partial<CheckRecord> = {}): CheckRecord => ({ state, at, viewer: '@viewer', reads: 1, detail: '', ...extra })

    it('keeps only checks that said something, the newest 20', () => {
        let h = withCheck(undefined, rec('missing', 1, { position: { part: 'list', of: 0, complete: true, xCount: 1 } }))
        expect(h).toEqual([{ at: 1, state: 'missing', viewer: '@viewer', of: 0 }])
        h = withCheck(h, rec('unknown', 2, { stop: 'rate_limited' }))
        // nor one that finished without saying (a long list read in part)
        h = withCheck(h, rec('unknown', 3))
        expect(h).toHaveLength(1)
        for (let i = 0; i < 30; i++) h = withCheck(h, rec('probable_spam', 10 + i, { section: 'Probable spam', quality: 'LowQuality', position: { part: 'fold', rank: 1, of: 1, complete: true } }))
        expect(h).toHaveLength(HISTORY_MAX)
        expect(h[0].at).toBe(20)
        expect(h[HISTORY_MAX - 1]).toEqual({ at: 39, state: 'probable_spam', viewer: '@viewer', section: 'Probable spam', quality: 'LowQuality', rank: 1, of: 1 })
    })

    it('says what changed and when', () => {
        const now = Date.UTC(2026, 10, 14, 20)
        const h: HistoryEntry[] = [
            { at: now - 3 * 3600_000, state: 'missing', viewer: '@viewer' },
            { at: now - 2 * 3600_000, state: 'missing', viewer: '@viewer' },
            { at: now - 3600_000, state: 'probable_spam', viewer: '@viewer', section: 'Probable spam' },
        ]
        expect(historyText(h, now)).toBe('History: Missing for others (3 h ago, 2 checks) → Behind "Show probable spam" (1 h ago).')
        expect(historyText(h.slice(0, 2), now)).toBe('The same in all 2 checks since 3 h ago.')
        expect(historyText(h.slice(0, 1), now)).toBe('')
        expect(historyText(undefined, now)).toBe('')
    })
})

describe('the signed-in accounts’ access flags', () => {
    const script = (user: object) =>
        `window.__INITIAL_STATE__=${JSON.stringify({ optimist: [], entities: { users: { entities: { '42': { screen_name: 'someone', ...user } } } }, session: { user_id: '42' } })};`

    it('a page’s account record says whether X holds the account back', () => {
        expect(pageUserFrom(script({ has_graduated_access: false }))).toEqual({ userId: '42', screenName: 'someone', graduated: false })
        expect(pageUserFrom(script({ has_graduated_access: true }))).toEqual({ userId: '42', screenName: 'someone', graduated: true })
        expect(pageUserFrom(script({}))).toEqual({ userId: '42', screenName: 'someone' })
    })

    it('the account that looks brings its flag into the check', async () => {
        const { rolesFor } = await import('../../src/src/monitor')
        const second = { screenName: 'viewer', userId: IDS.viewerUser, token: '0'.repeat(32), cookies: [], connectedAt: 0, graduated: false }
        const me = { userId: IDS.authorUser, screenName: 'author', at: 0, graduated: true }
        const base = { parentId: '1', capturedAt: 0, source: 'link' as const, nextCheckAt: 0, checks: 0 }
        expect(rolesFor({ ...base, id: '2', authorId: IDS.authorUser }, me, second)!.viewerGraduated).toBe(false)
        // a reply the second account wrote is looked at as the user
        expect(rolesFor({ ...base, id: '3', authorId: IDS.viewerUser }, me, second)!.viewerGraduated).toBe(true)
    })

    it('explain says when the account that looked was held back too', () => {
        expect(explain('probable_spam', '@viewer', 'Probable spam', true, { viewer: false })).toContain(
            "X was also holding @viewer back when it signed in, so its view may differ from most people's.",
        )
        expect(explain('missing', '@viewer', undefined, true, { viewer: false })).toMatch(/so its view may differ from most people's\.$/)
        expect(explain('hidden_by_author', '@viewer', undefined, false, { viewer: false })).not.toContain('holding')
        expect(explain('listed', '@viewer', undefined, undefined, { viewer: false })).not.toContain('holding')
    })
})
