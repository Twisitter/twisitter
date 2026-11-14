import fs from 'fs'
import type { Read } from '../../src/src/check'
import type { XAnswer } from '../../src/src/x-api'

// A recorded X answer, scrubbed (tests/fixtures; scripts/scrub-x.cjs)
export const fixture = (name: string): any =>
    JSON.parse(fs.readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'))

export const ok = (json: any): XAnswer => ({ status: 200, json })

// The ids the scrubber kept named
export const IDS = {
    // a 2022 post by an institution, and a reply its author sees listed but no
    // one else does (the "missing entirely" case)
    missingParent: '1000000000000000001',
    missingReply: '1000000000000000002',
    // a post whose three direct replies everyone sees
    listedParent: '1000000000000000011',
    listedReply: '1900000000000000006',
    // a reply deleted by its author
    deletedReply: '1000000000000000021',
    viewerUser: '200000001',
    authorUser: '200000002',
}

// A reader that answers from a table keyed "<operation>:<focal or root
// id>:<cursor>", and records what it was asked
export function fakeRead(routes: Record<string, XAnswer | (() => XAnswer)>) {
    const calls: string[] = []
    const read: Read = async (name, variables: any) => {
        const key = `${name}:${variables.focalTweetId || variables.rootTweetId || variables.userId || ''}:${variables.cursor || ''}`
        calls.push(key)
        const route = routes[key]
        if (route === undefined) throw new Error(`no recorded answer for ${key}`)
        return typeof route === 'function' ? route() : route
    }
    return { read, calls }
}
