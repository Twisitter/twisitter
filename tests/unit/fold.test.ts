// "Show probable spam" past the first page: the list and the part behind
// the button each get their own pages, a later page of that part stays in it,
// and its end is taken at X's word.
import { describe, expect, it } from 'vitest'
import { checkReply, isFinding } from '../../src/src/check'
import { fakeRead, fixture, IDS, ok } from './helpers'

// Pages the recordings don't have, built from recorded entries
const tweetItem = (id: string, parentId: string) => {
    const item = structuredClone(fixture('listed_thread').data.threaded_conversation_with_injections_v2.instructions[1].entries[1].content.items[0].item)
    const result = item.itemContent.tweet_results.result
    result.rest_id = id
    result.legacy.id_str = id
    result.legacy.in_reply_to_status_id_str = parentId
    return item
}
const thread = (id: string, parentId: string) => ({
    entryId: `conversationthread-${id}`,
    content: { entryType: 'TimelineTimelineModule', items: [{ entryId: `conversationthread-${id}-tweet-${id}`, item: tweetItem(id, parentId) }] },
})
const cursor = (cursorType: string, value: string, actionText?: string) => ({
    entryId: `cursor-${cursorType.toLowerCase()}-${value}`,
    content: { entryType: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineTimelineCursor', value, cursorType, ...(actionText && { displayTreatment: { actionText } }) } },
})
const label = (text: string) => ({ entryId: 'label-0', content: { entryType: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineLabel', text } } })
const page = (entries: any[], endsBelow = false) => ({
    data: {
        threaded_conversation_with_injections_v2: {
            instructions: [{ type: 'TimelineAddEntries', entries }, ...(endsBelow ? [{ type: 'TimelineTerminateTimeline', direction: 'Bottom' }] : [])],
        },
    },
})
// the recorded first page of a post, with "Show probable spam" on it
const withPrompt = () => {
    const p = fixture('missing_parent_page1')
    p.data.threaded_conversation_with_injections_v2.instructions[1].entries.push(cursor('ShowMoreThreads', 'cursor-spam', 'Show probable spam'))
    return p
}

const P = IDS.listedParent
const spamReply = { id: '1000000000000000031', parentId: P }

describe('the list, then the part behind the button', () => {
    it('a reply under "Probable spam" past two pages of listed replies is found there (it took 4 reads, 3 were allowed)', async () => {
        const viewer = fakeRead({
            [`TweetDetail:${P}:`]: ok(fixture('spam_parent_page1')),
            // a second page of listed replies
            [`TweetDetail:${P}:cursor-1`]: ok(page([thread('1900000000000000101', P), thread('1900000000000000102', P), cursor('Bottom', 'cursor-p2')])),
            // the page after the list, with only the button on it (recorded)
            [`TweetDetail:${P}:cursor-p2`]: ok(fixture('spam_parent_bottom')),
            [`TweetDetail:${P}:cursor-3`]: ok(fixture('spam_section')),
        })
        const outcome = await checkReply(spamReply, viewer.read)
        expect(outcome).toMatchObject({ state: 'probable_spam', section: 'Probable spam', reads: 4 })
        expect(isFinding(outcome)).toBe(true)
    })

    it('a missing reply under a post with a "Probable spam" part is missing, not unknown: that part ends where X says it does', async () => {
        const author = fixture('listed_thread')
        author.data.threaded_conversation_with_injections_v2.instructions[1].entries.splice(1, 0, thread(IDS.missingReply, P))
        const viewer = fakeRead({
            [`TweetDetail:${P}:`]: ok(fixture('spam_parent_page1')),
            [`TweetDetail:${P}:cursor-1`]: ok(fixture('spam_parent_bottom')),
            [`TweetDetail:${P}:cursor-3`]: ok(fixture('spam_section')),
            [`ModeratedTimeline:${P}:`]: ok(fixture('hidden_empty')),
            [`TweetDetail:${IDS.missingReply}:`]: ok(fixture('missing_reply_direct')),
        })
        const outcome = await checkReply({ id: IDS.missingReply, parentId: P }, viewer.read, fakeRead({ [`TweetDetail:${P}:`]: ok(author) }).read)
        expect(outcome).toMatchObject({ state: 'missing', authorSees: true })
        expect(isFinding(outcome)).toBe(true)
        // the list's first page also says the timeline ends, beside a bottom
        // cursor that goes on (recorded), so cursor-1 is still read; the spam
        // page's own bottom cursor (cursor-5), under X's end, isn't
        expect(viewer.calls).toEqual([`TweetDetail:${P}:`, `TweetDetail:${P}:cursor-1`, `TweetDetail:${P}:cursor-3`, `ModeratedTimeline:${P}:`, `TweetDetail:${IDS.missingReply}:`])
    })

    it('a reply on the part’s second page, which has no heading, is still behind the button', async () => {
        const viewer = fakeRead({
            [`TweetDetail:${IDS.missingParent}:`]: ok(withPrompt()),
            [`TweetDetail:${IDS.missingParent}:cursor-spam`]: ok(page([label('Probable spam'), thread('1000000000000000041', IDS.missingParent), cursor('Bottom', 'cursor-f2')])),
            [`TweetDetail:${IDS.missingParent}:cursor-1`]: ok(fixture('missing_parent_bottom')),
            [`TweetDetail:${IDS.missingParent}:cursor-f2`]: ok(page([thread(IDS.missingReply, IDS.missingParent), cursor('Bottom', 'cursor-f3')], true)),
        })
        const author = fakeRead({ [`TweetDetail:${IDS.missingParent}:`]: ok(fixture('author_view_parent')) })
        const outcome = await checkReply({ id: IDS.missingReply, parentId: IDS.missingParent }, viewer.read, author.read)
        // before: "listed", from a page reached by a plain bottom cursor
        expect(outcome).toMatchObject({ state: 'probable_spam', section: 'Probable spam', authorSees: true })
    })

    it('the part behind the button is read two pages deep at most; past that, a reply in no list is unknown', async () => {
        const viewer = fakeRead({
            [`TweetDetail:${IDS.missingParent}:`]: ok(withPrompt()),
            [`TweetDetail:${IDS.missingParent}:cursor-spam`]: ok(page([label('Probable spam'), thread('1000000000000000041', IDS.missingParent), cursor('Bottom', 'cursor-f2')])),
            [`TweetDetail:${IDS.missingParent}:cursor-1`]: ok(fixture('missing_parent_bottom')),
            [`TweetDetail:${IDS.missingParent}:cursor-f2`]: ok(page([thread('1000000000000000042', IDS.missingParent), cursor('Bottom', 'cursor-f3')])),
            [`ModeratedTimeline:${IDS.missingParent}:`]: ok(fixture('hidden_empty')),
            [`TweetDetail:${IDS.missingReply}:`]: ok(fixture('missing_reply_direct')),
        })
        const author = fakeRead({})
        const outcome = await checkReply({ id: IDS.missingReply, parentId: IDS.missingParent }, viewer.read, author.read)
        expect(outcome).toMatchObject({ state: 'unknown', reads: 6 })
        expect(viewer.calls).not.toContain(`TweetDetail:${IDS.missingParent}:cursor-f3`)
        expect(author.calls).toEqual([])
    })
})
