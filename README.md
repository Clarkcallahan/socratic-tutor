# Reading Conversations

A small web app where students talk through an assigned reading with an AI Socratic tutor, in place of a reading quiz. The instructor reviews each conversation, an evidence-based report per student, and a class summary.

This is a first working version. Read "What has and has not been tested" before using it with a class.

## What it needs to run

| Need | Why | What to get |
|---|---|---|
| A place to run a small Node.js program | The tutor's AI key and the student conversations must live on a server, never in the browser. A WordPress page alone cannot do this. | Any host that runs Node.js 22.13 or newer (24 recommended) or a Docker container, with HTTPS. |
| A persistent disk (even 1 GB) | Conversations are stored in one database file (SQLite). On hosts with temporary storage the file is erased on every restart. | A "persistent disk" or "volume" on your host, with `DATA_DIR` pointed at it. A small VPS has this by default. |
| An AI service account | Produces the tutor's replies and drafts the reports. | An Anthropic API key from console.anthropic.com. Usage is billed by Anthropic per conversation; set a monthly spending limit in their console. |

There is no separate database server, no analytics, and no third-party scripts or fonts.

## Try it on your own computer (about five minutes)

1. Install Node.js 24 from nodejs.org.
2. In a terminal, inside this folder: `npm install`
3. Copy `.env.example` to `.env` and fill in:
   - `INSTRUCTOR_PASSWORD` (12+ characters)
   - `SESSION_SECRET` (the file shows a command that generates one)
   - Either `ANTHROPIC_API_KEY`, or set `AI_PROVIDER=mock` to click through the app with placeholder replies and no AI account.
4. `npm start`
5. Open http://localhost:3000/instructor, sign in, create a course, add a reading, and use "Preview as a student".

## Put it on your website

The app runs as its own small site, ideally on a subdomain of your website such as `tutor.yourdomain.com`. Your main site then links to it or embeds it.

1. **Choose a host** that meets the three needs above. Managed "app platform" hosts (you connect a GitHub repository and they run it) are the least work; a small VPS is the most control. A `Dockerfile` is included for hosts that prefer containers.
2. **Upload the code.** Usually: put this folder in a private GitHub repository and connect it to the host. Do not upload `.env`, `data/`, or `node_modules/` (the included `.gitignore` already excludes them).
3. **Set the environment variables** in the host's settings page (not in a file): everything in `.env.example`, with `NODE_ENV=production` and `DATA_DIR` set to the persistent disk's path.
4. **Start command:** `npm start`. Health check path, if asked: `/healthz`.
5. **Point a subdomain at it.** In your domain's DNS settings, add the record your host tells you to (usually a CNAME for `tutor`). The host should issue the HTTPS certificate.
6. **Link from your site.** In the instructor area, each reading has a student link. Add it to your course page as an ordinary link or button. This is the simplest and most reliable option.
7. **Or embed it.** Each reading also shows an iframe snippet. Paste it into a Custom HTML block on your page, and set `EMBED_ORIGINS` on the server to your site's address (for example `https://yourdomain.com https://www.yourdomain.com`). The instructor area can never be embedded.

Things only you can do: create the hosting and Anthropic accounts, choose the passwords, set DNS, and confirm with your institution that this use of student data fits its policies (see Privacy).

## How it is organized

Each part can be revised without touching the others.

| Part | Where | How to change it |
|---|---|---|
| Tutor instructions | `prompts/tutor.md` | Edit the file. Takes effect on the next message. |
| Opening question, reflection question, closing line | `prompts/fixed-messages.json` | Edit the file. |
| Teaching-voice guide | Stored per course | Instructor area, Course settings. |
| Reading content | Stored per reading | Instructor area: paste text or upload a PDF. |
| Student conversations | Database (`conversations`, `messages`) | Never edited; exported or deleted from the instructor area. |
| Report instructions | `prompts/report.md`, `prompts/class-summary.md` | Edit the files, then use "Rewrite report". |
| Reports | Database (`reports`, `class_summaries`), separate from conversations | Regenerated on request. |
| AI provider | `src/ai.js` | The only file that talks to the AI service. |

## How the conversation works

1. The student opens the reading's link, reads a plain notice about what is recorded, enters their name, and confirms.
2. The tutor opens with the fixed opening question, then asks one question at a time, guided by `prompts/tutor.md`, your voice guide, and the reading text.
3. After `MIN_STUDENT_TURNS` responses the student may press "Finish conversation" (the conversation also wraps up automatically at `MAX_STUDENT_TURNS`).
4. The app asks for a short final reflection, saves it, and closes the conversation.

PDF uploads are converted to text with `[Page N]` markers so the tutor can point to pages. Scanned PDFs (images of pages) contain no text and will not work until run through OCR; the upload warns you when this appears to be the case. Always skim the extracted text before saving.

## Reports

Reports are drafted only when you ask, by the same AI service. They describe what a student showed in the conversation and are not grades.

- Each finding carries a support label: well supported, some support, or limited evidence.
- Each finding quotes the student. The app checks every quote against the transcript and flags any that do not match word for word.
- The student's initial reaction is shown separately from comprehension.
- Main ideas that never came up are listed as untested, not as misunderstood.
- The class summary is built from the individual reports with names removed, gives approximate counts, and states its limits.
- Print any report from the browser (Print, then "Save as PDF" if you want a file), or download it as a text file.

AI-drafted reports can still be wrong. The transcript is always shown beneath the report so you can check.

## Privacy and security

- **Collected:** student name, messages, tutor replies, timestamps. Nothing else. No student accounts, no cookies for students, no analytics.
- **Sent to the AI service:** the reading text, your voice guide, and the conversation messages. Student names are not sent. Students are told not to put private information in messages. The student notice names Anthropic; if you change providers in `src/ai.js`, update the notice in `public/student.html`.
- **Student access:** starting a conversation creates a random private key kept in that student's browser. Only that browser and the instructor can see the conversation. Only a scrambled (hashed) copy of the key is stored on the server.
- **Instructor access:** password sign-in with an 8-hour, HTTP-only, signed cookie; sign-in attempts are rate-limited.
- **Secrets:** the API key, password, and signing secret are read from environment variables on the server and never sent to the browser.
- **Export:** per reading (JSON with everything, or CSV of transcripts) and "Export all data".
- **Delete:** a single conversation, all conversations for a reading, a reading, or a course. Deleting removes the transcripts and their reports from the database. Backups made by your host are outside the app's control.

Known limits of this first version:

- **Student identity is not verified.** A student types their name; anyone with the reading link could type any name. Share links only with your class. Adding campus sign-in would need your institution's IT office.
- **One instructor password**, no multiple instructor accounts.
- **A student who clears their browser data or switches devices** cannot reopen their conversation and would need to start a new one.
- **Institutional policy.** Student conversations are education records. Before using this with a class, check with your institution about approved services for student data and the data terms of your AI account.

## What has and has not been tested

Tested in mock mode (placeholder AI): instructor sign-in and rejection of wrong passwords and cross-site requests; creating courses and readings; PDF text extraction with page markers; the full student flow in a real browser at phone width, including refresh mid-conversation, finishing, and the final reflection; report and class summary pages; JSON and CSV export; deletion.

Not tested: a live call to the Anthropic API (no key was available while building), and deployment to any host. The first thing to do after adding your key is run one conversation yourself and read the tutor's replies and the report. If the AI call fails, the server log shows the reason; the most likely cause is a model name that needs updating in `ANTHROPIC_MODEL`.
