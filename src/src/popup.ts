// The popup (also opened as a page after a sign-in and from notifications).
// Plain DOM: it asks the background for everything and redraws.

import api from './api'
import { isFinding, type ReplyState } from './check'
import { ago, explain, historyText, positionText, stateLabel } from './describe'
import { KEYS, type Tracked } from './store'
import { tweetUrl } from './x-api'

type State = {
    version: string
    dev: boolean
    me: { userId: string; screenName: string } | null
    // step 1's x.com tab, while the account isn't known (setup.ts)
    setup: { state: 'opening' | 'signed_out' | 'signing_in'; at: number } | null
    second: { screenName: string; userId: string; connectedAt: number; graduated?: boolean } | null
    secondStatus: { state: string; until?: number; detail?: string } | null
    userStatus: { state: string; until?: number; detail?: string } | null
    connecting: boolean
    connectResult: { ok: boolean; error?: string; t: number } | null
    lastTick: number
    reads: { user: number; second: number }
    tracked: Tracked[]
}

const ask = (action: string, extra: Record<string, unknown> = {}): Promise<any> =>
    api.runtime.sendMessage({ action, ...extra }).catch((e: unknown) => ({ ok: false, error: String(e) }))

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, any> = {}, ...kids: Array<Node | string | null | false | undefined>) {
    const node = document.createElement(tag)
    for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null || v === false) continue
        if (k === 'class') node.className = String(v)
        else if (k === 'text') node.textContent = String(v)
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v)
        else node.setAttribute(k, String(v))
    }
    for (const kid of kids) if (kid) node.append(kid)
    return node
}

const CONNECT_ERRORS: Record<string, string> = {
    same_account: "That's the account this browser is signed in as. The second account has to be a different one.",
    not_signed_in: 'The sign-in ended before an account signed in. Your own login is back.',
    unconfirmed: "X didn't say who signed in, so nothing was saved. Your own login is back. Try again.",
    cancelled: 'Sign-in cancelled. Your own login is back.',
    timed_out: 'The sign-in took more than 15 minutes, so it ended. Your own login is back.',
    no_tab: "Couldn't open X's login page.",
    already_connecting: 'A sign-in is already open.',
    connecting: 'A sign-in is open. Finish it or cancel it first.',
    no_x_tab: "Couldn't open x.com.",
}

let busy = ''
let message: { text: string; bad?: boolean } | null = null
let devOutput = ''
// what's typed in each field, by the field's id, kept across redraws
const drafts: Record<string, string> = {}
const LINK_ID = 'reply-link'
const PROBE_ID = 'probe-post'

// One redraw at a time, so an older state never lands after a newer one
let drawing: Promise<void> = Promise.resolve()
const redraw = (): Promise<void> => (drawing = drawing.then(render, render))

// A text field that keeps what's typed when the popup redraws. The draft goes
// in the value property, not the attribute, so a part of the popup that's
// otherwise the same still matches the one on screen (see render).
function field(id: string, props: Record<string, any>): HTMLInputElement {
    const input = el('input', {
        ...props,
        id,
        oninput: () => {
            drafts[id] = input.value
        },
    }) as HTMLInputElement
    input.value = drafts[id] || ''
    return input
}

async function act(name: string, run: () => Promise<any>) {
    busy = name
    message = null
    await redraw()
    try {
        const r = await run()
        if (r && r.ok === false) message = { text: CONNECT_ERRORS[r.error] || `Didn't work: ${r.error}`, bad: true }
    } finally {
        busy = ''
        await redraw()
    }
}

// how long step 1 waits on the tab it opened before offering more
const OPENING_MS = 15000

// Step 1, until Twisitter knows the user's own account: x.com opens in a
// background tab and says who's signed in, while this page stays in front.
// Signed out, X sends that tab to its front page, and this asks the user to
// sign in there (setup.ts).
function signInStep(s: State): HTMLElement {
    const inTab = document.body.classList.contains('tab')
    const go = (text: string, action: string, primary = true) =>
        el('button', { class: primary ? 'primary' : undefined, text, disabled: busy ? 'disabled' : undefined, onclick: () => act(action, () => ask(action)) })
    const say = (text: string, ...buttons: HTMLElement[]) => el('div', {}, el('div', { text }), el('div', { class: 'actions' }, ...buttons))
    const setup = s.setup
    if (setup && setup.state !== 'opening')
        return say(`You’re not signed in to X in this browser. Sign in on x.com${inTab ? ', and Twisitter brings you back here' : ''}.`, go('Sign in on x.com', 'sign-in-x'))
    if (setup && Date.now() - setup.at < OPENING_MS)
        return say('Opening x.com in a background tab to see who’s signed in…', el('button', { class: 'primary', text: 'Opening x.com…', disabled: 'disabled' }))
    if (setup) return say('x.com hasn’t said who’s signed in. If you’re not signed in there, sign in.', go('Sign in on x.com', 'sign-in-x'), go('Open x.com again', 'open-x', false))
    return say(`Twisitter learns your X account from an x.com page. It opens one in a background tab${inTab ? ', and this page stays here' : ''}.`, go('Open x.com', 'open-x'))
}

function accountSection(s: State) {
    const you = s.me
        ? el(
              'div',
              {},
              'You: ',
              el('strong', { text: `@${s.me.screenName}` }),
              s.userStatus?.state === 'signed_out'
                  ? el('span', { class: 'muted', text: ' (X stopped taking this sign-in; open x.com to sign in again)' })
                  : s.userStatus?.state === 'other_account'
                    ? el('span', {
                          class: 'muted',
                          text: ` (x.com in this browser is signed in as ${s.userStatus.detail || 'your second account'} now; checks that need your own view wait until it's you again)`,
                      })
                    : '',
          )
        : location.hash === '#welcome'
          ? el('div', { class: 'muted', text: 'Your own X account: not known yet (step 1).' })
          : signInStep(s)
    let second: HTMLElement
    if (s.connecting) {
        second = el(
            'div',
            { class: 'notice' },
            el('div', { text: "Sign in to your second X account on X's login page. Your own login comes back afterwards." }),
            el('div', { class: 'actions' }, el('button', { text: 'Cancel sign-in', onclick: () => act('cancel', () => ask('connect-cancel')) })),
        )
    } else if (s.second) {
        const status = s.secondStatus
        const problem =
            status?.state === 'signed_out'
                ? `X no longer accepts @${s.second.screenName}'s sign-in. Connect it again.`
                : status?.state === 'rate_limited'
                  ? `X asked for a pause; checks resume ${status.until ? ago(Math.min(status.until, Date.now())) : 'soon'}.`
                  : ''
        second = el(
            'div',
            {},
            el(
                'div',
                { class: 'row' },
                el('div', {}, 'Second account: ', el('strong', { text: `@${s.second.screenName}` })),
                el('button', { class: 'link', text: problem ? 'Connect again' : 'Disconnect', onclick: () => act('disconnect', () => (problem ? ask('connect-start') : ask('disconnect'))) }),
            ),
            problem && el('div', { class: 'notice bad small', text: problem }),
            s.second.graduated === false &&
                el('div', {
                    class: 'notice small',
                    text: `When it signed in, X was holding @${s.second.screenName} back until it's sure a person runs it ("Unlock more on X"), so what it sees may differ from what most people see.`,
                }),
        )
    } else {
        second = el(
            'div',
            { class: 'notice' },
            el('div', { text: 'Twisitter checks your replies the way others see them, through a second X account of yours.' }),
            el(
                'div',
                { class: 'small muted' },
                "You sign in on X's own login page. Its cookies stay in this extension, and your own login comes back right after.",
            ),
            el(
                'div',
                { class: 'actions' },
                el('button', {
                    class: 'primary',
                    text: 'Connect a second account',
                    disabled: !s.me || busy ? 'disabled' : undefined,
                    title: s.me ? undefined : 'Step 1 first: Twisitter needs to know your own X account.',
                    onclick: () => act('connect', () => ask('connect-start')),
                }),
            ),
        )
    }
    const result = s.connectResult && Date.now() - s.connectResult.t < 10 * 60 * 1000 ? s.connectResult : null
    return el(
        'section',
        {},
        you,
        second,
        result && !s.connecting && (result.ok ? el('div', { class: 'notice good small', text: 'Second account connected.' }) : el('div', { class: 'notice bad small', text: CONNECT_ERRORS[result.error || ''] || `Sign-in ended: ${result.error}` })),
    )
}

function checkSection(s: State) {
    const input = field(LINK_ID, { type: 'url', placeholder: 'Link to a reply on x.com', 'aria-label': 'Link to a reply' })
    return el(
        'section',
        {},
        el(
            'div',
            { class: 'row' },
            el('div', { class: 'small muted', text: s.lastTick ? `Last round ${ago(s.lastTick)} · ${s.reads.second} reads as the second account in 15 min` : 'No checks yet' }),
            el('button', {
                text: busy === 'check' ? 'Checking…' : 'Check now',
                disabled: !s.second || !!busy || s.connecting ? 'disabled' : undefined,
                onclick: () => act('check', () => ask('check-now')),
            }),
        ),
        el(
            'form',
            {
                class: 'row',
                style: 'margin-top:6px',
                onsubmit: (e: Event) => {
                    e.preventDefault()
                    const url = input.value.trim()
                    if (url)
                        act('add', async () => {
                            const r = await ask('add-link', { url })
                            // a link that went in leaves the field for the next
                            // one, unless the next one was typed meanwhile (the
                            // part is redrawn, as busy changed)
                            if (r?.ok && (drafts[LINK_ID] || '').trim() === url) delete drafts[LINK_ID]
                            return r
                        })
                },
            },
            input,
            // reads as the user wait while a second account signs in
            el('button', { type: 'submit', text: busy === 'add' ? 'Checking…' : 'Check reply', disabled: busy || s.connecting ? 'disabled' : undefined }),
        ),
    )
}

// X's own section label for the reply, and for its author when that differs
const xLabel = (quality: string, authorQuality?: string) =>
    `X's data files it as "${quality}"${authorQuality && authorQuality !== quality ? `, and as "${authorQuality}" for its author` : ''}. `

const badgeClass = (t: Tracked) => (!t.last ? '' : t.last.state === 'hidden_by_author' ? 'author' : isFinding(t.last) ? 'finding' : t.last.state === 'listed' ? 'ok' : '')

function replyItem(t: Tracked) {
    const last = t.last
    const state: ReplyState = last?.state || 'unknown'
    const label = last ? stateLabel(state, last.section) : 'Waiting for its first check'
    const finding = !!last && isFinding(last)
    const where = last && state !== 'deleted' && state !== 'parent_unavailable' ? positionText(last.position, last.viewer, last.section) : ''
    const past = historyText(t.history)
    return el(
        'li',
        { class: 'reply' },
        el('div', { class: 'row' }, el('span', { class: `badge ${badgeClass(t)}`, text: label }), el('span', { class: 'small muted', text: t.createdAt ? ago(t.createdAt) : '' })),
        el('div', { class: 'text' }, el('a', { href: tweetUrl(t.id, t.screenName), target: '_blank', text: t.text || `Reply ${t.id}` })),
        last &&
            el(
                'div',
                { class: `why small ${finding ? '' : 'muted'}` },
                finding || state !== 'listed' ? explain(state, last.viewer, last.section, last.authorSees, { author: last.graduated, viewer: last.viewerGraduated }) + ' ' : '',
                last.quality && state !== 'listed' ? el('span', { class: 'muted', text: xLabel(last.quality, last.authorQuality) }) : '',
                el('span', { class: 'muted', text: `Checked ${ago(last.at)} as ${last.viewer}.` }),
                last.stop || state === 'unknown' ? el('span', { class: 'muted', text: ` (${last.detail})` }) : '',
            ),
        where && el('div', { class: 'small muted', text: where }),
        past && el('div', { class: 'small muted', text: past }),
        t.lastTry && el('div', { class: 'small muted', text: `Checked again ${ago(t.lastTry.at)}, but that check couldn't say (${t.lastTry.detail}).` }),
        el(
            'div',
            { class: 'actions small' },
            el('a', { href: tweetUrl(t.parentId), target: '_blank', class: 'muted', text: 'Post it replies to' }),
            el('button', { class: 'link', text: 'Check', disabled: busy ? 'disabled' : undefined, onclick: () => act('one', () => ask('check-one', { id: t.id })) }),
            el('button', { class: 'link', text: 'Forget', onclick: () => act('forget', () => ask('forget', { id: t.id })) }),
        ),
    )
}

function repliesSection(s: State) {
    const findings = s.tracked.filter(t => t.last && isFinding(t.last))
    const rest = s.tracked.filter(t => !(t.last && isFinding(t.last)))
    return el(
        'section',
        {},
        el('div', { class: 'small muted', text: s.tracked.length ? `${findings.length} hidden from others · ${s.tracked.length} replies watched` : 'No replies yet. Post one on x.com, or paste a link above.' }),
        el('ul', { class: 'replies' }, ...[...findings, ...rest].slice(0, 60).map(replyItem)),
    )
}

// The page the extension opens when it's installed: what it does, and the
// three steps, each ticked off as it's done
function welcomeSection(s: State) {
    const step = (done: boolean, title: string, ...body: Array<Node | string>) =>
        el('li', { class: done ? 'done' : '' }, el('strong', { text: title }), el('div', { class: 'small' }, ...body))
    return el(
        'section',
        { class: 'welcome' },
        el('h2', { text: 'Welcome to Twisitter' }),
        el(
            'p',
            {},
            'X can hide a reply from others without telling its writer: behind "Show probable spam", out of the reply list, or on a post\u2019s hidden-replies page. ',
            'Its writer\u2019s own Replies tab still shows it as normal. Twisitter compares your view with a second X account\u2019s view and tells you when they differ.',
        ),
        el(
            'ol',
            { class: 'steps' },
            step(
                !!s.me,
                'Be signed in to X here',
                s.me ? `Signed in as @${s.me.screenName}.` : signInStep(s),
            ),
            step(
                !!s.second,
                'Connect a second X account',
                s.second
                    ? `Connected: @${s.second.screenName}.`
                    : 'Any other account of yours. Twisitter sets your own login aside, opens X\u2019s login page for you to sign in, keeps that account\u2019s session for its checks and puts your login back. That account only opens posts and their replies, the way anyone browsing would.',
            ),
            step(
                s.tracked.length > 0,
                'Reply as usual',
                'Twisitter notices the replies you post on x.com, and reads your Replies tab for those you post from X\u2019s apps. It checks each one a few times over its first month, and tells you if X hides it.',
            ),
        ),
        el('p', { class: 'small muted', text: 'Twisitter never posts, likes, follows or changes anything on X, and talks to no server but x.com. What it keeps stays in this browser.' }),
    )
}

function devSection() {
    // text, not url: the browser wouldn't send a bare id from a url field
    const post = field(PROBE_ID, { type: 'text', placeholder: 'Post id or link, for the transport probe', 'aria-label': 'Post for the probe' })
    return el(
        'section',
        {},
        el(
            'form',
            {
                class: 'row',
                onsubmit: async (e: Event) => {
                    e.preventDefault()
                    const focalId = (post.value.match(/(\d{5,25})\D*$/) || [])[1]
                    if (!focalId) return
                    devOutput = 'running…'
                    await render()
                    devOutput = JSON.stringify(await ask('dev', { cmd: 'probe', args: { focalId } }), null, 1)
                    await render()
                },
            },
            post,
            el('button', { type: 'submit', class: 'link', text: 'Probe' }),
        ),
        devOutput && el('pre', { class: 'dev', text: devOutput }),
    )
}

async function render() {
    const s: State = await ask('get-state')
    const root = document.getElementById('root')!
    const parts: Array<[string, HTMLElement | null | false | undefined]> = [
        ['header', el('header', {}, el('h1', { text: 'Twisitter' }), el('span', { class: 'version', text: s?.version ? `v${s.version}` : '' }))],
        ['message', message && el('section', {}, el('div', { class: `notice ${message.bad ? 'bad' : ''}`, text: message.text }))],
        ['welcome', s && location.hash === '#welcome' && welcomeSection(s)],
        ['account', s && accountSection(s)],
        ['check', s && checkSection(s)],
        ['replies', s && repliesSection(s)],
        ['dev', s?.dev && devSection()],
    ]
    const kids: HTMLElement[] = []
    for (const [name, node] of parts)
        if (node) {
            node.dataset.part = name
            kids.push(node)
        }
    // Only the parts that changed are redrawn, each in its place. A part
    // that's the same keeps its nodes, so a field in it is left alone while
    // someone types in it (isEqualNode compares attributes and text, not
    // what's typed). Each part's handlers depend only on what it shows.
    const focused = document.activeElement instanceof HTMLInputElement && root.contains(document.activeElement) ? document.activeElement : null
    const caret = focused && ([focused.selectionStart, focused.selectionEnd, focused.selectionDirection] as const)
    const shown = [...root.children] as HTMLElement[]
    if (shown.length === kids.length && kids.every((k, i) => k.dataset.part === shown[i].dataset.part))
        kids.forEach((k, i) => {
            if (!shown[i].isEqualNode(k)) shown[i].replaceWith(k)
        })
    else root.replaceChildren(...kids)
    // a part that did change gives its field back to whoever was typing in it
    const again = focused && !focused.isConnected ? document.getElementById(focused.id) : null
    if (again instanceof HTMLInputElement) {
        again.focus()
        try {
            if (caret && caret[0] !== null && caret[1] !== null) again.setSelectionRange(caret[0], caret[1], caret[2] || undefined)
        } catch {
            /* the field takes no selection */
        }
    }
}

if (location.hash || window.innerWidth > 500) document.body.classList.add('tab')
redraw()
ask('mark-seen')
// a sign-in or a check finishing elsewhere shows up here
const timer = setInterval(() => (document.hidden ? null : busy ? null : redraw()), 4000)
window.addEventListener('unload', () => clearInterval(timer))
// the account, step 1's tab and the second account show at once
api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (KEYS.me in changes || KEYS.setupTab in changes || KEYS.second in changes)) redraw()
})
