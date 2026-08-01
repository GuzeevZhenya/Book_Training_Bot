import { Composer } from "grammy";
import type { BotContext } from "../context.js";
import { googleSheets } from "../services/googleSheets.js";
import { isAdmin } from "../middlewares/adminOnly.js";
import { clientMainKeyboard } from "../keyboards/client.js";

export const startHandler = new Composer<BotContext>();

startHandler.command("start", async (ctx) => {
  const trainer = await googleSheets.findWorkerByTelegram(ctx.from?.username);
  const kb = clientMainKeyboard({
    isAdmin: isAdmin(ctx),
    trainerName: trainer?.name,
  });

  const adminHint = isAdmin(ctx)
    ? "\n🛠 У вас есть кнопка «Админ-панель»."
    : "";
  const trainerHint = trainer
    ? `\n👥 Кнопка «Клиенты: ${trainer.name}» — ваши записи.`
    : "";

  await ctx.reply(
    "Привет! Запись на тренировки.\n\n" +
      "📅 Записаться — выберите тренера, день и время\n" +
      "📋 Мои записи — ваши визиты по имени" +
      adminHint +
      trainerHint,
    { reply_markup: kb },
  );
});
