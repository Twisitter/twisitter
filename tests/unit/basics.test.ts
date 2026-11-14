import { describe, expect, it } from 'vitest'
import { createdTweet, pageUserFrom, tweetsIn } from '../../src/src/capture'
import { cookieHeaderFor, csrfFrom, type StoredCookie } from '../../src/src/cookies'
import { isMarkedFor, markedUrl, markerPattern } from '../../src/src/requests'
import { MINUTE, HOUR, DAY, nextCheckAt } from '../../src/src/store'
import { apiHeaders, classifyAnswer, DEFAULT_OPS, graphqlUrl, isQueryId, tweetDetailVariables } from '../../src/src/x-api'
import { fixture, IDS } from './helpers'

const TOKEN = '0123456789abcdef0123456789abcdef'

describe('requests to X', () => {
    it('builds the page’s TweetDetail URL', () => {
        const url = new URL(graphqlUrl('TweetDetail', DEFAULT_OPS.TweetDetail, tweetDetailVariables('123')))
        expect(url.origin + url.pathname).toBe('https://x.com/i/api/graphql/dQDdKtt882nl-Km98FJGSQ/TweetDetail')
        expect(JSON.parse(url.searchParams.get('variables')!)).toMatchObject({ focalTweetId: '123', rankingMode: 'Relevance' })
        expect(JSON.parse(url.searchParams.get('features')!).freedom_of_speech_not_reach_fetch_enabled).toBe(true)
        expect(url.searchParams.get('fieldToggles')).toBeTruthy()
    })
    it('sends the page’s headers, the CSRF value echoed', () => {
        expect(apiHeaders('abc')).toMatchObject({ 'x-csrf-token': 'abc', 'x-twitter-auth-type': 'OAuth2Session' })
        expect(apiHeaders('abc').authorization).toMatch(/^Bearer AAAA/)
    })
    it('tells answers apart', () => {
        expect(classifyAnswer({ status: 200, json: fixture('listed_thread') })).toBe('ok')
        expect(classifyAnswer({ status: 429 })).toBe('rate_limited')
        expect(classifyAnswer({ status: 403, json: { errors: [{ code: 353, message: 'This request requires a matching csrf cookie and header.' }] } })).toBe('signed_out')
        expect(classifyAnswer({ status: 404 })).toBe('error')
        expect(classifyAnswer({ status: 0, failure: 'no answer' })).toBe('error')
    })
    it('accepts queryIds as X writes them', () => {
        expect(isQueryId('dQDdKtt882nl-Km98FJGSQ')).toBe(true)
        expect(isQueryId('../../evil')).toBe(false)
    })
})

describe('the second account’s marker', () => {
    it('matches only the extension’s own marked requests to X', () => {
        const url = markedUrl('https://x.com/i/api/graphql/q/TweetDetail?variables=%7B%7D', TOKEN)
        expect(url.endsWith(`&tw_as=${TOKEN}`)).toBe(true)
        expect(isMarkedFor(url, TOKEN)).toBe(true)
        expect(isMarkedFor(markedUrl('https://api.x.com/1.1/x.json', TOKEN), TOKEN)).toBe(true)
        expect(isMarkedFor(url, 'f'.repeat(32))).toBe(false)
        expect(isMarkedFor(markedUrl('https://evil.example/x.com/', TOKEN), TOKEN)).toBe(false)
        expect(isMarkedFor(url.replace(TOKEN, `${TOKEN}0`), TOKEN)).toBe(false)
        expect(isMarkedFor(url, 'not-hex')).toBe(false)
        // Chrome's rule uses the same pattern (RE2)
        expect(markerPattern(TOKEN)).toContain(TOKEN)
    })
})

describe('cookies', () => {
    const c = (o: Partial<StoredCookie>): StoredCookie => ({ name: 'n', value: 'v', domain: '.x.com', path: '/', secure: true, httpOnly: false, hostOnly: false, ...o })
    it('puts the cookies for the host and path / in the header, skipping expired ones', () => {
        const now = 1_800_000_000
        const cookies = [
            c({ name: 'auth_token', value: 'a', httpOnly: true }),
            c({ name: 'ct0', value: 'csrf' }),
            c({ name: 'host_only', value: 'h', domain: 'x.com', hostOnly: true }),
            c({ name: 'api_only', value: 'p', domain: 'api.x.com', hostOnly: true }),
            c({ name: 'old', value: 'o', expirationDate: now - 1 }),
            c({ name: 'deep', value: 'd', path: '/i/' }),
        ]
        expect(cookieHeaderFor(cookies, 'x.com', now)).toBe('auth_token=a; ct0=csrf; host_only=h')
        expect(cookieHeaderFor(cookies, 'api.x.com', now)).toBe('auth_token=a; ct0=csrf; api_only=p')
        expect(csrfFrom(cookies)).toBe('csrf')
    })
})

describe('the account a page is signed in as', () => {
    // the shape X's pages carried on 2026-11-14, cut down
    const script = (session: object, users: object) =>
        `window.__INITIAL_STATE__=${JSON.stringify({ optimist: [], entities: { users: { entities: users } }, session })};window.__META_DATA__={"env":"prod"};`
    it('reads session.user_id and that user’s handle', () => {
        expect(pageUserFrom(script({ user_id: '42', isRestrictedSession: false }, { '42': { screen_name: 'someone', name: 'A "quoted" } name' } }))).toEqual({
            userId: '42',
            screenName: 'someone',
        })
    })
    it('says nobody for a signed-out page or one that doesn’t say', () => {
        expect(pageUserFrom(script({}, {}))).toBeNull()
        expect(pageUserFrom(script({ user_id: '42' }, {}))).toBeNull()
        expect(pageUserFrom('window.somethingElse={}')).toBeNull()
        expect(pageUserFrom('window.__INITIAL_STATE__={"unfinished":')).toBeNull()
    })
})

describe('capture', () => {
    const reply = fixture('missing_reply_direct').data.threaded_conversation_with_injections_v2.instructions[1].entries[1].content.itemContent.tweet_results.result
    it('reads a posted reply from the CreateTweet answer', () => {
        const got = createdTweet({ variables: { tweet_text: 'hi', reply: { in_reply_to_tweet_id: IDS.missingParent } } }, { data: { create_tweet: { tweet_results: { result: reply } } } })
        expect(got).toMatchObject({ id: IDS.missingReply, inReplyTo: IDS.missingParent, authorId: IDS.authorUser, screenName: 'author' })
    })
    it('takes the parent from the request when the answer leaves it out', () => {
        const bare = { ...reply, legacy: { ...reply.legacy, in_reply_to_status_id_str: undefined, full_text: '' } }
        const got = createdTweet({ variables: { tweet_text: 'typed text', reply: { in_reply_to_tweet_id: '555' } } }, { data: { create_tweet: { tweet_results: { result: bare } } } })
        expect(got).toMatchObject({ inReplyTo: '555', text: 'typed text' })
        expect(createdTweet({}, { data: {} })).toBeNull()
    })
    it('reads every tweet on a Replies tab page', () => {
        expect(tweetsIn(fixture('replies_tab')).map(t => t.authorId)).toEqual(Array(6).fill(IDS.viewerUser))
    })
})

describe('schedule', () => {
    it('looks soon after a reply is seen, then less and less often for a month', () => {
        const t0 = 1_000_000
        expect(nextCheckAt(t0, t0)).toBe(t0 + 2 * MINUTE)
        expect(nextCheckAt(t0, t0 + 2 * MINUTE)).toBe(t0 + HOUR)
        expect(nextCheckAt(t0, t0 + HOUR)).toBe(t0 + 6 * HOUR)
        expect(nextCheckAt(t0, t0 + 2 * DAY)).toBe(t0 + 3 * DAY)
        expect(nextCheckAt(t0, t0 + 31 * DAY)).toBe(Number.MAX_SAFE_INTEGER)
    })
})

describe('the Replies tab', () => {
    it('adds the user’s own replies from the last 30 days only', async () => {
        const { recentReplies } = await import('../../src/src/monitor')
        const now = Date.UTC(2026, 0, 20)
        const t = (id: string, authorId: string, daysAgo: number, inReplyTo = '9') => ({
            id,
            kind: 'tweet' as const,
            authorId,
            inReplyTo,
            createdAt: new Date(now - daysAgo * DAY).toUTCString(),
        })
        const got = recentReplies([t('1', IDS.viewerUser, 2), t('2', IDS.viewerUser, 45), t('3', 'someone', 1), { ...t('4', IDS.viewerUser, 1), inReplyTo: undefined }], IDS.viewerUser, now)
        expect(got.map(r => r.id)).toEqual(['1'])
    })
})

describe('roles', () => {
    it('reads a reply the second account wrote as the user, its author view as the second account', async () => {
        const { rolesFor, readAsUserNoted } = await import('../../src/src/monitor')
        const secondAccount = { screenName: 'viewer', userId: IDS.viewerUser, token: TOKEN, cookies: [], connectedAt: 0 }
        const me = { userId: IDS.authorUser, screenName: 'author', at: 0 }
        const base = { parentId: '1', capturedAt: 0, source: 'link' as const, nextCheckAt: 0, checks: 0 }
        const mine = rolesFor({ ...base, id: '2', authorId: IDS.authorUser }, me, secondAccount)!
        expect(mine.viewer).toBe('@viewer')
        expect(mine.asAuthor).toBe(readAsUserNoted)
        expect(mine.asViewer).not.toBe(readAsUserNoted)
        const theirs = rolesFor({ ...base, id: '3', authorId: IDS.viewerUser }, me, secondAccount)!
        expect(theirs.viewer).toBe('@author')
        expect(theirs.asViewer).toBe(readAsUserNoted)
        // a reply neither account wrote has no author view
        expect(rolesFor({ ...base, id: '4', authorId: '999' }, me, secondAccount)!.asAuthor).toBeUndefined()
        // with the user's own session failing: no author view, and the second
        // account's replies wait
        expect(rolesFor({ ...base, id: '2', authorId: IDS.authorUser }, me, secondAccount, false)!.asAuthor).toBeUndefined()
        expect(rolesFor({ ...base, id: '3', authorId: IDS.viewerUser }, me, secondAccount, false)).toBeNull()
    })
})
