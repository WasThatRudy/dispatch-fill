# Dispatch Fill

One click fills the job application form you're looking at: your contact details,
resume upload, AI answers for custom questions (dropdowns, multi-selects, radio
groups, essay boxes), and an AI-written cover-letter PDF where the form wants one.
It never submits: AI-filled fields get an amber outline for review, the toast shows
per-question progress, and a review button appears at the end.

Works on: Greenhouse, Lever, Ashby, Rippling, Kula, Google Forms (including
Drive-picker uploads), and Workday-style multi-step wizards (auto-advances through
steps, always stops before the final submit).

Two parts:
- **`extension/`** — Chrome/Arc MV3 extension. All page-widget detection and filling.
- **`server/`** — a small local Node server (`localhost:4310`) holding your profile
  and resume, and generating answers/cover letters via the Claude Code CLI. Your
  personal data never leaves your machine except into the form you're filling.

## Setup

1. **Prereqs**: Node 18+, [Claude Code](https://claude.com/claude-code) CLI logged in
   (`claude` on PATH), Chrome or Arc.
2. **Profile**: `cp templates/profile.template.json local/profile.json` and fill it in.
   The `resumeSummary` is what grounds every AI answer — make it specific and true.
   Drop your resume at `local/resume.pdf`.
3. **Server**: `cd server && npm install && npm start`
4. **Extension**: `chrome://extensions` → Developer mode → Load unpacked → select
   `extension/`. Pin "Dispatch Fill".
5. Open any job application form, click the toolbar icon, review, submit yourself.

## Honesty by design

Answers are grounded in your `profile.json` and nothing else: unknown facts stay
blank instead of being invented, disqualifying questions (visa, location) get
answered truthfully, and option values are copied exactly from the form's own
choices. You're putting your name on these applications; the tool doesn't lie
for you.

## Relationship to Dispatch

This is the form-filling half of a larger personal job-hunt pipeline (job
discovery, scoring, message drafting, batch cold email, response tracking).
The extension in both repos is identical; the full pipeline's server additionally
matches pages to pre-drafted per-job messages. This standalone server answers from
the live page's own text instead, so cover letters and "why us" answers stay
job-specific either way.
