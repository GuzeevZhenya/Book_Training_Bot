import { Bot, session } from "grammy";
import {
  conversations,
  createConversation,
} from "@grammyjs/conversations";
import { config } from "./config.js";
import type { BotContext } from "./context.js";
import type { SessionData } from "./types.js";
import { startHandler, onboardingWizard } from "./handlers/start.js";
import { bookingHandler, bookingWizard, healthWizard } from "./handlers/booking.js";
import { cancelHandler } from "./handlers/cancel.js";
import {
  adminHandler,
  addWorkerConversation,
  addServiceConversation,
  delServiceConversation,
  trainerDayConversation,
  trainerDelTimeConversation,
  trainerAddTimeConversation,
  manualBookConversation,
} from "./handlers/admin.js";

function initialSession(): SessionData {
  return {};
}

async function main(): Promise<void> {
  const bot = new Bot<BotContext>(config.botToken);

  bot.use(session({ initial: initialSession }));
  bot.use(conversations());
  bot.use(createConversation(onboardingWizard, "onboardingWizard"));
  bot.use(createConversation(bookingWizard, "bookingWizard"));
  bot.use(createConversation(healthWizard, "healthWizard"));
  bot.use(createConversation(addWorkerConversation, "addWorker"));
  bot.use(createConversation(addServiceConversation, "addService"));
  bot.use(createConversation(delServiceConversation, "delService"));
  bot.use(createConversation(trainerDayConversation, "trainerDay"));
  bot.use(createConversation(trainerDelTimeConversation, "trainerDelTime"));
  bot.use(createConversation(trainerAddTimeConversation, "trainerAddTime"));
  bot.use(createConversation(manualBookConversation, "manualBook"));

  bot.use(startHandler);
  bot.use(bookingHandler);
  bot.use(cancelHandler);
  bot.use(adminHandler);

  bot.catch((err) => {
    console.error("Bot error:", err.error);
  });

  console.log("Бот запускается...");
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
