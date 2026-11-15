// X's web API, called the way X's own web client calls it (recorded from the
// page on 2026-11-14). X changes the queryIds and feature flags when it ships
// a new web client, so the page hook (inject.ts) learns the current ones from
// the page's own requests, and these are only where a fresh install starts.

import { findInstructions } from './timeline'

// The web client's app token: the same for everyone, sent with every request
// the page makes. A user's session is in their cookies, not in this.
export const WEB_BEARER =
    'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'

// The only reads the extension makes, all of them reads X's own pages make
// in ordinary browsing: a post and its replies (TweetDetail, also a reply
// opened directly), a post's hidden replies (ModeratedTimeline) and the
// user's own Replies tab (UserRepliesTimeline). No searches.
export type OpName = 'TweetDetail' | 'ModeratedTimeline' | 'UserRepliesTimeline'
export interface Operation {
    queryId: string
    features: Record<string, boolean>
    fieldToggles?: Record<string, boolean>
}

// TweetDetail, ModeratedTimeline and UserRepliesTimeline sent this same set
const TIMELINE_FEATURES: Record<string, boolean> = {
    rweb_video_screen_enabled: false,
    rweb_cashtags_enabled: true,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    responsive_web_profile_redirect_enabled: true,
    rweb_tipjar_consumption_enabled: false,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    premium_content_api_read_enabled: false,
    communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    responsive_web_grok_analyze_button_fetch_trends_enabled: false,
    responsive_web_grok_analyze_post_followups_enabled: true,
    rweb_cashtags_composer_attachment_enabled: true,
    responsive_web_jetfuel_frame: true,
    rweb_sports_post_context_enabled: true,
    x_elections_post_context_enabled: true,
    responsive_web_grok_share_attachment_enabled: true,
    responsive_web_grok_annotations_enabled: true,
    articles_preview_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    rweb_conversational_replies_downvote_enabled: false,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    content_disclosure_indicator_enabled: true,
    content_disclosure_ai_generated_indicator_enabled: true,
    responsive_web_grok_show_grok_translated_post: true,
    responsive_web_grok_analysis_button_from_backend: true,
    post_ctas_fetch_enabled: true,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: false,
    responsive_web_grok_image_annotation_enabled: true,
    responsive_web_grok_imagine_annotation_enabled: true,
    responsive_web_grok_community_note_auto_translation_is_enabled: true,
    responsive_web_enhance_cards_enabled: false,
    responsive_web_made_on_x_label_enabled: false,
    responsive_web_nested_quote_preview_enabled: true,
}

export const DEFAULT_OPS: Record<OpName, Operation> = {
    TweetDetail: {
        queryId: 'dQDdKtt882nl-Km98FJGSQ',
        features: TIMELINE_FEATURES,
        fieldToggles: {
            withArticleRichContentState: true,
            withArticlePlainText: false,
            withArticleSummaryText: true,
            withArticleVoiceOver: true,
            withGrokAnalyze: false,
            withDisallowedReplyControls: false,
            withPayments: false,
            withDmBlocks: false,
        },
    },
    ModeratedTimeline: { queryId: 'PFe_4rTGtvczfkQ1_rvjNA', features: TIMELINE_FEATURES },
    UserRepliesTimeline: {
        queryId: 'fpl-c0_APDI3nZ1CeeBMbg',
        features: TIMELINE_FEATURES,
        fieldToggles: { withPayments: false, withArticlePlainText: false },
    },
}

export const isOpName = (name: unknown): name is OpName =>
    typeof name === 'string' && Object.prototype.hasOwnProperty.call(DEFAULT_OPS, name)

// A queryId as X writes them: base64url, about 22 characters
export const isQueryId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{10,40}$/.test(id)
// X's ids are decimal snowflakes
export const isTweetId = (id: unknown): id is string => typeof id === 'string' && /^\d{1,25}$/.test(id)

// What the page sends for a post's reply list, in Relevant order. Recent
// order leaves out the replies X files under "Probable spam" altogether, so a
// check always asks for Relevance and follows the "Show probable spam" cursor.
export const tweetDetailVariables = (focalTweetId: string, cursor?: string) => ({
    focalTweetId,
    ...(cursor ? { cursor } : {}),
    referrer: 'tweet',
    with_rux_injections: false,
    rankingMode: 'Relevance',
    includePromotedContent: true,
    withCommunity: true,
    withQuickPromoteEligibilityTweetFields: true,
    withBirdwatchNotes: true,
    withVoice: true,
})
// <post>/hidden: the replies the post's author hid
export const moderatedVariables = (rootTweetId: string, cursor?: string) => ({
    rootTweetId,
    count: 20,
    ...(cursor ? { cursor } : {}),
    includePromotedContent: false,
})
// A profile's Replies tab
export const repliesTabVariables = (userId: string, cursor?: string) => ({
    userId,
    count: 20,
    ...(cursor ? { cursor } : {}),
    includePromotedContent: true,
    withCommunity: true,
    withVoice: true,
})

export const graphqlUrl = (name: OpName, op: Operation, variables: object): string => {
    const params = new URLSearchParams({ variables: JSON.stringify(variables), features: JSON.stringify(op.features) })
    if (op.fieldToggles) params.set('fieldToggles', JSON.stringify(op.fieldToggles))
    return `https://x.com/i/api/graphql/${op.queryId}/${name}?${params}`
}

// The headers the page sends with its API requests. ct0 is the session's
// CSRF cookie: X wants the same value in this header.
export const apiHeaders = (ct0: string, bearer: string = WEB_BEARER): Record<string, string> => ({
    authorization: `Bearer ${bearer}`,
    'x-csrf-token': ct0,
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'en',
    'content-type': 'application/json',
})

// One answer from X, read in full
export interface XAnswer {
    status: number
    json?: any
    // x-rate-limit-remaining and x-rate-limit-reset (seconds since 1970)
    rateRemaining?: number
    rateReset?: number
    // a network failure or an answer that isn't JSON
    failure?: string
}

export type AnswerKind = 'ok' | 'rate_limited' | 'signed_out' | 'stale_client' | 'error'

const errorText = (json: any): string =>
    Array.isArray(json?.errors) ? json.errors.map((e: any) => `${e?.code ?? ''} ${e?.message ?? ''}`).join('; ') : ''

// What an answer means for the request that got it. "stale_client" is X no
// longer knowing the queryId or wanting other feature flags: the page hook
// learns the new ones the next time an x.com tab is open.
export const classifyAnswer = (a: XAnswer): AnswerKind => {
    if (a.status === 429) return 'rate_limited'
    const text = errorText(a.json)
    // 32: could not authenticate you; 89: invalid or expired token; 353: the
    // CSRF cookie and header don't match
    if (a.status === 401 || /(^|;\s*)(32|89|353)\s/.test(text)) return 'signed_out'
    if ((a.status === 400 || a.status === 404 || a.status === 422) && /features|query|queryid|unspecified|cannot be null/i.test(text))
        return 'stale_client'
    // every read is of a timeline: a 200 whose data holds none is X's error
    // answer ({ data: {}, errors: [...] }), not an empty list. One that has
    // both a timeline and errors is still the timeline.
    if (a.status === 200 && a.json && typeof a.json === 'object' && a.json.data && findInstructions({ data: a.json.data })) return 'ok'
    return 'error'
}
export const describeAnswer = (a: XAnswer): string =>
    a.failure ? a.failure : `HTTP ${a.status}${errorText(a.json) ? `: ${errorText(a.json).slice(0, 160)}` : ''}`

export const readAnswer = async (response: Response): Promise<XAnswer> => {
    const num = (name: string) => {
        const v = Number(response.headers.get(name))
        return Number.isFinite(v) && response.headers.get(name) !== null ? v : undefined
    }
    const answer: XAnswer = {
        status: response.status,
        rateRemaining: num('x-rate-limit-remaining'),
        rateReset: num('x-rate-limit-reset'),
    }
    const text = await response.text()
    try {
        answer.json = text ? JSON.parse(text) : undefined
    } catch {
        answer.failure = `HTTP ${response.status}, not JSON (${text.length} bytes)`
    }
    return answer
}

// A tweet's link, for the popup and notifications
export const tweetUrl = (id: string, screenName?: string) =>
    `https://x.com/${screenName ? encodeURIComponent(screenName) : 'i/web'}/status/${id}`
