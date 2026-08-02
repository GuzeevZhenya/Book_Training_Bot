import type { VercelRequest, VercelResponse } from "@vercel/node";

const REQUIRED_ENV = [
  "BOT_TOKEN",
  "SPREADSHEET_ID",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
] as const;

function missingEnv(): string[] {
  return REQUIRED_ENV.filter((name) => !process.env[name]?.trim());
}

function hasGoogleCredentials(): boolean {
  return Boolean(process.env.GOOGLE_CREDENTIALS_JSON?.trim());
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  try {
    const missing = missingEnv();
    const googleOk = hasGoogleCredentials();

    if (req.method === "GET") {
      res.status(200).json({
        ok: missing.length === 0 && googleOk,
        service: "bot-zapisi",
        missing,
        hasGoogleCredentials: googleOk,
      });
      return;
    }

    if (missing.length > 0 || !googleOk) {
      res.status(500).json({
        ok: false,
        error: "Не хватает переменных окружения на Vercel",
        missing: [
          ...missing,
          ...(googleOk ? [] : ["GOOGLE_CREDENTIALS_JSON"]),
        ],
      });
      return;
    }

    const { createBot } = await import("../src/createBot.js");
    const { webhookCallback } = await import("grammy");

    const bot = createBot();
    const secretToken = process.env.WEBHOOK_SECRET?.trim() || undefined;
    const handleUpdate = webhookCallback(bot, "http", { secretToken });

    const explicit = process.env.WEBHOOK_URL?.trim();
    const vercelHost = process.env.VERCEL_URL?.trim();
    const base =
      explicit ||
      (vercelHost ? `https://${vercelHost}` : "https://book-training-bot.vercel.app");
    const webhookUrl = `${base.replace(/\/$/, "")}/api/bot`;

    try {
      await bot.api.setWebhook(
        webhookUrl,
        secretToken ? { secret_token: secretToken } : {},
      );
    } catch (err) {
      console.error("setWebhook failed:", err);
    }

    await handleUpdate(req, res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("api/bot crashed:", message, err);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: message });
    }
  }
}
