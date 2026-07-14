# Video Reviewer Platform

A platform where an **admin** creates video review tasks (YouTube link + feedback questions) and **users** open a shared link, fill in their details, watch the full video (no skipping!), and answer the questions. Every user and every answer is recorded on the admin side.

## Run it

```
npm start
```

Then open:

| Page | URL |
|---|---|
| Admin dashboard | http://localhost:4400/admin |
| User task link | http://localhost:4400/t/TASK_ID (shown in the dashboard after you create a task) |

**Default admin password:** `admin123`

To change the password or port, set environment variables before starting:

```
set ADMIN_PASSWORD=my-secret-password
set PORT=5000
npm start
```

## How it works

### Admin side (`/admin`)
1. Log in with the admin password.
2. Click **New Task** → enter the task title, YouTube link, and the instructions users must accept (you can edit them any time).
3. Press **Next** → build the questions Google-Forms style: short answer, paragraph, number, multiple choice, or checkboxes. Each question can be required or optional. Reorder with ↑/↓.
4. Save → you get a **share link** to send to users.
5. Open any task to see **all submissions**: name, email, county, country, status (started / watched video / completed), timestamps, and every answer. Export everything to **CSV** (opens in Excel).

### User side (`/t/TASK_ID`)
1. A popup asks for **Name, Email, County, Country** (all required) — recorded immediately, so you even see people who started but never finished.
2. The user reads and **accepts the instructions**.
3. The YouTube video plays inside the site with a **locked player**: no YouTube controls, no seeking, no keyboard shortcuts, no clicking through to YouTube. Only play/pause. Switching tabs pauses the video. A watchdog snaps playback back if any seek is attempted.
4. When the video **ends**, the feedback questions unlock.
5. Submitting the answers shows the **thank-you page**. The browser remembers completion, so refreshing doesn't create duplicate submissions.

## Data

Everything is stored in `data.sqlite` in this folder (created automatically). Back up that one file to back up all tasks and submissions.

## Sharing links with real users

`localhost` links only work on your own computer. To collect responses from other people, host this app on a server (any Node.js host works — Render, Railway, a VPS…) and share `https://your-domain/t/TASK_ID` instead. Set a strong `ADMIN_PASSWORD` before going public.
