import { config } from "../config.js";
import type { BotContext } from "../context.js";

export function isAdmin(ctx: BotContext): boolean {
  const from = ctx.from;
  if (!from) return false;

  if (config.adminId != null && from.id === config.adminId) {
    return true;
  }

  const username = from.username?.toLowerCase();
  if (username && config.adminUsernames.includes(username)) {
    return true;
  }

  return false;
}

export async function requireAdmin(ctx: BotContext): Promise<boolean> {
  if (!isAdmin(ctx)) {
    await ctx.reply("Эта команда доступна только администратору.");
    return false;
  }
  return true;
}
