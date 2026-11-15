import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import webpack from 'webpack'
import CopyWebpackPlugin from 'copy-webpack-plugin'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const manifestVersion = JSON.parse(fs.readFileSync(path.join(__dirname, 'src', 'manifest.json'), 'utf8')).version

// The VERSION HISTORY section of STORE_DESCRIPTION.txt is the changelog: a
// version on its own line, then its note on the next.
function parseChangelog() {
    const file = path.join(__dirname, 'STORE_DESCRIPTION.txt')
    if (!fs.existsSync(file)) return []
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    const start = lines.findIndex(l => l.startsWith('VERSION HISTORY'))
    if (start === -1) return []
    const out = []
    for (let i = start + 1; i < lines.length; i++) {
        const v = lines[i].trim()
        if (/^\d+\.\d+/.test(v)) out.push({ version: v, notes: (lines[i + 1] || '').trim() })
    }
    return out
}
const changelog = parseChangelog()
if (!changelog.some(e => e.version === manifestVersion && e.notes)) {
    throw new Error(
        `STORE_DESCRIPTION.txt has no changelog entry for manifest version ${manifestVersion}. ` +
            'Add one at the top of VERSION HISTORY (the version on its own line, then its note) before building.',
    )
}

const mode = process.env.NODE_ENV === 'production' ? 'production' : 'development'
const browserIsFirefox = process.env.BROWSER === 'firefox'
const builtFor = browserIsFirefox ? 'firefox' : 'chrome'
// Dev and production builds land in separate folders, so a dev build (the dev
// bridge, breadcrumbs, source maps) can't be mistaken for a store build.
// DIST_DIR names another folder in the repo for this build: the e2e tests'
// own dev build is dist-chrome-e2e, so a test run never rebuilds a folder a
// browser has loaded. Webpack empties the folder first, so the name must start
// with dist- and can't be one of the four usual folders.
const usualDists = ['dist-chrome', 'dist-firefox', 'dist-chrome-dev', 'dist-firefox-dev']
const distDir = process.env.DIST_DIR
if (distDir !== undefined && (!/^dist-[a-z0-9-]+$/.test(distDir) || usualDists.includes(distDir))) {
    throw new Error(`DIST_DIR must be a folder name that starts with dist- and isn't ${usualDists.join(', ')}; got "${distDir}".`)
}
const distPath = path.join(__dirname, distDir || `dist-${builtFor}${mode === 'development' ? '-dev' : ''}`)
const distSrcPath = path.join(distPath, 'src')

// Chrome and Edge get the MV3 manifest as written. Firefox gets MV2: a
// persistent background page, webRequest for the second account's cookies
// (Chrome uses a declarativeNetRequest rule), and the page hook injected by a
// script tag, since an MV2 manifest can't ask for the page's world.
function transformManifest(buffer) {
    const manifest = JSON.parse(buffer.toString())
    if (browserIsFirefox) {
        manifest.manifest_version = 2
        manifest.permissions = manifest.permissions
            .filter(p => !p.startsWith('declarativeNetRequest'))
            .concat(['webRequest', 'webRequestBlocking'], manifest.host_permissions || [])
        delete manifest.host_permissions
        delete manifest.minimum_chrome_version
        manifest.browser_specific_settings = {
            gecko: {
                id: 'twisitter@twisitter.com',
                strict_min_version: '115.0',
                data_collection_permissions: { required: ['none'] },
            },
        }
        manifest.background = { scripts: [manifest.background.service_worker], persistent: true }
        manifest.browser_action = manifest.action
        delete manifest.action
        manifest.content_scripts = manifest.content_scripts.filter(cs => cs.world !== 'MAIN')
        manifest.web_accessible_resources = manifest.web_accessible_resources.flatMap(w => w.resources)
        manifest.content_security_policy = manifest.content_security_policy.extension_pages
    } else {
        // the hook is a MAIN-world content script on Chrome; nothing loads it by URL
        manifest.web_accessible_resources = []
        delete manifest.web_accessible_resources
    }
    return JSON.stringify(manifest, null, 2)
}

export default {
    mode,
    devtool: mode === 'development' ? 'inline-source-map' : false,
    entry: {
        background: './src/background.ts',
        content: './src/src/content.ts',
        inject: './src/src/inject.ts',
        popup: './src/src/popup.ts',
    },
    output: {
        publicPath: '',
        path: distPath,
        filename: pathData => (pathData.chunk.name === 'background' ? '[name].js' : 'src/[name].js'),
        clean: true,
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                exclude: /node_modules/,
                use: { loader: 'ts-loader', options: { transpileOnly: true } },
            },
        ],
    },
    resolve: { extensions: ['.ts', '.js'] },
    plugins: [
        new webpack.DefinePlugin({
            __BUILT_FOR__: JSON.stringify(builtFor),
            __DEV__: JSON.stringify(mode !== 'production'),
            __VERSION__: JSON.stringify(manifestVersion),
            __CHANGELOG__: JSON.stringify(changelog),
        }),
        new CopyWebpackPlugin({
            patterns: [
                { from: './src/manifest.json', to: distPath, transform: transformManifest },
                { from: 'src/icons', to: path.join(distPath, 'icons'), globOptions: { ignore: ['**/.DS_Store', '**/*.svg'] } },
                { context: 'src/src/', from: '*.html', to: distSrcPath },
                { context: 'src/src/', from: '*.css', to: distSrcPath },
            ],
        }),
    ],
}
