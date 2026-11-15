// Scrubs a recorded X answer down to the parts the extension reads, with no
// account in it: every tweet and user id is replaced (consistently, so the
// structure still holds), names and handles become stand-ins, tweet text and
// cursor values become placeholders, and every field the extension doesn't
// read is dropped. X's own interface strings (a "Probable spam" heading, a
// tombstone's "This Post was deleted…") stay.
//
// It runs where the answer was recorded, in the page, so a raw answer never
// lands on disk: tests/fixtures holds only its output. Self-contained on
// purpose (no imports, no closures over module scope) so its source can be
// pasted into a page as is.
//
//   scrubX(json, { ids: { realId: fakeId }, handles: { realHandle: fakeHandle } })
function scrubX(json, named) {
    const ids = new Map(Object.entries((named && named.ids) || {}))
    const handles = new Map(Object.entries((named && named.handles) || {}).map(([k, v]) => [k.toLowerCase(), v]))
    const cursors = new Map()
    let nextId = 1
    let nextText = 1
    let nextName = 1
    const fakeId = real => {
        const key = String(real)
        if (!ids.has(key)) ids.set(key, String(1900000000000000000n + BigInt(nextId++)))
        return ids.get(key)
    }
    const fakeHandle = real => {
        const key = String(real).toLowerCase()
        if (!handles.has(key)) handles.set(key, `user${handles.size + 1}`)
        return handles.get(key)
    }
    const digitsIn = s => String(s).replace(/\d{6,}/g, d => fakeId(d))
    const KEEP = new Set([
        'data', 'threaded_conversation_with_injections_v2', 'tweet', 'user', 'result', 'timeline_response', 'timeline',
        'instructions', 'type', 'entries', 'entry', 'moduleItems', 'entryId', 'sortIndex', 'content', 'entryType',
        '__typename', 'itemContent', 'itemType', 'tweet_results', 'tweetDisplayType', 'items', 'item', 'cursorType',
        'value', 'displayTreatment', 'actionText', 'text', 'tombstone', 'tombstoneInfo', 'richText', 'core',
        'user_results', 'rest_id', 'legacy', 'in_reply_to_status_id_str', 'in_reply_to_user_id_str',
        'in_reply_to_screen_name', 'conversation_id_str', 'reply_count', 'full_text', 'created_at', 'id_str',
        'user_id_str', 'screen_name', 'name', 'reason', 'create_tweet', 'direction', 'displayType', 'title',
        'tweetInterstitial', 'limitedActionResults', 'errors', 'message', 'code', 'viewer',
        'clientEventInfo', 'details', 'conversationDetails', 'conversationSection', 'has_graduated_access',
        'favorite_count', 'retweet_count',
    ])
    const ID_KEYS = new Set(['rest_id', 'id_str', 'user_id_str', 'in_reply_to_status_id_str', 'in_reply_to_user_id_str', 'conversation_id_str'])
    const walk = (v, key, parentKey) => {
        if (Array.isArray(v)) return v.map(x => walk(x, key, parentKey))
        if (v && typeof v === 'object') {
            const out = {}
            for (const [k, x] of Object.entries(v)) if (KEEP.has(k)) out[k] = walk(x, k, key)
            return out
        }
        if (typeof v !== 'string') return v
        if (ID_KEYS.has(key)) return fakeId(v)
        if (key === 'entryId' || key === 'sortIndex') return digitsIn(v)
        if (key === 'screen_name' || key === 'in_reply_to_screen_name') return fakeHandle(v)
        if (key === 'name') return parentKey === 'core' || parentKey === 'legacy' ? `Name ${nextName++}` : v
        if (key === 'full_text') return `Reply text ${nextText++}`
        if (key === 'value') return parentKey === 'content' || parentKey === 'itemContent' ? cursorFor(v) : v
        if (key === 'text' || key === 'message' || key === 'title' || key === 'actionText')
            return /@|https?:|\b[\w-]+\.[a-z]{2,}\b/i.test(v) ? '[text]' : v
        return v
    }
    const cursorFor = v => {
        if (!cursors.has(v)) cursors.set(v, `cursor-${cursors.size + 1}`)
        return cursors.get(v)
    }
    return walk(json, '', '')
}
if (typeof module !== 'undefined') module.exports = { scrubX }
