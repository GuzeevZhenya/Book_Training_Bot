import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";

loadDotenv();

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Отсутствует обязательная переменная окружения: ${name}`);
  }
  return value;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envTime(name: string, fallback: string): string {
  const raw = process.env[name]?.trim() || fallback;
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (!match) return fallback;
  return `${String(Number(match[1])).padStart(2, "0")}:${match[2]}`;
}

function parseUsernames(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(/[,;\s]+/)
    .map((u) => u.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean);
}

const adminUsernames = parseUsernames(
  process.env.ADMIN_USERNAMES || "DarinaDv2,Guzeev_96",
);

const adminIdRaw = process.env.ADMIN_ID?.trim();
const adminId = adminIdRaw ? Number(adminIdRaw) : NaN;

export const config = {
  botToken: requireEnv("BOT_TOKEN"),
  /** Числовой id (опционально, дополнительно к username) */
  adminId: Number.isFinite(adminId) ? adminId : null,
  adminUsernames,
  spreadsheetId: requireEnv("SPREADSHEET_ID"),
  sheetName: process.env.SHEET_NAME?.trim() || "Расписание",
  googleCredentialsPath: resolve(
    process.cwd(),
    process.env.GOOGLE_CREDENTIALS_PATH?.trim() ||
      "./credentials/service-account.json",
  ),
  timezone: process.env.TIMEZONE?.trim() || "Europe/Moscow",
  slotCapacity: envInt("SLOT_CAPACITY", 2),
  workStart: envTime("WORK_START", "10:00"),
  workEnd: envTime("WORK_END", "20:00"),
  slotIntervalMinutes: envInt("SLOT_INTERVAL_MINUTES", 90),
} as const;
