import { Composer } from "grammy";
import type { BotContext, BotConversation } from "../context.js";
import { requireAdmin, isAdmin } from "../middlewares/adminOnly.js";
import {
  adminMenuKeyboard,
  servicesAdminKeyboard,
  trainerCardKeyboard,
  trainersListKeyboard,
} from "../keyboards/admin.js";
import { clientMainKeyboard } from "../keyboards/client.js";
import { googleSheets } from "../services/googleSheets.js";
import { SlotNotFoundError } from "../types.js";
import { config } from "../config.js";

export const adminHandler = new Composer<BotContext>();

async function mainKb(ctx: BotContext) {
  const trainer = await googleSheets.findWorkerByTelegram(ctx.from?.username);
  return clientMainKeyboard({
    isAdmin: isAdmin(ctx),
    trainerName: trainer?.name,
  });
}

adminHandler.command("admin", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;
  try {
    await ctx.conversation.exitAll();
  } catch {
    /* ok */
  }
  await ctx.reply("🛠 Админ-панель:", {
    reply_markup: adminMenuKeyboard(),
  });
  await ctx.reply("Клавиатура обновлена.", {
    reply_markup: await mainKb(ctx),
  });
});

adminHandler.callbackQuery("admin:home", async (ctx) => {
  if (!(await requireAdmin(ctx))) {
    await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  await ctx.reply("🛠 Админ-панель:", { reply_markup: adminMenuKeyboard() });
});

async function sendBookings(ctx: BotContext): Promise<void> {
  try {
    const bookings = await googleSheets.getBookingsForDays([0, 1]);
    if (bookings.length === 0) {
      await ctx.reply("На сегодня и завтра записей нет.");
      return;
    }
    const lines: string[] = ["📋 Записи на сегодня и завтра:"];
    let lastDate = "";
    for (const b of bookings) {
      if (b.date !== lastDate) {
        lastDate = b.date;
        lines.push(`\n🗓 ${b.date}`);
      }
      const people: string[] = [];
      if (b.clientName || b.clientContact) {
        people.push(
          `${b.clientName || "—"} (${b.clientContact || "—"})` +
            (b.health1?.trim() ? ` ⚠️ ${b.health1.trim()}` : ""),
        );
      }
      if (b.clientName2 || b.clientContact2) {
        people.push(
          `${b.clientName2 || "—"} (${b.clientContact2 || "—"})` +
            (b.health2?.trim() ? ` ⚠️ ${b.health2.trim()}` : ""),
        );
      }
      lines.push(
        `• ${b.time} | ${b.worker} | ${b.service || "—"} ` +
          `[${b.bookedCount}/${config.slotCapacity}]\n  ${people.join("; ")}`,
      );
    }
    await ctx.reply(lines.join("\n"));
  } catch (err) {
    console.error(err);
    await ctx.reply("Не удалось загрузить записи.");
  }
}

async function showTrainers(ctx: BotContext): Promise<void> {
  const workers = await googleSheets.listWorkers(true);
  if (workers.length === 0) {
    await ctx.reply("Тренеров нет. Добавьте первого:", {
      reply_markup: trainersListKeyboard([]),
    });
    return;
  }
  await ctx.reply("👥 Выберите тренера:", {
    reply_markup: trainersListKeyboard(workers),
  });
}

async function showTrainerCard(ctx: BotContext, index: number): Promise<void> {
  const workers = await googleSheets.listWorkers(true);
  const w = workers[index];
  if (!w) {
    await ctx.reply("Тренер не найден.");
    return;
  }
  ctx.session.adminTrainerIndex = index;

  let url = w.sheetUrl;
  try {
    url = await googleSheets.getTrainerSheetUrl(w.name);
  } catch (err) {
    console.error(err);
  }

  const tg = w.telegram ? `\nTelegram: @${w.telegram}` : "\nTelegram: не привязан";
  const linkLine = url ? `\n📄 Лист: ${url}` : "";
  await ctx.reply(`👤 ${w.name}${tg}${linkLine}\n\nЧто сделать?`, {
    reply_markup: trainerCardKeyboard(index, url),
    link_preview_options: { is_disabled: true },

  });
}

adminHandler.callbackQuery("admin:bookings", async (ctx) => {
  if (!(await requireAdmin(ctx))) {
    await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  await sendBookings(ctx);
});

adminHandler.command("bookings", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;
  await sendBookings(ctx);
});

adminHandler.callbackQuery("admin:trainers", async (ctx) => {
  if (!(await requireAdmin(ctx))) {
    await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  await showTrainers(ctx);
});

adminHandler.callbackQuery("admin:services", async (ctx) => {
  if (!(await requireAdmin(ctx))) {
    await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  await ctx.reply("Направления (услуги):", {
    reply_markup: servicesAdminKeyboard(),
  });
});

adminHandler.callbackQuery("admin:services:list", async (ctx) => {
  if (!(await requireAdmin(ctx))) {
    await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  const services = await googleSheets.listServices(false);
  if (services.length === 0) {
    await ctx.reply("Список пуст.");
    return;
  }
  const lines = services.map(
    (s) =>
      `• ${s.name} — ${s.durationMin} мин, ${s.price}₽` +
      (s.active ? "" : " (выкл)"),
  );
  await ctx.reply(`🛠 Направления:\n\n${lines.join("\n")}`);
});

adminHandler.callbackQuery(/^admin:tr:(\d+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) {
    await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  await showTrainerCard(ctx, Number(ctx.match[1]));
});

adminHandler.callbackQuery(/^admin:tr:(\d+):week$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) {
    await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  const index = Number(ctx.match[1]);
  const workers = await googleSheets.listWorkers(true);
  const w = workers[index];
  if (!w) {
    await ctx.reply("Тренер не найден.");
    return;
  }
  try {
    const n = await googleSheets.generateSchedule(7, w.name);
    await ctx.reply(
      n === 0
        ? `У «${w.name}» неделя уже заполнена.`
        : `✅ Для «${w.name}» добавлено слотов: ${n}`,
    );
  } catch (err) {
    await ctx.reply(err instanceof Error ? err.message : "Ошибка");
  }
});

adminHandler.callbackQuery(/^admin:tr:(\d+):clients$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) {
    await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  const index = Number(ctx.match[1]);
  const workers = await googleSheets.listWorkers(true);
  const w = workers[index];
  if (!w) {
    await ctx.reply("Тренер не найден.");
    return;
  }
  const bookings = await googleSheets.listBookingsByWorker(w.name);
  if (bookings.length === 0) {
    await ctx.reply(`У «${w.name}» нет записей клиентов.`);
    return;
  }
  const lines: string[] = [`👥 Клиенты — ${w.name}:\n`];
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
});

adminHandler.callbackQuery(/^admin:tr:(\d+):slots$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) {
    await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  const index = Number(ctx.match[1]);
  const workers = await googleSheets.listWorkers(true);
  const w = workers[index];
  if (!w) {
    await ctx.reply("Тренер не найден.");
    return;
  }
  const slots = await googleSheets.listUpcomingSlotsByWorker(w.name, 7);
  if (slots.length === 0) {
    await ctx.reply(`Свободных слотов у «${w.name}» нет.`);
    return;
  }
  const lines = slots
    .slice(0, 40)
    .map((s) => `• ${s.date} ${s.time} — мест: ${s.freeSeats}`);
  await ctx.reply(
    `🕒 Свободно у «${w.name}» (до 40):\n\n${lines.join("\n")}`,
  );
});

adminHandler.callbackQuery(/^admin:tr:(\d+):off$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) {
    await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  const index = Number(ctx.match[1]);
  const workers = await googleSheets.listWorkers(true);
  const w = workers[index];
  if (!w) {
    await ctx.reply("Тренер не найден.");
    return;
  }
  try {
    await googleSheets.deactivateWorker(w.name);
    await ctx.reply(`Тренер «${w.name}» деактивирован (не показывается клиентам).`);
  } catch (err) {
    await ctx.reply(err instanceof Error ? err.message : "Ошибка");
  }
});

adminHandler.callbackQuery(/^admin:tr:(\d+):day$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) {
    await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  ctx.session.adminTrainerIndex = Number(ctx.match[1]);
  await ctx.conversation.enter("trainerDay");
});

adminHandler.callbackQuery(/^admin:tr:(\d+):deltime$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) {
    await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  ctx.session.adminTrainerIndex = Number(ctx.match[1]);
  await ctx.conversation.enter("trainerDelTime");
});

adminHandler.callbackQuery(/^admin:tr:(\d+):addtime$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) {
    await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  ctx.session.adminTrainerIndex = Number(ctx.match[1]);
  await ctx.conversation.enter("trainerAddTime");
});

adminHandler.callbackQuery("admin:sync_sheets", async (ctx) => {
  if (!(await requireAdmin(ctx))) {
    await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  try {
    await ctx.reply("Создаю/обновляю вкладки тренеров внизу таблицы...");
    const n = await googleSheets.syncAllTrainerSheets();
    await ctx.reply(
      `✅ Готово. Листов тренеров: ${n}\n` +
        `Откройте Google Таблицу — внизу появятся вкладки с именами тренеров.`,
    );
  } catch (err) {
    await ctx.reply(err instanceof Error ? err.message : "Ошибка");
  }
});

adminHandler.callbackQuery(/^admin:tr:(\d+):sheet$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) {
    await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  const index = Number(ctx.match[1]);
  const workers = await googleSheets.listWorkers(true);
  const w = workers[index];
  if (!w) {
    await ctx.reply("Тренер не найден.");
    return;
  }
  try {
    const url = await googleSheets.syncTrainerSheet(w.name);
    await ctx.reply(`📄 Лист «${w.name}» готов:\n${url}`, {
      reply_markup: trainerCardKeyboard(index, url),
      link_preview_options: { is_disabled: true },

    });
  } catch (err) {
    await ctx.reply(err instanceof Error ? err.message : "Ошибка");
  }
});

adminHandler.callbackQuery("admin:repair", async (ctx) => {
  if (!(await requireAdmin(ctx))) {
    await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  try {
    await ctx.reply("Исправляю даты/время и цвет в таблице...");
    const n = await googleSheets.repairScheduleDisplay();
    await ctx.reply(
      `✅ Готово. Строк обработано: ${n}\n` +
        `Даты → ДД.ММ.ГГГГ, время → ЧЧ:ММ, текст чёрный, шапка тёмная.`,
    );
  } catch (err) {
    await ctx.reply(err instanceof Error ? err.message : "Ошибка ремонта");
  }
});

adminHandler.callbackQuery("admin:seed", async (ctx) => {
  if (!(await requireAdmin(ctx))) {
    await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  try {
    await ctx.reply("Создаю демо-данные...");
    const r = await googleSheets.seedDemoData();
    await ctx.reply(
      `✅ Готово\nРаботники: +${r.workers}\nУслуги: +${r.services}\nСлоты: +${r.slots}`,
    );
  } catch (err) {
    await ctx.reply(err instanceof Error ? err.message : "Ошибка");
  }
});

adminHandler.command("seed_demo", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;
  try {
    const r = await googleSheets.seedDemoData();
    await ctx.reply(
      `✅ Готово\nРаботники: +${r.workers}\nУслуги: +${r.services}\nСлоты: +${r.slots}`,
    );
  } catch (err) {
    await ctx.reply(err instanceof Error ? err.message : "Ошибка");
  }
});

adminHandler.callbackQuery("admin:generate", async (ctx) => {
  if (!(await requireAdmin(ctx))) {
    await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  try {
    const n = await googleSheets.generateSchedule(7);
    await ctx.reply(
      n === 0 ? "Неделя уже заполнена." : `✅ Добавлено слотов: ${n}`,
    );
  } catch (err) {
    await ctx.reply(err instanceof Error ? err.message : "Ошибка");
  }
});

adminHandler.callbackQuery("admin:reset_schedule", async (ctx) => {
  if (!(await requireAdmin(ctx))) {
    await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  try {
    await googleSheets.clearScheduleAndBookings();
    await ctx.reply(
      "🧹 Расписание очищено, шапка A–J восстановлена.\n" +
        "Дальше: Тренеры → расписать неделю (или Демо-данные).",
    );
  } catch (err) {
    await ctx.reply(err instanceof Error ? err.message : "Ошибка сброса");
  }
});

export async function addWorkerConversation(
  conversation: BotConversation,
  ctx: BotContext,
): Promise<void> {
  await ctx.reply("Имя тренера:");
  const nameCtx = await conversation.waitFor("message:text");
  const name = nameCtx.message.text.trim();

  await ctx.reply(
    "Telegram-тег тренера (например Guzeev_96 или @Guzeev_96).\n" +
      "По нему проверяется уникальность и появляется кнопка «Клиенты».\n" +
      "Или «-», чтобы пропустить:",
  );
  const tgCtx = await conversation.waitFor("message:text");
  const tgRaw = tgCtx.message.text.trim();
  const telegram = tgRaw === "-" ? "" : tgRaw;

  try {
    const worker = await conversation.external(() =>
      googleSheets.addWorker(name, telegram),
    );
    const tag = worker.telegram ? ` (@${worker.telegram})` : "";
    await ctx.reply(
      worker.updated
        ? `✅ Тренер «${worker.name}» обновлён${tag}.`
        : `✅ Тренер «${worker.name}» добавлен${tag}.`,
    );
  } catch (err) {
    await ctx.reply(err instanceof Error ? err.message : "Ошибка");
  }
}

export async function addServiceConversation(
  conversation: BotConversation,
  ctx: BotContext,
): Promise<void> {
  await ctx.reply("Название направления/услуги:");
  const nameCtx = await conversation.waitFor("message:text");
  const name = nameCtx.message.text.trim();

  await ctx.reply("Длительность в минутах (например 90):");
  const durCtx = await conversation.waitFor("message:text");
  const durationMin = Number(durCtx.message.text.trim()) || 90;

  await ctx.reply("Цена (число):");
  const priceCtx = await conversation.waitFor("message:text");
  const price = Number(priceCtx.message.text.trim()) || 0;

  try {
    await conversation.external(() =>
      googleSheets.addService(name, durationMin, price),
    );
    await ctx.reply(`✅ «${name}» добавлено (${durationMin} мин, ${price}₽).`);
  } catch (err) {
    await ctx.reply(err instanceof Error ? err.message : "Ошибка");
  }
}

export async function delServiceConversation(
  conversation: BotConversation,
  ctx: BotContext,
): Promise<void> {
  const services = await conversation.external(() =>
    googleSheets.listServices(true),
  );
  if (services.length === 0) {
    await ctx.reply("Активных услуг нет.");
    return;
  }
  await ctx.reply(
    "Напишите точное название услуги для отключения:\n" +
      services.map((s) => `• ${s.name}`).join("\n"),
  );
  const nameCtx = await conversation.waitFor("message:text");
  try {
    await conversation.external(() =>
      googleSheets.deactivateService(nameCtx.message.text.trim()),
    );
    await ctx.reply("Услуга отключена.");
  } catch (err) {
    await ctx.reply(err instanceof Error ? err.message : "Ошибка");
  }
}

export async function trainerDayConversation(
  conversation: BotConversation,
  ctx: BotContext,
): Promise<void> {
  const index = await conversation.external(
    (c) => c.session.adminTrainerIndex ?? 0,
  );
  const workers = await conversation.external(() =>
    googleSheets.listWorkers(true),
  );
  const w = workers[index];
  if (!w) {
    await ctx.reply("Тренер не найден.");
    return;
  }
  await ctx.reply(
    `Дата для расписания «${w.name}» (ДД.ММ.ГГГГ):`,
  );
  const dateCtx = await conversation.waitFor("message:text");
  try {
    const n = await conversation.external(() =>
      googleSheets.generateDay(w.name, dateCtx.message.text.trim()),
    );
    await ctx.reply(
      n === 0
        ? "Все слоты этого дня уже есть."
        : `✅ Добавлено слотов на день: ${n}`,
    );
  } catch (err) {
    await ctx.reply(err instanceof Error ? err.message : "Ошибка");
  }
}

export async function trainerDelTimeConversation(
  conversation: BotConversation,
  ctx: BotContext,
): Promise<void> {
  const index = await conversation.external(
    (c) => c.session.adminTrainerIndex ?? 0,
  );
  const workers = await conversation.external(() =>
    googleSheets.listWorkers(true),
  );
  const w = workers[index];
  if (!w) {
    await ctx.reply("Тренер не найден.");
    return;
  }
  await ctx.reply(`Удаление времени у «${w.name}».\nДата (ДД.ММ.ГГГГ):`);
  const dateCtx = await conversation.waitFor("message:text");
  await ctx.reply("Время (ЧЧ:ММ):");
  const timeCtx = await conversation.waitFor("message:text");
  try {
    await conversation.external(() =>
      googleSheets.deleteSlot(
        dateCtx.message.text.trim(),
        timeCtx.message.text.trim(),
        w.name,
      ),
    );
    await ctx.reply("✅ Слот удалён из таблицы.");
  } catch (err) {
    if (err instanceof SlotNotFoundError) {
      await ctx.reply("Слот не найден.");
      return;
    }
    await ctx.reply(err instanceof Error ? err.message : "Ошибка");
  }
}

export async function trainerAddTimeConversation(
  conversation: BotConversation,
  ctx: BotContext,
): Promise<void> {
  const index = await conversation.external(
    (c) => c.session.adminTrainerIndex ?? 0,
  );
  const workers = await conversation.external(() =>
    googleSheets.listWorkers(true),
  );
  const w = workers[index];
  if (!w) {
    await ctx.reply("Тренер не найден.");
    return;
  }
  await ctx.reply(`Добавить время для «${w.name}».\nДата (ДД.ММ.ГГГГ):`);
  const dateCtx = await conversation.waitFor("message:text");
  await ctx.reply("Время (ЧЧ:ММ):");
  const timeCtx = await conversation.waitFor("message:text");
  try {
    await conversation.external(() =>
      googleSheets.addSlot(
        dateCtx.message.text.trim(),
        timeCtx.message.text.trim(),
        w.name,
      ),
    );
    await ctx.reply("✅ Слот добавлен.");
  } catch (err) {
    await ctx.reply(err instanceof Error ? err.message : "Ошибка");
  }
}

export async function manualBookConversation(
  conversation: BotConversation,
  ctx: BotContext,
): Promise<void> {
  await ctx.reply("Дата (ДД.ММ.ГГГГ):");
  const dateCtx = await conversation.waitFor("message:text");
  const date = dateCtx.message.text.trim();

  await ctx.reply("Время (ЧЧ:ММ):");
  const timeCtx = await conversation.waitFor("message:text");
  const time = timeCtx.message.text.trim();

  await ctx.reply("Имя тренера:");
  const wrkCtx = await conversation.waitFor("message:text");
  const worker = wrkCtx.message.text.trim();

  await ctx.reply("Услуга/направление:");
  const svcCtx = await conversation.waitFor("message:text");
  const service = svcCtx.message.text.trim();

  await ctx.reply("Имя клиента:");
  const nameCtx = await conversation.waitFor("message:text");
  const name = nameCtx.message.text.trim();

  await ctx.reply("Телефон клиента:");
  const phoneCtx = await conversation.waitFor("message:text");
  const phone = phoneCtx.message.text.trim();

  try {
    try {
      await conversation.external(() =>
        googleSheets.bookSlot(date, time, worker, service, name, phone),
      );
    } catch (err) {
      if (err instanceof SlotNotFoundError) {
        await conversation.external(() =>
          googleSheets.addSlot(date, time, worker, service),
        );
        await conversation.external(() =>
          googleSheets.bookSlot(date, time, worker, service, name, phone),
        );
      } else {
        throw err;
      }
    }
    await ctx.reply(
      `✅ ${name} записан на ${date} ${time} к «${worker}» (${service}).`,
    );
  } catch (err) {
    await ctx.reply(err instanceof Error ? err.message : "Ошибка записи");
  }
}

adminHandler.callbackQuery("admin:add_worker", async (ctx) => {
  if (!(await requireAdmin(ctx))) {
    await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  await ctx.conversation.enter("addWorker");
});

adminHandler.callbackQuery("admin:add_service", async (ctx) => {
  if (!(await requireAdmin(ctx))) {
    await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  await ctx.conversation.enter("addService");
});

adminHandler.callbackQuery("admin:del_service", async (ctx) => {
  if (!(await requireAdmin(ctx))) {
    await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  await ctx.conversation.enter("delService");
});

adminHandler.callbackQuery("admin:manual_book", async (ctx) => {
  if (!(await requireAdmin(ctx))) {
    await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  await ctx.conversation.enter("manualBook");
});
