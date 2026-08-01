import { Composer } from "grammy";
import type { BotContext, BotConversation } from "../context.js";
import { googleSheets } from "../services/googleSheets.js";
import { isAdmin } from "../middlewares/adminOnly.js";
import { clientMainKeyboard } from "../keyboards/client.js";

export const startHandler = new Composer<BotContext>();

function tgTag(username?: string | null): string {
  if (!username) return "";
  return username.startsWith("@") ? username : `@${username}`;
}

async function mainKeyboard(ctx: BotContext) {
  const trainer = await googleSheets.findWorkerByTelegram(ctx.from?.username);
  return clientMainKeyboard({
    isAdmin: isAdmin(ctx),
    trainerName: trainer?.name,
  });
}

/** Подтягивает профиль в сессию; true — имя уже есть */
export async function loadClientSession(ctx: BotContext): Promise<boolean> {
  const tgId = ctx.from?.id;
  if (!tgId) return false;

  const profile = await googleSheets.getClientProfile(tgId);
  const tag = tgTag(ctx.from?.username) || tgTag(profile?.username) || "";

  if (profile?.name?.trim()) {
    ctx.session.clientName = profile.name.trim();
    ctx.session.clientPhone = tag || profile.phone || "";
    // Пишем в таблицу только если @username/контакт реально изменились
    const usernameChanged =
      Boolean(ctx.from?.username) &&
      profile.username.replace(/^@/, "").toLowerCase() !==
        (ctx.from?.username || "").toLowerCase();
    const phoneChanged = Boolean(tag) && profile.phone !== tag;
    if (usernameChanged || phoneChanged) {
      await googleSheets
        .upsertClientProfile({
          telegramId: tgId,
          name: profile.name.trim(),
          phone: tag,
          username: ctx.from?.username,
        })
        .catch(console.error);
    }
    return true;
  }
  return false;
}

startHandler.command("start", async (ctx) => {
  try {
    await ctx.conversation.exitAll();
  } catch {
    /* нет активного диалога */
  }

  let ready = false;
  try {
    ready = await loadClientSession(ctx);
  } catch (err) {
    console.error(err);
  }

  if (!ready) {
    await ctx.conversation.enter("onboardingWizard");
    return;
  }

  const kb = await mainKeyboard(ctx);
  const adminHint = isAdmin(ctx)
    ? "\n🛠 У вас есть кнопка «Админ-панель»."
    : "";
  const trainer = await googleSheets.findWorkerByTelegram(ctx.from?.username);
  const trainerHint = trainer
    ? `\n👥 Кнопка «Клиенты: ${trainer.name}» — ваши записи.`
    : "";

  await ctx.reply(
    `Привет, ${ctx.session.clientName}!\n\n` +
      "📅 Записаться — выберите тренера, день и время\n" +
      "📋 Мои записи — ваши визиты\n" +
      "🩺 Здоровье — проблемы, которые увидит тренер" +
      adminHint +
      trainerHint,
    { reply_markup: kb },
  );
});

/**
 * Первый запуск: имя + Telegram-тег + опционально здоровье
 */
export async function onboardingWizard(
  conversation: BotConversation,
  ctx: BotContext,
): Promise<void> {
  const tgId = await conversation.external((c) => c.from?.id);
  const username = await conversation.external((c) => c.from?.username);
  const tag = tgTag(username);

  if (!tgId) {
    await ctx.reply("Не удалось определить аккаунт Telegram.");
    return;
  }

  await ctx.reply(
    "Привет! Один раз заполним профиль — потом при записи имя и Telegram подставятся сами.\n\n" +
      "Как вас зовут?",
  );

  const nameCtx = await conversation.waitFor("message:text");
  const name = nameCtx.message.text.trim();
  if (!name) {
    await ctx.reply("Имя пустое. Нажмите /start ещё раз.");
    return;
  }

  await ctx.reply(
    (tag
      ? `Ваш Telegram: ${tag}\n\n`
      : "У вас нет публичного @username в Telegram — в таблице будет только имя.\n\n") +
      "Есть проблемы со здоровьем, о которых стоит знать тренеру?\n" +
      "Напишите текстом (например: боли в спине) или отправьте «-», чтобы пропустить.",
  );

  const healthCtx = await conversation.waitFor("message:text");
  const raw = healthCtx.message.text.trim();
  const health =
    raw === "-" ||
    raw.toLowerCase() === "пропустить" ||
    raw.toLowerCase() === "нет"
      ? ""
      : raw.slice(0, 500);

  await conversation.external(async (c) => {
    await googleSheets.upsertClientProfile({
      telegramId: tgId,
      name,
      phone: tag,
      username: username || "",
      healthIssues: health,
    });
    c.session.clientName = name;
    c.session.clientPhone = tag;
  });

  const kb = await conversation.external(async (c) => {
    const trainer = await googleSheets.findWorkerByTelegram(c.from?.username);
    return clientMainKeyboard({
      isAdmin: isAdmin(c),
      trainerName: trainer?.name,
    });
  });

  await ctx.reply(
    `✅ Профиль сохранён, ${name}.\n` +
      (tag ? `Telegram: ${tag}\n` : "") +
      (health ? `Здоровье: ${health}\n` : "") +
      "\nМожно записываться через «📅 Записаться».\n" +
      "Здоровье позже можно изменить в «🩺 Здоровье».",
    { reply_markup: kb },
  );
}
