// What the check makes of answers that aren't what they look like: X's error
// answer with an empty data object, a page without the post asked for, and a
// reply whose page shows nothing when its author's view can't be read.
import { describe, expect, it } from 'vitest'
import { checkReply, isFinding } from '../../src/src/check'
import { classifyAnswer } from '../../src/src/x-api'
import { fakeRead, fixture, IDS, ok } from './helpers'

// X's GraphQL error answer: HTTP 200, data {}, errors
const emptyWithErrors = { status: 200, json: { data: {}, errors: [{ code: 37, message: 'Authorization: Denied by access control' }] } }
const listed = { id: IDS.listedReply, parentId: IDS.listedParent }
const missing = { id: IDS.missingReply, parentId: IDS.missingParent }
const deleted = { id: IDS.deletedReply, parentId: IDS.listedParent }
// the list as everyone sees it, read to its end
const listedAsViewer = {
    [`TweetDetail:${IDS.listedParent}:`]: ok(fixture('listed_thread')),
    [`TweetDetail:${IDS.listedParent}:cursor-1`]: ok(fixture('missing_parent_bottom')),
    [`ModeratedTimeline:${IDS.listedParent}:`]: ok(fixture('hidden_empty')),
}

describe('X’s error answers', () => {
    it('a 200 with errors and no timeline is an error; one with a timeline and errors is the timeline', () => {
        expect(classifyAnswer(emptyWithErrors)).toBe('error')
        expect(classifyAnswer({ status: 200, json: { data: {} } })).toBe('error')
        expect(classifyAnswer({ status: 200, json: { ...fixture('listed_thread'), errors: [{ code: 214, message: 'some field' }] } })).toBe('ok')
    })

    it('one for the post’s reply list stops the check: a listed reply isn’t reported missing', async () => {
        const viewer = fakeRead({ [`TweetDetail:${IDS.listedParent}:`]: emptyWithErrors })
        const author = fakeRead({})
        const outcome = await checkReply(listed, viewer.read, author.read)
        expect(outcome).toMatchObject({ state: 'unknown', stop: 'error', reads: 1 })
        expect(isFinding(outcome)).toBe(false)
        expect(author.calls).toEqual([])
    })

    it('a second account X answers only with errors finds nothing hidden', async () => {
        const viewer = fakeRead({
            [`TweetDetail:${IDS.missingParent}:`]: emptyWithErrors,
            [`ModeratedTimeline:${IDS.missingParent}:`]: emptyWithErrors,
            [`TweetDetail:${IDS.missingReply}:`]: emptyWithErrors,
        })
        const outcome = await checkReply(missing, viewer.read, fakeRead({ [`TweetDetail:${IDS.missingReply}:`]: ok(fixture('missing_reply_direct')) }).read)
        expect(outcome).toMatchObject({ state: 'unknown', stop: 'error' })
        expect(isFinding(outcome)).toBe(false)
    })

    it('a timeline without the post stops the check', async () => {
        const empty = { data: { threaded_conversation_with_injections_v2: { instructions: [{ type: 'TimelineAddEntries', entries: [] }] } } }
        const outcome = await checkReply(listed, fakeRead({ [`TweetDetail:${IDS.listedParent}:`]: ok(empty) }).read)
        expect(outcome).toMatchObject({ state: 'unknown', stop: 'error', reads: 1 })
    })

    it('a reply’s page without the reply stops the check, rather than calling it unavailable', async () => {
        const viewer = fakeRead({ ...listedAsViewer, [`TweetDetail:${IDS.missingReply}:`]: ok(fixture('listed_thread')) })
        const outcome = await checkReply({ id: IDS.missingReply, parentId: IDS.listedParent }, viewer.read)
        expect(outcome).toMatchObject({ state: 'unknown', stop: 'error' })
        expect(isFinding(outcome)).toBe(false)
    })
})

describe('a reply whose page shows nothing', () => {
    it('without its author’s view: unknown, since a deleted reply looks the same (not a finding)', async () => {
        const viewer = fakeRead({ ...listedAsViewer, [`TweetDetail:${IDS.deletedReply}:`]: ok(fixture('deleted_direct')) })
        const outcome = await checkReply(deleted, viewer.read)
        expect(outcome.state).toBe('unknown')
        expect(outcome.stop).toBeUndefined()
        expect(isFinding(outcome)).toBe(false)
    })

    it('when its author’s look doesn’t come back: unknown, and tried again soon', async () => {
        const viewer = fakeRead({ ...listedAsViewer, [`TweetDetail:${IDS.deletedReply}:`]: ok(fixture('deleted_direct')) })
        const author = fakeRead({ [`TweetDetail:${IDS.deletedReply}:`]: { status: 429 } })
        const outcome = await checkReply(deleted, viewer.read, author.read)
        expect(outcome).toMatchObject({ state: 'unknown', stop: 'rate_limited' })
        expect(isFinding(outcome)).toBe(false)
    })

    it('when its author still sees it: unavailable to others, and reported', async () => {
        const mine = fixture('missing_reply_direct')
        const entry = mine.data.threaded_conversation_with_injections_v2.instructions[1].entries[1]
        entry.entryId = `tweet-${IDS.deletedReply}`
        entry.content.itemContent.tweet_results.result.rest_id = IDS.deletedReply
        const viewer = fakeRead({ ...listedAsViewer, [`TweetDetail:${IDS.deletedReply}:`]: ok(fixture('deleted_direct')) })
        const outcome = await checkReply(deleted, viewer.read, fakeRead({ [`TweetDetail:${IDS.deletedReply}:`]: ok(mine) }).read)
        expect(outcome).toMatchObject({ state: 'unavailable', authorSees: true })
        expect(isFinding(outcome)).toBe(true)
    })
})
