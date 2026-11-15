import { describe, expect, it } from 'vitest'
import { checkReply } from '../../src/src/check'
import { explain } from '../../src/src/describe'
import { LOWER_SECTIONS, parseTimeline } from '../../src/src/timeline'
import { fakeRead, fixture, IDS, ok } from './helpers'

// X's own signals, seen in live answers on 2026-11-14 but not in the recorded
// ones (the scrubber didn't keep them then): each thread item's
// conversationSection, and each user record's has_graduated_access. These
// tests add them to recorded answers.
const labelled = (quality: string) => ({ details: { conversationDetails: { conversationSection: quality } } })
const entriesOf = (answer: any): any[] => answer.data.threaded_conversation_with_injections_v2.instructions.find((i: any) => Array.isArray(i.entries)).entries
const userOf = (entry: any) => entry.content.itemContent.tweet_results.result.core.user_results.result
// the reply as a top-level item, from its own recorded page
const replyEntry = () => entriesOf(fixture('missing_reply_direct'))[1]
const page = (entries: any[]) => ({ data: { threaded_conversation_with_injections_v2: { instructions: [{ type: 'TimelineAddEntries', entries }] } } })
// a thread module holding that reply, with X's label on the item when given
const moduleWith = (entry: any, quality?: string) => ({
    entryId: `conversationthread-${IDS.missingReply}`,
    content: {
        entryType: 'TimelineTimelineModule',
        items: [
            {
                entryId: `conversationthread-${IDS.missingReply}-tweet-${IDS.missingReply}`,
                item: { itemContent: entry.content.itemContent, ...(quality ? { clientEventInfo: labelled(quality) } : {}) },
            },
        ],
    },
})
const spamHeading = { entryId: 'label-0', content: { entryType: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineLabel', text: 'Probable spam' } } }
const promptCursor = {
    entryId: 'cursor-showmorethreads-1900000000000000099',
    content: {
        entryType: 'TimelineTimelineItem',
        itemContent: { itemType: 'TimelineTimelineCursor', value: 'cursor-spam', cursorType: 'ShowMoreThreads', displayTreatment: { actionText: 'Show probable spam' } },
    },
}
const withPrompt = () => {
    const p = fixture('missing_parent_page1')
    entriesOf(p).push(promptCursor)
    return p
}
// the listed thread with X's label on the listed reply's item
const listedWith = (quality: string) => {
    const p = fixture('listed_thread')
    const isListed = (i: any) => String(i.entryId).endsWith(`tweet-${IDS.listedReply}`)
    const mod = entriesOf(p).find((e: any) => e.content?.items?.some(isListed))
    mod.content.items.find(isListed).item.clientEventInfo = labelled(quality)
    return p
}
const listed = { id: IDS.listedReply, parentId: IDS.listedParent }
const missing = { id: IDS.missingReply, parentId: IDS.missingParent }

describe('parseTimeline: X’s own signals', () => {
    it('reads conversationSection from a thread item, and has_graduated_access from its user record', () => {
        const entry = replyEntry()
        userOf(entry).has_graduated_access = false
        expect(parseTimeline(page([moduleWith(entry, 'LowQuality')])).tweets[0]).toMatchObject({ id: IDS.missingReply, quality: 'LowQuality', graduated: false })
    })

    it('reads them on a top-level item too, and leaves both out when X sends neither', () => {
        const entry = replyEntry()
        userOf(entry).has_graduated_access = true
        const top = parseTimeline(page([{ ...entry, content: { ...entry.content, clientEventInfo: labelled('HighQuality') } }])).tweets[0]
        expect(top).toMatchObject({ quality: 'HighQuality', graduated: true })
        const bare = parseTimeline(page([replyEntry()])).tweets[0]
        expect(bare).not.toHaveProperty('quality')
        expect(bare).not.toHaveProperty('graduated')
    })

    it('counts only the names seen in X’s answers as set apart', () => {
        expect([...LOWER_SECTIONS]).toEqual(['LowQuality', 'AbusiveQuality'])
        expect(LOWER_SECTIONS.has('HighQuality')).toBe(false)
    })
})

describe('checkReply: X’s own signals', () => {
    it('behind "Show probable spam": X’s label for each side, and the author’s access flag', async () => {
        const entry = replyEntry()
        userOf(entry).has_graduated_access = false
        const viewer = fakeRead({
            [`TweetDetail:${IDS.missingParent}:`]: ok(withPrompt()),
            [`TweetDetail:${IDS.missingParent}:cursor-spam`]: ok(page([spamHeading, moduleWith(entry, 'LowQuality')])),
        })
        const authorView = fixture('author_view_parent')
        const mod = entriesOf(authorView).find((e: any) => e.content?.items)
        mod.content.items[0].item.clientEventInfo = labelled('HighQuality')
        const author = fakeRead({ [`TweetDetail:${IDS.missingParent}:`]: ok(authorView) })
        const outcome = await checkReply(missing, viewer.read, author.read)
        expect(outcome).toMatchObject({
            state: 'probable_spam',
            section: 'Probable spam',
            authorSees: true,
            quality: 'LowQuality',
            authorQuality: 'HighQuality',
            graduated: false,
            reads: 3,
        })
        // X's label agrees with the list: nothing to note
        expect(outcome.detail).toBe('only behind "Probable spam"')
    })

    it('missing: the access flag comes from the reply’s own page', async () => {
        const direct = fixture('missing_reply_direct')
        userOf(entriesOf(direct)[1]).has_graduated_access = false
        const viewer = fakeRead({
            [`TweetDetail:${IDS.missingParent}:`]: ok(fixture('missing_parent_page1')),
            [`TweetDetail:${IDS.missingParent}:cursor-1`]: ok(fixture('missing_parent_bottom')),
            [`ModeratedTimeline:${IDS.missingParent}:`]: ok(fixture('hidden_empty')),
            [`TweetDetail:${IDS.missingReply}:`]: ok(direct),
        })
        const outcome = await checkReply(missing, viewer.read)
        expect(outcome).toMatchObject({ state: 'missing', graduated: false })
        // a reply that isn't in the list has no label from it
        expect(outcome).not.toHaveProperty('quality')
    })

    it('X’s label alone doesn’t move a listed reply, but the mismatch is noted', async () => {
        const viewer = fakeRead({ [`TweetDetail:${IDS.listedParent}:`]: ok(listedWith('LowQuality')) })
        const outcome = await checkReply(listed, viewer.read)
        expect(outcome).toMatchObject({ state: 'listed', quality: 'LowQuality', detail: 'listed under the post (X labels it LowQuality)', reads: 1 })
    })

    it('a label X hasn’t been seen to use is kept, and never read as hidden', async () => {
        const viewer = fakeRead({ [`TweetDetail:${IDS.listedParent}:`]: ok(listedWith('SomeNewSection')) })
        const outcome = await checkReply(listed, viewer.read)
        expect(outcome).toMatchObject({ state: 'listed', quality: 'SomeNewSection', detail: 'listed under the post' })
    })
})

describe('explain: the access flag', () => {
    it('names it as a likely reason when a reply is set apart', () => {
        expect(explain('probable_spam', '@viewer', 'Probable spam', true, { author: false })).toContain('(X\'s "Unlock more on X" notice), a common reason for this.')
        expect(explain('missing', '@viewer', undefined, true, { author: false })).toMatch(/\(X's "Unlock more on X" notice\)\.$/)
        expect(explain('unavailable', '@viewer', undefined, true, { author: false })).toMatch(/\(X's "Unlock more on X" notice\)\.$/)
    })

    it('stays quiet when the flag is true or unknown, or when the reply is shown', () => {
        expect(explain('probable_spam', '@viewer', 'Probable spam', true, { author: true })).not.toContain('Unlock more')
        expect(explain('probable_spam', '@viewer', 'Probable spam', true)).not.toContain('Unlock more')
        expect(explain('listed', '@viewer', undefined, undefined, { author: false })).not.toContain('Unlock more')
    })
})
