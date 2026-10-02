# URL monitors

*Upload builds*, path 4: a studio that already hosts a web build registers its public address, and Vault copies it
into a test build whenever it changes. Code: `src/url-monitor.ts` (finding and copying files), `src/net-guard.ts`
(what may be fetched), `src/portal/uploads.ts` (the page and its API), table `url_monitors` (`src/db.ts` v15).

## What a studio gives

* **The game's folder address**, e.g. `https://games.example.org/tide/` (typing `…/tide` or `…/tide/index.html`
  means the same). One monitor per game; saving a different address for the game replaces it.
* **How to find the files**, one of:
  * **A file list** on the same site: text with one relative path per line (blank lines and `#` comments are
    skipped), or JSON: `["index.html", …]`, `[{ "path": … }]` or `{ "files": [...] }`. `index.html` is always
    included, and is fetched at the folder address itself (what players load). Every entry must be a file inside
    the game's folder, or the check fails.
  * **Following links.** Vault reads `index.html`, takes every `src`, `href`, `poster`, `srcset` and CSS `url()` /
    `@import` in it, and does the same for every HTML and CSS file it reaches inside the game's folder (at most 200
    of them, each up to 5 MB). Links to other sites or to folders above the game are ignored.

**What following links can't do.** It never reads JavaScript, so files a game loads from code are not found: Unity's
`Build/*.data` and `.wasm` (named in a loader script's config), Godot's `.pck`, levels fetched as JSON, lazily
loaded audio. Those games need a file list. Links built by a `<base href>` tag are not honoured either.

## A check

1. Find the files (above). At most 2,000 files.
2. Ask for each one with the `ETag` / `Last-Modified` it had at the last successful check (`If-None-Match`,
   `If-Modified-Since`). `304` means unchanged and nothing is downloaded. A file that does download is streamed into
   the builds bucket under `STUDIO/GAME/~incoming-web-copy/` while its SHA-256 is computed; if the hash equals the
   one already copied, it counts as unchanged. (A site that sends neither header is downloaded in full at every
   check and compared by hash.) A file whose copy has gone missing from the test build is fetched without conditions.
3. If nothing changed, was added or was removed, the incoming files are deleted and nothing else is written.
   Otherwise the changed files are copied over `STUDIO/GAME/web-copy/` (pages last, `index.html` very last), files no
   longer listed are deleted, and the build record is updated (`ref_type` branch, actor `url-monitor`, commit
   `url:` + a hash of the file list and contents). The game's page shows it like any test build; a release is
   requested from it by hand.
4. Any failure (a listed file answers 404 or 500, a redirect to another site, the 1 GB total exceeded, the time
   limit) deletes the incoming files and leaves the test build exactly as it was. The monitor keeps the reason, shown
   on *Upload builds*. With "following links", a linked file that doesn't load is left out and reported instead of
   failing the check (pages often link to things that aren't there); `index.html` itself must load.

Files named `*.br` / `*.gz` are stored as they are and served with `Content-Encoding`, as in CI uploads. If the site
compresses a response although asked not to (`Accept-Encoding: identity`), it is decompressed first. A response
without `Content-Length` is held in memory, so it may be at most 32 MB; with it, files are streamed (the service has
512 MB).

## What may be fetched

* `http:` and `https:` only; no username or password in the address.
* Never a private, loopback, link-local (including the cloud metadata address `169.254.169.254`), carrier-private,
  multicast or otherwise reserved address, in IPv4 or IPv6, including IPv4 addresses wrapped in IPv6 and odd
  spellings (`http://2130706433/`). Names are checked by the addresses they resolve to, inside the connection's own
  DNS lookup, so a name can't pass the check with one address and connect to another.
* Redirects are followed by hand (at most 5); every hop gets the same checks and must stay on the game's own origin.
  A site that redirects `http` to `https`, or to `www.`, has to be registered at the address it ends up at; the
  error says which.
* Everything fetched must be inside the game's folder on that origin; the file list must be on that origin too.
* The response is only ever stored as a file of the game; nothing from it is shown back to the person except the
  status code.

## When checks run

* **Check now** on *Upload builds* (studio maintainers, studio admins, Vault staff), and once when a monitor is saved.
  One check has 4 minutes (Cloud Run's request limit is 5).
* **`POST /v1/tasks/cleanup`** (production's nightly Cloud Scheduler job) checks monitors after its cleanup for at
  most 100 seconds, least recently checked first.
* **`POST /v1/tasks/monitors`** checks them all, for up to 12 minutes. It needs its own Scheduler job, which does not
  exist yet in either system; staging has no Scheduler job at all. See [setup.md](setup.md#7-scheduled-tasks).

A monitored test build is exempt from the 90-day cleanup while its monitor exists. Stopping a monitor keeps the
test build, which then ages out like any other branch build.

## Limits

2,000 files, 1 GB in total, one monitor per game, one fixed test build (`web-copy`) per monitor. A game with a
branch already publishing a test build called `web-copy` can't be monitored.

## Not done yet

* **Directory listings.** The card that asked for this also mentions "the ability to display a directory listing".
  A server's auto-index page (Apache, nginx) could serve as the file list: fetch the folder, take its links,
  descend into sub-folders (same origin, inside the folder, bounded depth and count). Not built: the listing's
  address and the game's address differ in ways that need a decision (which one are paths relative to), and index
  pages vary. A text file list covers the same need today.
* **Big or slow sites.** A check must finish within its time limit, and a failed check keeps nothing. A game near
  1 GB on a slow host may never complete inside 4 minutes. Fix: keep `~incoming` files between attempts and resume,
  or raise the service timeout and use the monitors' own task route.
* **A schedule per monitor**, pausing a monitor, and telling the studio (email, or a badge on the game) when a check
  has been failing for days. Today the result is only on the page.
* **Automatic publish requests** when a monitored game changes (path 2's equivalent). Deliberately left out: a
  site can change without the studio meaning to release.
* **Monitors on the game's own page.** It shows a line with the monitor's state and links to *Upload builds*, where
  the buttons are.
* **Several instances.** "A check is already running" is tracked in memory, which is right for the single instance
  the service runs as (SQLite has one writer).
