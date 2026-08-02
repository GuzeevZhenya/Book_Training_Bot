import "dotenv/config";

const token = process.env.BOT_TOKEN?.trim();
const url = process.argv[2]?.trim() || process.env.WEBHOOK_URL?.trim();
const secret = process.env.WEBHOOK_SECRET?.trim();

if (!token) {
  console.error("Нужен BOT_TOKEN");
  process.exit(1);
}

if (!url) {
  console.error(
    "Укажите URL: npx tsx scripts/set-webhook.ts https://xxx.vercel.app/api/bot",
  );
  process.exit(1);
}

const webhookUrl = url.endsWith("/api/bot") ? url : `${url.replace(/\/$/, "")}/api/bot`;

const body: Record<string, unknown> = {
  url: webhookUrl,
  allowed_updates: [
    "message",
    "callback_query",
    "my_chat_member",
    "chat_member",
  ],
  drop_pending_updates: true,
};

if (secret) {
  body.secret_token = secret;
}

const res = await fetch(
  `https://api.telegram.org/bot${token}/setWebhook`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  },
);

const data = (await res.json()) as { ok: boolean; description?: string };
console.log(data);
if (!data.ok) process.exit(1);
console.log("Webhook установлен:", webhookUrl);
