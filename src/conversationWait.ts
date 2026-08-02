import type { BotConversation } from "./context.js";

function isStartCommand(text: string | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  return t === "/start" || t.startsWith("/start@") || t.startsWith("/start ");
}

/**
 * Ждём callback. /start не глушит бота — диалог завершается,
 * апдейт уходит в обычные хендлеры (меню снова работает).
 */
export async function waitCallbackData(conversation: BotConversation) {
  return conversation.waitFor("callback_query:data", {
    otherwise: async (ctx) => {
      if (isStartCommand(ctx.message?.text)) {
        await conversation.halt({ next: true });
        return;
      }
      await ctx.reply(
        "Нажмите кнопку под сообщением выше.\nИли отправьте /start, чтобы выйти в меню.",
      );
    },
  });
}

export async function waitTextMessage(conversation: BotConversation) {
  return conversation.waitFor("message:text", {
    otherwise: async (ctx) => {
      if (isStartCommand(ctx.message?.text)) {
        await conversation.halt({ next: true });
        return;
      }
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery().catch(() => undefined);
        await ctx.reply("Отправьте текст сообщением или /start для выхода.");
        return;
      }
      await ctx.reply("Нужен текстовый ответ, или /start для выхода.");
    },
  });
}
