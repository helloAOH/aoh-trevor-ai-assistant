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

// ── CALL CLAUDE API ─────────────────────────────────────
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
    messages: [
      {
        role: 'user',
        content: userMessage,
      },
    ],
  });

  return response.content[0].text;
}

// ── SEND RESPONSE BACK TO SLACK ─────────────────────────
async function sendToSlack(responseUrl, text) {
  await axios.post(responseUrl, {
    response_type: 'in_channel',
    text: text,
  });
}

// ── ROUTES ──────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Trevor AI Assistant is running' });
});

app.post('/slack/ask', async (req, res) => {

  if (!verifySlackRequest(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { text, user_name, response_url } = req.body;

  if (!text || text.trim() === '') {
    return res.json({
      response_type: 'ephemeral',
      text: 'Please type a question after /ask',
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

// ── START ────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});