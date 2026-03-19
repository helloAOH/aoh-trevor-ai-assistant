require('dotenv').config();

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const crypto = require('crypto');
const TREVOR_CONTEXT = require('./context');

const app = express();
const PORT = process.env.PORT || 3000;

// ── MIDDLEWARE ──────────────────────────────────────────
app.use(
  express.urlencoded({
    extended: true,
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.json());

// ── VERIFY REQUEST CAME FROM SLACK ──────────────────────
function verifySlackRequest(req) {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) {
    console.warn('No SLACK_SIGNING_SECRET set');
    return true;
  }
  const slackSignature = req.headers['x-slack-signature'];
  const slackTimestamp = req.headers['x-slack-request-timestamp'];
  const currentTime = Math.floor(Date.now() / 1000);
  if (Math.abs(currentTime - slackTimestamp) > 300) return false;
  const sigBase = `v0:${slackTimestamp}:${req.rawBody}`;
  const mySignature =
    'v0=' +
    crypto.createHmac('sha256', secret).update(sigBase, 'utf8').digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(mySignature, 'utf8'),
      Buffer.from(slackSignature, 'utf8')
    );
  } catch (err) {
    return false;
  }
}

// ── TOOL: SEARCH PODCASTS VIA LISTENNOTES ───────────────
async function search_podcasts({ keywords, max_results = 8 }) {
  console.log(`Searching podcasts for: ${keywords}`);
  const response = await axios.get(
    'https://listen-api.listennotes.com/api/v2/search',
    {
      headers: { 'X-ListenAPI-Key': process.env.LISTENNOTES_API_KEY },
      params: {
        q: keywords,
        type: 'podcast',
        per_page: max_results,
        language: 'English',
      },
    }
  );

  const podcasts = response.data.results.map((podcast) => ({
    title: podcast.title_original,
    description: podcast.description_original?.slice(0, 300) + '...',
    website: podcast.website || 'N/A',
    total_episodes: podcast.total_episodes,
    listennotes_url: `https://www.listennotes.com/podcasts/${podcast.id}`,
    listen_score: podcast.listen_score || 0,
    listen_score_global_rank: podcast.listen_score_global_rank || 'N/A',
  }));

  return { podcasts };
}

// ── TOOL DEFINITIONS FOR CLAUDE ─────────────────────────
const tools = [
  {
    name: 'search_podcasts',
    description:
      'Search for podcasts using the ListenNotes API. ' +
      'Use this to find podcasts that match specific topics and audiences.',
    input_schema: {
      type: 'object',
      properties: {
        keywords: {
          type: 'string',
          description: 'Search keywords for finding podcasts',
        },
        max_results: {
          type: 'number',
          description: 'How many podcasts to return. Default 8.',
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
    tools: tools,
    messages: messages,
  });

  while (response.stop_reason === 'tool_use') {
    const toolUseBlock = response.content.find(
      (block) => block.type === 'tool_use'
    );
    if (!toolUseBlock) break;

    console.log(`Claude calling tool: ${toolUseBlock.name}`);
    let toolResult;
    try {
      if (toolUseBlock.name === 'search_podcasts') {
        toolResult = await search_podcasts(toolUseBlock.input);
      } else {
        toolResult = { error: `Unknown tool: ${toolUseBlock.name}` };
      }
    } catch (err) {
      toolResult = { error: `Tool failed: ${err.message}` };
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
      tools: tools,
      messages: messages,
    });
  }

  const textBlock = response.content.find((block) => block.type === 'text');
  return textBlock ? textBlock.text : 'No response generated';
}

// ── ORIGINAL ASK CLAUDE ──────────────────────────────────
async function askClaude(userMessage) {
  const client = new Anthropic.Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });
  const response = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1024,
    system:
      'You are a helpful assistant in a Slack workspace. ' +
      'Keep answers concise and clear. Use plain text only.',
    messages: [{ role: 'user', content: userMessage }],
  });
  return response.content[0].text;
}

// ── GENERATE PITCH EMAIL ─────────────────────────────────
async function generatePitchEmail(podcastName, podcastDescription, hostName) {
  const client = new Anthropic.Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  // Pick the best angle based on podcast description
  const anglesText = TREVOR_CONTEXT.pitchAngles
    .map((a) => `- ${a.id}: "${a.topic}" (Best for: ${a.bestFor})`)
    .join('\n');

  const prompt = `
You are drafting a pitch email for Trevor Hanson to appear as a guest on "${podcastName}".

Podcast description: ${podcastDescription}
Host name: ${hostName || podcastName}

Here is the EXACT email template. You must keep everything exactly as written.
Only fill in these two placeholders:
1. [HOST_NAME] → replace with: ${hostName || 'Hi there'}
2. [SPECIFIC_TO_PODCAST] → replace with a SHORT phrase (8-12 words max) 
   that describes what this specific podcast helps their listeners with.
   Base this on the podcast description above.

Available topic angles for future emails (just note which one fits best, 
don't use it in Email 1):
${anglesText}

Here is the template — return ONLY the completed email, nothing else:

${TREVOR_CONTEXT.pitchTemplates.email1}
  `.trim();

  const response = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content[0].text;
}

// ── SEND TO SLACK ────────────────────────────────────────
async function sendToSlack(responseUrl, text) {
  await axios.post(responseUrl, {
    response_type: 'in_channel',
    text: text,
  });
}

// ── SEND BLOCKS TO SLACK CHANNEL ────────────────────────
// Used for posting structured messages with buttons
async function postToSlackChannel(channel, blocks, text) {
  await axios.post(
    'https://slack.com/api/chat.postMessage',
    { channel, blocks, text },
    {
      headers: {
        Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
    }
  );
}

// ── BUILD SLACK BLOCKS FOR ONE PODCAST ──────────────────
// This creates the card with Approve/Reject buttons
function buildPodcastBlock(podcast, index) {
  const rank = podcast.listen_score_global_rank !== 'N/A'
    ? `Top ${podcast.listen_score_global_rank}`
    : 'Unranked';

  const score = podcast.listen_score
    ? `${podcast.listen_score}/100`
    : 'N/A';

  return [
    {
      type: 'divider',
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `*${index + 1}. ${podcast.title}*\n` +
          `📊 Listener Score: ${score} | 🏆 Rank: ${rank}\n` +
          `🌐 ${podcast.website}\n\n` +
          `${podcast.summary || podcast.description}`,
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
            listen_score: podcast.listen_score,
          }),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '❌ Reject', emoji: true },
          style: 'danger',
          action_id: 'reject_podcast',
          value: JSON.stringify({
            title: podcast.title,
          }),
        },
      ],
    },
  ];
}

// ── ROUTES ───────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Trevor AI Assistant is running' });
});

// Original /asktrevorai command
app.post('/slack/ask', async (req, res) => {
  if (!verifySlackRequest(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { text, user_name, response_url } = req.body;
  if (!text || text.trim() === '') {
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
    console.error('Error:', error.message);
    await sendToSlack(response_url, `❌ Something went wrong: ${error.message}`);
  }
});

// /find_podcasts command
app.post('/slack/find_podcasts', async (req, res) => {
  if (!verifySlackRequest(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { text, user_name, response_url } = req.body;

  if (!text || text.trim() === '') {
    return res.json({
      response_type: 'ephemeral',
      text: 'Please include keywords. Example: `/find_podcasts relationships attachment women`',
    });
  }

  res.json({
    response_type: 'ephemeral',
    text: `🔍 Searching for podcasts matching *"${text}"*...\nThis may take 20-30 seconds.`,
  });

  const alreadyPitchedList = TREVOR_CONTEXT.alreadyPitched.join(', ');
  const tiersText = TREVOR_CONTEXT.tiers
    .map((t) => `Tier ${t.tier} - ${t.name}: ${t.description}`)
    .join('\n');

  const systemPrompt = `
You are Trevor Hanson's podcast outreach assistant.

ABOUT TREVOR:
${TREVOR_CONTEXT.bio}

TARGETING TIERS (in priority order):
${tiersText}

PODCASTS ALREADY IN PIPELINE (DO NOT suggest these):
${alreadyPitchedList}

YOUR JOB:
1. Search for podcasts matching the keywords
2. Filter OUT any podcasts already in the pipeline above
3. Prioritize podcasts with high listen scores (top 0.5% to 1.5%)
4. Evaluate each podcast for fit with Trevor's audience and topics
5. Return the top 5 NEW podcasts not already in the pipeline

For each podcast return a JSON array with this exact structure:
[
  {
    "title": "podcast name",
    "website": "website url",
    "description": "2-3 sentences about the podcast",
    "summary": "Why Trevor fits this podcast in 2-3 sentences. Be specific.",
    "listen_score": number or 0,
    "listen_score_global_rank": "percentage or N/A",
    "tier": 1,
    "recommended_angle": "angle_1"
  }
]

Return ONLY the JSON array. No other text.
  `.trim();

  try {
    console.log(`${user_name} searching podcasts: ${text}`);

    const claudeResponse = await askClaudeWithTools(
      `Search for podcasts matching: "${text}". 
       Find the top 5 best matches for Trevor that are NOT already in his pipeline.
       Focus on high-ranking podcasts in relationships, personal development, 
       Christian women, or women's lifestyle categories.`,
      systemPrompt
    );

    // Parse Claude's JSON response
    let podcasts = [];
    try {
      const jsonMatch = claudeResponse.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        podcasts = JSON.parse(jsonMatch[0]);
      }
    } catch (parseError) {
      console.error('JSON parse error:', parseError.message);
      await sendToSlack(response_url, `❌ Error parsing results. Please try again.`);
      return;
    }

    if (podcasts.length === 0) {
      await sendToSlack(
        response_url,
        `No new podcasts found for "${text}". Try different keywords.`
      );
      return;
    }

    // Build the header message
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
          text: `Found *${podcasts.length} new podcasts* for Trevor to consider.\nClick *Approve* to generate a pitch email or *Reject* to dismiss.`,
        },
      },
    ];

    // Build blocks for each podcast
    const podcastBlocks = podcasts.flatMap((podcast, index) =>
      buildPodcastBlock(podcast, index)
    );

    const allBlocks = [...headerBlocks, ...podcastBlocks];

    // Post to #find-podcasts channel
    const channel = process.env.SLACK_PODCAST_CHANNEL || '#find-podcasts';
    await postToSlackChannel(channel, allBlocks, `Podcast results for "${text}"`);

    // Confirm to the user
    await sendToSlack(
      response_url,
      `✅ Results posted to ${channel} — ${podcasts.length} podcasts found!`
    );

    console.log(`Posted ${podcasts.length} podcast results to ${channel}`);
  } catch (error) {
    console.error('Error:', error.message);
    await sendToSlack(
      response_url,
      `❌ Search failed: ${error.message}`
    );
  }
});

// ── HANDLE APPROVE / REJECT BUTTON CLICKS ───────────────
app.post('/slack/actions', async (req, res) => {
  // Acknowledge Slack immediately
  res.status(200).send('');

  let payload;
  try {
    payload = JSON.parse(req.body.payload);
  } catch (err) {
    console.error('Could not parse payload:', err.message);
    return;
  }

  const action = payload.actions[0];
  const actionId = action.action_id;
  const channelId = payload.channel.id;
  const userName = payload.user.username;

  // ── REJECTED ──────────────────────────────────────────
  if (actionId === 'reject_podcast') {
    const podcastData = JSON.parse(action.value);
    await postToSlackChannel(
      channelId,
      [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `❌ *${podcastData.title}* rejected by ${userName}.`,
          },
        },
      ],
      `Rejected: ${podcastData.title}`
    );
    return;
  }

  // ── APPROVED ──────────────────────────────────────────
  if (actionId === 'approve_podcast') {
    const podcastData = JSON.parse(action.value);

    // Let the channel know we're generating the pitch
    await postToSlackChannel(
      channelId,
      [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `✅ *${podcastData.title}* approved by ${userName}!\n⏳ Generating pitch email...`,
          },
        },
      ],
      `Approved: ${podcastData.title}`
    );

    try {
      // Generate the pitch email
      const pitchEmail = await generatePitchEmail(
        podcastData.title,
        podcastData.description,
        null
      );

      // Post the pitch email to the channel
      await postToSlackChannel(
        channelId,
        [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: `📧 Email 1 — Pitch for ${podcastData.title}`,
              emoji: true,
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text:
                `*From:* trevor@theartofhealingbytrevor.com\n` +
                `*To:* ${podcastData.title}\n` +
                `*Attach:* Media Kit\n\n` +
                '```' + pitchEmail + '```',
            },
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: '💡 Review this email before sending. Follow up emails (Email 2 & 3) available on request.',
              },
            ],
          },
        ],
        `Pitch email for ${podcastData.title}`
      );

      console.log(`Pitch generated for ${podcastData.title}`);
    } catch (error) {
      console.error('Pitch generation error:', error.message);
      await postToSlackChannel(
        channelId,
        [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `❌ Could not generate pitch for ${podcastData.title}: ${error.message}`,
            },
          },
        ],
        'Pitch generation failed'
      );
    }
  }
});

// ── START ────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});