import { Bot, session } from "grammy";
import type { StorageAdapter } from "grammy";
import {
  conversations,
  createConversation,
} from "@grammyjs/conversations";
import { Redis } from "@upstash/redis";
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

function upstashStorage<T>(redis: Redis): StorageAdapter<T> {
  return {
    read: async (key) => {
      const value = await redis.get<T>(key);
      return value ?? undefined;
    },
    write: async (key, value) => {
      await redis.set(key, value);
    },
    delete: async (key) => {
      await redis.del(key);
    },
  };
}

function createSessionMiddleware() {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();

  if (url && token) {
    const redis = new Redis({ url, token });
    return session({
      initial: initialSession,
      storage: upstashStorage<SessionData>(redis),
    });
  }

  if (process.env.VERCEL) {
    throw new Error(
      "На Vercel нужны UPSTASH_REDIS_REST_URL и UPSTASH_REDIS_REST_TOKEN (Upstash Redis).",
    );
  }

  console.warn(
    "Redis не настроен — сессии в памяти (только для локального npm start).",
  );
  return session({ initial: initialSession });
}

/** Собирает бота с хендлерами (polling и webhook). */
export function createBot(): Bot<BotContext> {
  const bot = new Bot<BotContext>(config.botToken);

  bot.use(createSessionMiddleware());
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

  return bot;
}
