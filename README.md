# FlexVault Discord Release Announcement Action

A composite GitHub Action that automates staging release announcements to a private Discord channel (`#release-staging`) with:
1. **A 1-Click Copy Box:** Clean markdown with Discord's native copy button.
2. **A Live Rendered Preview:** Immediate visual verification before publishing.

## Features
- **4-Backtick Nested Code Block Safety:** Automatically shields nested code snippets from prematurely closing Discord's outer code block.
- **Discord 2000-Character Chunking:** Splits large changelogs into Part 1/N, Part 2/N cleanly so webhooks never fail with HTTP 400.
- **Kramdown / Markdown Anchor Cleaning:** Strips anchors like `{: #v... }` and resolves them to links.
- **Clickable Channel Links:** Built-in default feedback channel (`<#1547328671335846068>`) rendering as `#feedback-and-bugs`.

## Usage

### 1. From GitHub Releases (Plugins / CLI)
```yaml
- uses: FlexVaultSCM/discord-release-action@v1
  with:
    webhook-url: ${{ secrets.DISCORD_STAGING_WEBHOOK }}
    from-gh-release: ${{ needs.release-please.outputs.tag_name }}
    product-name: "FlexVault Godot Plugin"
    docs-url: "https://docs.fxv.dev/how-to/godot-plugin"
```

### 2. From Docs Markdown File (`releases.md`)
```yaml
- uses: FlexVaultSCM/discord-release-action@v1
  with:
    webhook-url: ${{ secrets.DISCORD_STAGING_WEBHOOK }}
    file: "docs/reference/releases.md"
    tag: ${{ github.event.inputs.tag }}
    product-name: "FlexVault"
    docs-url: "https://docs.fxv.dev/reference/releases"
```
