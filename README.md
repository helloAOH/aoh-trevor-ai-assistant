# Trevor AI Assistant — Internal Guide

## What This System Does

This is an AI-powered podcast outreach assistant for Trevor Hanson.
It finds podcasts, evaluates them, and drafts pitch emails for human review.

---

## What It Does NOT Do

- ❌ It does NOT send emails automatically
- ❌ It does NOT access Trevor's email account
- ❌ It does NOT post anything without human approval
- ❌ It does NOT take any action without a human clicking a button

---

## Slack Commands

### `/find_podcasts [keywords]`
Searches for podcasts matching your keywords.

**Examples:**
/asktrevorai What should I say in the subject line?
/asktrevorai How many podcasts should we pitch per week?
---

## The Approve / Reject Buttons

### ✅ Approve
- Saves approval to database
- Generates Email 1 draft immediately
- Shows button to generate Email 2 (Day 7 follow-up)
- Then Email 3 (Day 14 follow-up)
- **You still need to send the email manually from Trevor's email**

### ❌ Reject
- Saves rejection to database
- Claude will NOT suggest this podcast again
- Over time Claude learns what the team likes and dislikes

---

## Quality Score Guide

| Score | Label | What it means |
|---|---|---|
| 9-10 | 🏆 Elite | Major show, on Apple Charts, huge audience |
| 7-8 | ⭐ Excellent | Solid established show, strong fit |
| 6 | ✅ Good Fit | Decent show, worth considering |
| Below 6 | Never shown | Filtered out automatically |

**Score is calculated from:**
- Episode count (how established)
- Show longevity (how long running)
- Host social following
- Niche authority
- Audience alignment with Trevor
- Apple Charts bonus (if in top 50 today)

---

## How to Send the Emails

1. Copy the email draft from Slack
2. Open Trevor's email: trevor@theartofhealingbytrevor.com
3. Paste the email
4. Add the recipient's email address
5. Attach the Media Kit
6. Review and send

**Email sequence:**
- Email 1: Initial pitch (send immediately)
- Email 2: Follow-up (send 7 days later if no response)
- Email 3: Final follow-up (send 7 days after Email 2)

---

## Where Data Lives

| Data | Location |
|---|---|
| Approved/rejected podcasts | Postgres database on Railway |
| Generated pitch emails | Postgres database on Railway |
| Feedback and learning | Postgres database on Railway |
| API keys | Railway environment variables |
| Email templates | context.js file in GitHub |
| Trevor's targeting info | context.js file in GitHub |

---

## If Something Goes Wrong

Every error message will say:
❌ [what went wrong]
Screenshot this and send to your developer.
Just screenshot the error in Slack and send it to your developer.

---

## For Trevor — Future Possibilities

This same architecture can support:
- Sales call prep and follow-up workflows
- Content calendar and repurposing suggestions
- Funnel diagnostics and optimization
- Speaking engagement outreach
- Partnership and collaboration finder

The core is already built. New workflows = new slash commands.

---

## Tech Stack (For Reference)

| Component | What it is |
|---|---|
| Railway | Cloud server hosting |
| Node.js | Backend language |
| Claude API | AI brain |
| Slack | Control interface |
| ListenNotes API | Podcast discovery |
| Apple Charts RSS | Real-time ranking |
| Postgres | Memory database |