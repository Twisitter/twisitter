// The content script on x.com: passes what the page hook (inject.ts) finds to
// the background, and puts a note on the user's replies that X hides from
// others. It makes no requests to X.

import api, { extensionAlive } from './api'
import { pageUserFrom } from './capture'
import { DEV_REPLY_SOURCE, DEV_SOURCE, MSG_SOURCE } from './constants'
import { markNotes, startNotes, type PageNote } from './note'

export {}

const tab = window as unknown as { __twisitterAlive?: () => boolean }
// One live copy per tab; a copy left by an extension update is dead and
// doesn't count
if (!tab.__twisitterAlive?.()) {
    tab.__twisitterAlive = extensionAlive
    main()
}

function main() {
    // dev builds: a mark a test can look for
    if (__DEV__) document.documentElement.setAttribute('data-twisitter', `dev ${__VERSION__}`)
    // Firefox: an MV2 manifest can't ask for the page's world, so the hook
    // goes in by script tag (Chrome runs it from the manifest)
    if (__BUILT_FOR__ === 'firefox') {
        const script = document.createElement('script')
        script.src = api.runtime.getURL('src/inject.js')
        script.onload = () => script.remove()
        ;(document.head || document.documentElement).appendChild(script)
    }

    const toBackground = (msg: Record<string, unknown>) => {
        if (!extensionAlive()) return Promise.resolve(null)
        return api.runtime.sendMessage(msg).catch(() => null)
    }

    window.addEventListener('message', event => {
        if (event.source !== window || !extensionAlive()) return
        const data = event.data
        if (!data || typeof data !== 'object') return
        if (data.source === MSG_SOURCE) {
            const { source, ...rest } = data
            if (['learned-op', 'bearer', 'created-reply', 'replies-tab'].includes(rest.type)) toBackground({ action: rest.type, ...rest })
            else if (__DEV__ && rest.type === 'dev-txid') toBackground({ action: 'dev-txid', ...rest })
        } else if (__DEV__ && data.source === DEV_SOURCE) {
            // dev builds: lets a test drive the extension from an x.com tab
            toBackground({ action: 'dev', cmd: data.cmd, args: data.args }).then(result => {
                document.documentElement.setAttribute('data-twisitter-dev', JSON.stringify({ id: data.id, result }).slice(0, 20000))
                window.postMessage({ source: DEV_REPLY_SOURCE, id: data.id, result }, location.origin)
            })
        }
    })

    // who this page is signed in as, from the page X sent (capture.ts)
    const sendPageUser = () => {
        for (const script of Array.from(document.scripts)) {
            if (script.src || !script.textContent?.includes('__INITIAL_STATE__')) continue
            const who = pageUserFrom(script.textContent)
            if (who) toBackground({ action: 'page-user', ...who })
            return
        }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sendPageUser, { once: true })
    else sendPageUser()

    let notes: Record<string, PageNote> = {}
    const refreshNotes = async () => {
        const resp: any = await toBackground({ action: 'page-notes' })
        notes = resp?.notes || {}
        markNotes(notes)
    }
    api.runtime.onMessage.addListener((msg: any, _sender: any, sendResponse: (r: unknown) => void) => {
        if (msg?.action === 'ping') sendResponse({ ok: true })
        else if (msg?.action === 'notes-changed') refreshNotes()
    })
    startNotes(() => notes)
    refreshNotes()
}
