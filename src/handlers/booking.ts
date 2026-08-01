import { Composer } from "grammy";
import type { BotContext, BotConversation } from "../context.js";
import { googleSheets } from "../services/googleSheets.js";
import { isAdmin } from "../middlewares/adminOnly.js";
import {
  BTN_ADMIN,
  BTN_BOOK,
  BTN_CANCEL,
  BTN_HEALTH,
  BTN_INFO,
  BTN_MY,
  BTN_PROFILE,
  BTN_TRAINER_CLIENTS_PREFIX,
  clientMainKeyboard,
  datesKeyboard,
  healthActionsKeyboard,
  servicesKeyboard,
  timesKeyboard,
  workersKeyboard,
} from "../keyboards/client.js";
import { adminMenuKeyboard } from "../keyboards/admin.js";
import { SlotAlreadyBookedError, SlotNotFoundError } from "../types.js";
import { loadClientSession } from "./start.js";

function isQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("Quota exceeded") ||
    msg.includes("rateLimitExceeded") ||
    msg.includes("429")
  );
}

async function replyKeyboard(ctx: BotContext) {
  const trainer = await googleSheets.findWorkerByTelegram(ctx.from?.username);
  return clientMainKeyboard({
    isAdmin: isAdmin(ctx),
    trainerName: trainer?.name,
  });
}

function tgTag(username?: string | null): string {
  if (!username) return "";
  return username.startsWith("@") ? username : `@${username}`;
}

export const bookingHandler = new Composer<BotContext>();

bookingHandler.command("book", async (ctx) => {
  const ready = await loadClientSession(ctx).catch(() => false);
  if (!ready) {
    await ctx.reply("Сначала заполните профиль — нажмите /start");
    await ctx.conversation.enter("onboardingWizard");
    return;
  }
  await ctx.conversation.enter("bookingWizard");
});

bookingHandler.hears(BTN_BOOK, async (ctx) => {
  const ready = await loadClientSession(ctx).catch(() => false);
  if (!ready) {
    await ctx.reply("Сначала заполните профиль — нажмите /start");
    await ctx.conversation.enter("onboardingWizard");
    return;
  }
  await ctx.conversation.enter("bookingWizard");
});

bookingHandler.hears(BTN_ADMIN, async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.reply("Админ-панель доступна только администраторам.");
    return;
  }
  try {
    await ctx.conversation.exitAll();
  } catch {
    /* нет активного диалога */
  }
  await ctx.reply("🛠 Админ-панель:", {
    reply_markup: adminMenuKeyboard(),
  });
});

bookingHandler.hears(BTN_INFO, async (ctx) => {
  await ctx.reply(
    "ℹ️ Запись на тренировки\n\n" +
      "1. Выберите тренера\n" +
      "2. Выберите день и время\n" +
      "3. Выберите направление (услугу)\n\n" +
      "Имя и Telegram берутся из вашего профиля (заполняется при первом /start).\n\n" +
      "🩺 В «Здоровье» можно указать проблемы (спина, колени и т.п.) — " +
      "тренер увидит их в таблице при каждой записи.",
    { reply_markup: await replyKeyboard(ctx) },
  );
});

bookingHandler.hears(BTN_PROFILE, async (ctx) => {
  await loadClientSession(ctx).catch(console.error);
  const name = ctx.session.clientName || "не указано";
  const tag =
    tgTag(ctx.from?.username) || ctx.session.clientPhone || "не указан";
  let health = "не указаны";
  try {
    if (ctx.from?.id) {
      const profile = await googleSheets.getClientProfile(ctx.from.id);
      if (profile?.healthIssues?.trim()) {
        health = profile.healthIssues.trim();
      }
      if (profile?.name?.trim()) {
        ctx.session.clientName = profile.name.trim();
      }
    }
  } catch (err) {
    console.error(err);
  }
  await ctx.reply(
    `👤 Ваши данные:\nИмя: ${ctx.session.clientName || name}\n` +
      `Telegram: ${tag}\n` +
      `Проблемы со здоровьем: ${health}\n\n` +
      "Изменить здоровье — «🩺 Здоровье».",
  );
});

bookingHandler.hears(BTN_HEALTH, async (ctx) => {
  await ctx.conversation.enter("healthWizard");
});

bookingHandler.hears(BTN_MY, async (ctx) => {
  const phone = ctx.session.clientPhone;
  const username = ctx.from?.username ? `@${ctx.from.username}` : undefined;
  const tgId = ctx.from?.id;
  const myName = ctx.session.clientName;

  try {
    // Сначала строго по Telegram ID, контакт — запасной
    const list = await googleSheets.listUserBookings(
      phone || username,
      undefined,
      tgId,
    );
    if (list.length === 0) {
      await ctx.reply(
        "У вас нет активных записей.\n" +
          "Запишитесь через «📅 Записаться» — тогда они появятся здесь.",
      );
      return;
    }
    const who = myName ? ` (${myName})` : "";
    const lines = list.map(
      (s) =>
        `• ${s.date} в ${s.time}` +
        `\n  Тренер: ${s.worker || "—"}` +
        (s.service ? ` · ${s.service}` : "") +
        `\n  Имя в записи: ${s.displayName}`,
    );
    await ctx.reply(`📋 Ваши записи${who}:\n\n${lines.join("\n\n")}`);
  } catch (err) {
    console.error(err);
    await ctx.reply("Не удалось загрузить записи.");
  }
});

bookingHandler.hears(BTN_CANCEL, async (ctx) => {
  await cancelFlow(ctx);
});

bookingHandler.hears(new RegExp(`^${BTN_TRAINER_CLIENTS_PREFIX}\\s+(.+)$`), async (ctx) => {
  const trainerName = ctx.match[1]?.trim();
  if (!trainerName) return;

  const linked = await googleSheets.findWorkerByTelegram(ctx.from?.username);
  if (!isAdmin(ctx) && linked?.name !== trainerName) {
    await ctx.reply("Это меню только для вашего профиля тренера.");
    return;
  }

  try {
    const bookings = await googleSheets.listBookingsByWorker(trainerName);
    if (bookings.length === 0) {
      await ctx.reply(`У тренера «${trainerName}» пока нет записей клиентов.`);
      return;
    }
    const lines: string[] = [`👥 Клиенты — ${trainerName}:\n`];
    for (const b of bookings) {
      lines.push(`🗓 ${b.date} ${b.time}${b.service ? ` · ${b.service}` : ""}`);
      if (b.clientName || b.clientContact) {
        lines.push(`  1) ${b.clientName || "—"} · ${b.clientContact || "—"}`);
        if (b.health1?.trim()) {
          lines.push(`     ⚠️ ${b.health1.trim()}`);
        }
      }
      if (b.clientName2 || b.clientContact2) {
        lines.push(`  2) ${b.clientName2 || "—"} · ${b.clientContact2 || "—"}`);
        if (b.health2?.trim()) {
          lines.push(`     ⚠️ ${b.health2.trim()}`);
        }
      }
    }
    await ctx.reply(lines.join("\n"));
  } catch (err) {
    console.error(err);
    await ctx.reply("Не удалось загрузить клиентов.");
  }
});

async function cancelFlow(ctx: BotContext): Promise<void> {
  const phone = ctx.session.clientPhone;
  const username = ctx.from?.username ? `@${ctx.from.username}` : undefined;
  const contact = phone || username || "";
  const name = ctx.session.clientName;
  const tgId = ctx.from?.id;

  try {
    const found = await googleSheets.findUserActiveBooking(
      contact,
      name,
      tgId,
    );
    if (!found) {
      await ctx.reply("Активных записей не найдено.");
      return;
    }
    const { slot, seat } = found;
    const contactInSheet =
      seat === 1 ? slot.clientContact : slot.clientContact2;
    await googleSheets.cancelUserBooking(
      slot.date,
      slot.time,
      slot.worker,
      contactInSheet || contact,
      tgId,
    );
    await ctx.reply(
      `Запись отменена: ${slot.date} в ${slot.time} (${slot.worker})`,
    );
  } catch (err) {
    console.error(err);
    await ctx.reply(
      err instanceof Error ? err.message : "Не удалось отменить запись.",
    );
  }
}

/**
 * Клиент: тренер → день → время → услуга (имя и @username из профиля)
 */
export async function bookingWizard(
  conversation: BotConversation,
  ctx: BotContext,
): Promise<void> {
  const profileReady = await conversation.external(async (c) =>
    loadClientSession(c),
  );
  if (!profileReady) {
    await ctx.reply("Сначала заполните профиль — нажмите /start");
    return;
  }

  const workers = await conversation.external(() =>
    googleSheets.listWorkers(true),
  );
  if (workers.length === 0) {
    await ctx.reply(
      "Пока нет тренеров. Админ: Админ-панель → Демо-данные или Добавить тренера.",
    );
    return;
  }

  await ctx.reply("К кому хотите записаться?", {
    reply_markup: workersKeyboard(workers),
  });

  let serviceName = "";
  let workerName = "";
  let date = "";
  let time = "";
  let doneSelecting = false;

  while (!doneSelecting) {
    const cbCtx = await conversation.waitFor("callback_query:data");
    const data = cbCtx.callbackQuery.data;
    await cbCtx.answerCallbackQuery();

    if (data === "wiz:cancel") {
      await ctx.reply("Запись отменена.", {
        reply_markup: await conversation.external(async (c) => {
          const trainer = await googleSheets.findWorkerByTelegram(
            c.from?.username,
          );
          return clientMainKeyboard({
            isAdmin: isAdmin(c),
            trainerName: trainer?.name,
          });
        }),
      });
      return;
    }

    if (data.startsWith("wiz:wrk:")) {
      const idx = Number(data.split(":")[2]);
      const list = await conversation.external(() =>
        googleSheets.listWorkers(true),
      );
      const wrk = list[idx];
      if (!wrk) {
        await ctx.reply("Тренер не найден. Начните снова.");
        return;
      }
      workerName = wrk.name;
      await conversation.external((c) => {
        c.session.pendingWorker = workerName;
      });

      const dates = await conversation.external(() =>
        googleSheets.getAvailableDates(workerName, 7),
      );
      if (dates.length === 0) {
        await ctx.reply(
          `У «${workerName}» нет свободного времени.`,
        );
        return;
      }
      await ctx.reply(`Тренер: ${workerName}\n\nВыберите день:`, {
        reply_markup: datesKeyboard(dates),
      });
      continue;
    }

    if (data.startsWith("wiz:date:")) {
      const idx = Number(data.split(":")[2]);
      workerName =
        (await conversation.external((c) => c.session.pendingWorker)) ||
        workerName;
      const dates = await conversation.external(() =>
        googleSheets.getAvailableDates(workerName, 7),
      );
      const d = dates[idx];
      if (!d) {
        await ctx.reply("День не найден.");
        return;
      }
      date = d;
      await conversation.external((c) => {
        c.session.pendingDate = date;
      });
      const times = await conversation.external(() =>
        googleSheets.getAvailableTimes(workerName, date),
      );
      if (times.length === 0) {
        await ctx.reply("На этот день нет свободного времени.");
        return;
      }
      await ctx.reply(`День: ${date}\n\nВыберите время:`, {
        reply_markup: timesKeyboard(times),
      });
      continue;
    }

    if (data.startsWith("wiz:time:")) {
      const idx = Number(data.split(":")[2]);
      workerName =
        (await conversation.external((c) => c.session.pendingWorker)) ||
        workerName;
      date =
        (await conversation.external((c) => c.session.pendingDate)) || date;
      const times = await conversation.external(() =>
        googleSheets.getAvailableTimes(workerName, date),
      );
      const slot = times[idx];
      if (!slot) {
        await ctx.reply("Время не найдено.");
        return;
      }
      time = slot.time;
      await conversation.external((c) => {
        c.session.pendingTime = time;
      });

      const services = await conversation.external(() =>
        googleSheets.listServices(true),
      );
      if (services.length === 0) {
        serviceName = "Тренировка";
        doneSelecting = true;
        continue;
      }
      await ctx.reply("Выберите направление (услугу):", {
        reply_markup: servicesKeyboard(services),
      });
      continue;
    }

    if (data.startsWith("wiz:svc:")) {
      const idx = Number(data.split(":")[2]);
      const services = await conversation.external(() =>
        googleSheets.listServices(true),
      );
      const svc = services[idx];
      if (!svc) {
        await ctx.reply("Услуга не найдена.");
        return;
      }
      serviceName = svc.name;
      await conversation.external((c) => {
        c.session.pendingService = serviceName;
      });
      doneSelecting = true;
      continue;
    }

    if (data === "wiz:back:wrk") {
      const list = await conversation.external(() =>
        googleSheets.listWorkers(true),
      );
      await ctx.reply("К кому хотите записаться?", {
        reply_markup: workersKeyboard(list),
      });
      continue;
    }

    if (data === "wiz:back:date") {
      workerName =
        (await conversation.external((c) => c.session.pendingWorker)) ||
        workerName;
      const dates = await conversation.external(() =>
        googleSheets.getAvailableDates(workerName, 7),
      );
      await ctx.reply("Выберите день:", {
        reply_markup: datesKeyboard(dates),
      });
      continue;
    }

    if (data === "wiz:back:time") {
      workerName =
        (await conversation.external((c) => c.session.pendingWorker)) ||
        workerName;
      date =
        (await conversation.external((c) => c.session.pendingDate)) || date;
      const times = await conversation.external(() =>
        googleSheets.getAvailableTimes(workerName, date),
      );
      await ctx.reply("Выберите время:", {
        reply_markup: timesKeyboard(times),
      });
      continue;
    }
  }

  workerName =
    (await conversation.external((c) => c.session.pendingWorker)) || workerName;
  date =
    (await conversation.external((c) => c.session.pendingDate)) || date;
  time =
    (await conversation.external((c) => c.session.pendingTime)) || time;
  serviceName =
    (await conversation.external((c) => c.session.pendingService)) ||
    serviceName ||
    "Тренировка";

  const name = await conversation.external((c) => c.session.clientName?.trim());
  const username = await conversation.external((c) => c.from?.username);
  const contact =
    (await conversation.external((c) => {
      const tag = tgTag(c.from?.username);
      if (tag) {
        c.session.clientPhone = tag;
        return tag;
      }
      return c.session.clientPhone?.trim() || "";
    })) || "";

  if (!name) {
    await ctx.reply("Сначала заполните профиль — нажмите /start");
    return;
  }

  const tgId = await conversation.external((c) => c.from?.id);

  try {
    await conversation.external(() =>
      googleSheets.bookSlot(
        date,
        time,
        workerName,
        serviceName,
        name,
        contact || tgTag(username) || name,
        tgId,
        username,
      ),
    );
    await conversation.external((c) => {
      c.session.pendingDate = undefined;
      c.session.pendingTime = undefined;
      c.session.pendingWorker = undefined;
      c.session.pendingService = undefined;
    });

    const kb = await conversation.external(async (c) => {
      const trainer = await googleSheets.findWorkerByTelegram(c.from?.username);
      return clientMainKeyboard({
        isAdmin: isAdmin(c),
        trainerName: trainer?.name,
      });
    });

    const health =
      (await conversation.external(() =>
        tgId ? googleSheets.getClientProfile(tgId) : Promise.resolve(null),
      ))?.healthIssues?.trim() || "";

    await ctx.reply(
      `✅ ${name}, вы записаны!\n\n` +
        `Тренер: ${workerName}\n` +
        `Услуга: ${serviceName}\n` +
        `Когда: ${date} в ${time}` +
        (health ? `\n\n⚠️ Для тренера отмечено:\n${health}` : ""),
      { reply_markup: kb },
    );
  } catch (err) {
    if (err instanceof SlotAlreadyBookedError) {
      await ctx.reply("Мест больше нет — выберите другое время.");
      return;
    }
    if (err instanceof SlotNotFoundError) {
      await ctx.reply("Это время уже недоступно. Попробуйте снова.");
      return;
    }
    console.error(err);
    await ctx.reply(
      isQuotaError(err)
        ? "Сейчас много запросов к таблице. Подождите ~1 минуту и попробуйте снова."
        : err instanceof Error && err.message.includes("уже записаны")
          ? err.message
          : "Не удалось записаться. Попробуйте позже.",
    );
  }
}

/**
 * Клиент указывает / редактирует проблемы со здоровьем
 */
export async function healthWizard(
  conversation: BotConversation,
  ctx: BotContext,
): Promise<void> {
  const tgId = await conversation.external((c) => c.from?.id);
  if (!tgId) {
    await ctx.reply("Не удалось определить аккаунт Telegram.");
    return;
  }

  const mainKb = async () =>
    conversation.external(async (c) => {
      const trainer = await googleSheets.findWorkerByTelegram(c.from?.username);
      return clientMainKeyboard({
        isAdmin: isAdmin(c),
        trainerName: trainer?.name,
      });
    });

  const loadIssues = () =>
    conversation.external(async () => {
      const p = await googleSheets.getClientProfile(tgId);
      return p?.healthIssues?.trim() || "";
    });

  let current = await loadIssues();
  await ctx.reply(
    current
      ? `🩺 Ваши проблемы со здоровьем:\n\n${current}\n\n` +
          "Тренер видит это в Google Sheet при каждой вашей записи."
      : "🩺 Проблемы со здоровьем пока не указаны.\n\n" +
          "Напишите, что важно знать тренеру (например: проблемы со спиной, колени, давление).",
    { reply_markup: healthActionsKeyboard(Boolean(current)) },
  );

  while (true) {
    const cbCtx = await conversation.waitFor("callback_query:data");
    const data = cbCtx.callbackQuery.data;
    await cbCtx.answerCallbackQuery();

    if (data === "health:done") {
      await ctx.reply("Готово.", { reply_markup: await mainKb() });
      return;
    }

    if (data === "health:clear") {
      await conversation.external(async (c) =>
        googleSheets.setHealthIssues(tgId, "", {
          name: c.session.clientName,
          phone: c.session.clientPhone,
          username: c.from?.username,
        }),
      );
      await ctx.reply(
        "Проблемы со здоровьем очищены. В будущих записях пометка снята.",
        { reply_markup: await mainKb() },
      );
      return;
    }

    if (data === "health:edit") {
      await ctx.reply(
        "Напишите проблемы одним сообщением.\n" +
          "Чтобы очистить — отправьте «-».",
      );
      const msgCtx = await conversation.waitFor("message:text");
      const raw = msgCtx.message.text.trim();
      const issues =
        raw === "-" || raw.toLowerCase() === "очистить" ? "" : raw;

      if (issues.length > 500) {
        await ctx.reply(
          "Слишком длинный текст (макс. 500 символов). Попробуйте короче:",
          { reply_markup: healthActionsKeyboard(Boolean(current)) },
        );
        continue;
      }

      await conversation.external(async (c) =>
        googleSheets.setHealthIssues(tgId, issues, {
          name: c.session.clientName,
          phone: c.session.clientPhone,
          username: c.from?.username,
        }),
      );

      current = issues;
      await ctx.reply(
        issues
          ? `✅ Сохранено:\n${issues}\n\nПри записи это попадёт в колонки «Здоровье» таблицы.`
          : "Проблемы со здоровьем очищены.",
        { reply_markup: await mainKb() },
      );
      return;
    }
  }
}
