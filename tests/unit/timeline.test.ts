import { describe, expect, it } from 'vitest'
import { createdAtMs, findInstructions, isPromptCursor, parseTimeline, readTweetResult } from '../../src/src/timeline'
import { fixture, IDS } from './helpers'

describe('findInstructions', () => {
    it('finds the list in each kind of answer', () => {
        expect(findInstructions(fixture('listed_thread'))).toHaveLength(4) // TweetDetail
        expect(findInstructions(fixture('hidden_empty'))).toHaveLength(1) // ModeratedTimeline
        expect(findInstructions(fixture('replies_tab'))).toHaveLength(2) // UserRepliesTimeline
    })
    it('looks deeper when X moves the list', () => {
        expect(findInstructions({ data: { somewhere: { new: { instructions: [{ type: 'X' }] } } } })).toEqual([{ type: 'X' }])
        expect(findInstructions({ data: {} })).toBeNull()
    })
})

describe('parseTimeline', () => {
    it('reads the post, the replies inside thread modules, and the cursor', () => {
        const page = parseTimeline(fixture('listed_thread'))
        expect(page.tweets.map(t => t.id)).toEqual([IDS.listedParent, '1900000000000000002', '1900000000000000004', IDS.listedReply, '1900000000000000008'])
        const reply = page.tweets.find(t => t.id === IDS.listedReply)!
        expect(reply).toMatchObject({ kind: 'tweet', inReplyTo: IDS.listedParent, screenName: 'user4', section: '' })
        expect(reply.entryId).toMatch(/^conversationthread-/)
        // the author's answer to that reply sits in the same module
        expect(page.tweets.find(t => t.id === '1900000000000000008')!.inReplyTo).toBe(IDS.listedReply)
        expect(page.cursors).toEqual([{ entryId: 'cursor-bottom-1900000000000000010', type: 'Bottom', value: 'cursor-1' }])
    })

    it('reads a post with no listed replies: the post and a bottom cursor', () => {
        const page = parseTimeline(fixture('missing_parent_page1'))
        expect(page.tweets.map(t => t.id)).toEqual([IDS.missingParent])
        expect(page.tweets[0].replyCount).toBe(1) // X counts the reply it doesn't list
        expect(page.cursors.map(c => c.type)).toEqual(['Bottom'])
        // following that cursor brings only more cursors
        expect(parseTimeline(fixture('missing_parent_bottom')).tweets).toEqual([])
    })

    it('reads a reply opened directly: its parent above it', () => {
        const page = parseTimeline(fixture('missing_reply_direct'))
        expect(page.tweets.map(t => [t.id, t.inReplyTo])).toEqual([
            [IDS.missingParent, undefined],
            [IDS.missingReply, IDS.missingParent],
        ])
        expect(page.tweets[1].authorId).toBe(IDS.authorUser)
    })

    it('reads a deleted reply as an entry with no post', () => {
        const page = parseTimeline(fixture('deleted_direct'))
        expect(page.tweets).toEqual([{ id: IDS.deletedReply, kind: 'unavailable', entryId: `tweet-${IDS.deletedReply}`, section: '' }])
    })

    it('reads a Replies tab', () => {
        const page = parseTimeline(fixture('replies_tab'))
        expect(page.tweets).toHaveLength(6)
        expect(new Set(page.tweets.map(t => t.authorId))).toEqual(new Set([IDS.viewerUser]))
        expect(page.tweets.filter(t => t.inReplyTo)).toHaveLength(5)
        expect(page.cursors.map(c => c.type)).toEqual(['Top', 'Bottom'])
    })

    it('puts tweets after a heading in that heading’s section', () => {
        const page = parseTimeline({
            data: {
                threaded_conversation_with_injections_v2: {
                    instructions: [
                        {
                            type: 'TimelineAddEntries',
                            entries: [
                                { entryId: 'label-0', content: { entryType: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineLabel', text: 'Probable spam' } } },
                                fixture('missing_reply_direct').data.threaded_conversation_with_injections_v2.instructions[1].entries[1],
                            ],
                        },
                    ],
                },
            },
        })
        expect(page.labels).toEqual(['Probable spam'])
        expect(page.tweets[0]).toMatchObject({ id: IDS.missingReply, section: 'Probable spam' })
    })
})

describe('readTweetResult', () => {
    const tweet = fixture('missing_reply_direct').data.threaded_conversation_with_injections_v2.instructions[1].entries[1].content.itemContent.tweet_results.result
    it('unwraps visibility results', () => {
        expect(readTweetResult({ __typename: 'TweetWithVisibilityResults', tweet })).toMatchObject({ id: IDS.missingReply, limited: true })
    })
    it('reads tombstones and unavailable posts', () => {
        expect(readTweetResult({ __typename: 'TweetTombstone', tombstone: { text: { text: 'This Post was deleted by the Post author.' } } })).toEqual({
            id: '',
            kind: 'tombstone',
            note: 'This Post was deleted by the Post author.',
        })
        expect(readTweetResult({ __typename: 'TweetUnavailable', reason: 'Suspended' })).toEqual({ id: '', kind: 'unavailable', note: 'Suspended' })
        expect(readTweetResult(null)).toBeNull()
    })
})

describe('helpers', () => {
    it('tells a "Show probable spam" cursor from paging', () => {
        expect(isPromptCursor({ entryId: '', type: 'ShowMoreThreads', value: '' })).toBe(true)
        expect(isPromptCursor({ entryId: '', type: 'ShowMoreThreadsPrompt', value: '' })).toBe(true)
        expect(isPromptCursor({ entryId: '', type: 'Bottom', value: '' })).toBe(false)
    })
    it('reads X’s dates', () => {
        expect(createdAtMs('Mon Jan 05 12:00:00 +0000 2026')).toBe(Date.UTC(2026, 0, 5, 12))
        expect(createdAtMs('nonsense')).toBeUndefined()
    })
})
