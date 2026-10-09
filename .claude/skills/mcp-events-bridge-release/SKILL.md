---
name: mcp-events-bridge-release
description: >-
  Guides a maintainer through releasing @hookdeck/mcp-events-bridge to npm: choosing the
  version from the change set (SemVer), the release PR (package.json and CHANGELOG.md),
  release notes, and publishing by creating a GitHub Release, which runs the release
  workflow (npm trusted publishing with provenance). Use when cutting a release or a
  pre-release, drafting release notes, bumping the version, or running `gh release create`.
metadata:
  internal: true
---

# MCP Events bridge: release workflow

A release is published by **creating a GitHub Release**. That runs [`.github/workflows/release.yml`](../../../.github/workflows/release.yml), which checks the tag against `package.json`, runs the typecheck, tests and build, and publishes to npm with provenance. Nobody runs `npm publish` by hand.

The maintainer is in the loop at every **gate**: stop, show what you have, and wait for a clear yes. Don't treat an earlier yes as covering a later gate.

## Checklist

Follow in order.

- [ ] **Release shape:** stable from `main`, or a pre-release (`vX.Y.Z-beta.N`, from `main` or a feature branch). Confirm with the maintainer.
- [ ] **Tags:** `PREV_TAG` is the last release on this line (`gh release list`); propose `NEW_TAG`.
- [ ] **Change set:** read `git log PREV_TAG..origin/main` in full (and the diff where commits are unclear). Group the changes by what users see.
- [ ] **SemVer gate:** state the minimum bump the change set needs (see **SemVer**). If the maintainer proposed a version that under-bumps, say so and recommend the right one.
- [ ] **Release PR** (see **The release PR**): `package.json` version, the plugin's pinned version, and the `CHANGELOG.md` heading. **Gate:** the maintainer approves the version and the changelog, then the PR is merged.
- [ ] **CI gate:** the `test` workflow is green on the commit you'll release (see **CI check**). Don't release on red, pending or unknown.
- [ ] **Release notes:** draft them (see **Release notes** and [`references/release-notes-template.md`](references/release-notes-template.md)). **Gate:** the maintainer approves the tag, the target and the notes.
- [ ] **Publish:** `gh release create` with a temporary notes file (see **Publish**).
- [ ] **Verify:** the `release` workflow run succeeded, and npm serves the new version with the right dist-tag (see **Verify**).
- [ ] **After:** ask whether to redeploy the reference deployment (Fly.io) and whether anyone is waiting on the release (an issue, a thread). Posting anywhere needs its own yes.

## What triggers a release

- `release.yml` runs on `release: published`, so **only a published GitHub Release publishes to npm.** `gh release create` writes the notes and creates the tag in one step.
- A tag pushed by hand publishes nothing, but it then sits there for the next release to trip over: **never push a `v*` tag by hand.**
- A draft release publishes nothing until it's published. A release created by a workflow's `GITHUB_TOKEN` doesn't start other workflows, so create it as the maintainer (`gh` authenticated as them).
- The workflow fails, before publishing, if the tag isn't `v` + `package.json`'s version, or if a release marked pre-release has no pre-release suffix. npm never lets a version be reused, so these checks run first.
- npm dist-tag: `latest` for `X.Y.Z`; the suffix's first word for a pre-release (`0.3.0-beta.1` publishes to `beta`).

## One-time setup (maintainer)

The workflow publishes through [npm trusted publishing](https://docs.npmjs.com/trusted-publishers): no npm token in the repo. If it isn't set up, the publish step fails with an authentication error and nothing is published.

On npmjs.com, as an owner of `@hookdeck/mcp-events-bridge`: package **Settings** > **Trusted Publisher** > **GitHub Actions**, with organization `hookdeck`, repository `mcp-events-bridge`, workflow filename `release.yml`, and no environment. Check that it's there before the first automated release; you can't do it for them.

## SemVer

Classify everything since `PREV_TAG` by what users of the package see: `bridge.config.ts` and its providers, the CLI's commands, flags and output, environment variables, the MCP surface (tools, their arguments, event names and envelopes), and Event Gateway resource names.

| Change | Bump | Examples |
| --- | --- | --- |
| Breaking: users change config, scripts or agents | MAJOR (MINOR while `0.x`) | Renamed events or tools, changed tool arguments, a config field removed or renamed, resources renamed so `setup` makes new ones |
| New capability, backward compatible | MINOR | A new provider, tool, command, flag or delivery mode |
| Fixes, docs, internal | PATCH | Bug fixes, clearer output, docs and skill corrections, CI |

While the version is `0.x`, a breaking change bumps MINOR and says so loudly (0.2.0 did). Conventional Commit types (`feat:`, `fix:`, `!`, `BREAKING CHANGE:`) are hints: read the diff. If it's unclear whether something breaks users, ask.

## The release PR

On a branch `chore/release-X.Y.Z`:

1. `package.json` (and `package-lock.json`): `npm version X.Y.Z --no-git-tag-version`.
2. `CHANGELOG.md`: rename `## Unreleased` to `## X.Y.Z (YYYY-MM-DD)`, with the release date. Check the entries against the change set: every user-visible change from the log is there, and nothing that isn't shipping. Keep the house style (bold lead-in per bullet, issue and PR links).
3. The Claude Code plugin runs the published CLI at a pinned version: set `X.Y.Z` in `plugins/mcp-events-bridge/.claude-plugin/plugin.json` (`version`) and in `plugins/mcp-events-bridge/bin/events-bridge` (`@hookdeck/mcp-events-bridge@X.Y.Z`). `test/plugin.test.ts` fails until they match `package.json`. The marketplace serves the plugin from `main`, so between merging the release PR and npm publishing it, a new install can't start `watch`: publish straight after merging.
4. `docs/PLAN.md`: record the release where it lists versions.
5. Title `chore: release X.Y.Z`. **Gate:** the maintainer approves, then merge.

## CI check

After merging, `git fetch origin main` and check the rollup for the commit you'll release:

```bash
SHA=$(git rev-parse origin/main)
gh api graphql -f query='
  query($owner:String!,$repo:String!,$sha:GitObjectID!){
    repository(owner:$owner,name:$repo){
      object(oid:$sha){ ... on Commit { statusCheckRollup { state } } }
    }
  }' -F owner=hookdeck -F repo=mcp-events-bridge -F sha="$SHA" \
  --jq '.data.repository.object.statusCheckRollup.state'
```

Proceed only on `SUCCESS`. Don't use `repos/.../commits/$SHA/status`: Actions writes check runs, not legacy statuses, so that endpoint reports `pending` forever.

## Release notes

Use [`references/release-notes-template.md`](references/release-notes-template.md). Read the previous release's notes first (`gh release view PREV_TAG`); they set the voice. In short:

- Open with `## Summary`: two or three sentences on what the release means for someone running the bridge, in the second person.
- Add `## Upgrading from PREV` only when users have to do something, as numbered steps (commands, config edits, agents subscribing again, a redeploy).
- Then the release's `CHANGELOG.md` section, its `###` headings promoted to `##`, with repo-relative links made absolute (`https://github.com/hookdeck/mcp-events-bridge/blob/main/...`).
- End with the compare link and the changelog link.
- Omit empty sections. Follow the repo's writing rules in `AGENTS.md` (terminology, American English, no em dashes). No secrets.

## Publish

Create the release with `gh`, never by pushing a tag:

```bash
NOTES_FILE="$(mktemp "${TMPDIR:-/tmp}/mcp-events-bridge-release-notes.XXXXXX")"
trap 'rm -f "$NOTES_FILE"' EXIT
# write the approved notes to "$NOTES_FILE"
gh release create "vX.Y.Z" \
  --repo hookdeck/mcp-events-bridge \
  --target main \
  --title "vX.Y.Z" \
  --notes-file "$NOTES_FILE"
```

Pre-release: add `--prerelease` (and `--target <branch>` for a feature branch). The notes file is temporary: never commit it.

## Verify

```bash
gh run list --repo hookdeck/mcp-events-bridge --workflow release.yml --limit 1   # then: gh run watch <id> --exit-status
npm view @hookdeck/mcp-events-bridge dist-tags                                     # npm can take a few minutes
```

- **The run failed before `npm publish`** (tag mismatch, tests): nothing was published. Fix it on `main`, delete the GitHub release and its tag (`gh release delete vX.Y.Z --cleanup-tag`, with the maintainer's yes), and release again.
- **`npm publish` failed with an auth error:** trusted publishing isn't set up (see **One-time setup**). Once it is, re-run the failed job (`gh run rerun <id> --failed`); no new release needed.
- **Published:** check `npx @hookdeck/mcp-events-bridge@X.Y.Z --version` and that the package page shows provenance.

## Safety

- Don't release without the maintainer's yes on the version, the notes and the target.
- Don't release on red or pending CI.
- Never push `v*` tags by hand, and never `npm publish` from a laptop.
- Never put secrets in notes, commits or chat.
