import { Composer } from "grammy";
import type { BotContext } from "../context.js";
import { googleSheets } from "../services/googleSheets.js";

export const cancelHandler = new Composer<BotContext>();

cancelHandler.command("cancel", async (ctx) => {
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
    );
    await ctx.reply(
      `Запись на ${slot.date} в ${slot.time} (${slot.worker}) отменена.`,
    );
  } catch (err) {
    console.error(err);
    await ctx.reply(
      err instanceof Error ? err.message : "Не удалось отменить запись.",
    );
  }
});
