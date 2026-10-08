# Release notes template

Replace the placeholders, and drop any section with nothing to say. The release's `CHANGELOG.md` section is the body: don't rewrite its entries, so the two stay the same.

```markdown
## Summary

<Two or three sentences: what this release means for someone running the bridge, in the
second person. For a patch, what was wrong and that it's fixed.>

## Upgrading from <PREV_VERSION>

<Only when users have to do something. Numbered steps:>

1. `npm install @hookdeck/mcp-events-bridge@<X.Y.Z>`
2. <Config edits, `npx mcp-events-bridge setup`, restarting `serve` or redeploying, agents subscribing again.>

## Breaking

<From CHANGELOG.md, `###` promoted to `##`.>

## Added

## Changed

## Fixed

**Full changelog:** [`<PREV_TAG>...<NEW_TAG>`](https://github.com/hookdeck/mcp-events-bridge/compare/<PREV_TAG>...<NEW_TAG>) · [`CHANGELOG.md`](https://github.com/hookdeck/mcp-events-bridge/blob/main/CHANGELOG.md)
```

## Links

`CHANGELOG.md` links are relative to the repo (`skills/mcp-events-bridge/SKILL.md`, `#15`). In the notes, make them absolute:

- Files: `https://github.com/hookdeck/mcp-events-bridge/blob/main/<path>`
- Issues and PRs: GitHub links `#15` in release notes itself, but write the full URL when the changelog does.
