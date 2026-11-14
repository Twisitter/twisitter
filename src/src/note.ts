// The note on a reply X hides from others, in x.com's own pages: the thread,
// the reply's page, the user's Replies tab. Built with DOM calls only.

import type { ReplyState } from './check'
import { ago, explain, stateLabel } from './describe'

export interface PageNote {
    state: ReplyState
    section?: string
    viewer: string
    at: number
    authorSees?: boolean
}

const NOTE_CLASS = 'twisitter-note'

// The tweet an <article> shows: its timestamp links to /<user>/status/<id>
export function articleTweetId(article: Element): string | null {
    for (const a of Array.from(article.querySelectorAll('a[href*="/status/"]'))) {
        if (!a.querySelector('time')) continue
        const m = (a.getAttribute('href') || '').match(/\/status\/(\d+)(?:$|[/?#])/)
        if (m) return m[1]
    }
    return null
}

function buildNote(note: PageNote): HTMLElement {
    const box = document.createElement('div')
    box.className = NOTE_CLASS
    box.dataset.state = note.state
    const title = document.createElement('strong')
    title.textContent = `Twisitter: ${stateLabel(note.state, note.section)}`
    const body = document.createElement('span')
    body.textContent = ` ${explain(note.state, note.viewer, note.section, note.authorSees)} Checked ${ago(note.at)}.`
    box.append(title, body)
    // a click on the note shouldn't open the tweet
    box.addEventListener('click', e => e.stopPropagation())
    return box
}

export function markNotes(notes: Record<string, PageNote>) {
    for (const article of Array.from(document.querySelectorAll('article'))) {
        const id = articleTweetId(article)
        const existing = article.querySelector(`:scope .${NOTE_CLASS}`) as HTMLElement | null
        const note = id ? notes[id] : undefined
        const want = note ? `${note.state}:${note.at}` : ''
        if (existing && existing.dataset.key === want) continue
        existing?.remove()
        if (!note) continue
        const el = buildNote(note)
        el.dataset.key = want
        const text = article.querySelector('[data-testid="tweetText"]')
        if (text?.parentElement) text.parentElement.insertBefore(el, text.nextSibling)
        else article.appendChild(el)
    }
}

// X renders tweets as the user scrolls and navigates: mark new ones as they come
export function startNotes(current: () => Record<string, PageNote>) {
    let queued = false
    const observer = new MutationObserver(() => {
        if (queued) return
        queued = true
        requestAnimationFrame(() => {
            queued = false
            if (Object.keys(current()).length) markNotes(current())
        })
    })
    const begin = () => observer.observe(document.body || document.documentElement, { childList: true, subtree: true })
    if (document.body) begin()
    else document.addEventListener('DOMContentLoaded', begin, { once: true })
}
