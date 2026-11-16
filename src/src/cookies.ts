// X's cookies, as the extension saves and puts back.

import api from './api'

export interface StoredCookie {
    name: string
    value: string
    domain: string
    path: string
    secure: boolean
    httpOnly: boolean
    hostOnly: boolean
    sameSite?: string
    expirationDate?: number
    storeId?: string
}

export const toStoredCookie = (c: any): StoredCookie => ({
    name: String(c.name),
    value: String(c.value),
    domain: String(c.domain),
    path: String(c.path || '/'),
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    hostOnly: !!c.hostOnly,
    ...(c.sameSite && { sameSite: String(c.sameSite) }),
    ...(!c.session && Number(c.expirationDate) > 0 && { expirationDate: Number(c.expirationDate) }),
    ...(c.storeId && { storeId: String(c.storeId) }),
})

const cookieUrl = (c: StoredCookie) => `https://${c.domain.replace(/^\./, '')}${c.path || '/'}`

// What cookies.set needs to put a saved cookie back as it was: a host-only
// cookie gets no domain (one would make it a domain cookie), a session cookie
// no expiry, and an unspecified SameSite stays unspecified.
export const settableCookie = (c: StoredCookie) => ({
    url: cookieUrl(c),
    name: c.name,
    value: c.value,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    ...(!c.hostOnly && { domain: c.domain }),
    ...(c.sameSite && c.sameSite !== 'unspecified' && { sameSite: c.sameSite }),
    ...(c.expirationDate && { expirationDate: c.expirationDate }),
    ...(c.storeId && { storeId: c.storeId }),
})

export const isExpired = (c: StoredCookie, nowSec = Date.now() / 1000): boolean =>
    !!c.expirationDate && c.expirationDate <= nowSec

// The Cookie header a request to x.com (or api.x.com) would carry from saved
// cookies: those for the host and path /, unexpired
export const cookieHeaderFor = (cookies: StoredCookie[], host: string, nowSec = Date.now() / 1000): string =>
    cookies
        .filter(c => {
            const domain = c.domain.replace(/^\./, '').toLowerCase()
            const fits = c.hostOnly ? domain === host : host === domain || host.endsWith(`.${domain}`)
            return fits && (c.path || '/') === '/' && !isExpired(c, nowSec)
        })
        .map(c => `${c.name}=${c.value}`)
        .join('; ')

// The session's CSRF value, which X wants echoed in x-csrf-token
export const csrfFrom = (cookies: StoredCookie[]): string => cookies.find(c => c.name === 'ct0' && !isExpired(c))?.value || ''

export const xCookies = async (): Promise<StoredCookie[]> => {
    try {
        return (((await api.cookies.getAll({ domain: 'x.com' })) as any[]) || []).map(toStoredCookie)
    } catch {
        return []
    }
}

export const clearXCookies = async () => {
    for (const c of await xCookies()) {
        await api.cookies
            .remove({ url: cookieUrl(c), name: c.name, ...(c.storeId && { storeId: c.storeId }) })
            .catch(() => null)
    }
}

export const restoreCookies = async (cookies: StoredCookie[]) => {
    for (const c of cookies) {
        await api.cookies.set(settableCookie(c) as any).catch(() => null)
    }
}

// a cookie's identity in the browser: the same name on another domain or path is another cookie
const cookieKey = (c: StoredCookie) => `${c.name}|${c.domain}|${c.path || '/'}`

// The saved cookies the browser doesn't have now, put back. The ones it has
// stay as they are.
export const restoreMissingCookies = async (saved: StoredCookie[]) => {
    const have = new Set((await xCookies()).map(cookieKey))
    await restoreCookies(saved.filter(c => !have.has(cookieKey(c))))
}

// The browser's own CSRF cookie, for requests as the signed-in user
export const browserCsrf = async (): Promise<string> => {
    try {
        return (await api.cookies.get({ url: 'https://x.com/', name: 'ct0' }))?.value || ''
    } catch {
        return ''
    }
}
