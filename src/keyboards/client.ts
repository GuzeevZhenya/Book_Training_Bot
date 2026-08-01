import { Keyboard, InlineKeyboard } from "grammy";
import type { Service, Slot, Worker } from "../types.js";

export const BTN_BOOK = "📅 Записаться";
export const BTN_MY = "📋 Мои записи";
export const BTN_PROFILE = "👤 Мои данные";
export const BTN_HEALTH = "🩺 Здоровье";
export const BTN_INFO = "ℹ️ Информация";
export const BTN_CANCEL = "❌ Отменить запись";
export const BTN_ADMIN = "🛠 Админ-панель";
export const BTN_TRAINER_CLIENTS_PREFIX = "👥 Клиенты:";

export function clientMainKeyboard(options?: {
  isAdmin?: boolean;
  trainerName?: string;
}): Keyboard {
  const kb = new Keyboard()
    .text(BTN_BOOK)
    .text(BTN_MY)
    .row()
    .text(BTN_PROFILE)
    .text(BTN_HEALTH)
    .row()
    .text(BTN_CANCEL)
    .text(BTN_INFO);

  if (options?.trainerName) {
    kb.row().text(`${BTN_TRAINER_CLIENTS_PREFIX} ${options.trainerName}`);
  }

  if (options?.isAdmin) {
    kb.row().text(BTN_ADMIN);
  }

  return kb.resized().persistent();
}

export function servicesKeyboard(services: Service[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (let i = 0; i < services.length; i++) {
    const s = services[i]!;
    const price = s.price ? ` — ${s.price}₽` : "";
    kb.text(`${s.name}${price}`, `wiz:svc:${i}`).row();
  }
  kb.text("« Назад", "wiz:back:time").row();
  kb.text("« Отмена", "wiz:cancel");
  return kb;
}

export function workersKeyboard(workers: Worker[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (let i = 0; i < workers.length; i++) {
    kb.text(`👤 ${workers[i]!.name}`, `wiz:wrk:${i}`).row();
  }
  kb.text("« Отмена", "wiz:cancel");
  return kb;
}

export function datesKeyboard(dates: string[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  dates.forEach((d, i) => {
    kb.text(`📆 ${d}`, `wiz:date:${i}`);
    if (i % 2 === 1) kb.row();
  });
  if (dates.length % 2 === 1) kb.row();
  kb.text("« Назад", "wiz:back:wrk").row();
  kb.text("« Отмена", "wiz:cancel");
  return kb;
}

function seatLabel(slot: Slot): string {
  if (slot.freeSeats >= 2) return "2 места";
  if (slot.freeSeats === 1) return "1 место";
  return "нет";
}

export function timesKeyboard(slots: Slot[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  slots.forEach((s, i) => {
    kb.text(`🕒 ${s.time} (${seatLabel(s)})`, `wiz:time:${i}`);
    if (i % 2 === 1) kb.row();
  });
  if (slots.length % 2 === 1) kb.row();
  kb.text("« Назад", "wiz:back:date").row();
  kb.text("« Отмена", "wiz:cancel");
  return kb;
}

export function healthActionsKeyboard(hasIssues: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  kb.text(hasIssues ? "✏️ Изменить" : "➕ Указать", "health:edit").row();
  if (hasIssues) {
    kb.text("🗑 Очистить", "health:clear").row();
  }
  kb.text("« Готово", "health:done");
  return kb;
}
