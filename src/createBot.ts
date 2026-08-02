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

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!url || !token) return null;
  return new Redis({ url, token });
}

/** Upstash сам сериализует JSON — храним объекты как есть. */
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

/** Собирает бота с хендлерами (polling и webhook). */
export function createBot(): Bot<BotContext> {
  const bot = new Bot<BotContext>(config.botToken);
  const redis = getRedis();

  if (process.env.VERCEL && !redis) {
    throw new Error(
      "На Vercel нужны UPSTASH_REDIS_REST_URL и UPSTASH_REDIS_REST_TOKEN (Upstash Redis).",
    );
  }

  if (!redis) {
    console.warn(
      "Redis не настроен — сессии и диалоги в памяти (только локальный npm start).",
    );
  }

  bot.use(
    session({
      initial: initialSession,
      ...(redis ? { storage: upstashStorage<SessionData>(redis) } : {}),
    }),
  );

  // Важно: без storage диалоги записи живут только в RAM и на Vercel ломаются
  // на втором шаге (каждый webhook = новый процесс).
  bot.use(
    conversations(
      redis
        ? {
            storage: {
              type: "key",
              // bump при смене логики диалогов — сбрасывает зависшие записи в Redis
              version: 2,
              prefix: "convo-",
              adapter: upstashStorage(redis),
            },
          }
        : undefined,
    ),
  );

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
