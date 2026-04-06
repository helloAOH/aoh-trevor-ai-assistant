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

// ── FETCH APPLE PODCAST CHARTS — TOP 200 ─────────────────
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
  const results = {};
  for (const [category, id] of Object.entries(APPLE_CHART_CATEGORIES)) {
    try {
      const url = `https://rss.applemarketingtools.com/api/v2/us/podcasts/top/200/${id}/podcasts.json`;
      const response = await axios.get(url, {
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PodcastBot/1.0)' },
      });
      if (response.data?.feed?.results) {
        results[category] = response.data.feed.results.map((p, index) => ({
          rank: index + 1,
          name: p.name,
          artistName: p.artistName,
          url: p.url,
        }));
        console.log(
          `Apple charts fetched for ${category}: ${results[category].length} podcasts`
        );
      }
    } catch (err) {
      console.error(`Apple charts error for ${category}:`, err.message);
      results[category] = [];
    }
  }
  return results;
}

function formatAppleChartsForClaude(charts) {
  let text = 'APPLE PODCAST CHARTS TOP 200 (fetched today):\n\n';
  for (const [category, podcasts] of Object.entries(charts)) {
    if (podcasts.length === 0) continue;
    text += `${category.toUpperCase()} TOP ${podcasts.length}:\n`;
    podcasts.forEach((p) => {
      text += `  #${p.rank}. ${p.name} by ${p.artistName}\n`;
    });
    text += '\n';
  }
  return text;
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
            author {
              name
            }
            episodes(first: 1) {
              paginatorInfo {
                total
              }
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
      `${podchaserResults.length} Podchaser = ${allResults.length} unique results`
  );

  return { podcasts: allResults };
}

// ── TOOL DEFINITIONS ─────────────────────────────────────
const tools = [
  {
    name: 'search_podcasts',
    description:
      'Search for podcasts using both ListenNotes and Podchaser APIs combined. ' +
      'Returns deduplicated results from both sources. ' +
      'Podchaser results may include contact emails found in descriptions.',
    input_schema: {
      type: 'object',
      properties: {
        keywords: { type: 'string', description: 'Search keywords' },
        max_results: {
          type: 'number',
          description: 'Number of results per source. Default 10.',
        },
      },
      required: ['keywords'],
    },
  },
];

// ── CLAUDE WITH TOOL CALLING ─────────────────────────────
async function askClaudeWithTools(userMessage, systemPrompt) {
  const client = new Anthropic.Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });
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
      toolResult =
        toolUseBlock.name === 'search_podcasts'
          ? await search_podcasts(toolUseBlock.input)
          : { error: `Unknown tool: ${toolUseBlock.name}` };
    } catch (err) {
      toolResult = { error: err.message };
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseBlock.id,
          content: JSON.stringify(toolResult),
        },
      ],
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
  const client = new Anthropic.Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });
  const response = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1024,
    system:
      'You are a helpful assistant in a Slack workspace. Keep answers concise. ' +
      'GUARDRAIL: Never send emails or take any external action. Only provide information and drafts.',
    messages: [{ role: 'user', content: userMessage }],
  });
  return response.content[0].text;
}

// ── GENERATE PITCH EMAIL ─────────────────────────────────
async function generatePitchEmail(
  podcastName,
  podcastDescription,
  podcastAudience,
  emailNumber,
  hostName,
  chosenAngle
) {
  const client = new Anthropic.Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const anglesText = TREVOR_CONTEXT.pitchAngles
    .map((a) => `${a.id}: "${a.topic}" (Best for: ${a.bestFor})`)
    .join('\n');

  let template = '';
  if (emailNumber === 1) {
    template = TREVOR_CONTEXT.pitchTemplates.email1(
      '[HOST_NAME]',
      '[SPECIFIC_TO_PODCAST]'
    );
  } else if (emailNumber === 2) {
    template = TREVOR_CONTEXT.pitchTemplates.email2(
      '[HOST_NAME]',
      '[EPISODE_TOPIC_ANGLE]'
    );
  } else if (emailNumber === 3) {
    template = TREVOR_CONTEXT.pitchTemplates.email3(
      '[HOST_NAME]',
      '[EPISODE_TOPIC_ANGLE]'
    );
  }

  const prompt = `
GUARDRAIL: You are drafting a pitch email for human review only.
This email will NOT be sent automatically. A human must review and send it manually.

You are helping Trevor Hanson pitch himself as a podcast guest on "${podcastName}".

Podcast description: ${podcastDescription}
Podcast audience: ${podcastAudience || 'Not specified'}
Host name: ${hostName || podcastName}
Email number: ${emailNumber}
${chosenAngle ? `Previously chosen angle: ${chosenAngle}` : ''}

Available pitch angles:
${anglesText}

Instructions:
- For Email 1: Replace [HOST_NAME] with the host name. Replace [SPECIFIC_TO_PODCAST] with 8-12 words describing what this podcast helps listeners with.
- For Email 2 and 3: Replace [HOST_NAME] with the host name. Replace [EPISODE_TOPIC_ANGLE] with the chosen angle topic.
- Keep EVERYTHING else exactly as written. Do not change any other text.
- Match Trevor's voice: warm, direct, confident but not arrogant.
- Do not add commentary before or after the email.

Return a JSON object with no backticks and no markdown:
{
  "chosen_angle": "angle_id here",
  "angle_topic": "full angle topic text",
  "specific_to_podcast": "the 8-12 word phrase for email 1",
  "host_name": "the host name used",
  "email_content": "the complete finished email with all links intact"
}

Template to fill in:
${template}
  `.trim();

  const response = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 3000,
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
  return {
    email_content: text,
    chosen_angle: 'angle_1',
    host_name: hostName || podcastName,
  };
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
  let scoreDisplay = '';
  if (score >= 9) scoreDisplay = `🏆 ${score}/10 — Elite`;
  else if (score >= 7) scoreDisplay = `⭐ ${score}/10 — Excellent`;
  else scoreDisplay = `✅ ${score}/10 — Good Fit`;

  const appleBadge = podcast.apple_chart_rank
    ? `🍎 #${podcast.apple_chart_rank} on Apple Top 200 Today`
    : '';

  const emailDisplay =
    podcast.contact_email && podcast.contact_email !== 'Not found'
      ? `📧 ${podcast.contact_email}`
      : `📧 ${podcast.contact_email || 'Not found — check website'}`;

  const tierLabel = podcast.tier
    ? `Tier ${podcast.tier}`
    : 'Unclassified';

  return [
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `*${index + 1}. ${podcast.title}*` +
          (appleBadge ? `\n${appleBadge}` : ''),
      },
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*🌐 Website*\n${podcast.website || 'N/A'}`,
        },
        {
          type: 'mrkdwn',
          text: `*🎙️ Episodes*\n${podcast.total_episodes || 'N/A'} (${podcast.years_running || 'Unknown'})`,
        },
      ],
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*⭐ Quality Score*\n${scoreDisplay}`,
        },
        {
          type: 'mrkdwn',
          text: `*📱 Host Following*\n${podcast.host_social_following || 'Unknown'}`,
        },
      ],
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*📡 Source*\n${podcast.source || 'ListenNotes'}`,
        },
        {
          type: 'mrkdwn',
          text: `*🏷️ Sector*\n${tierLabel}`,
        },
      ],
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*🍎 Apple Reviews*\n${podcast.apple_review_count || 'Unknown'}`,
        },
        {
          type: 'mrkdwn',
          text: `*⭐ Apple Rating*\n${podcast.apple_rating || 'Unknown'}`,
        },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*🎤 Notable Guests*\n${podcast.notable_guests || 'Not available'}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*📊 Score Breakdown*\n${podcast.score_breakdown || 'N/A'}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${emailDisplay}*`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*👥 Audience*\n${podcast.audience || 'N/A'}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*💡 Why Trevor fits*\n${podcast.summary || podcast.description}`,
      },
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
          value: JSON.stringify({
            title: podcast.title,
            website: podcast.website,
            description: podcast.description,
            audience: podcast.audience,
            listen_score: podcast.quality_score || 0,
          }),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '❌ Reject', emoji: true },
          style: 'danger',
          action_id: 'reject_podcast',
          value: JSON.stringify({ title: podcast.title }),
        },
      ],
    },
  ];
}

// ── BUILD EMAIL BLOCK ────────────────────────────────────
function buildEmailBlock(podcastTitle, emailNumber, pitchData, podcastData) {
  const nextEmailNumber = emailNumber + 1;
  const hasNextEmail = nextEmailNumber <= 3;

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `📧 Email ${emailNumber} — Pitch for ${podcastTitle}`,
        emoji: true,
      },
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*From:*\ntrevor@theartofhealingbytrevor.com`,
        },
        { type: 'mrkdwn', text: `*To:*\n${podcastTitle}` },
      ],
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*Angle:*\n${pitchData.angle_topic || 'Default angle'}`,
        },
        {
          type: 'mrkdwn',
          text: `*Attach:*\n<${TREVOR_CONTEXT.links.mediaKit}|Media Kit>`,
        },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: "⚠️ *DRAFT ONLY — Review carefully before sending manually from Trevor's email.*",
        },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '```' + pitchData.email_content + '```',
      },
    },
  ];

  if (hasNextEmail) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: `📧 Generate Email ${nextEmailNumber} — Follow-up ${nextEmailNumber === 2 ? '(Day 7)' : '(Day 14)'}`,
            emoji: true,
          },
          style: 'primary',
          action_id: 'generate_next_email',
          value: JSON.stringify({
            title: podcastData.title,
            website: podcastData.website,
            description: podcastData.description,
            audience: podcastData.audience,
            emailNumber: nextEmailNumber,
            hostName: pitchData.host_name,
            chosenAngle: pitchData.chosen_angle,
            angleTopic: pitchData.angle_topic,
          }),
        },
      ],
    });
  } else {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '✅ All 3 emails generated. Send manually from trevor@theartofhealingbytrevor.com',
        },
      ],
    });
  }

  return blocks;
}

// ── HELPER: BUILD MEMORY CONTEXT FOR CLAUDE ──────────────
function buildMemoryContext(pastDecisions, feedbackSummary) {
  let context = '\nMEMORY — WHAT CLAUDE HAS LEARNED FROM PAST DECISIONS:\n';

  if (pastDecisions.length === 0 && feedbackSummary.length === 0) {
    context += 'No past decisions yet. This is a fresh start.\n';
    return context;
  }

  if (pastDecisions.length > 0) {
    context += '\nRecent decisions:\n';
    pastDecisions.forEach((d) => {
      context += `- ${d.podcast_title}: ${d.decision.toUpperCase()}`;
      if (d.keywords_searched) context += ` (searched: ${d.keywords_searched})`;
      context += '\n';
    });
  }

  if (feedbackSummary.length > 0) {
    const approved = feedbackSummary.filter((f) => f.decision === 'approved');
    const rejected = feedbackSummary.filter((f) => f.decision === 'rejected');

    if (approved.length > 0) {
      context += '\nApproved podcasts had these audience types:\n';
      approved.forEach((f) => {
        if (f.podcast_audience) {
          context += `- ${f.podcast_title}: ${f.podcast_audience}\n`;
        }
      });
    }

    if (rejected.length > 0) {
      context += '\nRejected podcasts — do not suggest similar:\n';
      rejected.forEach((f) => {
        context += `- ${f.podcast_title}`;
        if (f.rejection_reason) context += `: ${f.rejection_reason}`;
        context += '\n';
      });
    }
  }

  context += '\nUse this history to better predict what the team will approve.\n';
  return context;
}

// ── ROUTES ───────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Trevor AI Assistant is running',
    sources: ['ListenNotes', 'Podchaser'],
    apple_charts: 'Top 200',
    sectors: TREVOR_CONTEXT.tiers.map((t) => `Tier ${t.tier}: ${t.name}`),
    guardrails: [
      'Never auto-sends emails',
      'All pitches are drafts for human review',
      'English only filter active',
      'Minimum 50 Apple reviews threshold',
    ],
  });
});

// /asktrevorai
app.post('/slack/ask', async (req, res) => {
  if (!verifySlackRequest(req))
    return res.status(401).json({ error: 'Unauthorized' });
  const { text, user_name, response_url } = req.body;
  if (!text?.trim()) {
    return res.json({
      response_type: 'ephemeral',
      text: 'Please type a question after /asktrevorai',
    });
  }
  res.json({ response_type: 'ephemeral', text: '⏳ Thinking...' });
  try {
    const answer = await askClaude(text);
    await sendToSlack(
      response_url,
      `*${user_name} asked:* ${text}\n\n*Answer:*\n${answer}`
    );
  } catch (error) {
    console.error('asktrevorai error:', error.message);
    await sendToSlack(
      response_url,
      `❌ Something went wrong.\n*Error:* ${error.message}\n_Screenshot this and send to your developer._`
    );
  }
});

// /find_podcasts
app.post('/slack/find_podcasts', async (req, res) => {
  if (!verifySlackRequest(req))
    return res.status(401).json({ error: 'Unauthorized' });
  const { text, user_name, response_url } = req.body;

  if (!text?.trim()) {
    return res.json({
      response_type: 'ephemeral',
      text: 'Please include keywords.\n\n*Example:* `/find_podcasts relationships attachment women`',
    });
  }

  res.json({
    response_type: 'ephemeral',
    text:
      `🔍 Searching *ListenNotes + Podchaser* for *"${text}"*...\n` +
      `Fetching Apple Top 200 Charts + evaluating quality.\n` +
      `This may take 30-45 seconds.`,
  });

  try {
    const [appleCharts, rejectedPodcasts, pastDecisions, feedbackSummary] =
      await Promise.all([
        fetchAppleCharts(),
        db.getRejectedPodcasts(),
        db.getPastDecisions(10),
        db.getFeedbackSummary(10),
      ]);

    const appleChartsText = formatAppleChartsForClaude(appleCharts);
    const allExcluded = [
      ...TREVOR_CONTEXT.alreadyPitched,
      ...rejectedPodcasts,
    ];
    const memoryContext = buildMemoryContext(pastDecisions, feedbackSummary);

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

GUARDRAILS — NEVER VIOLATE THESE:
- You only find and evaluate podcasts. You do NOT send emails.
- You only draft pitches for human review. Humans send them manually.
- English language podcasts ONLY. Filter out any non-English podcasts immediately.

ABOUT TREVOR:
${TREVOR_CONTEXT.bio}

STRATEGIC PRIORITY:
Trevor's primary marketing goal is reaching HIGH-ACHIEVING individuals who are 
financially successful but struggling in their personal relationships.
These audiences are more likely to invest in Trevor's coaching and programs.
Tiers 3 and 4 are HIGH PRIORITY alongside Tiers 1 and 2.

TARGET SECTORS IN PRIORITY ORDER:
${tiersText}

LANGUAGE REQUIREMENT:
English only. Immediately exclude any non-English podcasts.

${appleChartsText}

APPLE CHART RANKING BONUS:
- Ranked #1-25 on Apple Top 200 = +3 points
- Ranked #26-75 = +2 points
- Ranked #76-200 = +1 point
- Not on charts = +0 points

APPLE RATINGS QUALITY SIGNAL:
Use your knowledge of Apple Podcast ratings to evaluate shows.
Reference calibration — shows Trevor has been on:
- Pretty Intense with Danica Patrick (major show, 1000s of reviews)
- What Fresh Hell Podcast (established show, hundreds of reviews)
- Mantalks with Connor Beaton (established niche show)

MINIMUM THRESHOLD: Only include podcasts you believe have 50+ Apple reviews
OR that appear on the Apple Top 200 charts.

Apple Ratings Bonus:
- 4.8+ stars with 100+ reviews = +1.5 points
- 4.5+ stars with 50+ reviews = +1 point
- 4.0+ stars with 50+ reviews = +0.5 points
- Fewer than 50 known reviews = 0 points (flag as low data)

HOW TO SCORE PODCASTS (base out of 7 plus bonuses):

EPISODE COUNT (up to 2 points):
- 500+ = 2 pts
- 200-499 = 1.5 pts
- 100-199 = 1 pt
- Under 100 = 0.5 pts

SHOW LONGEVITY (up to 1 point):
- 4+ years = 1 pt
- 2-3 years = 0.5 pts
- Under 2 years = 0 pts

SOCIAL MEDIA AND AUDIENCE SIZE (up to 2 points):
- 100k+ followers on any platform = 2 pts
- 50k-100k = 1.5 pts
- 10k-50k = 1 pt
- Unknown or small = 0.5 pts

NICHE AUTHORITY (up to 1 point):
- THE go-to show in their niche = 1 pt
- One of many similar shows = 0.5 pts

AUDIENCE ALIGNMENT WITH TREVOR (up to 1 point):
- Perfect match for Trevor's target audience = 1 pt
- Good match = 0.5 pts
- Weak match = 0 pts

APPLE CHART BONUS: up to +3 points
APPLE RATINGS BONUS: up to +1.5 points

MAXIMUM SCORE: 11.5 (display as capped at 10)

ONLY include podcasts scoring 6 or above.
Podcasts on Apple Top 200 automatically qualify if base score is 5+.
Tiers 3 and 4 podcasts get a +0.5 priority bonus if close to threshold.

CONTACT EMAIL PRIORITY:
1. Use contact_email from Podchaser data if available
2. Check if email appears in podcast description
3. Find most likely booking email using common patterns
4. If unknown: "Not found — check [website]/contact"

PODCASTS TO EXCLUDE (already in pipeline or rejected):
${allExcluded.join(', ')}

${memoryContext}

YOUR JOB:
1. Search for English-language podcasts matching the keywords
2. Classify each into the correct tier (1-6)
3. Prioritize Tiers 1-4 especially high-achiever sectors
4. Cross-reference with Apple Top 200 Charts
5. Apply Apple ratings bonus (min 50 reviews threshold)
6. Score each podcast
7. Only include scores 6 or above
8. Find contact emails
9. Return top 5 sorted by score then tier priority

CRITICAL: Return pure JSON array only. No backticks. No markdown. No extra text.

[
  {
    "title": "podcast name",
    "website": "url",
    "description": "2-3 sentences about the podcast",
    "audience": "Who listens. Age, interests, financial profile. 1-2 sentences.",
    "summary": "Why Trevor fits. Reference their specific audience and content. 2-3 sentences.",
    "total_episodes": 250,
    "quality_score": 8,
    "score_breakdown": "Episodes: 1.5 | Longevity: 1 | Social: 2 | Authority: 1 | Alignment: 1 | Apple Chart: 2 | Apple Rating: 1 | Priority Bonus: 0",
    "years_running": "5 years",
    "notable_guests": "Guest names here",
    "host_social_following": "150k Instagram",
    "apple_chart_rank": 45,
    "apple_review_count": "2500+ reviews",
    "apple_rating": "4.8 stars",
    "contact_email": "contact@podcastname.com",
    "source": "ListenNotes or Podchaser",
    "language": "English",
    "tier": 1,
    "recommended_angle": "angle_1"
  }
]
    `.trim();

    const claudeResponse = await askClaudeWithTools(
      `Search for English-language podcasts matching: "${text}".
       Use the combined ListenNotes + Podchaser search tool.
       Prioritize Tiers 3 and 4 (high achievers, entrepreneurship) alongside Tiers 1 and 2.
       Cross-reference with Apple Top 200 Charts.
       Only include podcasts with 50+ Apple reviews OR on Apple Charts.
       Score each and return top 5 as pure JSON. No backticks. No markdown.`,
      systemPrompt
    );

    let podcasts = [];
    try {
      const cleaned = claudeResponse
        .replace(/```json/g, '')
        .replace(/```/g, '')
        .trim();
      const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        podcasts = JSON.parse(jsonMatch[0]);
        console.log(`Claude returned ${podcasts.length} podcasts`);
      } else {
        console.error(
          'No JSON found. Claude returned:',
          cleaned.slice(0, 300)
        );
        await sendToSlack(
          response_url,
          `❌ No results found for "${text}".\n\nTry:\n• \`/find_podcasts relationships attachment\`\n• \`/find_podcasts high achievers love\`\n• \`/find_podcasts entrepreneurship mindset\``
        );
        return;
      }
    } catch (e) {
      console.error('JSON parse error:', e.message);
      await sendToSlack(
        response_url,
        `❌ Error processing results.\n*Error:* ${e.message}\n_Screenshot this and send to your developer._`
      );
      return;
    }

    // Safety filters
    podcasts = podcasts.filter((p) => {
      const score = p.quality_score || 0;
      if (score < 6) {
        console.log(`Filtered out (score ${score}): ${p.title}`);
        return false;
      }
      if (p.language && p.language.toLowerCase() !== 'english') {
        console.log(`Filtered out (non-English): ${p.title}`);
        return false;
      }
      console.log(`Passed (score ${score}, tier ${p.tier}): ${p.title}`);
      return true;
    });

    if (podcasts.length === 0) {
      await sendToSlack(
        response_url,
        `No qualifying podcasts found for *"${text}"*.\n\nTry:\n• \`/find_podcasts relationships attachment\`\n• \`/find_podcasts high achievers struggling in relationships\`\n• \`/find_podcasts entrepreneurship personal growth emotional intelligence\`\n• \`/find_podcasts self development mindset success\``
      );
      return;
    }

    const appleCount = podcasts.filter((p) => p.apple_chart_rank).length;
    const stats = await db.getStats();

    // Group by tier for the summary
    const tierCounts = {};
    podcasts.forEach((p) => {
      const tier = p.tier || 'Unknown';
      tierCounts[tier] = (tierCounts[tier] || 0) + 1;
    });
    const tierSummary = Object.entries(tierCounts)
      .map(([tier, count]) => {
        const tierInfo = TREVOR_CONTEXT.tiers.find(
          (t) => t.tier === parseInt(tier)
        );
        return `${count} × Tier ${tier}${tierInfo ? ` (${tierInfo.name})` : ''}`;
      })
      .join(' | ');

    const headerBlocks = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `🎙️ Podcast Results for "${text}"`,
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `Found *${podcasts.length} qualifying podcasts* for Trevor` +
            (appleCount > 0
              ? ` — *${appleCount} on Apple Top 200 today* 🍎`
              : '') +
            `\n*Sources:* ListenNotes + Podchaser\n` +
            `*Sectors found:* ${tierSummary}\n\n` +
            `*Quality Score Guide:*\n` +
            `🏆 9-10 — Elite (Apple Charts + top show + great ratings)\n` +
            `⭐ 7-8 — Excellent fit\n` +
            `✅ 6 — Good fit\n\n` +
            `*Memory:* ${stats.total_approved} approved | ${stats.total_rejected} rejected\n\n` +
            `⚠️ _All pitch emails are DRAFTS ONLY — nothing sends automatically._`,
        },
      },
    ];

    const podcastBlocks = podcasts.flatMap((p, i) => buildPodcastBlock(p, i));
    const channel = process.env.SLACK_PODCAST_CHANNEL || '#find-podcasts';

    await postToSlackChannel(
      channel,
      [...headerBlocks, ...podcastBlocks],
      `Podcast results for "${text}"`
    );

    await sendToSlack(
      response_url,
      `✅ Results posted to ${channel} — ${podcasts.length} podcasts found!`
    );
  } catch (error) {
    console.error('find_podcasts error:', error.message);
    await sendToSlack(
      response_url,
      `❌ Search failed.\n*Error:* ${error.message}\n_Screenshot this and send to your developer._`
    );
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

  // ── REJECT ──────────────────────────────────────────
  if (actionId === 'reject_podcast') {
    const podcastData = JSON.parse(action.value);

    await db.savePodcastDecision({
      podcastTitle: podcastData.title,
      podcastWebsite: podcastData.website || '',
      podcastDescription: podcastData.description || '',
      podcastAudience: podcastData.audience || '',
      listenScore: podcastData.listen_score || 0,
      decision: 'rejected',
      decidedBy: userName,
      keywordsSearched: '',
    });

    await db.saveFeedback({
      podcastTitle: podcastData.title,
      podcastWebsite: podcastData.website || '',
      podcastAudience: podcastData.audience || '',
      decision: 'rejected',
      qualityScore: podcastData.listen_score || 0,
      rejectionReason: 'Manually rejected by team',
      decidedBy: userName,
    });

    await postToSlackChannel(
      channelId,
      [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `❌ *${podcastData.title}* rejected by ${userName}.\n_Saved to database — Claude will not suggest this again._`,
          },
        },
      ],
      `Rejected: ${podcastData.title}`
    );
  }

  // ── APPROVE ──────────────────────────────────────────
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

    await db.saveFeedback({
      podcastTitle: podcastData.title,
      podcastWebsite: podcastData.website || '',
      podcastAudience: podcastData.audience || '',
      decision: 'approved',
      qualityScore: podcastData.listen_score || 0,
      approvalNotes: 'Manually approved by team',
      decidedBy: userName,
    });

    await postToSlackChannel(
      channelId,
      [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `✅ *${podcastData.title}* approved by ${userName}!\n⏳ Generating Email 1 draft...`,
          },
        },
      ],
      `Approved: ${podcastData.title}`
    );

    try {
      const pitchData = await generatePitchEmail(
        podcastData.title,
        podcastData.description,
        podcastData.audience,
        1,
        null,
        null
      );

      await db.savePitchEmail(podcastData.title, 1, pitchData.email_content);
      const emailBlocks = buildEmailBlock(
        podcastData.title,
        1,
        pitchData,
        podcastData
      );
      await postToSlackChannel(
        channelId,
        emailBlocks,
        `Email 1 for ${podcastData.title}`
      );
    } catch (error) {
      console.error('Pitch error:', error.message);
      await postToSlackChannel(
        channelId,
        [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `❌ Could not generate pitch.\n*Error:* ${error.message}\n_Screenshot this and send to your developer._`,
            },
          },
        ],
        'Pitch failed'
      );
    }
  }

  // ── GENERATE NEXT EMAIL ──────────────────────────────
  if (actionId === 'generate_next_email') {
    const data = JSON.parse(action.value);
    const { title, emailNumber, hostName, chosenAngle } = data;

    await postToSlackChannel(
      channelId,
      [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `⏳ Generating Email ${emailNumber} draft for *${title}*...`,
          },
        },
      ],
      `Generating email ${emailNumber}`
    );

    try {
      const pitchData = await generatePitchEmail(
        title,
        data.description,
        data.audience,
        emailNumber,
        hostName,
        chosenAngle
      );

      await db.savePitchEmail(title, emailNumber, pitchData.email_content);
      const emailBlocks = buildEmailBlock(title, emailNumber, pitchData, data);
      await postToSlackChannel(
        channelId,
        emailBlocks,
        `Email ${emailNumber} for ${title}`
      );
    } catch (error) {
      console.error('Email generation error:', error.message);
      await postToSlackChannel(
        channelId,
        [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `❌ Could not generate Email ${emailNumber}.\n*Error:* ${error.message}\n_Screenshot this and send to your developer._`,
            },
          },
        ],
        'Email generation failed'
      );
    }
  }
});

// ── START ────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Sources: ListenNotes + Podchaser');
  console.log('Apple Charts: Top 200');
  console.log('Sectors: 6 tiers with high-achiever priority');
  console.log('Guardrails: No auto-sending. English only. 50+ review threshold.');
});