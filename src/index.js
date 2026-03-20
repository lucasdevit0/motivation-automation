import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const envFilePath = path.join(rootDir, ".env");
const historyFilePath = path.join(rootDir, "data", "history.json");
const recentHistoryLimit = 7;
const modelName = "google/gemini-2.0-flash-lite-001";

loadEnvFile();

async function main() {
  const config = getConfig();
  const history = await readHistory(historyFilePath);
  const recentEntries = history.slice(-recentHistoryLimit);
  const entry = await generateUniqueEntry(config.openRouterApiKey, recentEntries);

  if (config.dryRun) {
    console.log("DRY_RUN enabled. Generated entry:");
    console.log(JSON.stringify(entry, null, 2));
    return;
  }

  await sendEmail({
    ...config,
    entry,
  });

  const historyEntry = {
    sentAt: new Date().toISOString(),
    model: modelName,
    recipients: config.recipients,
    ...entry,
  };

  history.push(historyEntry);
  await writeHistory(historyFilePath, history);
  console.log(`Email sent to ${config.recipients.join(", ")} and history updated.`);
}

function loadEnvFile() {
  try {
    const fileContents = requireTextFile(envFilePath);
    const lines = fileContents.split(/\r?\n/u);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex === -1) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      const rawValue = trimmed.slice(separatorIndex + 1).trim();
      const unquotedValue = rawValue.replace(/^(['"])(.*)\1$/u, "$2");

      if (!(key in process.env)) {
        process.env[key] = unquotedValue;
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

function getConfig() {
  const openRouterApiKey = getRequiredEnv("OPENROUTER_API_KEY");
  const googleClientId = getRequiredEnv("GOOGLE_CLIENT_ID");
  const googleClientSecret = getRequiredEnv("GOOGLE_CLIENT_SECRET");
  const googleRefreshToken = getRequiredEnv("GOOGLE_REFRESH_TOKEN");
  const emailFrom = getRequiredEnv("EMAIL_FROM");
  const recipients = parseRecipients(getRequiredEnv("EMAIL_TO"));
  const dryRun = process.env.DRY_RUN === "true";

  return {
    openRouterApiKey,
    googleClientId,
    googleClientSecret,
    googleRefreshToken,
    emailFrom,
    recipients,
    dryRun,
  };
}

function getRequiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseRecipients(value) {
  const recipients = value
    .split(/[,\n;]+/u)
    .map((recipient) => recipient.trim())
    .filter(Boolean);

  if (recipients.length === 0) {
    throw new Error("EMAIL_TO must contain at least one email address.");
  }

  return [...new Set(recipients)];
}

async function readHistory(filePath) {
  try {
    const fileContents = await readFile(filePath, "utf8");
    const parsed = JSON.parse(fileContents);
    if (!Array.isArray(parsed)) {
      throw new Error("History file must contain a JSON array.");
    }
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function writeHistory(filePath, history) {
  await writeFile(filePath, `${JSON.stringify(history, null, 2)}\n`, "utf8");
}

async function generateUniqueEntry(openRouterApiKey, recentEntries) {
  const recentSummary = recentEntries.map((entry, index) => ({
    number: index + 1,
    motivationalPhrase: entry.motivationalPhrase,
    healthSuggestion: entry.healthSuggestion,
    gratitudePhrase: entry.gratitudePhrase,
  }));

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const generated = await generateEntry(openRouterApiKey, recentSummary, attempt);
    if (!isRecentDuplicate(generated, recentEntries)) {
      return generated;
    }
  }

  throw new Error("Unable to generate a non-repetitive entry after multiple attempts.");
}

async function generateEntry(openRouterApiKey, recentSummary, attempt) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openRouterApiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com",
      "X-Title": "motivation-automation",
    },
    body: JSON.stringify({
      model: modelName,
      temperature: 0.9,
      messages: [
        {
          role: "system",
          content:
            "You write warm, concise daily wellbeing emails. Return valid JSON only with keys motivationalPhrase, healthSuggestion, gratitudePhrase. Each value must be one sentence, practical, original, and under 28 words.",
        },
        {
          role: "user",
          content: [
            "Create three original lines for today's email:",
            "1. A motivational phrase.",
            "2. One concrete thing we can do today to improve our health.",
            "3. A gratitude phrase.",
            "",
            `This is generation attempt ${attempt}.`,
            "Avoid repeating or closely paraphrasing any item from the last seven generations below.",
            JSON.stringify(recentSummary, null, 2),
            "",
            "Return JSON only in this exact shape:",
            JSON.stringify(
              {
                motivationalPhrase: "",
                healthSuggestion: "",
                gratitudePhrase: "",
              },
              null,
              2,
            ),
          ].join("\n"),
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter request failed (${response.status}): ${errorText}`);
  }

  const payload = await response.json();
  const message = payload.choices?.[0]?.message?.content;

  if (typeof message !== "string") {
    throw new Error("OpenRouter response did not include message content.");
  }

  const parsed = extractJsonObject(message);
  return validateGeneratedEntry(parsed);
}

function extractJsonObject(content) {
  const match = content.match(/\{[\s\S]*\}/u);
  if (!match) {
    throw new Error("Model response did not contain a JSON object.");
  }

  return JSON.parse(match[0]);
}

function validateGeneratedEntry(value) {
  if (!value || typeof value !== "object") {
    throw new Error("Generated entry must be a JSON object.");
  }

  const requiredKeys = [
    "motivationalPhrase",
    "healthSuggestion",
    "gratitudePhrase",
  ];

  for (const key of requiredKeys) {
    if (typeof value[key] !== "string" || !value[key].trim()) {
      throw new Error(`Generated entry is missing a valid "${key}" field.`);
    }
  }

  return {
    motivationalPhrase: value.motivationalPhrase.trim(),
    healthSuggestion: value.healthSuggestion.trim(),
    gratitudePhrase: value.gratitudePhrase.trim(),
  };
}

function isRecentDuplicate(entry, recentEntries) {
  const normalize = (value) =>
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, "")
      .replace(/\s+/gu, " ")
      .trim();

  const recentMotivational = new Set(
    recentEntries.map((item) => normalize(item.motivationalPhrase ?? "")),
  );
  const recentHealth = new Set(
    recentEntries.map((item) => normalize(item.healthSuggestion ?? "")),
  );
  const recentGratitude = new Set(
    recentEntries.map((item) => normalize(item.gratitudePhrase ?? "")),
  );

  return (
    recentMotivational.has(normalize(entry.motivationalPhrase)) ||
    recentHealth.has(normalize(entry.healthSuggestion)) ||
    recentGratitude.has(normalize(entry.gratitudePhrase))
  );
}

async function sendEmail(config) {
  const accessToken = await getAccessToken(config);
  const subjectDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    dateStyle: "long",
  }).format(new Date());

  const subject = `Daily motivation for ${subjectDate}`;
  const textBody = [
    "Here is your daily check-in:",
    "",
    `Motivational phrase: ${config.entry.motivationalPhrase}`,
    `Health suggestion: ${config.entry.healthSuggestion}`,
    `Gratitude phrase: ${config.entry.gratitudePhrase}`,
  ].join("\n");

  const htmlBody = [
    "<div style=\"font-family:Arial,sans-serif;line-height:1.6;color:#1f2937;\">",
    "<h2 style=\"margin-bottom:16px;\">Your daily check-in</h2>",
    `<p><strong>Motivational phrase:</strong> ${escapeHtml(config.entry.motivationalPhrase)}</p>`,
    `<p><strong>Health suggestion:</strong> ${escapeHtml(config.entry.healthSuggestion)}</p>`,
    `<p><strong>Gratitude phrase:</strong> ${escapeHtml(config.entry.gratitudePhrase)}</p>`,
    "</div>",
  ].join("");

  const mimeMessage = buildMimeMessage({
    from: config.emailFrom,
    to: config.recipients,
    subject,
    textBody,
    htmlBody,
  });

  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      raw: toBase64Url(mimeMessage),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gmail send failed (${response.status}): ${errorText}`);
  }
}

async function getAccessToken(config) {
  const body = new URLSearchParams({
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
    refresh_token: config.googleRefreshToken,
    grant_type: "refresh_token",
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google token request failed (${response.status}): ${errorText}`);
  }

  const payload = await response.json();
  if (typeof payload.access_token !== "string" || !payload.access_token) {
    throw new Error("Google token response did not include an access token.");
  }

  return payload.access_token;
}

function buildMimeMessage({ from, to, subject, textBody, htmlBody }) {
  const boundary = `boundary_${Date.now()}`;

  return [
    `From: ${from}`,
    `To: ${to.join(", ")}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    textBody,
    "",
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "",
    htmlBody,
    "",
    `--${boundary}--`,
  ].join("\r\n");
}

function toBase64Url(value) {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
}

function escapeHtml(value) {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function requireTextFile(filePath) {
  return readFileSync(filePath, "utf8");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
