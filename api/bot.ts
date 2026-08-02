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
        hint: "Webhook must stay https://book-training-bot.vercel.app/api/bot",
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

    // Нельзя setWebhook на каждый запрос: VERCEL_URL меняется
    // и Telegram начинает слать апдейты «в никуда».

    const { createBot } = await import("../src/createBot.js");
    const { webhookCallback } = await import("grammy");

    const bot = createBot();
    // Секрет только если реально задан И совпадает с тем, что в setWebhook
    const secretToken = process.env.WEBHOOK_SECRET?.trim() || undefined;
    const handleUpdate = webhookCallback(bot, "http", {
      ...(secretToken ? { secretToken } : {}),
    });

    await handleUpdate(req, res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("api/bot crashed:", message, err);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: message });
    }
  }
}
