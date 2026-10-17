# vault-site and the portal submodule

[VaultLearningGames/vault-site](https://github.com/VaultLearningGames/vault-site) is the website: a stock Hugo site at
the repository root (its history extracted from this repository's `site/`). This repository, the portal and its
deploy, is a git submodule of it at `portal/`. A vault-site commit runs vault-site's own workflow (Hugo build and
publish only); a commit here runs this repository's tests and portal deploy. The portal image carries vault-site at the
commit in `vault-site.ref` (README, [Previews and vault-site](../README.md#previews-and-vault-site)).

## The companion change in vault-site

Made in vault-site, not here (this repository's change can't push to it):

```sh
git clone git@github.com:VaultLearningGames/vault-site.git && cd vault-site
git switch -c portal-submodule
git submodule add -b main https://github.com/VaultLearningGames/vault-publisher.git portal
# then add the README section below
git add .gitmodules portal README.md
git commit -m "Add vault-publisher as the portal/ submodule"
```

`portal/` sits outside every Hugo mount (content/, layouts/, data/, static/, assets/, themes/), so Hugo never reads it
and `hugo server` / `hugo` work in a clone whose submodule was never initialised. The portal image removes `portal/`
from its copy anyway. vault-site's workflow should check out without submodules (`actions/checkout` defaults to
`submodules: false`), so a site build never needs access to this repository.

The section for vault-site's README:

```markdown
## Clone and develop

    git clone https://github.com/VaultLearningGames/vault-site.git      # the site alone: enough for hugo
    cd vault-site && hugo server --buildDrafts                           # http://localhost:1313

The portal (VaultLearningGames/vault-publisher) is the `portal/` submodule; the site builds without it. To work on
both:

    git clone --recurse-submodules https://github.com/VaultLearningGames/vault-site.git
    # or, in an existing clone: git submodule update --init
    cd vault-site/portal && npm install && node scripts/dev-portal.ts

From `portal/`, the portal finds this site as its parent folder and renders previews with it (portal/src/site-dir.ts).

Blog posts are `content/blog/<slug>/index.md`; the portal's blog editor commits them here. A commit here builds and
publishes the site (staging first; production when promoted); it doesn't deploy the portal.

## Updating the submodule and the portal's pin

* The submodule pointer (which portal commit `portal/` is): `git -C portal pull origin main && git add portal && git commit`.
  It is for development only; nothing deploys from it.
* The portal image's copy of this site is pinned separately, in vault-publisher's `vault-site.ref`: after a change
  here that previews must show (templates, front matter handling), put this repository's new commit SHA in that file
  and commit it in vault-publisher. Its next deploy carries it.
```
