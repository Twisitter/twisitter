// The popup (also opened as a page after a sign-in and from notifications).
// Plain DOM: it asks the background for everything and redraws.

import api from './api'
import { isFinding, type ReplyState } from './check'
import { ago, explain, stateLabel } from './describe'
import type { Tracked } from './store'
import { tweetUrl } from './x-api'

type State = {
    version: string
    dev: boolean
    me: { userId: string; screenName: string } | null
    second: { screenName: string; userId: string; connectedAt: number } | null
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
}

let busy = ''
let message: { text: string; bad?: boolean } | null = null
let devOutput = ''

async function act(name: string, run: () => Promise<any>) {
    busy = name
    message = null
    await render()
    try {
        const r = await run()
        if (r && r.ok === false) message = { text: CONNECT_ERRORS[r.error] || `Didn't work: ${r.error}`, bad: true }
    } finally {
        busy = ''
        await render()
    }
}

function accountSection(s: State) {
    const you = s.me
        ? el(
              'div',
              {},
              'You: ',
              el('strong', { text: `@${s.me.screenName}` }),
              s.userStatus?.state === 'signed_out' ? el('span', { class: 'muted', text: ' (X stopped taking this sign-in; open x.com to sign in again)' }) : '',
          )
        : el('div', { class: 'muted' }, 'Open x.com in this browser, signed in to your own account.')
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
    const input = el('input', { type: 'url', placeholder: 'Link to a reply on x.com', 'aria-label': 'Link to a reply' }) as HTMLInputElement
    return el(
        'section',
        {},
        el(
            'div',
            { class: 'row' },
            el('div', { class: 'small muted', text: s.lastTick ? `Last round ${ago(s.lastTick)} · ${s.reads.second} reads as the second account in 15 min` : 'No checks yet' }),
            el('button', { text: busy === 'check' ? 'Checking…' : 'Check now', disabled: !s.second || !!busy ? 'disabled' : undefined, onclick: () => act('check', () => ask('check-now')) }),
        ),
        el(
            'form',
            {
                class: 'row',
                style: 'margin-top:6px',
                onsubmit: (e: Event) => {
                    e.preventDefault()
                    const url = input.value.trim()
                    if (url) act('add', () => ask('add-link', { url }))
                },
            },
            input,
            el('button', { type: 'submit', text: busy === 'add' ? 'Checking…' : 'Check reply', disabled: busy ? 'disabled' : undefined }),
        ),
    )
}

const badgeClass = (t: Tracked) => (!t.last ? '' : t.last.state === 'hidden_by_author' ? 'author' : isFinding(t.last) ? 'finding' : t.last.state === 'listed' ? 'ok' : '')

function replyItem(t: Tracked) {
    const last = t.last
    const state: ReplyState = last?.state || 'unknown'
    const label = last ? stateLabel(state, last.section) : 'Waiting for its first check'
    const finding = !!last && isFinding(last)
    return el(
        'li',
        { class: 'reply' },
        el('div', { class: 'row' }, el('span', { class: `badge ${badgeClass(t)}`, text: label }), el('span', { class: 'small muted', text: t.createdAt ? ago(t.createdAt) : '' })),
        el('div', { class: 'text' }, el('a', { href: tweetUrl(t.id, t.screenName), target: '_blank', text: t.text || `Reply ${t.id}` })),
        last &&
            el(
                'div',
                { class: `why small ${finding ? '' : 'muted'}` },
                finding || state !== 'listed' ? explain(state, last.viewer, last.section, last.authorSees) + ' ' : '',
                el('span', { class: 'muted', text: `Checked ${ago(last.at)} as ${last.viewer}.` }),
                last.stop ? el('span', { class: 'muted', text: ` (${last.detail})` }) : '',
            ),
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
            'X can hide a reply from everyone but the person who wrote it: behind "Show probable spam", out of the reply list, or on a post\u2019s hidden-replies page. ',
            'Its writer still sees it where they left it, and X doesn\u2019t say. Twisitter compares your view with a second X account\u2019s view and tells you when they differ.',
        ),
        el(
            'ol',
            { class: 'steps' },
            step(
                !!s.me,
                'Be signed in to X here',
                s.me
                    ? `Signed in as @${s.me.screenName}.`
                    : el('span', {}, 'Open ', el('a', { href: 'https://x.com/home', target: '_blank', text: 'x.com' }), ' and sign in. Reload any x.com tab that was open before Twisitter was installed.'),
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
    const post = el('input', { type: 'url', placeholder: 'Post id or link, for the transport probe', 'aria-label': 'Post for the probe' }) as HTMLInputElement
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
    const kids = [
        el('header', {}, el('h1', { text: 'Twisitter' }), el('span', { class: 'version', text: s?.version ? `v${s.version}` : '' })),
        message && el('section', {}, el('div', { class: `notice ${message.bad ? 'bad' : ''}`, text: message.text })),
        s && location.hash === '#welcome' && welcomeSection(s),
        s && accountSection(s),
        s && checkSection(s),
        s && repliesSection(s),
        s?.dev && devSection(),
    ].filter(Boolean) as Node[]
    root.replaceChildren(...kids)
}

if (location.hash || window.innerWidth > 500) document.body.classList.add('tab')
render()
ask('mark-seen')
// a sign-in or a check finishing elsewhere shows up here
const timer = setInterval(() => (document.hidden ? null : busy ? null : render()), 4000)
window.addEventListener('unload', () => clearInterval(timer))
