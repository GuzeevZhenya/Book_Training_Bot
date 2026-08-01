import { InlineKeyboard } from "grammy";
import type { Worker } from "../types.js";

export function adminMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("👥 Тренеры и расписание", "admin:trainers")
    .row()
    .text("🛠 Направления (услуги)", "admin:services")
    .row()
    .text("📋 Записи сегодня/завтра", "admin:bookings")
    .row()
    .text("✍️ Записать клиента вручную", "admin:manual_book")
    .row()
    .text("🎲 Демо-данные + неделя", "admin:seed")
    .row()
    .text("🖤 Исправить даты и цвет", "admin:repair")
    .row()
    .text("📑 Листы тренеров (вкладки)", "admin:sync_sheets")
    .row()
    .text("🧹 Сбросить кривое расписание", "admin:reset_schedule")
    .row()
    .text("📆 Неделя для ВСЕХ тренеров", "admin:generate");
}

export function trainersListKeyboard(workers: Worker[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  workers.forEach((w, i) => {
    const tg = w.telegram ? ` (@${w.telegram})` : "";
    kb.text(`👤 ${w.name}${tg}`, `admin:tr:${i}`).row();
  });
  kb.text("➕ Добавить тренера", "admin:add_worker").row();
  kb.text("« В админ-меню", "admin:home");
  return kb;
}

export function trainerCardKeyboard(
  index: number,
  sheetUrl?: string,
): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text("📆 Расписать неделю", `admin:tr:${index}:week`)
    .row()
    .text("📅 Расписать день", `admin:tr:${index}:day`)
    .row()
    .text("🕒 Свободные слоты", `admin:tr:${index}:slots`)
    .row()
    .text("👥 Клиенты этого тренера", `admin:tr:${index}:clients`)
    .row();

  if (sheetUrl) {
    kb.url("📄 Открыть лист тренера", sheetUrl).row();
  } else {
    kb.text("📄 Создать/обновить лист", `admin:tr:${index}:sheet`).row();
  }

  kb.text("🗑 Удалить время", `admin:tr:${index}:deltime`)
    .row()
    .text("➕ Добавить одно время", `admin:tr:${index}:addtime`)
    .row()
    .text("❌ Деактивировать тренера", `admin:tr:${index}:off`)
    .row()
    .text("« К списку тренеров", "admin:trainers");
  return kb;
}

export function servicesAdminKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📋 Список направлений", "admin:services:list")
    .row()
    .text("➕ Добавить направление", "admin:add_service")
    .row()
    .text("🗑 Удалить направление", "admin:del_service")
    .row()
    .text("« В админ-меню", "admin:home");
}
