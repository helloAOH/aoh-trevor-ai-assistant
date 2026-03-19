// context.js
// This file is the brain behind Trevor's podcast targeting
// Claude reads this every time it searches for podcasts

const TREVOR_CONTEXT = {

  // ── WHO TREVOR IS ─────────────────────────────────────
  bio: `
    Trevor Hanson is a therapist and coach who helps people heal anxious 
    attachment and build real self-trust. 
    
    His story: He spent years trying to prove he was enough through his career 
    and relationships, including landing a big corporate role at Tesla. 
    Everything fell apart at once — he was laid off, broke his jaw in a skiing 
    accident, and broke off a majorly toxic engagement after realizing he had 
    completely lost himself. That season pushed him into therapy and completely 
    changed the direction of his life and work.
    
    Now through The Art of Healing, he helps people learn to feel safe, worthy, 
    and secure in their relationships and within themselves.
    
    Audience reached: 800k+
    IG: @theartofhealingbytrevor — 551k followers
    TikTok: @theartofhealingbytrevor — 248k followers
    Email: trevor@theartofhealingbytrevor.com
  `,

  // ── CORE TOPICS TREVOR SPEAKS ABOUT ──────────────────
  topics: [
    'Anxious attachment and how to heal it',
    'Why high-achieving women keep choosing the wrong relationships',
    'Breaking people-pleasing patterns in relationships',
    'Self-abandonment and how to stop it',
    'Building self-trust and self-worth',
    'Faith-based healing and relationships',
    'Choosing partners from clarity instead of fear',
    'Why successful women still struggle in love',
    'Healing attachment wounds',
    'Breaking toxic relationship patterns',
  ],

  // ── APPROVED PITCH ANGLES ─────────────────────────────
  // Claude picks the best angle based on the podcast audience
  pitchAngles: [
    {
      id: 'angle_1',
      topic: 'Why high-achieving women keep choosing the wrong relationships (even when they know better)',
      bestFor: 'Personal development, entrepreneurship, success-focused podcasts',
    },
    {
      id: 'angle_2',
      topic: 'Breaking anxious attachment patterns in faith and love',
      bestFor: 'Christian podcasts, faith-based relationship shows',
    },
    {
      id: 'angle_3',
      topic: 'Why successful women self-abandon in relationships',
      bestFor: 'Women empowerment, self-worth, confidence podcasts',
    },
    {
      id: 'angle_4',
      topic: 'Healing attachment wounds through self-trust',
      bestFor: 'Mental health, therapy, psychology podcasts',
    },
    {
      id: 'angle_5',
      topic: 'From people-pleasing to self-trust in relationships',
      bestFor: 'Dating, relationships, self-improvement podcasts',
    },
  ],

  // ── PODCAST TIERS ─────────────────────────────────────
  // Priority order for finding new podcasts
  tiers: [
    {
      tier: 1,
      name: 'Relationships & Dating',
      description: 'Podcasts focused on relationships, dating, attachment, love',
      examples: [
        'Sabrina Zohar Show',
        'Love Life with Matthew Hussey',
        'Thais Gibson Podcast',
        'Jayson Gaddis Relationship School',
        'Language of Love with Dr Laura Berman',
        'Stan Tatkin',
        'Dr Nicole LaPera',
      ],
      listenScoreMin: 60,
    },
    {
      tier: 2,
      name: 'Personal Development',
      description: 'Self-improvement, mindset, success, entrepreneurship',
      examples: [
        'Jay Shetty',
        'Mel Robbins',
        'Lewis Howes',
        'Ed Mylett',
        'Brene Brown Unlocking Us',
      ],
      listenScoreMin: 70,
    },
    {
      tier: 3,
      name: 'Christian Women & Faith',
      description: 'Faith-based podcasts targeting Christian women',
      examples: [
        'We Can Do Hard Things',
        'The Real Life Podcast',
        'ONE Extraordinary Marriage',
      ],
      listenScoreMin: 50,
    },
    {
      tier: 4,
      name: "Women's Lifestyle & Wellness",
      description: 'General lifestyle, wellness, and women-focused shows',
      examples: [
        'Girls Gotta Eat',
        'What Fresh Hell',
        'Katie Wells Wellness Mama',
      ],
      listenScoreMin: 55,
    },
  ],

  // ── PODCASTS ALREADY IN PIPELINE ─────────────────────
  // Claude will NOT suggest these — already being worked
  alreadyPitched: [
    // Re-pitched / In Progress
    'Reimagining Love with Dr Alexandra Solomon',
    'U Up',
    'Couples Therapy',
    'Modern Love',
    'Dear Shandy',
    'Love Life with Matthew Hussey',
    "Let's be Honest with Kristin Cavallari",
    'We Met At Acme',
    'We Can Do Hard Things',
    'The Real Life Podcast',
    'Nick and Amy with The Ultimate Intimacy App',
    'Delight Your Marriage',
    "Why Won't You Date Me",
    'The Sabrina Zohar Show',
    'Dateable',
    'Thais Gibson',
    'Jayson Gaddis Relationship School Podcast',
    "Let's Get Vulnerable",
    'Language of Love with Dr Laura Berman',
    'ONE Extraordinary Marriage Show',
    'Girls Gotta Eat',
    // Line-up / Not Yet Pitched
    'The Psychology of Relationships',
    'Sex with Emily',
    'Brooke and Connor Make A Podcast',
    'Relationships Made Easy',
    'The Girls Bathroom',
    'Dr Nicole LaPera',
    'Stan Tatkin',
    'Julie Menanno',
    'Sunflower Club with James McCrae',
    // Booked
    'Dating Intentionally',
    'Get Your Marriage On',
    // Recorded
    'Relationship Advice Thrive Therapy',
    'Seeing Other People',
    'Terri Cole',
    // Not Booked For Follow Up
    'Denaye Barahona Simple Families',
    'Kate Anthony The Divorce Survival Guide',
    'Katie Wells Wellness Mama',
    // Aired
    'What Fresh Hell',
    // Dream 100
    'Jay Shetty',
    'Mel Robbins',
    'Lewis Howes',
    'Ed Mylett',
    'Freemans',
    'Abi Stumvoll',
    'Morgan Pearson',
    'Lori Harder',
    'Jillian Turecki Jillian on Love',
    'Lisa Bilyeu',
    'Matthew Hussey Love Life',
    'Glennon Doyle We Can Do Hard Things',
    'Unlocking Us with Brene Brown',
    'Sabrina Zohar',
  ],

  // ── PITCH EMAIL TEMPLATES ─────────────────────────────
  // Claude fills in ONLY the marked sections
  // Everything else stays exactly as written
  pitchTemplates: {

    email1: `Hi [HOST_NAME],

I love your podcast & what you do. The way you support your listeners in [SPECIFIC_TO_PODCAST] feels deeply aligned with my work, so I wanted to introduce myself to see if we can collaborate together.

I'm a therapist and coach who helps people heal anxious attachment and build real self-trust. Before I did this work, I was living it. I spent years trying to prove I was enough through my career and relationships, including landing a big corporate role at Tesla. But everything fell apart all at once. I was laid off, broke my jaw in a skiing accident, and broke off a majorly toxic engagement after I realized I had completely lost myself. That season pushed me into therapy and completely changed the direction of my life and my work.

Now, through The Art of Healing, I help people learn to feel safe, worthy, and secure in their relationships and within themselves. My work has reached over 800k people just like your audience, who are seeking to transform themselves and their relationships beyond surface-level advice.

IG: @theartofhealingbytrevor - 551k followers
TikTok @theartofhealingbytrevor - 248k followers

Check out some of the Podcasts I've done with Danica Patrick, Adam Lane Smith, Robin Ducharme, Jimmy Knowles & More
Reel | Pretty Intense with Danica Patrick
Reel | What Fresh Hell Podcast
Reel | Ready Love Ready w/ Robin Ducharme
Reel | Mantalks w/ Connor Beaton
Media Kit Attached

My Podcast Guest Assets

I'd love to come on your podcast to share practical tools your listeners can use to break anxious attachment patterns, stop self-abandoning, and choose partners from a place of clarity and self-trust instead of people pleasing (hot topic right now). I really appreciate the thoughtful, honest conversations you're creating, and I'd be stoked and honored to contribute to that in a future episode.

Warmly,
Trevor`,

    email2: `Hey [HOST_NAME],

Quick follow-up because I had a thought I think your audience would really resonate with:

[EPISODE_TOPIC_ANGLE]

This is something I see constantly, especially with entrepreneurs and creatives. They've done the mindset work, they're successful in business, but in relationships they still:
over-give
people-please
ignore red flags
and end up in the same patterns

Not because they lack awareness, but because fear of abandonment is still driving their behavior underneath it.

This is exactly what I went through myself. On paper, I was successful (corporate role at Tesla), but in relationships I was anxious, over-investing, and ultimately ended up in a toxic engagement where I completely lost myself. That breakdown is what led me into therapy and eventually into this work.

Since then, I've worked with thousands of clients and grown an audience of 800k+ around helping people break these patterns in real time, not just understand them.

Here's a few links to some podcasts I've been on recently:
Pretty Intense with Danica Patrick
I Wish You Knew Podcast with Adam Lane Smith
Reel | Pretty Intense with Danica Patrick
Reel | What Fresh Hell Podcast

I'm confident this topic would land really well with your audience. If you're open, I'd love to make this a powerful episode for your listeners.

– Trevor
IG @theartofhealingbytrevor - 551k followers
TikTok @theartofhealingbytrevor - 248k followers
Some of the Podcasts I've recently recorded done with Danica Patrick, Adam Lane Smith, Robin Ducharme, Jimmy Knowles & More
Podcast Guest Assets`,

    email3: `Hey [HOST_NAME],

I know things move fast, so I wanted to send one last note before I close the loop.

I'll keep it simple. I genuinely think a conversation around:

"[EPISODE_TOPIC_ANGLE]"

would be a standout episode for your audience.

This is the intersection I specialize in — where high performance meets self-abandonment in relationships — and it's often the missing piece for women who are doing everything right in business but still feel stuck in their personal lives.

This message has resonated with:
800k+ across my audience
thousands of coaching clients
and recent podcast audiences where these topics have performed especially well

If now's not the right time, no worries at all. I appreciate you taking a look.

And if this does feel aligned down the line, I'd love to reconnect and create something meaningful for your listeners.

– Trevor
IG @theartofhealingbytrevor - 551k followers
TikTok @theartofhealingbytrevor - 248k followers
Some of the Podcasts I've recently recorded done with Danica Patrick, Adam Lane Smith, Robin Ducharme, Jimmy Knowles & More
Podcast Guest Assets`,
  },
};

module.exports = TREVOR_CONTEXT;