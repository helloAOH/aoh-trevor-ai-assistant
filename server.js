require('dotenv').config();

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const crypto = require('crypto');
const TREVOR_CONTEXT = require('./context');
const db = require('./database');

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
    'v0=' + crypto.createHmac('sha256', secret).update(sigBase, 'utf8').digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(mySignature, 'utf8'),
      Buffer.from(slackSignature, 'utf8')
    );
  } catch (err) {
    return false;
  }
}

// ── SEARCH PODCASTS ──────────────────────────────────────
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
  return {
    podcasts: response.data.results.map((p) => ({
      title: p.title_original,
      description: p.description_original?.slice(0, 300) + '...',
      website: p.website || 'N/A',
      total_episodes: p.total_episodes,
      listennotes_url: `https://www.listennotes.com/podcasts/${p.id}`,
      listen_score: p.listen_score || 0,
      listen_score_global_rank: p.listen_score_global_rank || 'N/A',
    })),
  };
}

// ── TOOL DEFINITIONS ─────────────────────────────────────
const tools = [
  {
    name: 'search_podcasts',
    description: 'Search for podcasts using the ListenNotes API.',
    input_schema: {
      type: 'object',
      properties: {
        keywords: { type: 'string', description: 'Search keywords' },
        max_results: { type: 'number', description: 'Number of results. Default 8.' },
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
    system: 'You are a helpful assistant in a Slack workspace. Keep answers concise.',
    messages: [{ role: 'user', content: userMessage }],
  });
  return response.content[0].text;
}

// ── GENERATE PITCH EMAIL ─────────────────────────────────
async function generatePitchEmail(podcastName, podcastDescription, podcastAudience, emailNumber, hostName, chosenAngle) {
  const client = new Anthropic.Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const anglesText = TREVOR_CONTEXT.pitchAngles
    .map((a) => `${a.id}: "${a.topic}" (Best for: ${a.bestFor})`)
    .join('\n');

  // Build the correct template based on email number
  let template = '';
  if (emailNumber === 1) {
    template = TREVOR_CONTEXT.pitchTemplates.email1('[HOST_NAME]', '[SPECIFIC_TO_PODCAST]');
  } else if (emailNumber === 2) {
    template = TREVOR_CONTEXT.pitchTemplates.email2('[HOST_NAME]', '[EPISODE_TOPIC_ANGLE]');
  } else if (emailNumber === 3) {
    template = TREVOR_CONTEXT.pitchTemplates.email3('[HOST_NAME]', '[EPISODE_TOPIC_ANGLE]');
  }

  const prompt = `
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
- Do not add any commentary before or after the email.

Return a JSON object:
{
  "chosen_angle": "angle_id here",
  "angle_topic": "full angle topic text",
  "specific_to_podcast": "the 8-12 word phrase for email 1",
  "host_name": "the host name used",
  "email_content": "the complete finished email with all links intact"
}

Here is the template to fill in:
${template}
  `.trim();

  const response = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 3000,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text;
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
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
  const rank = podcast.listen_score_global_rank !== 'N/A'
    ? `Top ${podcast.listen_score_global_rank}`
    : 'Unranked';
  const score = podcast.listen_score ? `${podcast.listen_score}/100` : 'N/A';

  return [
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*${index + 1}. ${podcast.title}*` },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*🌐 Website*\n${podcast.website || 'N/A'}` },
        { type: 'mrkdwn', text: `*📊 Score*\n${score} | 🏆 ${rank}` },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*👥 Audience*\n${podcast.audience || 'Relationship-focused listeners seeking personal growth'}`,
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
            listen_score: podcast.listen_score,
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
        { type: 'mrkdwn', text: `*From:*\ntrevor@theartofhealingbytrevor.com` },
        { type: 'mrkdwn', text: `*To:*\n${podcastTitle}` },
      ],
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Angle:*\n${pitchData.angle_topic || 'Default angle'}` },
        { type: 'mrkdwn', text: `*Attach:*\n<${TREVOR_CONTEXT.links.mediaKit}|Media Kit>` },
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
      elements: [{
        type: 'mrkdwn',
        text: '✅ All 3 emails generated for this podcast.',
      }],
    });
  }

  return blocks;
}

// ── ROUTES ───────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Trevor AI Assistant is running' });
});

// /asktrevorai
app.post('/slack/ask', async (req, res) => {
  if (!verifySlackRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { text, user_name, response_url } = req.body;
  if (!text?.trim()) {
    return res.json({ response_type: 'ephemeral', text: 'Please type a question after /asktrevorai' });
  }
  res.json({ response_type: 'ephemeral', text: '⏳ Thinking...' });
  try {
    const answer = await askClaude(text);
    await sendToSlack(response_url, `*${user_name} asked:* ${text}\n\n*Answer:*\n${answer}`);
  } catch (error) {
    await sendToSlack(response_url, `❌ Something went wrong: ${error.message}`);
  }
});

// /find_podcasts
app.post('/slack/find_podcasts', async (req, res) => {
  if (!verifySlackRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { text, user_name, response_url } = req.body;

  if (!text?.trim()) {
    return res.json({
      response_type: 'ephemeral',
      text: 'Please include keywords. Example: `/find_podcasts relationships attachment women`',
    });
  }

  res.json({
    response_type: 'ephemeral',
    text: `🔍 Searching for podcasts matching *"${text}"*...\nThis may take 20-30 seconds.`,
  });

  try {
    const rejectedPodcasts = await db.getRejectedPodcasts();
    const allExcluded = [...TREVOR_CONTEXT.alreadyPitched, ...rejectedPodcasts];
    const pastDecisions = await db.getPastDecisions(10);
    const pastContext = pastDecisions.length > 0
      ? `\nPAST DECISIONS (learn from these):\n${pastDecisions
          .map((d) => `- ${d.podcast_title}: ${d.decision} (searched: ${d.keywords_searched})`)
          .join('\n')}`
      : '';

    const tiersText = TREVOR_CONTEXT.tiers
      .map((t) => `Tier ${t.tier} - ${t.name}: ${t.description}`)
      .join('\n');

    const systemPrompt = `
You are Trevor Hanson's podcast outreach assistant.

ABOUT TREVOR:
${TREVOR_CONTEXT.bio}

TARGETING TIERS (priority order):
${tiersText}

PODCASTS TO EXCLUDE (already in pipeline or previously rejected):
${allExcluded.join(', ')}
${pastContext}

YOUR JOB:
1. Search for podcasts matching the keywords
2. Exclude any podcast already listed above
3. Prioritize high listen scores (top 0.5% to 1.5% globally)
4. Return top 5 NEW podcasts not in the pipeline

Return ONLY a JSON array:
[
  {
    "title": "podcast name",
    "website": "url",
    "description": "2-3 sentences about the podcast",
    "audience": "Who listens. Age, interests, values. 1-2 sentences.",
    "summary": "Why Trevor fits this specific podcast. 2-3 sentences.",
    "listen_score": 0,
    "listen_score_global_rank": "percentage or N/A",
    "tier": 1,
    "recommended_angle": "angle_1"
  }
]
    `.trim();

    const claudeResponse = await askClaudeWithTools(
      `Search for podcasts matching: "${text}". Find top 5 NEW podcasts for Trevor not already in his pipeline.`,
      systemPrompt
    );

    let podcasts = [];
    try {
      const jsonMatch = claudeResponse.match(/\[[\s\S]*\]/);
      if (jsonMatch) podcasts = JSON.parse(jsonMatch[0]);
    } catch (e) {
      await sendToSlack(response_url, `❌ Error parsing results. Please try again.`);
      return;
    }

    if (podcasts.length === 0) {
      await sendToSlack(response_url, `No new podcasts found for "${text}". Try different keywords.`);
      return;
    }

    const headerBlocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: `🎙️ Podcast Results for "${text}"`, emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Found *${podcasts.length} new podcasts* for Trevor.\nClick *✅ Approve* to generate a pitch or *❌ Reject* to dismiss.`,
        },
      },
    ];

    const podcastBlocks = podcasts.flatMap((p, i) => buildPodcastBlock(p, i));
    const channel = process.env.SLACK_PODCAST_CHANNEL || '#find-podcasts';
    await postToSlackChannel(channel, [...headerBlocks, ...podcastBlocks], `Results for "${text}"`);
    await sendToSlack(response_url, `✅ Results posted to ${channel} — ${podcasts.length} podcasts found!`);

  } catch (error) {
    console.error('Error:', error.message);
    await sendToSlack(response_url, `❌ Search failed: ${error.message}`);
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

  // ── REJECT ───────────────────────────────────────────
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

    await postToSlackChannel(
      channelId,
      [{
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `❌ *${podcastData.title}* rejected by ${userName} and saved to database.`,
        },
      }],
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

    await postToSlackChannel(
      channelId,
      [{
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `✅ *${podcastData.title}* approved by ${userName}!\n⏳ Generating Email 1...`,
        },
      }],
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
      const emailBlocks = buildEmailBlock(podcastData.title, 1, pitchData, podcastData);
      await postToSlackChannel(channelId, emailBlocks, `Email 1 for ${podcastData.title}`);

    } catch (error) {
      console.error('Pitch error:', error.message);
      await postToSlackChannel(
        channelId,
        [{
          type: 'section',
          text: { type: 'mrkdwn', text: `❌ Could not generate pitch: ${error.message}` },
        }],
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
      [{
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `⏳ Generating Email ${emailNumber} for *${title}*...`,
        },
      }],
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
      await postToSlackChannel(channelId, emailBlocks, `Email ${emailNumber} for ${title}`);

    } catch (error) {
      console.error('Email generation error:', error.message);
      await postToSlackChannel(
        channelId,
        [{
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `❌ Could not generate Email ${emailNumber}: ${error.message}`,
          },
        }],
        'Email generation failed'
      );
    }
  }
});

// ── START ────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});