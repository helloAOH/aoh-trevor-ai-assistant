// database.js
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function initializeDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS podcast_decisions (
        id SERIAL PRIMARY KEY,
        podcast_title TEXT NOT NULL,
        podcast_website TEXT,
        podcast_description TEXT,
        podcast_audience TEXT,
        listen_score INTEGER,
        decision TEXT NOT NULL,
        decided_by TEXT,
        keywords_searched TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS pitch_history (
        id SERIAL PRIMARY KEY,
        podcast_title TEXT NOT NULL,
        email_number INTEGER NOT NULL,
        email_content TEXT NOT NULL,
        edited_content TEXT,
        was_edited BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS feedback_log (
        id SERIAL PRIMARY KEY,
        action TEXT NOT NULL,
        podcast_title TEXT,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    console.log('Database tables ready');
  } catch (err) {
    console.error('Database init error:', err.message);
  } finally {
    client.release();
  }
}

async function savePodcastDecision(data) {
  const {
    podcastTitle,
    podcastWebsite,
    podcastDescription,
    podcastAudience,
    listenScore,
    decision,
    decidedBy,
    keywordsSearched,
  } = data;

  const scoreAsInt = parseInt(listenScore, 10) || 0;

  await pool.query(
    `INSERT INTO podcast_decisions
     (podcast_title, podcast_website, podcast_description, podcast_audience,
      listen_score, decision, decided_by, keywords_searched)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      podcastTitle,
      podcastWebsite,
      podcastDescription,
      podcastAudience,
      scoreAsInt,
      decision,
      decidedBy,
      keywordsSearched,
    ]
  );
}

async function savePitchEmail(podcastTitle, emailNumber, emailContent) {
  const result = await pool.query(
    `INSERT INTO pitch_history
     (podcast_title, email_number, email_content)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [podcastTitle, emailNumber, emailContent]
  );
  return result.rows[0].id;
}

async function getPastDecisions(limit = 20) {
  const result = await pool.query(
    `SELECT podcast_title, decision, podcast_audience, keywords_searched, created_at
     FROM podcast_decisions
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

async function getRejectedPodcasts() {
  const result = await pool.query(
    `SELECT podcast_title FROM podcast_decisions WHERE decision = 'rejected'`
  );
  return result.rows.map((r) => r.podcast_title);
}

async function getApprovedPodcasts() {
  const result = await pool.query(
    `SELECT podcast_title, podcast_website
     FROM podcast_decisions
     WHERE decision = 'approved'`
  );
  return result.rows;
}

module.exports = {
  initializeDatabase,
  savePodcastDecision,
  savePitchEmail,
  getPastDecisions,
  getRejectedPodcasts,
  getApprovedPodcasts,
};