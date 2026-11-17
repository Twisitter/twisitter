// Publish Chrome then Firefox. Chrome's step waits for you (the listing text and
// the Privacy tab), and Firefox's only waits on AMO, so it goes last. Each store
// script builds its own fresh production artifact. A store that fails doesn't
// stop the other, and each store that takes the version is recorded (common.mjs),
// so running this again publishes only to the stores still missing it. Edge isn't
// included: chrome.zip goes to Edge by hand. Ctrl+C kills the current child and
// aborts.
import { spawn, spawnSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import {
    c, getManifest, readPublishStatus, assertCleanBuildInputs, assertSameCodeForVersion, assertNodeVersion,
    assertVersionInDescription,
} from './common.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const stores = [
    { name: 'chrome', script: 'publish-chrome.mjs' },
    { name: 'firefox', script: 'publish-firefox.mjs' },
]

let current = null
let aborted = false
process.on('SIGINT', () => {
    console.log('\n' + c.red('✖ Publishing aborted by user'))
    aborted = true
    current?.kill('SIGINT')
    process.exit(130)
})

const run = script =>
    new Promise((resolve, reject) => {
        current = spawn('node', [path.join(__dirname, script)], { stdio: 'inherit', cwd: process.cwd() })
        current.on('close', code => {
            current = null
            code === 0 ? resolve() : reject(new Error(`${script} exited with code ${code}`))
        })
        current.on('error', err => {
            current = null
            reject(err)
        })
    })

const { version } = getManifest()
const publishedAt = store => readPublishStatus().published[store.name]
console.log(c.cyan(`🚀 Publish all ${version}: Chrome → Firefox (each builds fresh prod)\n`))

// Before the preflight, so a refusal comes at once (each store's script checks again)
assertVersionInDescription(version)
assertCleanBuildInputs()
assertSameCodeForVersion()
assertNodeVersion()
if (stores.every(publishedAt)) {
    console.log(c.green(`✔ Every store already has ${version}.`))
    process.exit(0)
}
if (spawnSync('yarn', ['preflight'], { stdio: 'inherit' }).status !== 0) {
    console.error(c.red('Preflight failed, so nothing was published.'))
    process.exit(1)
}

for (const store of stores) {
    if (aborted) break
    const when = publishedAt(store)
    if (when) {
        console.log(c.green(`✔ ${store.name} already has ${version} (${when}), skipping`))
        continue
    }
    try {
        await run(store.script)
    } catch (error) {
        if (aborted) break
        // One store failing doesn't stop the other
        console.error(c.red(`Failed: ${error.message}`))
    }
}

if (!aborted) {
    // A store counts once its script recorded it, not because it exited cleanly
    const missing = stores.filter(store => !publishedAt(store)).map(store => store.name)
    if (!missing.length) {
        console.log('\n' + c.green(`✔ Every store has ${version}!`))
    } else {
        console.error('\n' + c.red(`✖ Not published: ${missing.join(', ')} (see its output above)`))
        console.log(`Fix that, then run ${c.bold('yarn publish:all')} again. It publishes only to the stores still missing ${version}.`)
        process.exit(1)
    }
}
