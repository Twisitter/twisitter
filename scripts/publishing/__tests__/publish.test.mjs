// The publish flow end to end with nothing sent anywhere: the real publish scripts
// run in a scratch git repo, with a fake yarn (the preflight and the builds), a fake
// web-ext package for AMO and a fetch stub for the Chrome Web Store.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { hasChangelogEntry } from '../common.mjs'

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SLOW = { timeout: 60_000 }
const VERSION = '1.2.3'
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null']

// FAKE_EDIT_DURING=<script>: a file is edited while that yarn script runs.
// FAKE_INSTALL_FAILS: yarn.lock doesn't match.
const FAKE_YARN = `#!/bin/sh
echo "yarn $*" >> "$FAKE_LOG"
if [ "$1" = "$FAKE_EDIT_DURING" ]; then echo '// edited' >> src/main.ts; fi
case "$1" in
    preflight) exit "\${FAKE_PREFLIGHT:-0}" ;;
    install) exit "\${FAKE_INSTALL_FAILS:-0}" ;;
    build-chrome) echo zip > chrome.zip ;;
    build-firefox) mkdir -p dist-firefox && echo '{"browser_specific_settings":{"gecko":{"id":"test@example.com"}}}' > dist-firefox/manifest.json ;;
esac
`

// FAKE_AMO: ok (default), exists (AMO already has the version) or fail (no answer)
const FAKE_WEB_EXT = `import fs from 'fs'
export default {
    cmd: {
        async sign(opts) {
            const source = fs.existsSync(opts.uploadSourceCode) ? 'yes' : 'missing'
            fs.appendFileSync(process.env.FAKE_LOG, \`sign approvalTimeout=\${opts.approvalTimeout} source=\${source}\\n\`)
            if (process.env.FAKE_AMO === 'exists') throw new Error('Submission failed (2): Bad Request\\n{"version": ["Version ${VERSION} already exists."]}')
            if (process.env.FAKE_AMO === 'fail') throw new Error('Submission failed (2): 503.')
        },
    },
}
`

// FAKE_CHROME=fail: the publish call answers without OK. FAKE_EDIT_DURING_CHROME:
// other code is committed while Chrome's step waits on you.
const STUB_FETCH = `import fs from 'fs'
import { execFileSync } from 'child_process'
const answer = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) })
globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    fs.appendFileSync(process.env.FAKE_LOG, \`fetch \${init.method || 'GET'} \${u}\\n\`)
    if (u === 'https://oauth2.googleapis.com/token') return answer({ access_token: 'token' })
    if (u.includes('/upload/chromewebstore/')) return answer({ uploadState: 'SUCCESS' })
    if (u.endsWith('/publish')) {
        if (process.env.FAKE_EDIT_DURING_CHROME) {
            fs.writeFileSync('src/later.ts', 'export const later = 1\\n')
            execFileSync('git', [...${JSON.stringify(GIT_ID)}, 'add', '-A'])
            execFileSync('git', [...${JSON.stringify(GIT_ID)}, 'commit', '-qm', 'later'])
        }
        return answer({ status: [process.env.FAKE_CHROME === 'fail' ? 'NOT_AUTHORIZED' : 'OK'] })
    }
    if (u.startsWith('https://addons.mozilla.org/')) return answer({})
    throw new Error('unexpected fetch: ' + u)
}
`

let tmp, repo, log

const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
    fs.writeFileSync(path.join(repo, file), text)
}
const git = (...args) => execFileSync('git', [...GIT_ID, ...args], { cwd: repo, encoding: 'utf8' }).trim()
const commitAll = message => {
    git('add', '-A')
    git('commit', '-qm', message)
}
const setVersion = version => {
    write('src/manifest.json', JSON.stringify({ version }))
    write('STORE_DESCRIPTION.txt', `A description.\n\nVERSION HISTORY:\n2026/11/17 - ${version}\nA note for ${version}.\n`)
}
const status = () => JSON.parse(fs.readFileSync(path.join(repo, '.publish-status.json'), 'utf8'))

// Runs one publish script as `node scripts/publishing/<script>` in the repo
function run(script, env = {}) {
    fs.writeFileSync(log, '')
    const r = spawnSync(process.execPath, [path.join('scripts', 'publishing', script)], {
        cwd: repo,
        encoding: 'utf8',
        env: {
            PATH: `${path.join(tmp, 'bin')}${path.delimiter}${process.env.PATH}`,
            HOME: process.env.HOME,
            TMPDIR: os.tmpdir(),
            NODE_OPTIONS: `--import=${pathToFileURL(path.join(tmp, 'stub-fetch.mjs')).href}`,
            FAKE_LOG: log,
            CI: '1',
            CHROME_EXTENSION_ID: 'ext',
            CHROME_CLIENT_ID: 'id',
            CHROME_CLIENT_SECRET: 'secret',
            CHROME_REFRESH_TOKEN: 'refresh',
            FIREFOX_JWT_ISSUER: 'issuer',
            FIREFOX_JWT_SECRET: 'secret',
            ...env,
        },
    })
    const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)
    return { code: r.status, out: r.stdout + r.stderr, calls }
}
const ranChrome = calls => calls.includes('yarn build-chrome')
const ranFirefox = calls => calls.includes('yarn build-firefox')

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-publish-'))
    repo = path.join(tmp, 'repo')
    log = path.join(tmp, 'calls.log')
    fs.mkdirSync(path.join(tmp, 'bin'))
    fs.writeFileSync(path.join(tmp, 'bin', 'yarn'), FAKE_YARN, { mode: 0o755 })
    // Outside the repo, where node finds it walking up from scripts/publishing
    fs.mkdirSync(path.join(tmp, 'node_modules', 'web-ext'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'node_modules', 'web-ext', 'package.json'), '{"name":"web-ext","type":"module","main":"index.js"}')
    fs.writeFileSync(path.join(tmp, 'node_modules', 'web-ext', 'index.js'), FAKE_WEB_EXT)
    fs.writeFileSync(path.join(tmp, 'stub-fetch.mjs'), STUB_FETCH)

    fs.mkdirSync(repo)
    for (const file of ['publishing/common.mjs', 'publishing/publish-all.mjs', 'publishing/publish-chrome.mjs', 'publishing/publish-firefox.mjs', 'lib/env.mjs']) {
        write(`scripts/${file}`, fs.readFileSync(path.join(SCRIPTS, file), 'utf8'))
    }
    write('.gitignore', fs.readFileSync(path.join(SCRIPTS, '..', '.gitignore'), 'utf8'))
    setVersion(VERSION)
    write('src/main.ts', 'export const main = 1\n')
    write('tests/unit/main.test.ts', '// a test\n')
    write('README.md', 'readme\n')
    write('STORE_PRIVACY.txt', 'privacy answers\n')
    write('graphics/screenshot.png', 'png\n')
    write('.nvmrc', `${process.version.slice(1)}\n`)
    // no template: git copies no hook samples, which the sandbox won't let it write
    git('init', '-q', '--template=')
    commitAll('start')
})

afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
})

describe('the VERSION HISTORY entry', () => {
    it('is found the way the build reads it: a dated or bare version line, then a note', () => {
        const history = v => `Text.\n\nVERSION HISTORY:\n${v}\nA note.\n`
        expect(hasChangelogEntry(history('2026/11/17 - 1.2.3'), '1.2.3')).toBe(true)
        expect(hasChangelogEntry(history('1.2.3'), '1.2.3')).toBe(true)
        expect(hasChangelogEntry(history('2026/11/17 - 1.2.3'), '1.2')).toBe(false)
        expect(hasChangelogEntry(history('2026/11/17 - 1.2.30'), '1.2.3')).toBe(false)
        expect(hasChangelogEntry('Text that mentions 1.2.3 but has no history.', '1.2.3')).toBe(false)
        expect(hasChangelogEntry('VERSION HISTORY:\n2026/11/17 - 1.2.3\n', '1.2.3')).toBe(false)
    })

    it('missing stops yarn publish:all before the preflight, and each store script too', SLOW, () => {
        setVersion('1.2.4')
        write('src/manifest.json', JSON.stringify({ version: '1.2.5' }))
        commitAll('no note for 1.2.5')
        const all = run('publish-all.mjs')
        expect(all.code).toBe(1)
        expect(all.out).toContain('no VERSION HISTORY entry for 1.2.5')
        expect(all.calls).toEqual([])
        expect(run('publish-chrome.mjs').calls).toEqual([])
        expect(run('publish-firefox.mjs').calls).toEqual([])
    })
})

describe('yarn publish:all', () => {
    it('keeps going past a failed store, and a rerun publishes only the store still missing', SLOW, () => {
        const first = run('publish-all.mjs', { FAKE_CHROME: 'fail' })
        expect(first.code).toBe(1)
        expect(first.calls).toContain('yarn preflight')
        expect(ranChrome(first.calls)).toBe(true)
        // Firefox's step returns once AMO has the version, without waiting for approval
        expect(first.calls).toContain('sign approvalTimeout=0 source=yes')
        expect(first.out).toContain('Not published: chrome')
        expect(Object.keys(status().published)).toEqual(['firefox'])

        const second = run('publish-all.mjs')
        expect(second.code).toBe(0)
        expect(ranChrome(second.calls)).toBe(true)
        expect(ranFirefox(second.calls)).toBe(false)
        expect(second.out).toContain(`firefox already has ${VERSION}`)
        expect(Object.keys(status().published).sort()).toEqual(['chrome', 'firefox'])

        // Nothing left to do: not even the preflight runs
        const third = run('publish-all.mjs')
        expect(third.code).toBe(0)
        expect(third.calls).toEqual([])
    })

    it('stops before the preflight while the extension has uncommitted or untracked changes', SLOW, () => {
        write('src/main.ts', 'export const main = 2\n')
        const edited = run('publish-all.mjs')
        expect(edited.code).toBe(1)
        expect(edited.calls).toEqual([])
        expect(edited.out).toContain('src/main.ts')
        expect(run('publish-chrome.mjs').calls).toEqual([])

        git('checkout', '--', 'src/main.ts')
        write('src/new.ts', 'export const added = 1\n')
        const added = run('publish-all.mjs')
        expect(added.code).toBe(1)
        expect(added.calls).toEqual([])
        expect(added.out).toContain('src/new.ts')
    })

    it("doesn't count changes outside the extension's files", SLOW, () => {
        write('README.md', 'edited\n')
        write('tests/unit/main.test.ts', '// edited\n')
        write('STORE_PRIVACY.txt', 'edited\n')
        write('graphics/screenshot.png', 'edited\n')
        write('notes.md', 'untracked\n')
        const r = run('publish-all.mjs')
        expect(r.code).toBe(0)
        expect(Object.keys(status().published).sort()).toEqual(['chrome', 'firefox'])
    })

    it('refuses other code under a version a store already has, until the version is bumped', SLOW, () => {
        expect(run('publish-chrome.mjs').code).toBe(0)
        expect(Object.keys(status().published)).toEqual(['chrome'])

        write('src/main.ts', 'export const main = 2\n')
        commitAll('other code')
        const refused = run('publish-all.mjs')
        expect(refused.code).toBe(1)
        expect(refused.calls).toEqual([])
        expect(refused.out).toContain(`chrome already got ${VERSION}`)
        // A store's own script refuses too
        const alone = run('publish-firefox.mjs')
        expect(alone.code).toBe(1)
        expect(alone.calls).toEqual([])

        setVersion('1.2.4')
        commitAll('bump')
        expect(run('publish-all.mjs').code).toBe(0)
        expect(status().version).toBe('1.2.4')
    })

    it('stops unless Node is the version .nvmrc names', SLOW, () => {
        write('.nvmrc', '1.2.3\n')
        commitAll('another Node')
        const all = run('publish-all.mjs')
        expect(all.code).toBe(1)
        expect(all.out).toContain('.nvmrc names 1.2.3')
        expect(all.calls).toEqual([])
        // A store's own script stops too
        const alone = run('publish-firefox.mjs')
        expect(alone.code).toBe(1)
        expect(alone.calls).toEqual([])
    })

    it("builds with yarn.lock's dependencies, and stops if the extension changes while it builds", SLOW, () => {
        const r = run('publish-all.mjs', { FAKE_EDIT_DURING: 'build-firefox' })
        for (const build of ['yarn build-chrome', 'yarn build-firefox']) {
            expect(r.calls[r.calls.indexOf(build) - 1]).toBe('yarn install --immutable')
        }
        expect(r.code).toBe(1)
        expect(r.out).toContain('changed while it was building')
        expect(r.calls.some(line => line.startsWith('sign'))).toBe(false)
        expect(Object.keys(status().published)).toEqual(['chrome'])

        git('checkout', '--', 'src/main.ts')
        const failed = run('publish-firefox.mjs', { FAKE_INSTALL_FAILS: '1' })
        expect(failed.code).toBe(1)
        expect(failed.out).toContain('yarn install --immutable failed')
        expect(ranFirefox(failed.calls)).toBe(false)
    })

    it('records the commit a store was built from, though HEAD moves while its step waits', SLOW, () => {
        const built = git('rev-parse', 'HEAD')
        const r = run('publish-all.mjs', { FAKE_EDIT_DURING_CHROME: '1' })
        expect(status().commit).toBe(built)
        // So Firefox isn't given the code committed after Chrome's build
        expect(r.code).toBe(1)
        expect(ranFirefox(r.calls)).toBe(false)
        expect(r.out).toContain(`chrome already got ${VERSION}`)
        expect(Object.keys(status().published)).toEqual(['chrome'])
    })
})

describe('a Firefox run that stopped after AMO took the version', () => {
    it('counts as published on the rerun when the earlier submission was this code', SLOW, () => {
        expect(run('publish-firefox.mjs', { FAKE_AMO: 'fail' }).code).toBe(1)
        expect(status().published).toEqual({})
        expect(status().firefoxSubmissions).toHaveLength(1)

        const rerun = run('publish-firefox.mjs', { FAKE_AMO: 'exists' })
        expect(rerun.code).toBe(0)
        expect(rerun.out).toContain(`AMO already has ${VERSION} from this code`)
        expect(Object.keys(status().published)).toEqual(['firefox'])
        // The refused submission isn't kept as one AMO may hold
        expect(status().firefoxSubmissions).toHaveLength(1)
    })

    it("isn't counted when nothing here shows AMO got this code, unless accepted by hand", SLOW, () => {
        const refused = run('publish-firefox.mjs', { FAKE_AMO: 'exists' })
        expect(refused.code).toBe(1)
        expect(refused.out).toContain('PUBLISH_FIREFOX_ACCEPT_EXISTING=1')
        expect(status().published).toEqual({})

        const accepted = run('publish-firefox.mjs', { FAKE_AMO: 'exists', PUBLISH_FIREFOX_ACCEPT_EXISTING: '1' })
        expect(accepted.code).toBe(0)
        expect(Object.keys(status().published)).toEqual(['firefox'])
    })

    it('stops every store from shipping other code under that version', SLOW, () => {
        expect(run('publish-firefox.mjs', { FAKE_AMO: 'fail' }).code).toBe(1)
        write('src/main.ts', 'export const main = 2\n')
        commitAll('other code')
        const r = run('publish-all.mjs')
        expect(r.code).toBe(1)
        expect(r.calls).toEqual([])
        expect(r.out).toContain("didn't finish, so AMO may have that code")
    })
})
