import { webhookCallback } from "grammy";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createBot } from "../src/createBot.js";

const bot = createBot();

const secretToken = process.env.WEBHOOK_SECRET?.trim() || undefined;

const handleUpdate = webhookCallback(bot, "http", {
  secretToken,
});

let webhookEnsured: Promise<void> | null = null;

function ensureWebhook(): Promise<void> {
  if (!webhookEnsured) {
    const explicit = process.env.WEBHOOK_URL?.trim();
    const vercelHost = process.env.VERCEL_URL?.trim();
    const base = explicit || (vercelHost ? `https://${vercelHost}` : "");
    const url = base ? `${base.replace(/\/$/, "")}/api/bot` : "";

    webhookEnsured = url
      ? bot.api
          .setWebhook(url, secretToken ? { secret_token: secretToken } : {})
          .then(() => {
            console.log("Webhook set:", url);
          })
          .catch((err: unknown) => {
            console.error("setWebhook failed:", err);
          })
      : Promise.resolve();
  }
  return webhookEnsured;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method === "GET") {
    res.status(200).json({ ok: true, service: "bot-zapisi" });
    return;
  }

  await ensureWebhook();
  await handleUpdate(req, res);
}
