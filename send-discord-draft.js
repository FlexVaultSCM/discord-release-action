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
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

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
    dryRun: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--file' && i + 1 < args.length) {
      options.file = args[++i];
    } else if (arg === '--tag' && i + 1 < args.length) {
      options.tag = args[++i];
    } else if (arg === '--title' && i + 1 < args.length) {
      options.title = args[++i];
    } else if (arg === '--body' && i + 1 < args.length) {
      options.body = args[++i];
    } else if (arg === '--body-file' && i + 1 < args.length) {
      options.bodyFile = args[++i];
    } else if (arg === '--url' && i + 1 < args.length) {
      options.url = args[++i];
    } else if (arg === '--docs-url' && i + 1 < args.length) {
      options.docsUrl = args[++i];
    } else if (arg === '--product-name' && i + 1 < args.length) {
      options.productName = args[++i];
    } else if (arg === '--destination-channel' && i + 1 < args.length) {
      options.destinationChannel = args[++i];
    } else if (arg === '--from-gh-release') {
      options.fromGhRelease = true;
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        options.tag = args[++i];
      }
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

  // Split into sections starting with "## "
  const sections = content.split(/\r?\n(?=##\s+)/);
  const releaseSections = sections.filter(s => s.trim().startsWith('## '));

  if (releaseSections.length === 0) {
    throw new Error(`No release entries found starting with '## ' in ${filePath}`);
  }

  let selectedSection = releaseSections[0];
  if (targetTag) {
    const cleanTag = targetTag.replace(/^v/, '');
    const found = releaseSections.find(s => {
      const firstLine = s.split(/\r?\n/)[0];
      return firstLine.includes(targetTag) || firstLine.includes(cleanTag);
    });
    if (!found) {
      throw new Error(`Target tag '${targetTag}' was not found in ${filePath}`);
    }
    selectedSection = found;
  }

  const lines = selectedSection.split(/\r?\n/);
  // Remove markdown anchor like {: #v0-11-2 } from header
  const rawHeader = lines[0].replace(/^##\s+/, '').replace(/\{:\s*#[^\}]+\}/g, '').trim();

  // Extract anchor if present to link directly to section
  const anchorMatch = lines[0].match(/\{:\s*#([^\}]+)\}/);
  const anchor = anchorMatch ? anchorMatch[1].trim() : '';

  // Extract body and strip anchors throughout
  const rawBody = lines
    .slice(1)
    .join('\n')
    .replace(/\{:\s*#[^\}]+\}/g, '')
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
  const repoFlag = process.env.GITHUB_REPOSITORY ? `--repo "${process.env.GITHUB_REPOSITORY}"` : '';
  const tagArg = targetTag ? `"${targetTag}"` : '';
  const cmd = `gh release view ${tagArg} --json tagName,name,body,url ${repoFlag}`.trim();
  console.log(`Executing: ${cmd}`);
  const stdout = execSync(cmd, { encoding: 'utf8' });
  const data = JSON.parse(stdout);

  return {
    tag: data.tagName || targetTag,
    title: data.name || data.tagName,
    body: data.body || '',
    url: data.url || ''
  };
}

function getFeedbackChannelMention() {
  const channelId = process.env.DISCORD_FEEDBACK_CHANNEL_ID || '1547328671335846068';
  if (channelId && channelId.trim()) {
    return `<#${channelId.trim()}>`;
  }
  return '`#feedback-and-bugs`';
}

function splitIntoChunks(header, body, footer, maxLen = 1750) {
  const single = `${header}\n\n${body}\n\n${footer}`;
  if (single.length <= maxLen) {
    return [single];
  }

  // Split body into lines/bullets
  const lines = body.split(/\r?\n/);
  const chunks = [];
  let current = '';

  for (const line of lines) {
    const projected = `${header}\n\n${current ? current + '\n' + line : line}\n\n${footer}`;
    if (projected.length > maxLen && current) {
      chunks.push(current.trim());
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current.trim()) {
    chunks.push(current.trim());
  }

  if (chunks.length <= 1) {
    // If lines alone couldn't be split (e.g. single massive paragraph), truncate gracefully
    const maxBodyLen = Math.max(100, maxLen - header.length - footer.length - 100);
    const truncatedBody = `${body.slice(0, maxBodyLen)}...\n\n*(Truncated for Discord 2,000 character limit. See full notes in link below)*`;
    return [`${header}\n\n${truncatedBody}\n\n${footer}`];
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

  return [
    `📋 **Click the copy icon in the top-right of this box, then paste & edit in ${destinationChannel}:**`,
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
    releaseTag = parsed.tag;
    releaseTitle = parsed.title;
    releaseBody = parsed.body;
    anchor = parsed.anchor;
  } else if (options.fromGhRelease) {
    const parsed = fetchGitHubRelease(options.tag);
    releaseTag = parsed.tag;
    releaseTitle = parsed.title;
    releaseBody = parsed.body;
    releaseUrl = parsed.url;
  } else if (options.bodyFile) {
    if (fs.existsSync(options.bodyFile)) {
      releaseBody = fs.readFileSync(options.bodyFile, 'utf8').trim();
    }
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
  if (options.docsUrl && options.docsUrl !== releaseUrl) {
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

      // Brief pause so Discord receives and displays them in exact order
      await new Promise(r => setTimeout(r, 600));

      console.log(`Sending live preview to Discord...`);
      await sendWebhookMessage(webhookUrl, chunk);

      await new Promise(r => setTimeout(r, 600));
    }
  }

  console.log('\n✅ Discord release staging completed successfully!');
}

main().catch(err => {
  console.error('\n❌ Fatal Error in send-discord-draft:');
  console.error(err.message || err);
  process.exit(1);
});
