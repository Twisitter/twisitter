// Cross-browser API shim. Firefox's chrome.* compat layer is broken — method
// calls that return values (storage.get, tabs.query, alarms.get, …) return
// undefined instead of a Promise. Firefox's NATIVE browser.* works correctly.
// Chrome MV3's chrome.* returns Promises natively. This picks the right one at
// compile time via the __BUILT_FOR__ webpack define, so all callers can just
// `await api.storage.local.get(…)` on both browsers.
//
// Getter instead of a bare const so the reference is resolved lazily — tests
// install globalThis.chrome after imports, and a top-level `chrome` read would
// throw before the mock is in place.
function getApi(): typeof chrome {
    return __BUILT_FOR__ === 'firefox'
        ? (globalThis as any).browser
        : chrome
}

export default new Proxy({} as typeof chrome, {
    get(_target, prop) {
        return (getApi() as any)[prop]
    },
})

// Is this script's extension still running? False for a content script left behind
// in a tab by an extension update or reload: its runtime is gone (Chrome clears
// runtime.id; Firefox may throw instead).
export function extensionAlive(): boolean {
    try {
        return !!getApi().runtime?.id
    } catch {
        return false
    }
}
