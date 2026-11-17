// Firefox AMO publish flow: zip the source for review (git archive: AMO asks for
// readable source for webpack builds), sign and submit the listed version with
// web-ext, then update the store description through the AMO API.
// `--text-only` updates the description without publishing. The add-on id comes
// from the built manifest's gecko id.
import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import webExt from 'web-ext'
import {
    CONFIG, ROOT, c, getManifest, readDescription, assertVersionInDescription,
    amoJwt, requireEnv, setupAbortHandler, buildFresh, markPublished,
    readPublishStatus, writePublishStatus, extensionChangedSince,
} from './common.mjs'

setupAbortHandler()

function extensionId() {
    if (process.env.FIREFOX_EXTENSION_ID) return process.env.FIREFOX_EXTENSION_ID
    try {
        const dist = JSON.parse(fs.readFileSync(path.join(CONFIG.firefoxDist, 'manifest.json'), 'utf8'))
        return dist.browser_specific_settings.gecko.id
    } catch {
        console.error(c.red('Cannot determine the AMO add-on id: build dist-firefox or set FIREFOX_EXTENSION_ID.'))
        process.exit(1)
    }
}

function createSourceZip(commit) {
    console.log('\n' + c.yellow('[1/3] Zipping source for review...'))
    // The commit that was built, committed files only: never .env or other
    // untracked or ignored content.
    execFileSync('git', ['archive', '--format=zip', '-o', 'source.zip', commit], { cwd: ROOT, stdio: 'inherit' })
    console.log(c.green(`✔ source.zip written (git archive ${commit.slice(0, 7)})`))
    return CONFIG.sourceZip
}

// AMO refused the version as one it already has: an earlier run submitted it and
// stopped before recording it. That counts as published only if every earlier
// submission, any of which AMO may have kept, was these files.
function acceptExistingVersion(version, submission, earlier) {
    const status = readPublishStatus()
    // AMO refused this one, so it holds none of its files
    status.firefoxSubmissions = (status.firefoxSubmissions || []).filter(s => s.at !== submission.at)
    writePublishStatus(status)
    if (earlier.length && earlier.every(s => !extensionChangedSince(s.commit))) {
        console.warn(c.yellow(`AMO already has ${version} from this code (submitted ${earlier.at(-1).at}); recording it as published.`))
    } else if (process.env.PUBLISH_FIREFOX_ACCEPT_EXISTING) {
        console.warn(c.yellow(`AMO already has ${version}; recording it as published (PUBLISH_FIREFOX_ACCEPT_EXISTING).`))
    } else {
        console.error(c.red(`AMO already has ${version}, and nothing here shows it was submitted from these files.`))
        console.error('Bump the version, or if you know AMO has this code, run again with PUBLISH_FIREFOX_ACCEPT_EXISTING=1.')
        process.exit(1)
    }
}

async function updateStoreListing(version) {
    console.log('\n' + c.yellow('[3/3] Updating AMO store description...'))
    const description = readDescription()
    if (!description) {
        console.log('No description file: skipping the metadata update.')
        return
    }
    const url = `https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(extensionId())}/`
    try {
        const res = await fetch(url, {
            method: 'PATCH',
            headers: {
                Authorization: `JWT ${amoJwt(process.env.FIREFOX_JWT_ISSUER, process.env.FIREFOX_JWT_SECRET)}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ description: { 'en-US': description } }),
        })
        if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`)
        console.log(c.green('✔ Store description updated!'))
    } catch (error) {
        // Not fatal: the version submission already succeeded
        console.error(c.red('Description update failed:'), error.message)
        console.error(`Update it by hand or retry with: yarn publish:firefox:text  (v${version})`)
    }
}

async function main() {
    requireEnv(['FIREFOX_JWT_ISSUER', 'FIREFOX_JWT_SECRET'])
    const version = getManifest().version
    assertVersionInDescription(version)

    if (process.argv.includes('--text-only')) {
        console.log(c.cyan(`🚀 Updating Firefox store description only (v${version})`))
        await updateStoreListing(version)
        return
    }

    console.log(c.cyan(`🚀 Firefox publish flow for v${version}`))

    // Always sign a freshly built dist-firefox: a stale one could be from an
    // older commit. (Dev builds live in dist-firefox-dev/, so no dev-leak risk.)
    const commit = buildFresh('build-firefox', path.join(CONFIG.firefoxDist, 'manifest.json'))
    const sourceZip = createSourceZip(commit)

    // Each submission of this version is recorded before AMO sees it: when a run
    // stops after AMO has the version, the next run's "already exists" is checked
    // against the code of each submission AMO may have kept
    const status = readPublishStatus()
    const earlier = status.firefoxSubmissions || []
    const submission = { commit, at: new Date().toISOString() }
    writePublishStatus({ ...status, firefoxSubmissions: [...earlier, submission] })

    console.log('\n' + c.yellow('[2/3] Signing & submitting to AMO (listed channel)...'))
    try {
        await webExt.cmd.sign(
            {
                apiKey: process.env.FIREFOX_JWT_ISSUER,
                apiSecret: process.env.FIREFOX_JWT_SECRET,
                sourceDir: CONFIG.firefoxDist,
                artifactsDir: path.join(ROOT, 'web-ext-artifacts'),
                channel: 'listed',
                amoBaseUrl: 'https://addons.mozilla.org/api/v5/',
                uploadSourceCode: sourceZip,
                // Return once AMO has the version. Waiting for approval (15 min by
                // default) can throw after the version already exists on AMO, and
                // every rerun would then fail on it.
                approvalTimeout: 0,
            },
            { shouldExitProgram: false },
        )
        console.log(c.green('✔ Submitted to AMO! (review usually clears quickly)'))
    } catch (error) {
        if (!/already exists/i.test(String(error?.message || error))) throw error
        acceptExistingVersion(version, submission, earlier)
    }
    markPublished('firefox', commit)
    fs.rmSync(sourceZip, { force: true })

    await updateStoreListing(version)
}

main().catch(e => {
    console.error(c.red('Firefox publish failed:'), e.message || e)
    process.exit(1)
})
