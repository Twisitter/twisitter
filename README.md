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

## How it works

- **Capture.** A page hook (`src/src/inject.ts`, in the page's own world) reads
  the page's `CreateTweet` answers, so replies posted on x.com are watched at
  once. The background also reads the user's Replies tab
  (`UserRepliesTimeline`) every half hour, for replies posted from X's phone
  apps. A reply can be added by its link too.
- **The second account.** The user signs in to it on X's own login page. The
  user's own X cookies are set aside first and put back after; the second
  account's cookies stay in the extension and ride only on the extension's own
  marked GET requests, through a declarativeNetRequest session rule (Chrome,
  Edge) or a blocking webRequest listener (Firefox). Those requests omit the
  browser's cookies, so X's answers can't touch the user's session.
- **Only ordinary reads.** The second account opens posts and their replies
  (including "Show probable spam"), a post's hidden-replies page and replies
  opened directly: what anyone browsing X opens. No searches. Who is signed in
  comes from x.com's own pages, not from extra requests.
- **Pace.** A reply is checked about two minutes after it's seen, then at an
  hour, six hours, a day, three days, a week, two weeks and a month. A check
  that stops early (X asks for a pause, an error) tries again in a quarter
  hour, then half as often each time, and leaves the last answer standing
  meanwhile. Reads as the user wait while a second account signs in. One reply
  per five-minute round; reads go one at a time, 2.5 s apart, at most 60 per 15
  minutes per account (X allows 300 `TweetDetail` reads per 15 minutes). The
  Replies tab adds replies from the last 30 days; older ones come in by link.
- **Learning X's client.** X changes GraphQL queryIds and feature flags with
  each web client. The page hook sends the ones the page uses; the defaults in
  `src/src/x-api.ts` are from 2026-11-14.

Everything stays in the browser: the user's own sessions, X's own endpoints,
no servers.

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

With Node 20.20.0 (`.nvmrc`), after the install above:

```bash
yarn build-chrome    # dist-chrome and chrome.zip, for Chrome and Edge
yarn build-firefox   # dist-firefox and firefox.zip
yarn source-zip      # source.zip: the committed tree, for Firefox's reviewers
```

The production build is minified, with no source maps. Build from a clean
checkout of the commit `source.zip` comes from, so the two match.
