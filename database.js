// database.js
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
});

// ── CREATE ALL TABLES ────────────────────────────────────
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
      CREATE TABLE IF NOT EXISTS podcast_feedback (
        id SERIAL PRIMARY KEY,
        podcast_title TEXT,
        podcast_website TEXT,
        podcast_audience TEXT,
        decision TEXT NOT NULL,
        quality_score INTEGER,
        keywords_searched TEXT,
        rejection_reason TEXT,
        approval_notes TEXT,
        decided_by TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS general_feedback (
        id SERIAL PRIMARY KEY,
        feedback_text TEXT NOT NULL,
        submitted_by TEXT,
        category TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS system_preferences (
        id SERIAL PRIMARY KEY,
        preference_key TEXT UNIQUE NOT NULL,
        preference_value TEXT NOT NULL,
        updated_by TEXT,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    console.log('Database tables ready');
  } catch (err) {
    console.error('Database init error:', err.message);
  } finally {
    client.release();
  }
}

// ── SAVE PODCAST DECISION ────────────────────────────────
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

// ── SAVE DETAILED FEEDBACK ───────────────────────────────
async function saveFeedback(data) {
  const {
    podcastTitle,
    podcastWebsite,
    podcastAudience,
    decision,
    qualityScore,
    keywordsSearched,
    rejectionReason,
    approvalNotes,
    decidedBy,
  } = data;

  await pool.query(
    `INSERT INTO podcast_feedback
     (podcast_title, podcast_website, podcast_audience, decision,
      quality_score, keywords_searched, rejection_reason, approval_notes, decided_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      podcastTitle,
      podcastWebsite,
      podcastAudience,
      decision,
      qualityScore || 0,
      keywordsSearched || '',
      rejectionReason || null,
      approvalNotes || null,
      decidedBy,
    ]
  );
}

// ── SAVE GENERAL FEEDBACK ────────────────────────────────
async function saveGeneralFeedback(feedbackText, submittedBy, category) {
  await pool.query(
    `INSERT INTO general_feedback
     (feedback_text, submitted_by, category)
     VALUES ($1, $2, $3)`,
    [feedbackText, submittedBy, category || 'general']
  );
}

// ── SAVE PITCH EMAIL ─────────────────────────────────────
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

// ── GET PAST DECISIONS FOR CLAUDE ────────────────────────
async function getPastDecisions(limit = 20) {
  const result = await pool.query(
    `SELECT podcast_title, decision, podcast_audience,
            keywords_searched, created_at
     FROM podcast_decisions
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

// ── GET DETAILED FEEDBACK FOR CLAUDE ────────────────────
async function getFeedbackSummary(limit = 15) {
  const result = await pool.query(
    `SELECT podcast_title, decision, podcast_audience,
            quality_score, rejection_reason, approval_notes,
            keywords_searched, created_at
     FROM podcast_feedback
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

// ── GET GENERAL FEEDBACK FOR CLAUDE ─────────────────────
async function getGeneralFeedback(limit = 10) {
  const result = await pool.query(
    `SELECT feedback_text, submitted_by, category, created_at
     FROM general_feedback
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

// ── GET REJECTION REASON STATS ───────────────────────────
async function getRejectionStats() {
  const result = await pool.query(`
    SELECT rejection_reason, COUNT(*) as count
    FROM podcast_feedback
    WHERE decision = 'rejected'
      AND rejection_reason IS NOT NULL
    GROUP BY rejection_reason
    ORDER BY count DESC
  `);
  return result.rows;
}

// ── GET REJECTED PODCASTS ────────────────────────────────
async function getRejectedPodcasts() {
  const result = await pool.query(
    `SELECT podcast_title
     FROM podcast_decisions
     WHERE decision = 'rejected'`
  );
  return result.rows.map((r) => r.podcast_title);
}

// ── GET APPROVED PODCASTS ────────────────────────────────
async function getApprovedPodcasts() {
  const result = await pool.query(
    `SELECT podcast_title, podcast_website
     FROM podcast_decisions
     WHERE decision = 'approved'`
  );
  return result.rows;
}

// ── GET FULL STATS ───────────────────────────────────────
async function getStats() {
  const decisionsResult = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE decision = 'approved') as total_approved,
      COUNT(*) FILTER (WHERE decision = 'rejected') as total_rejected,
      COUNT(*) as total_reviewed
    FROM podcast_decisions
  `);

  const emailsResult = await pool.query(`
    SELECT COUNT(*) as total_emails
    FROM pitch_history
  `);

  const rejectionResult = await pool.query(`
    SELECT rejection_reason, COUNT(*) as count
    FROM podcast_feedback
    WHERE decision = 'rejected'
      AND rejection_reason IS NOT NULL
    GROUP BY rejection_reason
    ORDER BY count DESC
    LIMIT 5
  `);

  const feedbackResult = await pool.query(`
    SELECT COUNT(*) as total_feedback
    FROM general_feedback
  `);

  return {
    ...decisionsResult.rows[0],
    total_emails: emailsResult.rows[0].total_emails,
    total_feedback: feedbackResult.rows[0].total_feedback,
    top_rejection_reasons: rejectionResult.rows,
  };
}

module.exports = {
  initializeDatabase,
  savePodcastDecision,
  saveFeedback,
  saveGeneralFeedback,
  savePitchEmail,
  getPastDecisions,
  getFeedbackSummary,
  getGeneralFeedback,
  getRejectionStats,
  getRejectedPodcasts,
  getApprovedPodcasts,
  getStats,
};