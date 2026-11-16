// First run (setup.ts): step 1 of the welcome page learns the user's account
// from an x.com page it opens in a background tab, so the welcome page stays
// in front. x.com is answered by routes; X's redirect of a signed-out /home is
// a 302 to its front page.

import { expect, fakeXPage, IDS, popupUrl, signedInAs, test } from './fixtures'

const signedInPage = route => route.fulfill({ status: 200, contentType: 'text/html', body: fakeXPage({ head: signedInAs(IDS.authorUser, 'author') }) })
const tabInfo = (worker, id) => worker.evaluate(id => chrome.tabs.get(id).then(t => ({ active: t.active, url: t.url, windowId: t.windowId })), id)

// Playwright can't route the first load of a tab the extension opens: it
// starts before Playwright knows the page. So once it does, the test loads
// step 1's tab again, which stands for X's answer arriving. Returns step 1's
// tab and the page that asked.
async function loadStepTab(context, worker) {
    await expect.poll(() => context.pages().some(p => /^(https:\/\/x\.com\/|chrome-error:)/.test(p.url())), { timeout: 10000 }).toBe(true)
    const { setup_tab: setup } = await worker.evaluate(() => chrome.storage.local.get('setup_tab'))
    await worker.evaluate(id => chrome.tabs.reload(id), setup.tabId)
    return setup
}

test('step 1 opens x.com in a background tab, and ticks off as soon as that page says who’s signed in', async ({ context, worker, extensionId }) => {
    await context.route('https://x.com/home', signedInPage)
    const page = await context.newPage()
    // an address of its own, as the install opens a welcome page too
    const url = popupUrl(extensionId) + '?mine#welcome'
    await page.goto(url)
    // in front, as a welcome page is when it opens
    await worker.evaluate(async u => chrome.tabs.update((await chrome.tabs.query({})).find(t => t.url === u).id, { active: true }), url)
    const step1 = page.locator('.steps li').nth(0)
    const connect = page.getByRole('button', { name: 'Connect a second account' })
    await expect(connect).toBeDisabled()
    await expect(page.getByText('Your own X account: not known yet (step 1).')).toBeVisible()
    await step1.getByRole('button', { name: 'Open x.com' }).click()
    await expect(step1.getByRole('button', { name: 'Opening x.com…' })).toBeDisabled()
    await loadStepTab(context, worker)
    await expect(step1).toHaveClass(/done/, { timeout: 10000 })
    await expect(step1).toContainText('Signed in as @author')
    await expect(connect).toBeEnabled()
    // x.com opened beside the welcome page, behind it
    const tabs = await worker.evaluate(async () => (await chrome.tabs.query({})).map(t => ({ id: t.id, url: t.url, active: t.active, windowId: t.windowId, opener: t.openerTabId })))
    const x = tabs.find(t => t.url === 'https://x.com/home')
    const welcome = tabs.find(t => t.id === x.opener)
    expect(welcome).toMatchObject({ url, active: true, windowId: x.windowId })
    expect(x.active).toBe(false)
})

test('signed out: step 1 asks to sign in on x.com, brings that tab forward, and the welcome page comes back after', async ({ context, worker, extensionId }) => {
    let signedIn = false
    await context.route('https://x.com/home', route => (signedIn ? signedInPage(route) : route.fulfill({ status: 302, headers: { location: 'https://x.com/' } })))
    await context.route('https://x.com/', route => route.fulfill({ status: 200, contentType: 'text/html', body: fakeXPage({}) }))
    await context.route(/^https:\/\/x\.com\/i\/(flow\/login|jf\/onboarding\/)/, route => route.fulfill({ status: 200, contentType: 'text/html', body: fakeXPage({}) }))
    const page = await context.newPage()
    await page.goto(popupUrl(extensionId) + '#welcome')
    const step1 = page.locator('.steps li').nth(0)
    await step1.getByRole('button', { name: 'Open x.com' }).click()
    const setup = await loadStepTab(context, worker)
    await expect(step1).toContainText('You’re not signed in to X in this browser', { timeout: 10000 })

    await step1.getByRole('button', { name: 'Sign in on x.com' }).click()
    // X's login page, in the same tab, now in front of the welcome page
    await expect.poll(() => tabInfo(worker, setup.tabId), { timeout: 10000 }).toMatchObject({ active: true, url: 'https://x.com/i/flow/login' })
    expect((await tabInfo(worker, setup.from)).active).toBe(false)

    // X moves its login on (it sends a code, say), and the user goes back to
    // the welcome page. Step 1 now only brings X's tab forward: loading the
    // login page again would lose the user's place in it.
    const login = context.pages().find(p => p.url().startsWith('https://x.com/i/flow/login'))
    const onboarding = 'https://x.com/i/jf/onboarding/web?mode=login'
    await login.goto(onboarding)
    await worker.evaluate(id => chrome.tabs.update(id, { active: true }), setup.from)
    await expect(step1).toContainText('Finish signing in on x.com, in the tab Twisitter opened')
    const loadedAgain = login.waitForEvent('framenavigated', { timeout: 3000 }).then(
        () => true,
        () => false,
    )
    await step1.getByRole('button', { name: 'Go to the sign-in tab' }).click()
    await expect.poll(() => tabInfo(worker, setup.tabId), { timeout: 10000 }).toMatchObject({ active: true, url: onboarding })
    expect(await loadedAgain).toBe(false)

    // the user signs in, and X moves on to /home
    signedIn = true
    await login.goto('https://x.com/home')
    await expect(step1).toHaveClass(/done/, { timeout: 10000 })
    await expect(page.getByRole('button', { name: 'Connect a second account' })).toBeEnabled()
    await expect.poll(async () => (await tabInfo(worker, setup.from)).active, { timeout: 10000 }).toBe(true)
})

test('the toolbar popup offers the same step when it doesn’t know the account', async ({ context, worker, extensionId }) => {
    await context.route('https://x.com/home', signedInPage)
    const page = await context.newPage()
    // the popup's own size: not a page in a tab
    await page.setViewportSize({ width: 380, height: 600 })
    await page.goto(popupUrl(extensionId))
    await expect(page.getByText('Twisitter learns your X account from an x.com page. It opens one in a background tab.')).toBeVisible()
    await page.getByRole('button', { name: 'Open x.com' }).click()
    await loadStepTab(context, worker)
    await expect(page.getByText('You: @author')).toBeVisible({ timeout: 10000 })
})
