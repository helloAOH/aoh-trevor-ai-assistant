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

// ── SEARCH PODCASTS VIA LISTENNOTES ──────────────────────
async function search_podcasts({ keywords, max_results = 10 }) {
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
      description: p.description_original?.slice(0, 500),
      website: p.website || 'N/A',
      total_episodes: p.total_episodes,
      publisher: p.publisher_original,
      listennotes_url: `https://www.listennotes.com/podcasts/${p.id}`,
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
        max_results: { type: 'number', description: 'Number of results. Default 10.' },
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
async function generatePitchEmail(
  podcastName,
  podcastDescription,
  podcastAudience,
  emailNumber,
  hostName,
  chosenAngle
) {
  const client = new Anthropic.Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const anglesText = TREVOR_CONTEXT.pitchAngles
    .map((a) => `${a.id}: "${a.topic}" (Best for: ${a.bestFor})`)
    .join('\n');

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

  const emailDisplay =
    podcast.contact_email && podcast.contact_email !== 'Not found'
      ? `📧 ${podcast.contact_email}`
      : `📧 ${podcast.contact_email || 'Not found — check website'}`;

  return [
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${index + 1}. ${podcast.title}*`,
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
        { type: 'mrkdwn', text: `*From:*\ntrevor@theartofhealingbytrevor.com` },
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

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Trevor AI Assistant is running' });
});

// /asktrevorai
app.post('/slack/ask', async (req, res) => {
  if (!verifySlackRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
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
    text: `🔍 Searching for podcasts matching *"${text}"*...\nClaude is evaluating quality and finding contact info. This may take 30-40 seconds.`,
  });

  try {
    const rejectedPodcasts = await db.getRejectedPodcasts();
    const allExcluded = [...TREVOR_CONTEXT.alreadyPitched, ...rejectedPodcasts];
    const pastDecisions = await db.getPastDecisions(10);
    const pastContext =
      pastDecisions.length > 0
        ? `\nPAST DECISIONS (learn from these):\n${pastDecisions
            .map((d) => `- ${d.podcast_title}: ${d.decision}`)
            .join('\n')}`
        : '';

    const systemPrompt = `
You are Trevor Hanson's podcast outreach assistant.

ABOUT TREVOR:
${TREVOR_CONTEXT.bio}

TARGET SECTORS IN PRIORITY ORDER:
1. Relationships and Dating — podcasts about relationships, dating, attachment, love
2. Personal Development — self-improvement, mindset, success, entrepreneurship
3. Young Successful Women and Christian Women — lifestyle, faith, women empowerment

HOW TO EVALUATE PODCAST QUALITY:
Score each podcast out of 10 using these signals:

EPISODE COUNT (up to 2 points):
- 500+ episodes = 2 points
- 200-499 episodes = 1.5 points
- 100-199 episodes = 1 point
- Under 100 episodes = 0.5 points

SHOW LONGEVITY (up to 1 point):
- Running 4+ years = 1 point
- Running 2-3 years = 0.5 points
- Under 2 years = 0 points

SOCIAL MEDIA AND AUDIENCE SIZE (up to 2 points):
- Host has 100k+ followers on any platform = 2 points
- Host has 50k-100k followers = 1.5 points
- Host has 10k-50k followers = 1 point
- Unknown or small = 0.5 points

GUEST QUALITY (up to 2 points):
- Has interviewed major names (NYT bestsellers, celebrities, top experts) = 2 points
- Has interviewed mid-level known guests = 1 point
- Unknown guests only = 0 points

NICHE AUTHORITY (up to 2 points):
- Is THE go-to show in their niche = 2 points
- Strong presence but not THE top show = 1 point
- One of many similar shows = 0.5 points

AUDIENCE ALIGNMENT WITH TREVOR (up to 1 point):
- Perfect match (relationships + women + personal growth) = 1 point
- Good match = 0.5 points
- Weak match = 0 points

TOTAL SCORE = sum of all above (max 10)

ONLY return podcasts scoring 7 or above.
9-10 = Elite — must include
7-8 = Excellent — include
Below 7 = do not include

CONTACT EMAIL:
For each podcast find the most likely contact or booking email.
Common patterns: hello@, contact@, booking@, pitch@, podcast@, info@
If unknown write: "Not found — check [website]/contact"

PODCASTS TO EXCLUDE (already in pipeline or previously rejected):
${allExcluded.join(', ')}
${pastContext}

YOUR JOB:
1. Search for podcasts matching the keywords
2. Score each podcast using the criteria above
3. Only include podcasts scoring 7 or above
4. Find contact email for each
5. Return top 5 sorted by score highest first

Return ONLY a JSON array. No other text.

[
  {
    "title": "podcast name",
    "website": "url",
    "description": "2-3 sentences about the podcast",
    "audience": "Who listens. Age, interests, values. 1-2 sentences.",
    "summary": "Why Trevor fits this specific podcast. Be specific. 2-3 sentences.",
    "total_episodes": 250,
    "quality_score": 8,
    "score_breakdown": "Episodes: 1.5 | Longevity: 1 | Social: 2 | Guests: 1.5 | Authority: 1.5 | Alignment: 1",
    "years_running": "5 years",
    "notable_guests": "Brene Brown, Matthew Hussey, Jay Shetty",
    "host_social_following": "150k Instagram",
    "contact_email": "contact@podcastname.com",
    "tier": 1,
    "recommended_angle": "angle_1"
  }
]
    `.trim();

    const claudeResponse = await askClaudeWithTools(
      `Search for podcasts matching: "${text}". 
       Evaluate each podcast for quality using the scoring criteria. 
       Only return podcasts scoring 7 or above out of 10.
       Find contact emails for each podcast.
       Return top 5 results sorted by quality score.`,
      systemPrompt
    );

    let podcasts = [];
    try {
      const jsonMatch = claudeResponse.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        podcasts = JSON.parse(jsonMatch[0]);
      } else {
        // Log what Claude actually returned so we can debug
        console.error('No JSON array found in Claude response');
        console.error('Claude returned:', claudeResponse.slice(0, 500));
        await sendToSlack(
          response_url,
          `❌ Claude did not return expected format.\n\nClaude said:\n${claudeResponse.slice(0, 300)}`
        );
        return;
      }
    } catch (e) {
      console.error('JSON parse error:', e.message);
      console.error('Raw response:', claudeResponse.slice(0, 500));
      await sendToSlack(
        response_url,
        `❌ Error parsing results: ${e.message}`
      );
      return;
    }

    // Safety filter — only quality score 7+
    podcasts = podcasts.filter((p) => {
      const score = p.quality_score || 0;
      if (score < 7) {
        console.log(`Filtered out (score ${score}): ${p.title}`);
        return false;
      }
      console.log(`Passed filter (score ${score}): ${p.title}`);
      return true;
    });

    if (podcasts.length === 0) {
      await sendToSlack(
        response_url,
        `No high-quality podcasts found for *"${text}"*.\n\nTry broader keywords like:\n• \`/find_podcasts relationships\`\n• \`/find_podcasts personal development women\`\n• \`/find_podcasts dating advice\``
      );
      return;
    }

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
            `Found *${podcasts.length} quality podcasts* for Trevor.\n\n` +
            `*Quality Score Guide:*\n` +
            `🏆 9-10 — Elite show\n` +
            `⭐ 7-8 — Excellent fit\n\n` +
            `Click *✅ Approve* to generate a pitch or *❌ Reject* to dismiss.`,
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
      `✅ Results posted to ${channel} — ${podcasts.length} quality podcasts found!`
    );

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
      [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `❌ *${podcastData.title}* rejected by ${userName} and saved to database.`,
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

    await postToSlackChannel(
      channelId,
      [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `✅ *${podcastData.title}* approved by ${userName}!\n⏳ Generating Email 1...`,
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
              text: `❌ Could not generate pitch: ${error.message}`,
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
            text: `⏳ Generating Email ${emailNumber} for *${title}*...`,
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
              text: `❌ Could not generate Email ${emailNumber}: ${error.message}`,
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
});