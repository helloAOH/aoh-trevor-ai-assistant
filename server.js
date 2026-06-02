require('dotenv').config();

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const crypto = require('crypto');
const TREVOR_CONTEXT = require('./context');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// ── MIDDLEWARE ───────────────────────────────────────────
app.use(
  express.urlencoded({
    extended: true,
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.json());

// ── INITIALIZE DATABASE ──────────────────────────────────
db.initializeDatabase();

// ── VERIFY SLACK REQUEST ─────────────────────────────────
function verifySlackRequest(req) {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return true;
  const slackSignature = req.headers['x-slack-signature'];
  const slackTimestamp = req.headers['x-slack-request-timestamp'];
  const currentTime = Math.floor(Date.now() / 1000);
  if (Math.abs(currentTime - slackTimestamp) > 300) return false;
  const sigBase = `v0:${slackTimestamp}:${req.rawBody}`;
  const mySignature =
    'v0=' +
    crypto
      .createHmac('sha256', secret)
      .update(sigBase, 'utf8')
      .digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(mySignature, 'utf8'),
      Buffer.from(slackSignature, 'utf8')
    );
  } catch (err) {
    return false;
  }
}

// ── FETCH APPLE PODCAST CHARTS ───────────────────────────
const APPLE_CHART_CATEGORIES = {
  relationships: '1528997175',
  personal_development: '1527223741',
  health_women: '1545225244',
  society: '1368298768',
  religion: '1548855547',
  business: '1541235542',
  education: '1548855548',
};

async function fetchAppleCharts() {
  try {
    const url = 'https://rss.applemarketingtools.com/api/v2/us/podcasts/top/100/podcasts.json';
    const response = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PodcastBot/1.0)' },
    });
    if (response.data?.feed?.results) {
      const list = response.data.feed.results.map((p, index) => ({
        rank: index + 1,
        name: p.name,
        artistName: p.artistName,
      }));
      console.log(`Apple top podcasts fetched: ${list.length}`);
      return { top: list };
    }
  } catch (err) {
    console.error('Apple charts error:', err.message);
  }
  return { top: [] };
}

function formatAppleChartsForClaude(charts) {
  const podcasts = (charts && charts.top) || [];
  if (podcasts.length === 0) return 'APPLE PODCAST CHARTS: unavailable right now.\n\n';
  let text = `APPLE PODCASTS — US TOP ${podcasts.length} OVERALL (fetched today):\n`;
  podcasts.forEach((p) => {
    text += `  #${p.rank}. ${p.name} by ${p.artistName}\n`;
  });
  text += '\n';
  return text;
}

// ── GET REAL APPLE PODCASTS LINK (free iTunes Search API) ──
async function fetchAppleInfo(title) {
  try {
    const response = await axios.get('https://itunes.apple.com/search', {
      params: { term: title, entity: 'podcast', limit: 1 },
      timeout: 8000,
    });
    const result = response.data?.results?.[0];
    if (result?.collectionViewUrl) {
      return { appleUrl: result.collectionViewUrl };
    }
  } catch (err) {
    console.error('iTunes lookup error:', err.message);
  }
  // Fallback: an Apple Podcasts search link (always works)
  return { appleUrl: `https://podcasts.apple.com/us/search?term=${encodeURIComponent(title)}` };
}

// ── SEARCH PODCASTS VIA LISTENNOTES ──────────────────────
async function searchListenNotes(keywords, maxResults = 10) {
  try {
    console.log(`ListenNotes searching for: ${keywords}`);
    const response = await axios.get(
      'https://listen-api.listennotes.com/api/v2/search',
      {
        headers: { 'X-ListenAPI-Key': process.env.LISTENNOTES_API_KEY },
        params: {
          q: keywords,
          type: 'podcast',
          per_page: maxResults,
          language: 'English',
        },
      }
    );
    const results = (response.data?.results || []).map((p) => ({
      title: p.title_original,
      description: p.description_original?.slice(0, 500) || '',
      website: p.website || 'N/A',
      total_episodes: p.total_episodes || 0,
      publisher: p.publisher_original || '',
      language: 'English',
      source: 'ListenNotes',
      contact_email: null,
      earliest_pub_date_ms: p.earliest_pub_date_ms || null,
      latest_pub_date_ms: p.latest_pub_date_ms || null,
      itunes_id: p.itunes_id || null,
    }));
    console.log(`ListenNotes returned ${results.length} results`);
    return results;
  } catch (err) {
    console.error('ListenNotes error:', err.message);
    return [];
  }
}

// ── SEARCH PODCASTS VIA PODCHASER ────────────────────────
async function searchPodchaser(keywords, maxResults = 10) {
  try {
    console.log(`Podchaser searching for: ${keywords}`);
    const safeKeywords = keywords.replace(/"/g, '').replace(/\n/g, ' ');

    const query = `
      query {
        podcasts(searchTerm: "${safeKeywords}", first: ${maxResults}) {
          data {
            id
            title
            description
            webUrl
            author { name }
            episodes(first: 1) {
              paginatorInfo { total }
            }
          }
        }
      }
    `;

    const response = await axios.post(
      'https://api.podchaser.com/graphql',
      { query },
      {
        headers: {
          Authorization: `Bearer ${process.env.PODCHASER_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );

    const podcasts = response.data?.data?.podcasts?.data || [];
    console.log(`Podchaser returned ${podcasts.length} results`);

    return podcasts.map((p) => {
      const emailMatch = p.description?.match(
        /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/
      );
      return {
        title: p.title,
        description: p.description?.slice(0, 500) || '',
        website: p.webUrl || 'N/A',
        total_episodes: p.episodes?.paginatorInfo?.total || 0,
        publisher: p.author?.name || '',
        language: 'English',
        source: 'Podchaser',
        contact_email: emailMatch ? emailMatch[0] : null,
      };
    });
  } catch (err) {
    console.error('Podchaser error:', err.message);
    return [];
  }
}

// ── COMBINE BOTH SOURCES ──────────────────────────────────

// ── MATCH A PODCAST TO THE REAL APPLE TOP 100 (by name) ──
function matchAppleTop100(title, topList) {
  if (!title || !topList || topList.length === 0) return null;
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const t = norm(title);
  if (!t) return null;
  for (const item of topList) {
    const n = norm(item.name);
    if (n && (n === t || n.includes(t) || t.includes(n))) {
      return item.rank;
    }
  }
  return null;
}
async function search_podcasts({ keywords, max_results = 10 }) {
  console.log(`Combined search for: ${keywords}`);

  const [listenNotesResults, podchaserResults] = await Promise.all([
    searchListenNotes(keywords, max_results),
    searchPodchaser(keywords, max_results),
  ]);

  const allResults = [...listenNotesResults];
  const existingTitles = new Set(
    listenNotesResults.map((p) => p.title.toLowerCase().trim())
  );

  podchaserResults.forEach((p) => {
    if (!existingTitles.has(p.title.toLowerCase().trim())) {
      allResults.push(p);
      existingTitles.add(p.title.toLowerCase().trim());
    }
  });

  console.log(
    `Combined: ${listenNotesResults.length} ListenNotes + ` +
    `${podchaserResults.length} Podchaser = ${allResults.length} unique`
  );

  return { podcasts: allResults };
}

// ── TOOL DEFINITIONS ─────────────────────────────────────
const tools = [
  {
    name: 'search_podcasts',
    description: 'Search podcasts using ListenNotes and Podchaser combined.',
    input_schema: {
      type: 'object',
      properties: {
        keywords: { type: 'string', description: 'Search keywords' },
        max_results: { type: 'number', description: 'Results per source. Default 10.' },
      },
      required: ['keywords'],
    },
  },
];

// ── CLAUDE WITH TOOL CALLING ─────────────────────────────
async function askClaudeWithTools(userMessage, systemPrompt) {
  const client = new Anthropic.Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const messages = [{ role: 'user', content: userMessage }];

  let response = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 4096,
    system: systemPrompt,
    tools,
    messages,
  });

  while (response.stop_reason === 'tool_use') {
    const toolUseBlock = response.content.find((b) => b.type === 'tool_use');
    if (!toolUseBlock) break;

    let toolResult;
    try {
      toolResult = toolUseBlock.name === 'search_podcasts'
        ? await search_podcasts(toolUseBlock.input)
        : { error: `Unknown tool: ${toolUseBlock.name}` };
    } catch (err) {
      toolResult = { error: err.message };
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseBlock.id,
        content: JSON.stringify(toolResult),
      }],
    });

    response = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 4096,
      system: systemPrompt,
      tools,
      messages,
    });
  }

  const textBlock = response.content.find((b) => b.type === 'text');
  return textBlock ? textBlock.text : 'No response generated';
}

// ── BASIC CLAUDE ─────────────────────────────────────────
async function askClaude(userMessage) {
  const client = new Anthropic.Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1024,
    system:
      'You are a helpful assistant in a Slack workspace. Keep answers concise. ' +
      'GUARDRAIL: Never send emails or take external actions. Drafts only.',
    messages: [{ role: 'user', content: userMessage }],
  });
  return response.content[0].text;
}

// ── GENERATE PITCH EMAIL ─────────────────────────────────
async function generatePitchEmail(
  podcastName, podcastDescription, podcastAudience,
  emailNumber, hostName, chosenAngle, tier
) {
  const client = new Anthropic.Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Load current social stats from the database (set via /update_stats)
  let socialStatsLine = '';
  try {
    socialStatsLine = (await db.getSystemPreference('SOCIAL_STATS')) || '';
  } catch (e) {
    console.error('Could not load SOCIAL_STATS:', e.message);
  }

  console.log('Generating email — tier:', tier, '| email #', emailNumber);
  const anglesText = TREVOR_CONTEXT.pitchAngles
    .map((a) => `${a.id}: "${a.topic}" (Best for: ${a.bestFor})`)
    .join('\n');

  // Pick the right tier template (A/B/C). Defaults to A if tier is unknown.
  const templateLetter = TREVOR_CONTEXT.pitchTemplates.tierToTemplate[tier] || 'A';
  console.log('Using template:', templateLetter, 'for tier:', tier);
  
    let template = '';
  if (emailNumber === 1) {
    template = TREVOR_CONTEXT.pitchTemplates[templateLetter].email1('[HOST_NAME]');
  } else if (emailNumber === 2) {
    template = TREVOR_CONTEXT.pitchTemplates.email2('[HOST_NAME]');
  } else if (emailNumber === 3) {
    template = TREVOR_CONTEXT.pitchTemplates.email3('[HOST_NAME]');
  } else if (emailNumber === 4) {
    template = TREVOR_CONTEXT.pitchTemplates.email4('[HOST_NAME]');
  }

  // Tier audience guidance for the rewrite (based on which template is used)
  const audienceGuidance = {
    A: 'Audience: people working on relationships, dating, attachment, self-worth, and personal growth. They want relatable, honest, practical insight. Keep it warm and human; avoid heavy clinical jargon unless the show itself is clearly clinical.',
    B: 'Audience: career-driven high achievers and entrepreneurs who win at work but struggle in love. Lean into the tension between outer success and inner/relationship struggle. Performance, patterns, and ROI language fits well here.',
    C: 'Audience: Christian women seeking faith-integrated growth, healing, and godly relationships. Weave faith in naturally and respectfully. Warm, honest, grounded in both faith and practical truth.',
  }[templateLetter] || '';

  const prompt = `
GUARDRAIL: Draft for human review only. Will NOT be sent automatically.

You are an expert podcast-pitch copywriter. Rewrite Trevor Hanson's guest-pitch email so it feels completely native to a specific show's audience and tone.

THE SHOW
Name: "${podcastName}"
Description: ${podcastDescription}
Audience: ${podcastAudience || 'Not specified'}
Host name: ${hostName || podcastName}
Email number: ${emailNumber}
${chosenAngle ? `Previously chosen angle: ${chosenAngle}` : ''}

TIER GUIDANCE
${audienceGuidance}

YOUR TASK
Read the show above, get a feel for its tone and audience, and REWRITE the template below so every sentence feels native to THIS show — while keeping the exact same structure, sections, and order. This is a full rewrite, not a fill-in-the-blank. If a sentence doesn't translate cleanly into the show's tone, rewrite it from scratch.

REWRITE RULES
- Keep the same structure and section order as the template (subject, hook, pain-point bullets, story, proposal + topic options, promotion, sign-off, PS).
- Rewrite the subject line in the audience's language (under 12 words).
- Replace the pain-point bullets with ones THIS audience specifically struggles with.
- Keep Trevor's actual story events (shattered jaw, Tesla layoff, broken engagement, master's in marriage & family therapy, licensed therapist/coach) — but reframe how they're introduced to fit the audience.
- Rewrite the topic options so they're compelling for this audience (keep the core: attachment, confidence, relationships, self-trust).
- Match the show's tone: lighter and funnier for casual/comedy shows; deeper or clinical only if the show is clearly clinical; faith-integrated for Christian shows.
- Replace [HOST_NAME] with the host's name.

NEVER
- Never invent credentials, claims, results, or offers that aren't in the template.
- Never change or remove the promotion links or the PS links — keep every <https://...> exactly as written.
- In the promotion section, use these EXACT current social stats and ignore any follower numbers in the template (ig = Instagram, fb = Facebook, tiktok = TikTok, newsletter = email subscribers): ${socialStatsLine || 'leave template numbers as-is'}

Available angles (pick the best fit for this show):
${anglesText}

Return JSON only — no backticks, no markdown:
{
  "chosen_angle": "angle_id",
  "angle_topic": "the topic/title you led with",
  "host_name": "host name used",
  "email_content": "the complete rewritten email with all links"
}

TEMPLATE TO REWRITE:
${template}
  `.trim();

  const response = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text;
  const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();

  try {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error('Could not parse pitch JSON:', e.message);
  }
  return { email_content: text, chosen_angle: 'angle_1', host_name: hostName || podcastName };
}


// ── SEND TO SLACK ────────────────────────────────────────
async function sendToSlack(responseUrl, text) {
  await axios.post(responseUrl, { response_type: 'in_channel', text });
}

// ── POST BLOCKS TO SLACK CHANNEL ────────────────────────
async function postToSlackChannel(channel, blocks, text) {
  const result = await axios.post(
    'https://slack.com/api/chat.postMessage',
    { channel, blocks, text },
    {
      headers: {
        Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
    }
  );
  if (!result.data.ok) {
    console.error('Slack post error:', result.data.error);
  }
  return result;
}

// ── BUILD PODCAST CARD ───────────────────────────────────
function buildPodcastBlock(podcast, index) {
  const score = podcast.quality_score || 0;
  let scoreEmoji = '✅';
  if (score >= 9) scoreEmoji = '🏆';
  else if (score >= 7) scoreEmoji = '⭐';

  const appleBadge = podcast.apple_chart_rank
    ? ` | 🍎 Apple #${podcast.apple_chart_rank}` : '';

  const email = podcast.contact_email &&
    podcast.contact_email !== 'Not found'
    ? podcast.contact_email
    : 'Not found — check website';

  const tierName = TREVOR_CONTEXT.tiers.find(
    (t) => t.tier === podcast.tier
  )?.name || 'General';

  const cardText = [
    `*${index + 1}. ${podcast.title}*${appleBadge}`,
    ``,
    `${scoreEmoji} *Score:* ${score}/10 | 🏷️ *Tier ${podcast.tier}:* ${tierName} | 📡 *Source:* ${podcast.source || 'ListenNotes'}`,
    `🌐 *Website:* ${(podcast.website || 'N/A').slice(0, 100)}`,
   `🎙️ *Episodes:* ${podcast.total_episodes || 'Unknown'}`,
    `📅 *Running:* ${podcast.first_episode_date || 'Unknown'} → ${podcast.latest_episode_date || 'Unknown'}${podcast.years_running && podcast.years_running !== 'Unknown' ? ` (~${podcast.years_running} yrs)` : ''}`,
    `📈 *Reach:* ${podcast.apple_chart_rank ? `🍎 In Apple Top 100 (#${podcast.apple_chart_rank})` : 'Not in Apple Top 100'}${podcast.apple_url ? ` — <${podcast.apple_url}|Verify on Apple>` : ''}`,
    `📧 *Contact:* ${email.slice(0, 150)}`,
    ``,
    `👥 *Audience:* ${(podcast.audience || 'N/A').slice(0, 200)}`,
    ``,
    `💡 *Why Trevor fits:* ${(podcast.summary || podcast.description || '').slice(0, 250)}`,
    ``,
    `📊 *Score breakdown:* ${(podcast.score_breakdown || 'N/A').slice(0, 150)}`,
  ].join('\n');

  // Encode podcast data for button values
  const podcastValue = JSON.stringify({
    title: podcast.title,
    website: (podcast.website || '').slice(0, 100),
    description: (podcast.description || '').slice(0, 300),
    audience: (podcast.audience || '').slice(0, 200),
    listen_score: podcast.quality_score || 0,
    tier: podcast.tier || null,
    recommended_angle: podcast.recommended_angle || null,
    contact_email: podcast.contact_email || null,
  });

  return [
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: cardText },
    },
    {
      type: 'actions',
      block_id: `podcast_action_${index}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '✅ Approve', emoji: true },
          style: 'primary',
          action_id: 'approve_podcast',
          value: podcastValue,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '❌ Reject', emoji: true },
          style: 'danger',
          action_id: 'reject_podcast_start',
          value: podcastValue,
        },
      ],
    },
  ];
}

// ── BUILD REJECT REASON FORM ─────────────────────────────
// Shows after clicking Reject — inline form with dropdown + text input
function buildRejectReasonForm(podcastTitle, podcastValue) {
  return [
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `❌ *Rejecting: ${podcastTitle}*\nPlease select a reason and add details:`,
      },
    },
    {
      type: 'actions',
      block_id: `reject_reason_${Date.now()}`,
      elements: [
        {
          type: 'static_select',
          placeholder: { type: 'plain_text', text: 'Select reason...' },
          action_id: 'reject_reason_select',
          options: [
            { text: { type: 'plain_text', text: '📉 Too small / low reach' }, value: 'Too small' },
            { text: { type: 'plain_text', text: '🎯 Wrong niche / audience' }, value: 'Wrong niche' },
            { text: { type: 'plain_text', text: '🔁 Already pitched' }, value: 'Already pitched' },
            { text: { type: 'plain_text', text: '👎 Low quality content' }, value: 'Low quality' },
            { text: { type: 'plain_text', text: '📝 Other (see details)' }, value: 'Other' },
          ],
        },
      ],
    },
    {
      type: 'input',
      block_id: `reject_details_${Date.now()}`,
      element: {
        type: 'plain_text_input',
        action_id: 'reject_details_input',
        placeholder: {
          type: 'plain_text',
          text: 'Add details — Claude learns from this. Be specific.',
        },
        multiline: true,
      },
      label: { type: 'plain_text', text: 'Details (required)' },
      hint: {
        type: 'plain_text',
        text: 'Example: "Host has under 5k followers, too small for our goals"',
      },
    },
    {
      type: 'actions',
      block_id: `reject_submit_${Date.now()}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '✔️ Confirm Rejection', emoji: true },
          style: 'danger',
          action_id: 'reject_confirm',
          value: podcastValue,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '↩️ Cancel', emoji: true },
          action_id: 'reject_cancel',
          value: podcastTitle,
        },
      ],
    },
  ];
}

// ── BUILD APPROVE NOTES FORM ─────────────────────────────
// Shows after approve — optional notes for Claude
function buildApproveNotesForm(podcastTitle) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `💬 *Optional:* Add notes for Claude about why *${podcastTitle}* was approved.\n_This helps Claude find similar podcasts in the future._`,
      },
    },
    {
      type: 'input',
      block_id: `approve_notes_block`,
      optional: true,
      element: {
        type: 'plain_text_input',
        action_id: 'approve_notes_input',
        placeholder: {
          type: 'plain_text',
          text: 'e.g. "Great audience of high-achieving women, host is very engaged"',
        },
        multiline: false,
      },
      label: { type: 'plain_text', text: 'Approval notes (optional)' },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '💾 Save Notes', emoji: true },
          style: 'primary',
          action_id: 'approve_notes_submit',
          value: podcastTitle,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Skip', emoji: true },
          action_id: 'approve_notes_skip',
          value: podcastTitle,
        },
      ],
    },
  ];
}

// ── BUILD EMAIL BLOCK ────────────────────────────────────
// ── SPLIT LONG TEXT INTO SLACK-SAFE CHUNKS (3000 char limit) ──
function splitIntoBlocks(content, maxLen = 2900) {
  const chunks = [];
  let remaining = content || '';
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) { chunks.push(remaining); break; }
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt <= 0) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}
function buildEmailBlock(podcastTitle, emailNumber, pitchData, podcastData) {
  const nextEmailNumber = emailNumber + 1;
  const hasNextEmail = nextEmailNumber <= 4;
  // Tier + template info for the email header
  const templateLetter = TREVOR_CONTEXT.pitchTemplates.tierToTemplate[podcastData.tier] || 'A';
  const tierInfo = TREVOR_CONTEXT.tiers.find((t) => t.tier === podcastData.tier);
  const tierName = tierInfo ? tierInfo.name : 'General';

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `📧 Email ${emailNumber} — ${podcastTitle.slice(0, 40)}`,
        emoji: true,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*From:*\ntrevor@theartofhealingbytrevor.com` },
        { type: 'mrkdwn', text: `*To:*\n${podcastData.contact_email || 'No email found — check website'}` },
      ],
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Tier:*\nTier ${podcastData.tier || '?'} — ${tierName}` },
        { type: 'mrkdwn', text: `*Template:*\nTemplate ${templateLetter}` },
      ],
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Angle:*\n${(pitchData.angle_topic || 'Default').slice(0, 100)}` },
        { type: 'mrkdwn', text: `*Attach:*\n<${TREVOR_CONTEXT.links.mediaKit}|Media Kit>` },
      ],
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: "⚠️ *DRAFT ONLY — Review before sending manually from Trevor's email.*",
      }],
    },
   ];

  // Split long email content into Slack-safe chunks (3000-char block limit)
  splitIntoBlocks(pitchData.email_content, 2900).forEach((chunk) => {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '```' + chunk + '```' },
    });
  });

  if (hasNextEmail) {
    blocks.push({
      type: 'actions',
      elements: [{
        type: 'button',
        text: {
          type: 'plain_text',
          text: `📧 Generate Email ${nextEmailNumber} — Follow-up ${nextEmailNumber === 2 ? '(Day 7)' : nextEmailNumber === 3 ? '(Day 14)' : '(1 Month)'}`,
          emoji: true,
        },
        style: 'primary',
        action_id: 'generate_next_email',
        value: JSON.stringify({
          title: podcastData.title,
          website: podcastData.website,
          description: (podcastData.description || '').slice(0, 300),
          audience: (podcastData.audience || '').slice(0, 200),
          emailNumber: nextEmailNumber,
          hostName: pitchData.host_name,
          chosenAngle: pitchData.chosen_angle,
          angleTopic: pitchData.angle_topic,
          tier: podcastData.tier || null,
          contact_email: podcastData.contact_email || null,
        }),
      }],
    });
  } else {
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: '✅ All 4 emails generated. Send manually from trevor@theartofhealingbytrevor.com',
      }],
    });
  }

  return blocks;
}

// ── HELPER: BUILD MEMORY CONTEXT FOR CLAUDE ──────────────
function buildMemoryContext(pastDecisions, feedbackSummary, generalFeedback) {
  let context = '\nMEMORY — LEARNED FROM PAST DECISIONS:\n';

  if (pastDecisions.length === 0 && feedbackSummary.length === 0 && generalFeedback.length === 0) {
    context += 'No past decisions yet.\n';
    return context;
  }

  if (pastDecisions.length > 0) {
    context += '\nRecent decisions:\n';
    pastDecisions.forEach((d) => {
      context += `- ${d.podcast_title}: ${d.decision.toUpperCase()}\n`;
    });
  }

  if (feedbackSummary.length > 0) {
    const approved = feedbackSummary.filter((f) => f.decision === 'approved');
    const rejected = feedbackSummary.filter((f) => f.decision === 'rejected');

    if (approved.length > 0) {
      context += '\nApproved podcast notes:\n';
      approved.forEach((f) => {
        if (f.approval_notes) context += `- ${f.podcast_title}: ${f.approval_notes}\n`;
      });
    }

    if (rejected.length > 0) {
      context += '\nRejection patterns to avoid:\n';
      const reasonCounts = {};
      rejected.forEach((f) => {
        if (f.rejection_reason) {
          reasonCounts[f.rejection_reason] = (reasonCounts[f.rejection_reason] || 0) + 1;
        }
      });
      Object.entries(reasonCounts).forEach(([reason, count]) => {
        context += `- "${reason}" rejected ${count} times\n`;
      });

      // Include specific rejection details
      rejected.slice(0, 5).forEach((f) => {
        if (f.rejection_reason && f.approval_notes) {
          context += `- ${f.podcast_title}: ${f.rejection_reason} — ${f.approval_notes}\n`;
        }
      });
    }
  }

  if (generalFeedback.length > 0) {
    context += '\nTeam feedback and preferences:\n';
    generalFeedback.forEach((f) => {
      context += `- [${f.category}] ${f.feedback_text}\n`;
    });
  }

  context += '\nUse this to improve your suggestions.\n';
  return context;
}

// ── ROUTES ───────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Trevor AI Assistant is running',
    commands: ['/find_podcasts', '/feedback', '/stats', '/asktrevorai'],
  });
});

// ── /asktrevorai ─────────────────────────────────────────
app.post('/slack/ask', async (req, res) => {
  if (!verifySlackRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { text, user_name, response_url } = req.body;
  if (!text?.trim()) {
    return res.json({ response_type: 'ephemeral', text: 'Please type a question.' });
  }
  res.json({ response_type: 'ephemeral', text: '⏳ Thinking...' });
  try {
    const answer = await askClaude(text);
    await sendToSlack(response_url, `*${user_name} asked:* ${text}\n\n*Answer:*\n${answer}`);
  } catch (error) {
    await sendToSlack(response_url,
      `❌ Error: ${error.message}\n_Screenshot and send to developer._`);
  }
});

// ── /find_podcasts ────────────────────────────────────────
app.post('/slack/find_podcasts', async (req, res) => {
  if (!verifySlackRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { text, user_name, response_url } = req.body;

  if (!text?.trim()) {
    return res.json({
      response_type: 'ephemeral',
      text: 'Please include keywords.\nExample: `/find_podcasts relationships attachment women`',
    });
  }

  res.json({
    response_type: 'ephemeral',
    text: `🔍 Searching *ListenNotes + Podchaser* for *"${text}"*...\nThis may take 30-45 seconds.`,
  });

  try {
    const [appleCharts, rejectedPodcasts, pastDecisions, feedbackSummary, generalFeedback] =
      await Promise.all([
        fetchAppleCharts(),
        db.getRejectedPodcasts(),
        db.getPastDecisions(10),
        db.getFeedbackSummary(10),
        db.getGeneralFeedback(10),
      ]);

    const appleChartsText = formatAppleChartsForClaude(appleCharts);
    const allExcluded = [...TREVOR_CONTEXT.alreadyPitched, ...rejectedPodcasts];
    const memoryContext = buildMemoryContext(pastDecisions, feedbackSummary, generalFeedback);

    const tiersText = TREVOR_CONTEXT.tiers
      .map(
        (t) =>
          `Tier ${t.tier} - ${t.name} (PRIORITY ${t.tier}):\n` +
          `  Focus: ${t.description}\n` +
          `  Examples: ${t.examples.join(', ')}`
      )
      .join('\n\n');

    const systemPrompt = `
You are Trevor Hanson's podcast outreach assistant.

GUARDRAILS:
- Find and evaluate podcasts only. Do NOT send emails.
- English language podcasts ONLY.

DATA ACCURACY RULES (CRITICAL):
- Only state FACTS that are present in the search data you were given.
- NEVER invent ratings, review counts, follower counts, host names, or email addresses.
- If a fact is not in the data, write "Unknown" — do NOT guess.
- You MAY judge audience, fit, alignment, and authority from the description — clearly as your assessment, not as hard facts.
- Episode count: use the provided total_episodes.
- Longevity: use earliest_pub_date_ms and latest_pub_date_ms (Unix timestamps in milliseconds) to report the first episode date, latest episode date, and years running. If those dates are missing, write "Unknown" and score Longevity 0.
- Contact email: use ONLY an email present in the data (Podchaser contact_email, or one found in the description). If none exists, set it to null. NEVER guess an email.

ABOUT TREVOR:
${TREVOR_CONTEXT.bio}

STRATEGIC PRIORITY:
Reach HIGH-ACHIEVING individuals who are financially successful but struggling
in personal relationships. Tiers 3 and 4 are HIGH PRIORITY.

TARGET SECTORS:
${tiersText}

${appleChartsText}

SCORING (base out of 7 + bonuses) — score ONLY on real data or honest judgment:
- Episodes (real): 500+=2 | 200-499=1.5 | 100-199=1 | <100=0.5
- Longevity (real, from episode dates): 4+yrs=2 | 2-3yrs=1 | <2yrs=0.5 | unknown=0
- Alignment with Trevor (your judgment from description): Perfect=2 | Good=1 | Weak=0
- Niche Authority (your judgment): THE go-to show=1 | one of many=0.5
- Do NOT score social/follower size — we cannot verify it.

APPLE TOP 100 BONUS (only if the show appears in the US TOP 100 list above):
- #1-25 = +3 | #26-50 = +1.5 | #51-100 = +0.5 | not listed = +0

TIER PRIORITY BONUS:
- Tier 3 or Tier 4 = +0.5

Minimum score to include: 5.5
Shows in the Apple US Top 100 qualify at base score 4.5+.
Cap quality_score at 10.

EXCLUDE: ${allExcluded.join(', ')}

${memoryContext}

Return pure JSON array only. No backticks. No markdown.

[
  {
    "title": "podcast name",
    "website": "url from the data",
    "description": "2-3 sentences",
    "audience": "your assessment of who listens + financial profile (judgment)",
    "summary": "why Trevor fits specifically (judgment)",
    "total_episodes": 250,
    "first_episode_date": "Mar 2019 or Unknown",
    "latest_episode_date": "May 2026 or Unknown",
    "years_running": "7 or Unknown",
    "quality_score": 8,
    "score_breakdown": "Episodes:1.5|Longevity:2|Alignment:2|Authority:1|AppleTop100:0|TierBonus:0",
    "contact_email": "email from data or null",
    "source": "ListenNotes",
    "language": "English",
    "tier": 1,
    "recommended_angle": "angle_1"
  }
]
    `.trim();

    const claudeResponse = await askClaudeWithTools(
      `Search English podcasts matching: "${text}".
       Prioritize Tiers 3 and 4. Cross-reference Apple Charts.
       Return top 5 as pure JSON. No backticks. No markdown.`,
      systemPrompt
    );

    let podcasts = [];
    try {
      const cleaned = claudeResponse.replace(/```json/g, '').replace(/```/g, '').trim();
      const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        podcasts = JSON.parse(jsonMatch[0]);
        console.log(`Claude returned ${podcasts.length} podcasts`);
      } else {
        await sendToSlack(response_url,
          `❌ No results for "${text}". Try:\n• \`/find_podcasts relationships attachment\`\n• \`/find_podcasts entrepreneurship success\``);
        return;
      }
    } catch (e) {
      await sendToSlack(response_url,
        `❌ Error: ${e.message}\n_Screenshot and send to developer._`);
      return;
    }

    podcasts = podcasts.filter((p) => {
      const score = p.quality_score || 0;
      if (score < 5.5) { console.log(`Filtered (score ${score}): ${p.title}`); return false; }
      if (p.language && p.language.toLowerCase() !== 'english') return false;
      console.log(`Passed (score ${score}, tier ${p.tier}): ${p.title}`);
      return true;
    });

    if (podcasts.length === 0) {
      await sendToSlack(response_url,
        `No qualifying podcasts for *"${text}"*.\nTry broader keywords.`);
      return;
    }

    // Add a real Apple Podcasts link to each result
    await Promise.all(podcasts.map(async (p) => {
      const info = await fetchAppleInfo(p.title);
      p.apple_url = info.appleUrl;
    }));
    // Real Apple Top 100 rank (code-computed — overrides any Claude guess)
    podcasts.forEach((p) => {
      p.apple_chart_rank = matchAppleTop100(p.title, appleCharts.top);
      console.log(`Apple Top 100 check: ${p.title} -> ${p.apple_chart_rank || 'not charting'}`);
    });

    const appleCount = podcasts.filter((p) => p.apple_chart_rank).length;
    const stats = await db.getStats();

    const tierCounts = {};
    podcasts.forEach((p) => {
      const tier = p.tier || 'Unknown';
      tierCounts[tier] = (tierCounts[tier] || 0) + 1;
    });
    const tierSummary = Object.entries(tierCounts)
      .map(([tier, count]) => `${count}×T${tier}`)
      .join(' | ');

    const headerBlocks = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `🎙️ Results for "${text.slice(0, 40)}"`,
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `*${podcasts.length} podcasts found* | ${tierSummary}` +
            (appleCount > 0 ? ` | 🍎 ${appleCount} on Apple Charts` : '') +
            `\n🏆 9-10 Elite | ⭐ 7-8 Excellent | ✅ Good Fit\n` +
            `DB: ${stats.total_approved} approved | ${stats.total_rejected} rejected\n` +
            `⚠️ _Drafts only — nothing sends automatically._`,
        },
      },
    ];

    const podcastBlocks = podcasts.flatMap((p, i) => buildPodcastBlock(p, i));
    const channel = process.env.SLACK_PODCAST_CHANNEL || '#find-podcasts';

    await postToSlackChannel(channel, [...headerBlocks, ...podcastBlocks],
      `Results for "${text}"`);
    await sendToSlack(response_url,
      `✅ Posted to ${channel} — ${podcasts.length} podcasts found!`);

  } catch (error) {
    console.error('find_podcasts error:', error.message);
    await sendToSlack(response_url,
      `❌ Search failed: ${error.message}\n_Screenshot and send to developer._`);
  }
});

// ── /feedback ────────────────────────────────────────────
app.post('/slack/podfeedback', async (req, res) => {
  if (!verifySlackRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { text, user_name, response_url } = req.body;

  if (!text?.trim()) {
    return res.json({
      response_type: 'ephemeral',
      text:
        '*How to use /podfeedback:*\n\n' +
        '`/podfeedback The podcasts are too small. We need 500+ episode shows.`\n' +
        '`/podfeedback Stop suggesting marriage podcasts. Trevor targets singles.`\n' +
        '`/podfeedback The emails are too long. Keep them shorter.`\n\n' +
        'Claude reads all feedback before every search.',
    });
  }

  try {
    let category = 'general';
    const lowerText = text.toLowerCase();
    if (lowerText.includes('email') || lowerText.includes('pitch')) category = 'pitch_quality';
    else if (lowerText.includes('podcast') || lowerText.includes('show')) category = 'sourcing';
    else if (lowerText.includes('score') || lowerText.includes('quality')) category = 'scoring';
    else if (lowerText.includes('audience') || lowerText.includes('niche')) category = 'targeting';

    await db.saveGeneralFeedback(text, user_name, category);

    res.json({
      response_type: 'in_channel',
      text:
        `✅ *Feedback saved by ${user_name}*\n` +
        `📂 Category: ${category}\n` +
        `💬 "${text}"\n\n` +
        `_Claude will use this to improve future suggestions._`,
    });
  } catch (error) {
    res.json({
      response_type: 'ephemeral',
      text: `❌ Could not save feedback: ${error.message}`,
    });
  }
});

// ── /update_stats ────────────────────────────────────────
app.post('/slack/update_stats', async (req, res) => {
  if (!verifySlackRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { text, user_name } = req.body;

  if (!text?.trim()) {
    return res.json({
      response_type: 'ephemeral',
      text:
        '*How to use /update_stats:*\n\n' +
        '`/update_stats ig 561k fb 73k tiktok 248k newsletter 40k+`\n\n' +
        'This updates Trevor’s follower numbers everywhere in the pitch emails. ' +
        'It stays until you run it again.',
    });
  }

  try {
    const value = text.trim();
    await db.setSystemPreference('SOCIAL_STATS', value, user_name);

    res.json({
      response_type: 'in_channel',
      text:
        `✅ *Social stats updated by ${user_name}*\n` +
        `📊 New stats: \`${value}\`\n\n` +
        `_These will now appear in all future pitch emails._`,
    });
  } catch (error) {
    res.json({
      response_type: 'ephemeral',
      text: `❌ Could not update stats: ${error.message}`,
    });
  }
});

// ── /stats ───────────────────────────────────────────────
app.post('/slack/stats', async (req, res) => {
  if (!verifySlackRequest(req)) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const stats = await db.getStats();
    const generalFeedback = await db.getGeneralFeedback(5);
    const approvalRate = stats.total_reviewed > 0
      ? Math.round((stats.total_approved / stats.total_reviewed) * 100)
      : 0;

    let statsText =
      `📊 *Trevor AI Outreach Stats*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `*Podcast Pipeline:*\n` +
      `🔍 Total reviewed: ${stats.total_reviewed}\n` +
      `✅ Approved: ${stats.total_approved}\n` +
      `❌ Rejected: ${stats.total_rejected}\n` +
      `📈 Approval rate: ${approvalRate}%\n\n` +
      `*Emails:*\n` +
      `📧 Total drafts: ${stats.total_emails}\n\n`;

    if (stats.top_rejection_reasons?.length > 0) {
      statsText += `*Top Rejection Reasons:*\n`;
      stats.top_rejection_reasons.forEach((r) => {
        statsText += `• ${r.rejection_reason}: ${r.count} times\n`;
      });
      statsText += '\n';
    }

    if (generalFeedback.length > 0) {
      statsText += `*Recent Team Feedback:*\n`;
      generalFeedback.forEach((f) => {
        statsText += `• [${f.category}] ${f.feedback_text.slice(0, 80)}${f.feedback_text.length > 80 ? '...' : ''}\n`;
      });
      statsText += '\n';
    }

    statsText +=
      `*Commands:*\n` +
      `\`/find_podcasts [keywords]\` — Find podcasts\n` +
      `\`/feedback [text]\` — Give Claude feedback\n` +
      `\`/stats\` — View this summary\n` +
      `\`/asktrevorai [question]\` — Ask anything`;

    res.json({ response_type: 'in_channel', text: statsText });
  } catch (error) {
    res.json({
      response_type: 'ephemeral',
      text: `❌ Could not load stats: ${error.message}`,
    });
  }
});

// ── HANDLE ALL BUTTON CLICKS ─────────────────────────────
app.post('/slack/actions', async (req, res) => {
  res.status(200).send('');

  let payload;
  try {
    payload = JSON.parse(req.body.payload);
  } catch (err) {
    console.error('Payload parse error:', err.message);
    return;
  }

  const action = payload.actions[0];
  const actionId = action.action_id;
  const channelId = payload.channel.id;
  const userName = payload.user.username;

  // ── APPROVE ────────────────────────────────────────────
  if (actionId === 'approve_podcast') {
    const podcastData = JSON.parse(action.value);

    await db.savePodcastDecision({
      podcastTitle: podcastData.title,
      podcastWebsite: podcastData.website || '',
      podcastDescription: podcastData.description || '',
      podcastAudience: podcastData.audience || '',
      listenScore: podcastData.listen_score || 0,
      decision: 'approved',
      decidedBy: userName,
      keywordsSearched: '',
    });

    // Post approval confirmation + email generation
    await postToSlackChannel(channelId,
      [{
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `✅ *${podcastData.title}* approved by ${userName}!\n⏳ Generating Email 1 draft...`,
        },
      }],
      `Approved: ${podcastData.title}`
    );

    // Generate pitch email
    try {
      const pitchData = await generatePitchEmail(
        podcastData.title, podcastData.description,
        podcastData.audience, 1, null, null, podcastData.tier
      );
      await db.savePitchEmail(podcastData.title, 1, pitchData.email_content);
      const emailBlocks = buildEmailBlock(podcastData.title, 1, pitchData, podcastData);
      await postToSlackChannel(channelId, emailBlocks, `Email 1 for ${podcastData.title}`);
    } catch (error) {
      console.error('Pitch error:', error.message);
      await postToSlackChannel(channelId,
        [{ type: 'section', text: { type: 'mrkdwn',
          text: `❌ Could not generate pitch: ${error.message}` }}],
        'Pitch failed'
      );
    }

    // Post optional notes form
    await postToSlackChannel(
      channelId,
      buildApproveNotesForm(podcastData.title),
      `Notes for ${podcastData.title}`
    );
  }

  // ── APPROVE NOTES SUBMIT ────────────────────────────────
  if (actionId === 'approve_notes_submit') {
    const podcastTitle = action.value;

    // Extract notes from the input block
    const notesBlock = payload.state?.values?.approve_notes_block;
    const notes = notesBlock?.approve_notes_input?.value || '';

    if (notes.trim()) {
      await db.saveFeedback({
        podcastTitle,
        podcastWebsite: '',
        podcastAudience: '',
        decision: 'approved',
        qualityScore: 0,
        approvalNotes: notes,
        decidedBy: userName,
      });

      await postToSlackChannel(channelId,
        [{
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `💾 *Approval notes saved for ${podcastTitle}*\n"${notes}"\n_Claude will use this to find similar podcasts._`,
          },
        }],
        `Notes saved for ${podcastTitle}`
      );
    }
  }

  // ── APPROVE NOTES SKIP ──────────────────────────────────
  if (actionId === 'approve_notes_skip') {
    await postToSlackChannel(channelId,
      [{
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `_Notes skipped for ${action.value}._`,
        },
      }],
      'Notes skipped'
    );
  }

  // ── REJECT START — Show inline form ────────────────────
  if (actionId === 'reject_podcast_start') {
    const podcastData = JSON.parse(action.value);

    await postToSlackChannel(
      channelId,
      buildRejectReasonForm(podcastData.title, action.value),
      `Reject: ${podcastData.title}`
    );
  }

  // ── REJECT CONFIRM — Save rejection with reason ─────────
  if (actionId === 'reject_confirm') {
    const podcastData = JSON.parse(action.value);

    // Get selected reason from dropdown
    let selectedReason = 'Other';
    const stateValues = payload.state?.values || {};
    for (const blockId of Object.keys(stateValues)) {
      if (stateValues[blockId]?.reject_reason_select?.selected_option?.value) {
        selectedReason = stateValues[blockId].reject_reason_select.selected_option.value;
      }
    }

    // Get typed details
    let details = '';
    for (const blockId of Object.keys(stateValues)) {
      if (stateValues[blockId]?.reject_details_input?.value) {
        details = stateValues[blockId].reject_details_input.value;
      }
    }

    // Require details
    if (!details.trim()) {
      await postToSlackChannel(channelId,
        [{
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `⚠️ Please add details before confirming rejection. Details help Claude learn.`,
          },
        }],
        'Missing details'
      );
      return;
    }

    const fullReason = `${selectedReason}: ${details}`;

    await db.savePodcastDecision({
      podcastTitle: podcastData.title,
      podcastWebsite: podcastData.website || '',
      podcastDescription: podcastData.description || '',
      podcastAudience: podcastData.audience || '',
      listenScore: 0,
      decision: 'rejected',
      decidedBy: userName,
      keywordsSearched: '',
    });

    await db.saveFeedback({
      podcastTitle: podcastData.title,
      podcastWebsite: podcastData.website || '',
      podcastAudience: podcastData.audience || '',
      decision: 'rejected',
      qualityScore: 0,
      rejectionReason: selectedReason,
      approvalNotes: details,
      decidedBy: userName,
    });

    await postToSlackChannel(channelId,
      [{
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `❌ *${podcastData.title}* rejected by ${userName}\n` +
            `📂 *Reason:* ${selectedReason}\n` +
            `💬 *Details:* "${details}"\n\n` +
            `_Saved to database — Claude will not suggest this again and will learn from this feedback._`,
        },
      }],
      `Rejected: ${podcastData.title}`
    );
  }

  // ── REJECT CANCEL ───────────────────────────────────────
  if (actionId === 'reject_cancel') {
    await postToSlackChannel(channelId,
      [{
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `↩️ Rejection cancelled for *${action.value}*`,
        },
      }],
      'Rejection cancelled'
    );
  }

  // ── GENERATE NEXT EMAIL ─────────────────────────────────
  if (actionId === 'generate_next_email') {
    const data = JSON.parse(action.value);
    const { title, emailNumber, hostName, chosenAngle } = data;

    await postToSlackChannel(channelId,
      [{ type: 'section', text: { type: 'mrkdwn',
        text: `⏳ Generating Email ${emailNumber} for *${title}*...` }}],
      `Generating email ${emailNumber}`
    );

    try {
      const pitchData = await generatePitchEmail(
        title, data.description, data.audience,
        emailNumber, hostName, chosenAngle, data.tier
      );
      await db.savePitchEmail(title, emailNumber, pitchData.email_content);
      const emailBlocks = buildEmailBlock(title, emailNumber, pitchData, data);
      await postToSlackChannel(channelId, emailBlocks, `Email ${emailNumber} for ${title}`);
    } catch (error) {
      await postToSlackChannel(channelId,
        [{ type: 'section', text: { type: 'mrkdwn',
          text: `❌ Could not generate Email ${emailNumber}: ${error.message}` }}],
        'Email failed'
      );
    }
  }
});

// ── START ────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Commands: /find_podcasts /feedback /stats /asktrevorai');
});