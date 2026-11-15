import { describe, expect, it } from 'vitest'
import { checkReply, isFinding, walkThread } from '../../src/src/check'
import { fakeRead, fixture, IDS, ok } from './helpers'

const missing = { id: IDS.missingReply, parentId: IDS.missingParent }

// The reply entry from a recorded answer, to build pages the recordings don't
// have yet (a "Probable spam" section, a hidden-replies page). The live check
// records real ones; these stand in until then.
const replyEntry = () => fixture('missing_reply_direct').data.threaded_conversation_with_injections_v2.instructions[1].entries[1]
const page = (entries: any[]) => ({ data: { threaded_conversation_with_injections_v2: { instructions: [{ type: 'TimelineAddEntries', entries }] } } })
const promptCursor = {
    entryId: 'cursor-showmorethreads-1900000000000000099',
    content: {
        entryType: 'TimelineTimelineItem',
        itemContent: { itemType: 'TimelineTimelineCursor', value: 'cursor-spam', cursorType: 'ShowMoreThreads', displayTreatment: { actionText: 'Show probable spam' } },
    },
}
const withPrompt = () => {
    const p = fixture('missing_parent_page1')
    p.data.threaded_conversation_with_injections_v2.instructions[1].entries.push(promptCursor)
    return p
}
const spamSection = () =>
    page([
        { entryId: 'label-0', content: { entryType: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineLabel', text: 'Probable spam' } } },
        {
            entryId: `conversationthread-${IDS.missingReply}`,
            content: { entryType: 'TimelineTimelineModule', items: [{ entryId: `conversationthread-${IDS.missingReply}-tweet-${IDS.missingReply}`, item: { itemContent: replyEntry().content.itemContent } }] },
        },
    ])

describe('checkReply', () => {
    it('a reply its author sees listed and no one else sees anywhere: missing (the 2022 case)', async () => {
        const viewer = fakeRead({
            [`TweetDetail:${IDS.missingParent}:`]: ok(fixture('missing_parent_page1')),
            [`TweetDetail:${IDS.missingParent}:cursor-1`]: ok(fixture('missing_parent_bottom')),
            [`ModeratedTimeline:${IDS.missingParent}:`]: ok(fixture('hidden_empty')),
            [`TweetDetail:${IDS.missingReply}:`]: ok(fixture('missing_reply_direct')),
        })
        const author = fakeRead({ [`TweetDetail:${IDS.missingParent}:`]: ok(fixture('author_view_parent')) })
        const outcome = await checkReply(missing, viewer.read, author.read)
        expect(outcome).toMatchObject({ state: 'missing', authorSees: true, reads: 5 })
        expect(isFinding(outcome)).toBe(true)
        // the bottom page added no tweets, so its own bottom cursor wasn't followed
        expect(viewer.calls).toEqual([
            `TweetDetail:${IDS.missingParent}:`,
            `TweetDetail:${IDS.missingParent}:cursor-1`,
            `ModeratedTimeline:${IDS.missingParent}:`,
            `TweetDetail:${IDS.missingReply}:`,
        ])
    })

    it('a listed reply costs one read, and the author view isn’t asked', async () => {
        const viewer = fakeRead({ [`TweetDetail:${IDS.listedParent}:`]: ok(fixture('listed_thread')) })
        const author = fakeRead({})
        const outcome = await checkReply({ id: IDS.listedReply, parentId: IDS.listedParent }, viewer.read, author.read)
        expect(outcome).toMatchObject({ state: 'listed', reads: 1 })
        expect(isFinding(outcome)).toBe(false)
        expect(author.calls).toEqual([])
    })

    it('a reply X filed under "Probable spam" (recorded): the button sits on the page after the list, with no tweets on it', async () => {
        const spamReply = { id: '1000000000000000031', parentId: IDS.listedParent }
        const viewer = fakeRead({
            [`TweetDetail:${IDS.listedParent}:`]: ok(fixture('spam_parent_page1')),
            [`TweetDetail:${IDS.listedParent}:cursor-1`]: ok(fixture('spam_parent_bottom')),
            [`TweetDetail:${IDS.listedParent}:cursor-3`]: ok(fixture('spam_section')),
        })
        const outcome = await checkReply(spamReply, viewer.read)
        expect(outcome).toMatchObject({ state: 'probable_spam', section: 'Probable spam', reads: 3 })
        expect(viewer.calls).toEqual([`TweetDetail:${IDS.listedParent}:`, `TweetDetail:${IDS.listedParent}:cursor-1`, `TweetDetail:${IDS.listedParent}:cursor-3`])
    })

    it('a reply behind "Show probable spam": the prompt is followed before paging', async () => {
        const viewer = fakeRead({
            [`TweetDetail:${IDS.missingParent}:`]: ok(withPrompt()),
            [`TweetDetail:${IDS.missingParent}:cursor-spam`]: ok(spamSection()),
        })
        const author = fakeRead({ [`TweetDetail:${IDS.missingParent}:`]: ok(fixture('author_view_parent')) })
        const outcome = await checkReply(missing, viewer.read, author.read)
        expect(outcome).toMatchObject({ state: 'probable_spam', section: 'Probable spam', authorSees: true, reads: 3 })
        expect(isFinding(outcome)).toBe(true)
        expect(viewer.calls[1]).toBe(`TweetDetail:${IDS.missingParent}:cursor-spam`)
    })

    it('a reply on the post’s hidden replies page: hidden by the post’s author', async () => {
        const hidden = fixture('hidden_empty')
        hidden.data.tweet.result.timeline_response.timeline.instructions[0].entries = [replyEntry()]
        const viewer = fakeRead({
            [`TweetDetail:${IDS.missingParent}:`]: ok(fixture('missing_parent_page1')),
            [`TweetDetail:${IDS.missingParent}:cursor-1`]: ok(fixture('missing_parent_bottom')),
            [`ModeratedTimeline:${IDS.missingParent}:`]: ok(hidden),
        })
        // hidden replies leave the thread for their writer too
        const author = fakeRead({ [`TweetDetail:${IDS.missingParent}:`]: ok(fixture('missing_parent_page1')), [`TweetDetail:${IDS.missingParent}:cursor-1`]: ok(fixture('missing_parent_bottom')) })
        const outcome = await checkReply(missing, viewer.read, author.read)
        expect(outcome).toMatchObject({ state: 'hidden_by_author', authorSees: false })
        // still worth telling: X never tells the writer
        expect(isFinding(outcome)).toBe(true)
    })

    it('a deleted reply: gone for its author too, so nothing to report', async () => {
        const deleted = { id: IDS.deletedReply, parentId: IDS.listedParent }
        const viewer = fakeRead({
            [`TweetDetail:${IDS.listedParent}:`]: ok(fixture('listed_thread')),
            // the end of a list (recorded on another post)
            [`TweetDetail:${IDS.listedParent}:cursor-1`]: ok(fixture('missing_parent_bottom')),
            [`ModeratedTimeline:${IDS.listedParent}:`]: ok(fixture('hidden_empty')),
            [`TweetDetail:${IDS.deletedReply}:`]: ok(fixture('deleted_direct')),
        })
        const author = fakeRead({ [`TweetDetail:${IDS.deletedReply}:`]: ok(fixture('deleted_direct')) })
        const outcome = await checkReply(deleted, viewer.read, author.read)
        expect(outcome).toMatchObject({ state: 'deleted', authorSees: false })
        expect(isFinding(outcome)).toBe(false)
    })

    it('without the author’s view, a missing reply is still reported', async () => {
        const viewer = fakeRead({
            [`TweetDetail:${IDS.missingParent}:`]: ok(fixture('missing_parent_page1')),
            [`TweetDetail:${IDS.missingParent}:cursor-1`]: ok(fixture('missing_parent_bottom')),
            [`ModeratedTimeline:${IDS.missingParent}:`]: ok(fixture('hidden_empty')),
            [`TweetDetail:${IDS.missingReply}:`]: ok(fixture('missing_reply_direct')),
        })
        const outcome = await checkReply(missing, viewer.read)
        expect(outcome.state).toBe('missing')
        expect(outcome.authorSees).toBeUndefined()
        expect(isFinding(outcome)).toBe(true)
    })

    it.each([
        ['rate_limited', { status: 429 }],
        ['signed_out', { status: 401, json: { errors: [{ code: 32, message: 'Could not authenticate you.' }] } }],
        ['stale_client', { status: 400, json: { errors: [{ message: 'The following features cannot be null: x' }] } }],
        ['stale_client', { status: 404, json: { errors: [{ message: 'Query: Unspecified' }] } }],
    ])('stops on %s', async (stop, answer) => {
        const viewer = fakeRead({ [`TweetDetail:${IDS.missingParent}:`]: answer })
        const outcome = await checkReply(missing, viewer.read)
        expect(outcome).toMatchObject({ state: 'unknown', stop, reads: 1 })
        expect(isFinding(outcome)).toBe(false)
    })
})

describe('cheap answers', () => {
    it('a post that can’t be seen ends the check at its first page', async () => {
        const p = fixture('missing_parent_page1')
        p.data.threaded_conversation_with_injections_v2.instructions[1].entries[0].content.itemContent.tweet_results.result = {
            __typename: 'TweetTombstone',
            tombstone: { text: { text: 'This Post is from a suspended account. Learn more' } },
        }
        const viewer = fakeRead({ [`TweetDetail:${IDS.missingParent}:`]: ok(p) })
        const author = fakeRead({})
        const outcome = await checkReply(missing, viewer.read, author.read)
        expect(outcome).toMatchObject({ state: 'parent_unavailable', reads: 1 })
        expect(outcome.detail).toContain('suspended account')
        expect(author.calls).toEqual([])
    })

    it('a long list read in part: unknown, and the author’s view isn’t read', async () => {
        let n = 0
        const longList = async (name: string, v: any) => {
            if (name === 'ModeratedTimeline') return ok(fixture('hidden_empty'))
            if (v.focalTweetId === IDS.missingReply) return ok(fixture('missing_reply_direct'))
            n++
            const p = fixture('listed_thread')
            const entries = p.data.threaded_conversation_with_injections_v2.instructions[1].entries
            entries[1].content.items[0].item.itemContent.tweet_results.result.rest_id = String(1800000000000000000n + BigInt(n))
            entries[entries.length - 1].content.value = `cursor-page-${n}`
            return ok(p)
        }
        const author = fakeRead({})
        const outcome = await checkReply({ id: IDS.missingReply, parentId: IDS.listedParent }, longList as any, author.read)
        // four pages of the list, the hidden replies, the reply itself
        expect(outcome).toMatchObject({ state: 'unknown', reads: 6 })
        expect(author.calls).toEqual([])
    })
})

describe('walkThread', () => {
    it('stops at the page limit and says the list went on', async () => {
        let n = 0
        // every page brings one new reply and another bottom cursor
        const endless = async () => {
            n++
            const p = fixture('listed_thread')
            const entries = p.data.threaded_conversation_with_injections_v2.instructions[1].entries
            entries[1].content.items[0].item.itemContent.tweet_results.result.rest_id = String(1800000000000000000n + BigInt(n))
            entries[entries.length - 1].content.value = `cursor-page-${n}`
            return ok(p)
        }
        const walk = await walkThread(endless as any, IDS.listedParent, '42', 3)
        expect(walk).toMatchObject({ found: false, truncated: true, reads: 3 })
    })
})
