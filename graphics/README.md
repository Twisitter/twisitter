# Store graphics

Rendered by `scripts/store-graphics.mjs` from the layouts in `templates/`. The
popup and the welcome page in them are the real ones: a production build loaded
in Chromium with made-up accounts (`@you`, `@yoursecond`) and replies, none of
them real. x.com doesn't resolve during the run, so nothing reaches X. The made-up
data is at the top of the script.

| File | Size | For |
|---|---|---|
| `screenshot-1-two-views.png` | 1280x800 | screenshots: Chrome, Edge, Firefox |
| `screenshot-2-popup.png` | 1280x800 | |
| `screenshot-3-second-account.png` | 1280x800 | |
| `screenshot-4-privacy.png` | 1280x800 | |
| `promo-440x280.png` | 440x280 | Chrome Web Store small promo tile |
| `promo-1400x560.png` | 1400x560 | Chrome Web Store marquee tile |
| `logo-300.png` | 300x300 | Edge Add-ons logo |

The screenshots and tiles are PNGs with no alpha channel, as the Chrome Web
Store asks.

Render them again after a change to the popup, the note, the icon or a layout:

```bash
yarn build-chrome
```

```bash
node scripts/store-graphics.mjs
```

It takes a production build (`dist-chrome` by default, or a folder as its
argument) and refuses a dev build, whose popup has a dev section. Chromium needs
the Bash sandbox off.
