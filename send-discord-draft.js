#!/usr/bin/env node

/**
 * FlexVault Discord Release Announcement Staging Script
 *
 * Formats release notes into a 1-click copy-paste markdown code block and a live
 * rendered preview, and sends them to a Discord webhook (#release-staging).
 *
 * Supports:
 * - Parsing docs/reference/releases.md (--file)
 * - Reading directly from GitHub Releases (--from-gh-release [<tag>])
 * - Custom input via arguments (--tag, --title, --body, --body-file, --url)
 * - Automatic cleaning of commit hashes and PR links
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

if (typeof fetch !== 'function') {
  console.error(`\n❌ Error: Node.js 18+ is required for native fetch support (detected: ${process.version}).`);
  console.error(`Please configure your workflow to run on Node 18 or 20+ via actions/setup-node@v4.`);
  process.exit(1);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    file: null,
    tag: null,
    title: null,
    body: null,
    bodyFile: null,
    url: null,
    docsUrl: 'https://docs.fxv.dev/reference/releases',
    productName: 'FlexVault',
    destinationChannel: '#releases',
    fromGhRelease: false,
    cleanLinks: true,
    dryRun: false
  };

  const takesValue = (idx) => idx + 1 < args.length && !args[idx + 1].startsWith('--');

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--file' && takesValue(i)) {
      options.file = args[++i];
    } else if (arg === '--tag' && takesValue(i)) {
      options.tag = args[++i];
    } else if (arg === '--title' && takesValue(i)) {
      options.title = args[++i];
    } else if (arg === '--body' && takesValue(i)) {
      options.body = args[++i];
    } else if (arg === '--body-file' && takesValue(i)) {
      options.bodyFile = args[++i];
    } else if (arg === '--url' && takesValue(i)) {
      options.url = args[++i];
    } else if (arg === '--docs-url' && takesValue(i)) {
      options.docsUrl = args[++i];
    } else if (arg === '--product-name' && takesValue(i)) {
      options.productName = args[++i];
    } else if (arg === '--destination-channel' && takesValue(i)) {
      options.destinationChannel = args[++i];
    } else if (arg === '--from-gh-release') {
      options.fromGhRelease = true;
      if (takesValue(i)) {
        options.tag = args[++i];
      }
    } else if (arg === '--no-clean-links') {
      options.cleanLinks = false;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    }
  }

  return options;
}

function parseReleasesDoc(filePath, targetTag) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Releases doc file not found at: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, 'utf8');

  // Split only on top-level release headers (starting with "## ")
  const sections = content.split(/\r?\n(?=##\s+)/);
  const releaseSections = sections.filter(s => s.trim().startsWith('## '));

  if (releaseSections.length === 0) {
    throw new Error(`No release entries found starting with '## ' in ${filePath}`);
  }

  let selectedSection = releaseSections[0];
  if (targetTag) {
    const cleanTag = targetTag.replace(/^v/, '');
    const tagRegex = new RegExp(`\\b${cleanTag.replace(/\./g, '\\.')}\\b`);
    const found = releaseSections.find(s => {
      const firstLine = s.split(/\r?\n/)[0];
      return tagRegex.test(firstLine);
    });
    if (!found) {
      throw new Error(`Target tag '${targetTag}' was not found in ${filePath}`);
    }
    selectedSection = found;
  }

  const lines = selectedSection.split(/\r?\n/);
  // Remove markdown anchor like {: #v0-11-2 } from header
  const rawHeader = lines[0].replace(/^##\s+/, '').replace(/\{:\s*#[^}]+\}/g, '').trim();

  // Extract anchor if present to link directly to section
  const anchorMatch = lines[0].match(/\{:\s*#([^}]+)\}/);
  const anchor = anchorMatch ? anchorMatch[1].trim() : '';

  // Extract body and strip anchors throughout
  const rawBody = lines
    .slice(1)
    .join('\n')
    .replace(/\{:\s*#[^}]+\}/g, '')
    .trim();

  // Extract version tag
  const tagMatch = rawHeader.match(/(v?\d+\.\d+(?:\.\d+)?(?:-[a-zA-Z0-9.]+)?)/);
  const tag = tagMatch ? (tagMatch[1].startsWith('v') ? tagMatch[1] : `v${tagMatch[1]}`) : rawHeader;

  return {
    tag,
    title: rawHeader,
    body: rawBody,
    anchor
  };
}

function fetchGitHubRelease(targetTag) {
  const args = ['release', 'view'];
  if (targetTag && targetTag.trim()) {
    args.push(targetTag.trim());
  }
  args.push('--json', 'tagName,name,body,url');

  if (process.env.GITHUB_REPOSITORY) {
    args.push('--repo', process.env.GITHUB_REPOSITORY);
  }

  console.log(`Executing: gh ${args.join(' ')}`);
  try {
    const stdout = execFileSync('gh', args, { encoding: 'utf8' });
    const data = JSON.parse(stdout);
    return {
      tag: data.tagName || targetTag,
      title: data.name || data.tagName,
      body: data.body || '',
      url: data.url || ''
    };
  } catch (err) {
    throw new Error(`Failed to fetch release via gh CLI: ${err.message}`);
  }
}

function cleanReleaseBody(body) {
  if (!body) return '';
  return body
    // Remove PR links: ([#123](https://...)) or ([#123])
    .replace(/\s*\(\[#\d+\](?:\([^)]+\))?\)/g, '')
    // Remove commit hash links: ([a-f0-9]{7,40}](https://...)) or ([a-f0-9]{7,40})
    .replace(/\s*\(\[?[a-f0-9]{7,40}\]?(?:\([^)]+\))?\)/gi, '')
    // Remove redundant compare header if present at start: ## [1.2.3](https://...) (2026-xx-xx)
    .replace(/^##\s+\[?[0-9.]+\]?(?:\([^)]+\))?(?:\s*\([^)]*\))?\r?\n+/m, '')
    // Clean up trailing whitespace on lines
    .replace(/[ \t]+$/gm, '')
    .trim();
}

function getFeedbackChannelMention() {
  const channelId = process.env.DISCORD_FEEDBACK_CHANNEL_ID;
  if (channelId === '' || channelId === 'none' || channelId === 'false') {
    return '`#feedback-and-bugs`';
  }
  const id = channelId || '1547328671335846068';
  if (/^\d+$/.test(id.trim())) {
    return `<#${id.trim()}>`;
  }
  return id.startsWith('#') ? `\`${id}\`` : `<#${id}>`;
}

function formatDestinationChannel(channel) {
  if (!channel) return '`#releases`';
  if (/^\d+$/.test(channel.trim())) {
    return `<#${channel.trim()}>`;
  }
  return channel.startsWith('#') || channel.startsWith('<#') ? channel : `\`${channel}\``;
}

function splitIntoChunks(header, body, footer, maxLen = 1750) {
  const single = `${header}\n\n${body}\n\n${footer}`;
  if (single.length <= maxLen) {
    return [single];
  }

  // Break any oversized lines exceeding the safety threshold
  const lineLimit = Math.max(100, maxLen - header.length - footer.length - 120);
  const rawLines = body.split(/\r?\n/);
  const normalizedLines = [];

  for (const line of rawLines) {
    if (line.length <= lineLimit) {
      normalizedLines.push(line);
    } else {
      let rem = line;
      while (rem.length > lineLimit) {
        let splitIdx = rem.lastIndexOf(' ', lineLimit);
        if (splitIdx <= 0) splitIdx = lineLimit;
        normalizedLines.push(rem.slice(0, splitIdx));
        rem = rem.slice(splitIdx).trimStart();
      }
      if (rem) normalizedLines.push(rem);
    }
  }

  const chunks = [];
  let currentLines = [];
  let currentLen = 0;
  let inCodeBlock = false;
  let currentCodeFence = '```';

  for (const line of normalizedLines) {
    const fenceMatch = line.match(/^(\s*)(`{3,})/);
    const lineLen = line.length + 1;
    const projectedLen = header.length + currentLen + lineLen + footer.length + 50;

    if (projectedLen > maxLen && currentLines.length > 0) {
      let chunkText = currentLines.join('\n');
      if (inCodeBlock) {
        chunkText += '\n' + currentCodeFence;
      }
      chunks.push(chunkText.trim());

      currentLines = [];
      currentLen = 0;
      if (inCodeBlock) {
        currentLines.push(currentCodeFence);
        currentLen += currentCodeFence.length + 1;
      }
    }

    if (fenceMatch) {
      inCodeBlock = !inCodeBlock;
      currentCodeFence = fenceMatch[2];
    }

    currentLines.push(line);
    currentLen += lineLen;
  }

  if (currentLines.length > 0) {
    let chunkText = currentLines.join('\n');
    if (inCodeBlock) {
      chunkText += '\n' + currentCodeFence;
    }
    chunks.push(chunkText.trim());
  }

  if (chunks.length <= 1) {
    return [single];
  }

  return chunks.map((c, i) => {
    const partHeader = `${header} (Part ${i + 1}/${chunks.length})`;
    const partFooter = i === chunks.length - 1 ? footer : `*(Continued in Part ${i + 2}...)*`;
    return `${partHeader}\n\n${c}\n\n${partFooter}`;
  });
}

function makeCopyBlock(renderedPost, destinationChannel) {
  // CommonMark rule: outer fence must contain more backticks than any inner sequence
  const backtickMatches = renderedPost.match(/`+/g);
  const maxTicks = backtickMatches ? Math.max(...backtickMatches.map(m => m.length)) : 0;
  const fence = '`'.repeat(Math.max(4, maxTicks + 1));

  const targetDisplay = formatDestinationChannel(destinationChannel);

  return [
    `📋 **Click the copy icon in the top-right of this box, then paste & edit in ${targetDisplay}:**`,
    `${fence}markdown`,
    renderedPost,
    `${fence}`,
    `👁️ **Live Preview of how it will look:**`
  ].join('\n');
}

async function sendWebhookMessage(webhookUrl, content, botName = 'FlexVault DraftBot') {
  if (content.length > 2000) {
    throw new Error(`Cannot send Discord message: length ${content.length} exceeds 2000 character limit!`);
  }

  const payload = {
    username: botName,
    content
  };

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (res.status === 204 || res.status === 200) {
      return;
    }

    if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      const waitMs = Math.ceil((data.retry_after || 1) * 1000);
      console.warn(`[Discord 429] Rate limited. Waiting ${waitMs}ms before retry...`);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }

    const errText = await res.text().catch(() => '');
    throw new Error(`Discord Webhook failed with HTTP ${res.status}: ${errText}`);
  }

  throw new Error(`Discord Webhook failed after ${maxRetries} attempts.`);
}

async function main() {
  const options = parseArgs();

  let releaseTag = options.tag || '';
  let releaseTitle = options.title || '';
  let releaseBody = options.body || '';
  let releaseUrl = options.url || '';
  let anchor = '';

  if (options.file) {
    const parsed = parseReleasesDoc(options.file, options.tag);
    releaseTag = options.tag || parsed.tag;
    releaseTitle = options.title || parsed.title;
    releaseBody = options.body || parsed.body;
    anchor = parsed.anchor;
  } else if (options.fromGhRelease) {
    const parsed = fetchGitHubRelease(options.tag);
    releaseTag = options.tag || parsed.tag;
    releaseTitle = options.title || parsed.title;
    releaseBody = options.body || parsed.body;
    releaseUrl = options.url || parsed.url;
  } else if (options.bodyFile) {
    if (fs.existsSync(options.bodyFile)) {
      releaseBody = options.body || fs.readFileSync(options.bodyFile, 'utf8').trim();
    }
  }

  if (options.cleanLinks) {
    releaseBody = cleanReleaseBody(releaseBody);
  }

  if (!releaseTitle) {
    releaseTitle = releaseTag ? `${options.productName} ${releaseTag}` : options.productName;
  }

  if (!releaseUrl) {
    if (anchor && options.docsUrl) {
      releaseUrl = `${options.docsUrl}#${anchor}`;
    } else {
      releaseUrl = options.docsUrl;
    }
  }

  const feedbackChannel = getFeedbackChannelMention();

  const header = `# ⚡ ${releaseTitle} is live!`;
  const footerLines = [
    '---',
    `📦 **Full Release Notes & Downloads:** ${releaseUrl}`
  ];
  if (options.docsUrl && options.docsUrl !== releaseUrl && !releaseUrl.startsWith(`${options.docsUrl}#`)) {
    footerLines.push(`📖 **Documentation:** ${options.docsUrl}`);
  }
  footerLines.push(`🛠️ *Questions or bugs? Drop a post in* ${feedbackChannel}!`);
  const footer = footerLines.join('\n');

  // Split into chunks if needed to guarantee Discord's 2,000 character limit
  const postChunks = splitIntoChunks(header, releaseBody, footer, 1750);

  const webhookUrl = process.env.DISCORD_STAGING_WEBHOOK;

  console.log(`Prepared ${postChunks.length} draft chunk(s) for ${releaseTitle}`);

  for (let i = 0; i < postChunks.length; i++) {
    const chunk = postChunks[i];
    const copyBlock = makeCopyBlock(chunk, options.destinationChannel);

    console.log(`\n================== CHUNK ${i + 1}/${postChunks.length} ==================`);
    console.log(`Copy Block Length: ${copyBlock.length} characters`);
    console.log(`Preview Length: ${chunk.length} characters`);

    if (options.dryRun || !webhookUrl) {
      if (!webhookUrl && !options.dryRun) {
        console.warn('Warning: DISCORD_STAGING_WEBHOOK not set. Running in dry-run mode.');
      }
      console.log('\n--- [1-CLICK COPY BLOCK] ---');
      console.log(copyBlock);
      console.log('\n--- [LIVE PREVIEW] ---');
      console.log(chunk);
    } else {
      console.log(`Sending copy block to Discord...`);
      await sendWebhookMessage(webhookUrl, copyBlock);

      await new Promise(r => setTimeout(r, 800));

      console.log(`Sending live preview to Discord...`);
      await sendWebhookMessage(webhookUrl, chunk);

      await new Promise(r => setTimeout(r, 800));
    }
  }

  console.log('\n✅ Discord release staging completed successfully!');
}

main().catch(err => {
  console.error('\n❌ Fatal Error in send-discord-draft:');
  console.error(err.stack || err.message || err);
  process.exit(1);
});
