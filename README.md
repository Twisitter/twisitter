# Twisitter

A browser extension (Chrome, Edge, Firefox) that tells X users when their
replies are shown to them as normal but hidden from everyone else.

X can file a reply under "Show probable spam", leave it out of a post's reply
list altogether, or let the post's author hide it. The reply's writer is never
told. In the first two cases they still see the reply where they left it, and
in all three their own Replies tab shows it as normal. Twisitter compares the
writer's view with a second X account's view and reports when they differ, and
why.

## What it reports

For each reply it watches, the check reads, as the second account:

1. the parent post's reply list in **Relevant** order, following "Show probable
   spam" (`ShowMoreThreads`) cursors and a few pages of more replies: up to
   four pages of the list (X puts the button on the page after the last
   replies) and two pages behind the button. Recent order leaves the
   probable-spam replies out entirely, so it isn't used;
2. if the reply isn't there, `<post>/hidden` (`ModeratedTimeline`), the replies
   the post's author hid;
3. if it isn't there either, the reply opened directly.

Then, for any reply the second account doesn't see listed, the parent's list
as the author, to tell "hidden from others" from "gone for everyone".

| State | Others see | Reported |
|---|---|---|
| listed | the reply under the post | no |
| probable spam | it only after clicking "Show probable spam", Relevant order only | yes |
| missing | it in no list, though it opens from a direct link | yes |
| hidden by the post's author | it only on the post's hidden-replies page | yes (the writer is never told) |
| unavailable | "This Post is unavailable" | yes, if its author still sees it |
| deleted | nothing, its author included | no |

Two of X's own signals ride along when X sends them:

- **X's label for the reply's place in the list.** Each reply in a thread
  carries `conversationSection`: `HighQuality` in the main list and
  `LowQuality` behind "Show probable spam" (seen 2026-11-14). The check records
  it beside what the list showed and notes a mismatch, but the list decides.
- **The author's access flag.** Each tweet's user record carries
  `has_graduated_access`, false while X holds an account back until it's sure
  a person runs it ("Unlock more on X"). When it's false for the reply's
  author, the result names it as a likely reason.

Each result also places the reply among the replies the second account saw:
its rank, whether that part of the list was read to its end, X's own count of
the post's replies, and where it would sit by likes, reposts and replies or by
date. That comes from the pages the check reads anyway. Each reply keeps its
last 20 finished checks, so a change such as "missing, then Probable spam an
hour later" shows in the popup. And since every x.com page carries the
signed-in account's `has_graduated_access`, the popup says when X was holding
the second account back as it signed in: what it sees may then differ from
what most people see.

It doesn't look at reach in other people's feeds: there's nothing to compare
that against.

## Checking another account

On another account's profile, the popup offers "Check @name's replies". It
covers the newest 20 of that account's replies to other accounts that the user
has scrolled past on its Replies tab. X's own page reads the tab, and the page
hook passes those answers on, so listing them costs no read. Each reply is then
checked in its parent's reply list as above, as the user: to another account's
replies, the user is already "others". When X's answer says the user follows,
mutes or blocks the account, the user's view isn't an outsider's, so the second
account reads instead, if one is connected. Without one, a follow is checked
anyway with a caveat, and a mute or block isn't checked.

There's no writer's view, so the check can't say what the writer sees, or tell
a deleted reply from one X keeps from everyone ("couldn't say"). Replies in the
account's own threads are left out. One check per click, never repeated in the
background. A click within the hour reads nothing it already read, so a check
stopped by the read limit goes on where it stopped. Results are kept 30 days, as
ids, states and times, and a reply X hides gets the same note on x.com's pages
as the user's own.

## Reporting a problem

"Report a problem", at the foot of the popup, opens the form at
twisitter.com/feedback with the version, the browser, a status summary and the
diagnostic log filled in (`src/src/report.ts`). They travel in the link's
`#fragment`, which the browser never sends anywhere, so nothing leaves the
machine until the person sends the form. The extension itself makes no request
for it. On Firefox the details are Mozilla's "technical and interaction data",
declared optional in the manifest: on Firefox 140 and later the click asks
Firefox for it first (`permissions.request`), and a no opens the form without
them. Firefox 115 to 139 have no such setting, so the details go.

- The log (`src/src/diaglog.ts`) is a line per round that found something,
  changed or stopped early, per sign-in, account check and change in an
  account's trouble, and one line per quiet hour with its counts: rounds,
  routine checks by state, reads by account and kind, and answers that weren't
  ok. It keeps 400 lines. Post ids go in as `#<id>`; no account's name or id,
  no cookies, and nothing a post says.
- On the form, the person can leave the details out, or hide the post ids
  behind stand-ins. **Send privately** posts to twisitter.com's Worker, which
  keeps the report and files it as an issue in a private repository.
  **Post publicly on GitHub** opens this repository's issue form, filled in
  with the ids always hidden, and the log copied to the clipboard.

## How it works

- **Capture.** A page hook (`src/src/inject.ts`, in the page's own world) reads
  the page's `CreateTweet` answers, so replies posted on x.com are watched at
  once. The background also reads the user's Replies tab
  (`UserRepliesTimeline`) every half hour, for replies posted from X's phone
  apps. A reply can be added by its link too.
- **First run.** The user's own account comes from an x.com page, so at
  install Twisitter adds its scripts to the x.com tabs already open (browsers
  load content scripts only into pages opened later). Step 1 of the welcome
  page can open x.com in a background tab, leaving the welcome page in front.
  Signed out, X sends that tab from `/home` to its front page; step 1 then asks
  the user to sign in there, and brings the welcome page back once a page says
  who they are (`src/src/setup.ts`).
- **The second account.** The user signs in to it on X's own login page. The
  user's own X cookies are set aside first and put back after; the second
  account's cookies stay in the extension and ride only on the extension's own
  marked GET requests, through a declarativeNetRequest session rule (Chrome,
  Edge) or a blocking webRequest listener (Firefox). Those requests omit the
  browser's cookies, so X's answers can't touch the user's session. The
  sign-in counts as done when X sets its session cookie (`auth_token`). Only
  then does the extension touch the login tab, loading `x.com/home` there,
  whose page says who signed in. It never reads the login pages' addresses:
  X changes them. If that cookie were ever renamed, "I've signed in" in the
  popup still finishes the sign-in once the user confirms. When a sign-in
  ends, the login tab leaves X before any cookie changes, so no X page keeps
  talking to X mid-change. Twisitter then checks that the user's own login
  came back, and says so if it didn't. A sign-in as the user's own account by
  mistake keeps that fresh sign-in rather than the one saved at the start,
  which X may have ended.
- **Only ordinary reads.** The second account opens posts and their replies
  (including "Show probable spam"), a post's hidden-replies page and replies
  opened directly: what anyone browsing X opens. An account check opens the
  same pages, as the user. No searches. Who is signed in comes from x.com's own
  pages, not from extra requests.
- **Pace.** A reply is checked about two minutes after it's seen, then at an
  hour, six hours, a day, three days, a week, two weeks and a month. A check
  that stops early (X asks for a pause, an error) tries again in a quarter
  hour, then half as often each time, and leaves the last answer standing
  meanwhile. Reads as the user wait while a second account signs in. One reply
  per five-minute round; reads go one at a time, 2.5 s apart, at most 60 per 15
  minutes per account (X allows 300 `TweetDetail` reads per 15 minutes). The
  Replies tab adds replies from the last 30 days; older ones come in by link.
  An account check stops before it would pass 60 reads per 15 minutes as the
  user, or 30 as the second account, which leaves the rounds the rest.
- **Learning X's client.** X changes GraphQL queryIds and feature flags with
  each web client. The page hook sends the ones the page uses; the defaults in
  `src/src/x-api.ts` are from 2026-11-14.

Everything stays in the browser: the user's own sessions and X's own
endpoints. The one exception is a problem report the user sends (Reporting a
problem, above).

## Develop

Yarn 4 with a 7-day age gate on new packages (`.yarnrc.yml`), no install
scripts.

```bash
node .yarn/releases/yarn-4.14.1.cjs install
```

```bash
yarn typecheck && yarn test        # unit tests on recorded X answers
yarn build-chrome-e2e && yarn test:e2e   # a dev build in Chromium, X answered by routes
```

The e2e tests have their own build folder, `dist-chrome-e2e`, so they never
rebuild a `dist-*-dev` folder loaded in a browser. `yarn preflight` runs all
four commands.

`tests/fixtures` holds recorded X answers, scrubbed in the page before they
were saved (`scripts/scrub-x.cjs`): every id is replaced, names and text are
stand-ins, and only the fields the extension reads are kept.

Dev builds (`dist-*-dev`, `dist-chrome-e2e`) add a transport probe and a dev bridge an x.com tab
can drive (`window.postMessage({ source: 'twisitter-dev', cmd, args })`).
Production builds leave both out.

Firefox runs no automated test here; try a build by hand: in Firefox, open
`about:debugging`, then This Firefox, Load Temporary Add-on, and pick
`dist-firefox-dev/manifest.json`. Check that a reply posted on x.com shows in the
popup, that connecting a second account brings your own login back, and that
Check now gives a result.

`PRIVACY.md` is the privacy policy's text, and `STORE_PRIVACY.txt` holds the
answers for the stores' privacy forms.

## Store builds

With Node 26.13.1 (`.nvmrc`), after the install above:

```bash
yarn build-chrome    # dist-chrome and chrome.zip, for Chrome and Edge
yarn build-firefox   # dist-firefox and firefox.zip
yarn source-zip      # source.zip: the committed tree, for Firefox's reviewers
```

The production build is minified, with no source maps. Build from a clean
checkout of the commit `source.zip` comes from, so the two match.

## Publishing

A store's first version goes in by hand, in its dashboard, because that's where
the listing is made: the description, screenshots (`graphics/`), privacy
answers (`STORE_PRIVACY.txt`), the privacy policy URL, and for Firefox the
source. After that, these upload new versions:

```bash
yarn publish:all        # Chrome, then Firefox
yarn publish:chrome     # one store
yarn publish:firefox
yarn publish:firefox:text   # Firefox's description only, no new version
yarn publish:log        # what went to which store, when, and what failed
yarn refresh:chrome     # mint a new Chrome refresh token into .env
```

Copy `.env.example` to `.env` and fill it in: the Chrome Web Store item id and
an OAuth client with a refresh token, and Firefox Add-ons API keys. `.env` is
gitignored.

Each publish:

- stops before anything runs when VERSION HISTORY has no entry for the
  manifest's version, the extension's files have uncommitted changes, or Node
  isn't the version `.nvmrc` names (Mozilla's reviewers rebuild with it);
- runs `yarn preflight` (a rerun skips it once it has passed for this code),
  then `yarn install --immutable` and a fresh production build for each store,
  without `DIST_DIR`, and stops if a file changes while it builds;
- for Chrome, uploads `chrome.zip`, then waits while you paste the description
  into the dashboard and fill the Privacy tab for any new permission (the API
  can set neither), then submits;
- for Firefox, submits `dist-firefox` with `source.zip` (a `git archive` of
  the commit built) through `web-ext`, then sets the description;
- records each store that took the version in `.publish-status.json`
  (gitignored), so a rerun after a failure publishes only to the stores still
  missing it, and refuses other code under a version a store already has;
- appends what it did to `.publish-log.jsonl` (gitignored), which
  `yarn publish:log` prints.

Edge isn't scripted: upload `chrome.zip` in its dashboard.

The publish scripts (`scripts/publishing/`, `scripts/lib/env.mjs`) are synced
copies, with this extension's settings in `shared.json`. A test fails if one is
edited here.
