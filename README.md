# Motivation Automation

This project sends a daily email with:

- a motivational phrase
- one health suggestion for the day
- a gratitude phrase

Before generating the next email, it looks at the last 7 entries in [`data/history.json`](./data/history.json) and asks the model to avoid repeats. After a successful send, it appends the new entry to the same file.

## Stack

- Node.js 24
- OpenRouter model: `google/gemini-2.0-flash-lite-001`
- Gmail API with OAuth refresh token
- GitHub Actions for the daily schedule

## Environment variables

Copy `.env.example` to `.env` locally and fill in:

- `OPENROUTER_API_KEY`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REFRESH_TOKEN`
- `EMAIL_FROM`
- `EMAIL_TO`

`EMAIL_TO` accepts either a single email or multiple recipients separated by commas, semicolons, or new lines.

## Local usage

Run a syntax check:

```bash
node --check src/index.js
```

Run the automation locally:

```bash
node src/index.js
```

Dry run without sending email:

```bash
DRY_RUN=true node src/index.js
```

## GitHub Actions

The workflow lives at `.github/workflows/daily-email.yml`.

- Scheduled cron: `0 12 * * *`
- That corresponds to 9:00 AM in Sao Paulo on March 20, 2026
- It also supports manual runs via `workflow_dispatch`

The workflow writes the updated `data/history.json` back to the repository after each successful run so future generations can check the last 7 entries.

## Required GitHub secrets

Add these repository secrets:

- `OPENROUTER_API_KEY`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REFRESH_TOKEN`
- `EMAIL_FROM`
- `EMAIL_TO`
