require('dotenv').config();

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const crypto = require('crypto');

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

  if (Math.abs(currentTime - slackTimestamp) > 300) {
    return false;
  }

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
// This is the function Claude will call when it needs podcast data
async function search_podcasts({ keywords, max_results = 5 }) {
  console.log(`Searching podcasts for: ${keywords}`);

  const response = await axios.get('https://listen-api.listennotes.com/api/v2/search', {
    headers: {
      'X-ListenAPI-Key': process.env.LISTENNOTES_API_KEY,
    },
    params: {
      q: keywords,
      type: 'podcast',
      per_page: max_results,
      language: 'English',
    },
  });

  // Pull out only what we need from the API response
  const podcasts = response.data.results.map((podcast) => ({
    title: podcast.title_original,
    description: podcast.description_original?.slice(0, 300) + '...',
    website: podcast.website || 'N/A',
    total_episodes: podcast.total_episodes,
    recent_episodes: podcast.episodes?.slice(0, 3).map((ep) => ({
      title: ep.title_original,
      date: new Date(ep.pub_date_ms).toLocaleDateString(),
    })) || [],
    listennotes_url: `https://www.listennotes.com/podcasts/${podcast.id}`,
    audience_score: podcast.listen_score || 'N/A',
    genre: podcast.genre_ids || [],
  }));

  return { podcasts };
}

// ── TOOL DEFINITIONS FOR CLAUDE ─────────────────────────
// This tells Claude what tools exist and how to use them
const tools = [
  {
    name: 'search_podcasts',
    description:
      'Search for podcasts using the ListenNotes API. ' +
      'Use this to find podcasts that match specific topics, audiences, or keywords. ' +
      'Returns podcast details including title, description, website, and recent episodes.',
    input_schema: {
      type: 'object',
      properties: {
        keywords: {
          type: 'string',
          description:
            'Search keywords. Example: "Christian women faith relationships"',
        },
        max_results: {
          type: 'number',
          description: 'How many podcasts to return. Default is 5. Maximum 10.',
        },
      },
      required: ['keywords'],
    },
  },
];

// ── CLAUDE WITH TOOL CALLING ─────────────────────────────
// This is the upgraded askClaude that can use tools
async function askClaudeWithTools(userMessage, systemPrompt) {
  const client = new Anthropic.Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const messages = [{ role: 'user', content: userMessage }];

  // Step 1: Send message to Claude with tools available
  let response = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 4096,
    system: systemPrompt,
    tools: tools,
    messages: messages,
  });

  // Step 2: Keep looping while Claude wants to use tools
  // Claude may call tools multiple times before giving final answer
  while (response.stop_reason === 'tool_use') {
    const toolUseBlock = response.content.find((block) => block.type === 'tool_use');

    if (!toolUseBlock) break;

    console.log(`Claude is calling tool: ${toolUseBlock.name}`);
    console.log(`With inputs:`, toolUseBlock.input);

    // Step 3: Actually run the tool Claude requested
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

    console.log(`Tool returned ${toolResult.podcasts?.length || 0} results`);

    // Step 4: Send tool results back to Claude so it can continue
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

    // Step 5: Ask Claude to continue with the tool results
    response = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 4096,
      system: systemPrompt,
      tools: tools,
      messages: messages,
    });
  }

  // Step 6: Extract Claude's final text response
  const textBlock = response.content.find((block) => block.type === 'text');
  return textBlock ? textBlock.text : 'No response generated';
}

// ── ORIGINAL ASK CLAUDE (kept for /asktrevorai command) ──
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

// ── FORMAT PODCAST RESULTS FOR SLACK ────────────────────
// Makes the Slack message look clean and readable
function formatPodcastResults(claudeResponse) {
  return (
    `*🎙️ Podcast Research Results*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    claudeResponse
  );
}

// ── SEND RESPONSE BACK TO SLACK ─────────────────────────
async function sendToSlack(responseUrl, text) {
  await axios.post(responseUrl, {
    response_type: 'in_channel',
    text: text,
  });
}

// ── ROUTES ──────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Trevor AI Assistant is running' });
});

// Original /asktrevorai command — unchanged
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

  res.json({
    response_type: 'ephemeral',
    text: '⏳ Thinking...',
  });

  try {
    console.log(`${user_name} asked: ${text}`);
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

// NEW: /find_podcasts command
app.post('/slack/find_podcasts', async (req, res) => {
  if (!verifySlackRequest(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { text, user_name, response_url } = req.body;

  // Validate input
  if (!text || text.trim() === '') {
    return res.json({
      response_type: 'ephemeral',
      text: 'Please include keywords. Example: `/find_podcasts Christian women faith relationships`',
    });
  }

  // Immediately acknowledge Slack
  res.json({
    response_type: 'ephemeral',
    text: `🔍 Searching for podcasts matching *"${text}"*...\nThis may take 15-20 seconds.`,
  });

  // System prompt tells Claude exactly what we want
  const systemPrompt = `
You are Trevor's podcast outreach assistant. 
Trevor Crane is an author and speaker who helps Christian women with 
faith, relationships, attachment, and personal growth.

Your job is to find podcasts that would be a great fit for Trevor as a guest.

When analyzing podcasts, evaluate:
1. Audience alignment (Christian women, faith, relationships, personal growth)
2. Content relevance to Trevor's message
3. Recent episode topics as evidence of fit

For each podcast format your response EXACTLY like this:

*[Number]. [Podcast Name]*
🎯 *Fit Score:* [High/Medium/Low]
👥 *Audience:* [describe their audience]
💡 *Why Trevor fits:* [2-3 sentences]
🎙️ *Recent Episodes:*
  • [episode title]
  • [episode title]
🌐 *Website:* [website]
📊 *Listener Score:* [score]/100

---

After listing all podcasts, add a section:
*📋 Recommended Next Steps:*
List the top 2-3 podcasts to prioritize and why.
`.trim();

  try {
    console.log(`${user_name} searching podcasts: ${text}`);

    const claudeResponse = await askClaudeWithTools(
      `Find podcasts matching these keywords: "${text}". 
       Search for relevant podcasts and analyze each one for fit with Trevor's audience.
       Return the top 5 results.`,
      systemPrompt
    );

    const formattedResponse = formatPodcastResults(claudeResponse);
    await sendToSlack(response_url, formattedResponse);

    console.log('Podcast results sent successfully');
  } catch (error) {
    console.error('Error:', error.message);
    await sendToSlack(
      response_url,
      `❌ Search failed: ${error.message}\n\nMake sure LISTENNOTES_API_KEY is set in Railway.`
    );
  }
});

// ── START ────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});