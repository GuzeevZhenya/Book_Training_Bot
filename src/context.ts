import type { Context, SessionFlavor } from "grammy";
import type {
  Conversation,
  ConversationFlavor,
} from "@grammyjs/conversations";
import type { SessionData } from "./types.js";

export type SessionContext = Context & SessionFlavor<SessionData>;
export type BotContext = ConversationFlavor<SessionContext>;
export type BotConversation = Conversation<BotContext, BotContext>;
