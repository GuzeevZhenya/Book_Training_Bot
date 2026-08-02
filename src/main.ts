import { createBot } from "./createBot.js";
import { config } from "./config.js";

async function main(): Promise<void> {
  const bot = createBot();

  console.log("Бот запускается (long polling)...");
  console.log(
    `Админы (username): ${config.adminUsernames.map((u) => "@" + u).join(", ")}` +
      (config.adminId != null ? ` + id ${config.adminId}` : ""),
  );

  await bot.start({
    onStart: (info) => {
      console.log(`Бот @${info.username} запущен`);
    },
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
