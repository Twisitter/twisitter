import { dev, expect, popupUrl, test } from './fixtures.js'

// "Report a problem" from the popup: a tab on twisitter.com's form, with the
// version, the status and the diagnostic log in the link's #fragment, naming
// no account. twisitter.com doesn't resolve here, so the tab goes nowhere, and
// without the tabs permission the extension can't read a web tab's address:
// the test notes the link as the background opens it.

const decode = b64 => JSON.parse(Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))

test('the popup’s Report a problem opens the form with the details, and they name no account', async ({ context, worker, extensionId }) => {
    const me = { userId: '200000009', screenName: 'zzmine', at: Date.now() }
    const second = { screenName: 'zzsecond', userId: '200000001', token: '0123456789abcdef0123456789abcdef', cookies: [], connectedAt: Date.now() }
    await dev(worker, 'set-local', { me, second_account: second, diag_log: ['11-16 20:00 installed 0.0.1'] })

    await worker.evaluate(() => {
        globalThis.openedForTest = []
        const create = chrome.tabs.create.bind(chrome.tabs)
        chrome.tabs.create = props => (globalThis.openedForTest.push(props.url), create(props))
    })
    const popup = await context.newPage()
    await popup.goto(popupUrl(extensionId))
    await popup.getByRole('button', { name: 'Report a problem' }).click()

    const tabUrl = () => worker.evaluate(() => globalThis.openedForTest.find(u => u.startsWith('https://twisitter.com/')) || '')
    await expect.poll(tabUrl, { timeout: 10000 }).toMatch(/^https:\/\/twisitter\.com\/feedback#r=[A-Za-z0-9_-]+$/)
    const d = decode((await tabUrl()).split('#r=')[1])
    expect(d.v).toMatch(/^\d+\.\d+\.\d+/)
    expect(d.b).toMatch(/Chrome \d+/)
    expect(d.s).toContain('Your account: last noted on x.com')
    expect(d.s).toContain('Second account: connected')
    expect(d.l).toContain('installed 0.0.1')
    const all = JSON.stringify(d)
    for (const secret of [me.screenName, me.userId, second.screenName, second.userId, second.token]) expect(all).not.toContain(secret)
    expect(all).not.toContain('@')
})
