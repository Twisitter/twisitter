// What the page hook (inject.ts) takes from the page's own answers. Pure, so
// the tests run it on recorded answers.

import { readTweetResult, type XTweet } from './timeline'

export interface CapturedTweet {
    id: string
    inReplyTo: string
    authorId: string
    screenName: string
    text: string
    createdAt: string
}

const compact = (t: XTweet | null): CapturedTweet | null =>
    t && t.kind === 'tweet' && t.id
        ? {
              id: t.id,
              inReplyTo: t.inReplyTo || '',
              authorId: t.authorId || '',
              screenName: t.screenName || '',
              text: (t.text || '').slice(0, 500),
              createdAt: t.createdAt || '',
          }
        : null

// A CreateTweet answer: the tweet the page just posted. The request says what
// it replies to, should the answer leave that out.
export function createdTweet(requestBody: any, responseJson: any): CapturedTweet | null {
    const tweet = compact(readTweetResult(responseJson?.data?.create_tweet?.tweet_results?.result))
    if (!tweet) return null
    const replyTo = requestBody?.variables?.reply?.in_reply_to_tweet_id
    return {
        ...tweet,
        inReplyTo: tweet.inReplyTo || (typeof replyTo === 'string' && /^\d+$/.test(replyTo) ? replyTo : ''),
        text: tweet.text || String(requestBody?.variables?.tweet_text || '').slice(0, 500),
    }
}

// Every tweet in an answer (a Replies tab page), wherever it sits
export function tweetsIn(json: any, limit = 100): CapturedTweet[] {
    const out: CapturedTweet[] = []
    const visit = (o: any, depth: number) => {
        if (!o || typeof o !== 'object' || depth > 16 || out.length >= limit) return
        if (o.tweet_results?.result) {
            const t = compact(readTweetResult(o.tweet_results.result))
            if (t) out.push(t)
            return
        }
        for (const v of Object.values(o)) visit(v, depth + 1)
    }
    visit(json, 0)
    return out
}

// The account an x.com page is signed in as. X's server writes it into the
// page as `window.__INITIAL_STATE__={…}` (session.user_id, and that user in
// entities.users), and the page's app deletes the global once it has read it,
// so this reads the inline script's text. Null for a page with nobody
// signed in, or one that doesn't say.
export function pageUserFrom(scriptText: string): { userId: string; screenName: string } | null {
    const at = scriptText.indexOf('__INITIAL_STATE__')
    if (at < 0) return null
    const start = scriptText.indexOf('{', at)
    if (start < 0) return null
    // the object ends where its braces balance, strings aside
    let depth = 0
    let inString = false
    let escaped = false
    let end = -1
    for (let i = start; i < scriptText.length; i++) {
        const ch = scriptText[i]
        if (inString) {
            if (escaped) escaped = false
            else if (ch === '\\') escaped = true
            else if (ch === '"') inString = false
        } else if (ch === '"') inString = true
        else if (ch === '{') depth++
        else if (ch === '}' && --depth === 0) {
            end = i + 1
            break
        }
    }
    if (end < 0) return null
    try {
        const state = JSON.parse(scriptText.slice(start, end))
        const userId = state?.session?.user_id
        const screenName = state?.entities?.users?.entities?.[userId]?.screen_name
        return typeof userId === 'string' && /^\d{1,25}$/.test(userId) && typeof screenName === 'string' && /^\w{1,15}$/.test(screenName)
            ? { userId, screenName }
            : null
    } catch {
        return null
    }
}
