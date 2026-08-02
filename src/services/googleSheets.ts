import { readFileSync } from "node:fs";
import { google, sheets_v4 } from "googleapis";
import { config } from "../config.js";
import {
  ClientProfile,
  Service,
  Slot,
  SlotAlreadyBookedError,
  SlotNotFoundError,
  SlotStatus,
  Worker,
} from "../types.js";

const STATUS_FREE: SlotStatus = "Свободно";
const STATUS_HALF: SlotStatus = "1/2";
const STATUS_BUSY: SlotStatus = "Занято";

const SHEET_WORKERS = "Работники";
const SHEET_SERVICES = "Услуги";
const SHEET_CLIENTS = "Клиенты";
const SHEET_SCHEDULE = config.sheetName || "Расписание";

/** Расписание A–L (+ здоровье) */
const SCHEDULE_RANGE = `'${SHEET_SCHEDULE}'!A:L`;
const WORKERS_RANGE = `'${SHEET_WORKERS}'!A:D`;
const SERVICES_RANGE = `'${SHEET_SERVICES}'!A:D`;
const CLIENTS_RANGE = `'${SHEET_CLIENTS}'!A:F`;

const RESERVED_SHEETS = new Set([
  SHEET_SCHEDULE,
  SHEET_WORKERS,
  SHEET_SERVICES,
  SHEET_CLIENTS,
  "Sheet1",
  "Лист1",
]);

const SCHEDULE_HEADER = [
  "Дата",
  "Время",
  "Работник",
  "Услуга",
  "Статус",
  "Имя 1",
  "Телефон 1",
  "Имя 2",
  "Телефон 2",
  "Примечание",
  "Здоровье 1",
  "Здоровье 2",
];

function cellRange(
  sheet: string,
  startCol: string,
  endCol: string,
  row: number,
): string {
  return `'${sheet}'!${startCol}${row}:${endCol}${row}`;
}

function fromSheetText(value: string): string {
  const v = (value ?? "").trim();
  return v.startsWith("'") ? v.slice(1) : v;
}

/** Google Sheets serial date → ДД.ММ.ГГГГ */
function serialToDateString(serial: number): string {
  const whole = Math.floor(serial);
  const utc = Date.UTC(1899, 11, 30) + whole * 86400000;
  const d = new Date(utc);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

/** Google Sheets serial time (fraction of day) → ЧЧ:ММ */
function serialToTimeString(serial: number): string {
  let fraction = serial;
  if (fraction >= 1) fraction = fraction % 1;
  const totalMinutes = Math.round(fraction * 24 * 60) % (24 * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Нормализация ячейки даты (текст или serial) */
function normalizeDateCell(raw: unknown): string {
  if (raw == null || raw === "") return "";
  if (typeof raw === "number") {
    if (raw > 1000) return serialToDateString(raw);
    return "";
  }
  const s = String(raw).trim();
  // строки-разделители из UI-таблицы Google («Дата: 06.08.2026»)
  if (/^дата\s*:/i.test(s)) return "";
  if (/^\d{2}\.\d{2}\.\d{4}$/.test(s)) return s;
  const asNum = Number(s.replace(",", "."));
  if (Number.isFinite(asNum) && asNum > 1000 && !s.includes(":")) {
    return serialToDateString(asNum);
  }
  return "";
}

/** Нормализация ячейки времени */
function normalizeTimeCell(raw: unknown): string {
  if (raw == null || raw === "") return "";
  if (typeof raw === "number") {
    return serialToTimeString(raw);
  }
  const s = String(raw).trim();
  if (/^\d{1,2}:\d{2}$/.test(s)) return normalizeTime(s);
  const asNum = Number(s.replace(",", "."));
  if (Number.isFinite(asNum) && asNum < 1.5) {
    return serialToTimeString(asNum);
  }
  return normalizeTime(fromSheetText(s));
}

function parseSheetDate(dateStr: string): Date | null {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(dateStr.trim());
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const d = new Date(year, month - 1, day);
  if (
    d.getFullYear() !== year ||
    d.getMonth() !== month - 1 ||
    d.getDate() !== day
  ) {
    return null;
  }
  d.setHours(0, 0, 0, 0);
  return d;
}

function todayInTimezone(): Date {
  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: config.timezone }),
  );
  now.setHours(0, 0, 0, 0);
  return now;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function formatDateKey(date: Date): string {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = date.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

function normalizeTime(time: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return time.trim();
  return `${String(Number(match[1])).padStart(2, "0")}:${match[2]}`;
}

function normalizeDate(date: string): string {
  return date.trim();
}

function timeToMinutes(time: string): number {
  const t = normalizeTime(time);
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function minutesToTime(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function isDateInRange(dateStr: string, from: Date, toExclusive: Date): boolean {
  const parsed = parseSheetDate(dateStr);
  if (!parsed) return false;
  return parsed >= from && parsed < toExclusive;
}

function statusFromCount(count: number): SlotStatus {
  if (count <= 0) return STATUS_FREE;
  if (count >= config.slotCapacity) return STATUS_BUSY;
  return STATUS_HALF;
}

function isYes(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === "да" || v === "yes" || v === "1" || v === "true" || v === "";
}

function buildDayTimes(): string[] {
  const start = timeToMinutes(config.workStart);
  const end = timeToMinutes(config.workEnd);
  const step = config.slotIntervalMinutes;
  const times: string[] = [];
  for (let t = start; t <= end; t += step) {
    times.push(minutesToTime(t));
  }
  return times;
}

function rowToSlot(row: unknown[], rowIndex: number): Slot | null {
  const date = normalizeDateCell(row[0]);
  const time = normalizeTimeCell(row[1]);
  if (!date || !time) return null;

  const worker = fromSheetText(String(row[2] ?? ""));
  const service = fromSheetText(String(row[3] ?? ""));
  const clientName = fromSheetText(String(row[5] ?? ""));
  const clientContact = fromSheetText(String(row[6] ?? ""));
  const clientName2 = fromSheetText(String(row[7] ?? ""));
  const clientContact2 = fromSheetText(String(row[8] ?? ""));
  const note = fromSheetText(String(row[9] ?? ""));
  const health1 = fromSheetText(String(row[10] ?? ""));
  const health2 = fromSheetText(String(row[11] ?? ""));

  let bookedCount = 0;
  if (clientName || clientContact) bookedCount += 1;
  if (clientName2 || clientContact2) bookedCount += 1;
  bookedCount = Math.min(bookedCount, config.slotCapacity);

  return {
    rowIndex,
    date,
    time: normalizeTime(time),
    worker,
    service,
    status: statusFromCount(bookedCount),
    clientName,
    clientContact,
    clientName2,
    clientContact2,
    note,
    health1,
    health2,
    bookedCount,
    freeSeats: config.slotCapacity - bookedCount,
  };
}

/** Строка расписания для записи как ТЕКСТ (без serial-дат) */
function scheduleRowValues(parts: {
  date: string;
  time: string;
  worker: string;
  service?: string;
  status?: string;
  name1?: string;
  phone1?: string;
  name2?: string;
  phone2?: string;
  note?: string;
  health1?: string;
  health2?: string;
}): string[] {
  return [
    parts.date,
    parts.time,
    parts.worker,
    parts.service ?? "",
    parts.status ?? STATUS_FREE,
    parts.name1 ?? "",
    parts.phone1 ?? "",
    parts.name2 ?? "",
    parts.phone2 ?? "",
    parts.note ?? "",
    parts.health1 ?? "",
    parts.health2 ?? "",
  ];
}

function contactsMatch(a: string, b: string): boolean {
  const na = a.trim().toLowerCase().replace(/^@/, "").replace(/^\+/, "");
  const nb = b.trim().toLowerCase().replace(/^@/, "").replace(/^\+/, "");
  if (!na || !nb) return false;
  return na === nb || a.trim() === b.trim();
}

/** tg1:ID / tg2:ID (+ legacy tg:ID по порядку мест) */
function parseSeatTelegramIds(note: string): { seat1?: string; seat2?: string } {
  const parts = note
    .split("|")
    .map((p) => p.trim())
    .filter(Boolean);

  let seat1: string | undefined;
  let seat2: string | undefined;
  const legacy: string[] = [];

  for (const p of parts) {
    const m1 = /^tg1:(\d+)$/.exec(p);
    const m2 = /^tg2:(\d+)$/.exec(p);
    const ml = /^tg:(\d+)$/.exec(p);
    if (m1) seat1 = m1[1];
    else if (m2) seat2 = m2[1];
    else if (ml) legacy.push(ml[1]!);
  }

  if (!seat1 && legacy[0]) seat1 = legacy[0];
  if (!seat2 && legacy[1]) seat2 = legacy[1];
  // один legacy tg и занято только место 2
  if (!seat2 && legacy[0] && !seat1) seat1 = legacy[0];

  return { seat1, seat2 };
}

function buildNoteWithSeats(
  existingNote: string,
  seat: 1 | 2,
  telegramId?: number,
): string {
  const ids = parseSeatTelegramIds(existingNote);
  if (seat === 1 && telegramId) ids.seat1 = String(telegramId);
  if (seat === 2 && telegramId) ids.seat2 = String(telegramId);

  const parts: string[] = [];
  if (ids.seat1) parts.push(`tg1:${ids.seat1}`);
  if (ids.seat2) parts.push(`tg2:${ids.seat2}`);
  return parts.join(" | ");
}

function clearSeatFromNote(note: string, seat: 1 | 2): string {
  const ids = parseSeatTelegramIds(note);
  if (seat === 1) {
    // после отмены место1 ← данные места2
    ids.seat1 = ids.seat2;
    ids.seat2 = undefined;
  } else {
    ids.seat2 = undefined;
  }
  const parts: string[] = [];
  if (ids.seat1) parts.push(`tg1:${ids.seat1}`);
  if (ids.seat2) parts.push(`tg2:${ids.seat2}`);
  return parts.join(" | ");
}

function nowInTimezone(): Date {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: config.timezone }),
  );
}

function slotDateTime(dateStr: string, timeStr: string): Date | null {
  const d = parseSheetDate(dateStr);
  if (!d) return null;
  const t = normalizeTime(timeStr);
  const tm = /^(\d{2}):(\d{2})$/.exec(t);
  if (!tm) return null;
  const result = new Date(d);
  result.setHours(Number(tm[1]), Number(tm[2]), 0, 0);
  return result;
}

function isSlotInPast(dateStr: string, timeStr: string): boolean {
  const dt = slotDateTime(dateStr, timeStr);
  if (!dt) return false;
  return dt.getTime() < nowInTimezone().getTime();
}

/** Имя вкладки для тренера (ограничения Google Sheets) */
function trainerSheetTitle(workerName: string): string {
  let title = workerName
    .trim()
    .replace(/[:\\/?*\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 90);
  if (!title) title = "Тренер";
  if (RESERVED_SHEETS.has(title)) {
    title = `Тр ${title}`.slice(0, 90);
  }
  return title;
}

function trainerSheetUrl(sheetId: number): string {
  return `https://docs.google.com/spreadsheets/d/${config.spreadsheetId}/edit#gid=${sheetId}`;
}

const DEMO_WORKERS = [
  "Анна Ковалёва",
  "Дмитрий Орлов",
  "Мария Смирнова",
];

const DEMO_SERVICES: Array<[string, number, number]> = [
  ["Персональная тренировка", 90, 2500],
  ["Функциональный тренинг", 90, 2000],
  ["Консультация", 60, 1000],
];

export class GoogleSheetsService {
  private sheets: sheets_v4.Sheets | null = null;

  /** Кэш метаданных листов (titles), чтобы не дергать spreadsheets.get на каждый вызов */
  private sheetTitlesCache: { at: number; titles: Set<string> } | null = null;
  private structureReadyAt = 0;
  private slotsCache: { at: number; slots: Slot[] } | null = null;
  private lastPastCleanupAt = 0;
  private clientsCache: { at: number; rows: ClientProfile[] } | null = null;

  private static STRUCTURE_TTL_MS = 10 * 60_000;
  private static META_TTL_MS = 5 * 60_000;
  private static SLOTS_TTL_MS = 20_000;
  private static CLIENTS_TTL_MS = 30_000;
  private static PAST_CLEANUP_TTL_MS = 5 * 60_000;

  private invalidateSlotsCache(): void {
    this.slotsCache = null;
  }

  private invalidateClientsCache(): void {
    this.clientsCache = null;
  }

  private loadCredentials(): object {
    if (config.googleCredentialsJson) {
      return JSON.parse(config.googleCredentialsJson) as object;
    }
    return JSON.parse(
      readFileSync(config.googleCredentialsPath, "utf-8"),
    ) as object;
  }

  private async getClient(): Promise<sheets_v4.Sheets> {
    if (this.sheets) return this.sheets;

    const credentials = this.loadCredentials();

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    this.sheets = google.sheets({ version: "v4", auth });
    return this.sheets;
  }

  private async getSheetTitles(force = false): Promise<Set<string>> {
    const now = Date.now();
    if (
      !force &&
      this.sheetTitlesCache &&
      now - this.sheetTitlesCache.at < GoogleSheetsService.META_TTL_MS
    ) {
      return this.sheetTitlesCache.titles;
    }
    const sheets = await this.getClient();
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: config.spreadsheetId,
      fields: "sheets.properties.title",
    });
    const titles = new Set(
      (meta.data.sheets ?? [])
        .map((s) => s.properties?.title)
        .filter((t): t is string => Boolean(t)),
    );
    this.sheetTitlesCache = { at: now, titles };
    return titles;
  }

  private async getSheetIdByTitle(title: string): Promise<number> {
    const sheets = await this.getClient();
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: config.spreadsheetId,
      fields: "sheets.properties",
    });
    const sheet = (meta.data.sheets ?? []).find(
      (s) => s.properties?.title === title,
    );
    const id = sheet?.properties?.sheetId;
    if (id == null) throw new Error(`Лист «${title}» не найден`);
    return id;
  }

  /**
   * Чинит даты/время (serial → текст), чёрный шрифт, белый фон, формат TEXT.
   */
  async repairScheduleDisplay(): Promise<number> {
    await this.ensureStructure();
    const sheets = await this.getClient();
    const sheetId = await this.getSheetIdByTitle(SHEET_SCHEDULE);

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: config.spreadsheetId,
      range: SCHEDULE_RANGE,
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const values = response.data.values ?? [];
    if (values.length <= 1) {
      await this.applyScheduleStyles(sheetId);
      return 0;
    }

    const out: string[][] = [SCHEDULE_HEADER];
    for (let i = 1; i < values.length; i++) {
      const row = values[i] as unknown[];
      const date = normalizeDateCell(row[0]);
      const time = normalizeTimeCell(row[1]);
      if (!date || !time) continue;
      out.push(
        scheduleRowValues({
          date,
          time,
          worker: fromSheetText(String(row[2] ?? "")),
          service: fromSheetText(String(row[3] ?? "")),
          status: fromSheetText(String(row[4] ?? "")) || STATUS_FREE,
          name1: fromSheetText(String(row[5] ?? "")),
          phone1: fromSheetText(String(row[6] ?? "")),
          name2: fromSheetText(String(row[7] ?? "")),
          phone2: fromSheetText(String(row[8] ?? "")),
          note: fromSheetText(String(row[9] ?? "")),
          health1: fromSheetText(String(row[10] ?? "")),
          health2: fromSheetText(String(row[11] ?? "")),
        }),
      );
    }

    await sheets.spreadsheets.values.clear({
      spreadsheetId: config.spreadsheetId,
      range: SCHEDULE_RANGE,
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: config.spreadsheetId,
      range: `'${SHEET_SCHEDULE}'!A1`,
      valueInputOption: "RAW",
      requestBody: { values: out },
    });

    await this.applyScheduleStyles(sheetId);
    await this.normalizeBookingNotes().catch(console.error);
    await this.syncAllTrainerSheets().catch(console.error);
    return out.length - 1;
  }

  /** Приводит Примечание к виду tg1:ID | tg2:ID */
  async normalizeBookingNotes(): Promise<number> {
    const slots = await this.readAllSlots();
    let fixed = 0;
    for (const s of slots) {
      if (!s.note.trim()) continue;
      const ids = parseSeatTelegramIds(s.note);
      const parts: string[] = [];
      if (ids.seat1) parts.push(`tg1:${ids.seat1}`);
      if (ids.seat2) parts.push(`tg2:${ids.seat2}`);
      const next = parts.join(" | ");
      if (next === s.note.trim()) continue;
      s.note = next;
      await this.writeBookingColumns(s);
      fixed += 1;
    }
    return fixed;
  }

  private async applyScheduleStyles(sheetId: number): Promise<void> {
    const sheets = await this.getClient();
    const black = { red: 0, green: 0, blue: 0 };
    const white = { red: 1, green: 1, blue: 1 };
    const headerBg = { red: 0.12, green: 0.12, blue: 0.12 };

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.spreadsheetId,
      requestBody: {
        requests: [
          // Все ячейки: чёрный текст, белый фон, формат TEXT
          {
            repeatCell: {
              range: {
                sheetId,
                startRowIndex: 0,
                endRowIndex: 2000,
                startColumnIndex: 0,
                endColumnIndex: 12,
              },
              cell: {
                userEnteredFormat: {
                  textFormat: {
                    foregroundColor: black,
                    fontSize: 10,
                    bold: false,
                  },
                  backgroundColor: white,
                  horizontalAlignment: "LEFT",
                  numberFormat: { type: "TEXT" },
                },
              },
              fields:
                "userEnteredFormat(textFormat,backgroundColor,horizontalAlignment,numberFormat)",
            },
          },
          // Шапка: тёмный фон, белый жирный текст
          {
            repeatCell: {
              range: {
                sheetId,
                startRowIndex: 0,
                endRowIndex: 1,
                startColumnIndex: 0,
                endColumnIndex: 12,
              },
              cell: {
                userEnteredFormat: {
                  textFormat: {
                    foregroundColor: white,
                    fontSize: 10,
                    bold: true,
                  },
                  backgroundColor: headerBg,
                  horizontalAlignment: "CENTER",
                  numberFormat: { type: "TEXT" },
                },
              },
              fields:
                "userEnteredFormat(textFormat,backgroundColor,horizontalAlignment,numberFormat)",
            },
          },
        ],
      },
    });
  }

  /**
   * Создаёт вкладку тренера внизу таблицы и возвращает ссылку.
   */
  async ensureTrainerSheet(workerName: string): Promise<string> {
    const title = trainerSheetTitle(workerName);
    const sheets = await this.getClient();

    const meta = await sheets.spreadsheets.get({
      spreadsheetId: config.spreadsheetId,
      fields: "sheets.properties",
    });
    let sheet = (meta.data.sheets ?? []).find(
      (s) => s.properties?.title === title,
    );

    if (!sheet) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: config.spreadsheetId,
        requestBody: {
          requests: [{ addSheet: { properties: { title } } }],
        },
      });
      const meta2 = await sheets.spreadsheets.get({
        spreadsheetId: config.spreadsheetId,
        fields: "sheets.properties",
      });
      sheet = (meta2.data.sheets ?? []).find(
        (s) => s.properties?.title === title,
      );
    }

    const sheetId = sheet?.properties?.sheetId;
    if (sheetId == null) {
      throw new Error(`Не удалось создать лист «${title}»`);
    }

    const url = trainerSheetUrl(sheetId);
    await this.saveWorkerSheetUrl(workerName, url);
    return url;
  }

  private async saveWorkerSheetUrl(
    workerName: string,
    url: string,
  ): Promise<void> {
    const workers = await this.listWorkers(false);
    const w = workers.find(
      (x) => x.name.toLowerCase() === workerName.trim().toLowerCase(),
    );
    if (!w) return;
    const sheets = await this.getClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.spreadsheetId,
      range: cellRange(SHEET_WORKERS, "D", "D", w.rowIndex),
      valueInputOption: "RAW",
      requestBody: { values: [[url]] },
    });
  }

  /** Пересобирает личный лист тренера из общего «Расписание» */
  async syncTrainerSheet(workerName: string): Promise<string> {
    const url = await this.ensureTrainerSheet(workerName);
    const title = trainerSheetTitle(workerName);
    const sheets = await this.getClient();
    const sheetId = await this.getSheetIdByTitle(title);

    const all = await this.readAllSlots();
    const mine = all.filter(
      (s) => s.worker.trim().toLowerCase() === workerName.trim().toLowerCase(),
    );

    const out: string[][] = [SCHEDULE_HEADER];
    for (const s of mine) {
      out.push(
        scheduleRowValues({
          date: s.date,
          time: s.time,
          worker: s.worker,
          service: s.service,
          status: s.status,
          name1: s.clientName,
          phone1: s.clientContact,
          name2: s.clientName2,
          phone2: s.clientContact2,
          note: s.note,
          health1: s.health1,
          health2: s.health2,
        }),
      );
    }

    await sheets.spreadsheets.values.clear({
      spreadsheetId: config.spreadsheetId,
      range: `'${title}'!A:L`,
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.spreadsheetId,
      range: `'${title}'!A1`,
      valueInputOption: "RAW",
      requestBody: { values: out },
    });
    await this.applyScheduleStyles(sheetId);
    return url;
  }

  async syncAllTrainerSheets(): Promise<number> {
    const workers = await this.listWorkers(true);
    for (const w of workers) {
      await this.syncTrainerSheet(w.name);
    }
    return workers.length;
  }

  async getTrainerSheetUrl(workerName: string): Promise<string> {
    const workers = await this.listWorkers(false);
    const w = workers.find(
      (x) => x.name.toLowerCase() === workerName.trim().toLowerCase(),
    );
    if (w?.sheetUrl) return w.sheetUrl;
    return this.syncTrainerSheet(workerName);
  }

  private async ensureSheetExists(title: string): Promise<void> {
    const titles = await this.getSheetTitles();
    if (titles.has(title)) return;

    const sheets = await this.getClient();
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title } } }],
      },
    });
    titles.add(title);
    this.sheetTitlesCache = { at: Date.now(), titles };
  }

  async ensureStructure(force = false): Promise<void> {
    const now = Date.now();
    if (
      !force &&
      this.structureReadyAt &&
      now - this.structureReadyAt < GoogleSheetsService.STRUCTURE_TTL_MS
    ) {
      return;
    }

    await this.ensureSheetExists(SHEET_WORKERS);
    await this.ensureSheetExists(SHEET_SERVICES);
    await this.ensureSheetExists(SHEET_SCHEDULE);
    await this.ensureSheetExists(SHEET_CLIENTS);

    const sheets = await this.getClient();

    const workers = await sheets.spreadsheets.values.get({
      spreadsheetId: config.spreadsheetId,
      range: WORKERS_RANGE,
    });
    if (!workers.data.values?.length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: config.spreadsheetId,
        range: `'${SHEET_WORKERS}'!A1:D1`,
        valueInputOption: "RAW",
        requestBody: {
          values: [["Имя", "Активен", "Telegram", "Ссылка на лист"]],
        },
      });
    }

    const services = await sheets.spreadsheets.values.get({
      spreadsheetId: config.spreadsheetId,
      range: SERVICES_RANGE,
    });
    if (!services.data.values?.length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: config.spreadsheetId,
        range: `'${SHEET_SERVICES}'!A1:D1`,
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [["Название", "Длительность_мин", "Цена", "Активен"]],
        },
      });
    }

    const clients = await sheets.spreadsheets.values.get({
      spreadsheetId: config.spreadsheetId,
      range: CLIENTS_RANGE,
    });
    if (!clients.data.values?.length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: config.spreadsheetId,
        range: `'${SHEET_CLIENTS}'!A1:F1`,
        valueInputOption: "RAW",
        requestBody: {
          values: [
            [
              "Telegram ID",
              "Имя",
              "Телефон",
              "Username",
              "Проблемы со здоровьем",
              "Обновлено",
            ],
          ],
        },
      });
    }

    // Шапка Расписания — только при первом ensure / force (не на каждый клик)
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.spreadsheetId,
      range: `'${SHEET_SCHEDULE}'!A1:L1`,
      valueInputOption: "RAW",
      requestBody: { values: [SCHEDULE_HEADER] },
    });

    try {
      const sheetId = await this.getSheetIdByTitle(SHEET_SCHEDULE);
      await this.applyScheduleStyles(sheetId);
    } catch {
      // ignore style errors on first create
    }

    this.structureReadyAt = Date.now();
  }

  /** Очистить все строки расписания кроме шапки (если колонки «поехали») */
  async resetSchedule(): Promise<void> {
    await this.ensureStructure(true);
    const sheets = await this.getClient();
    await sheets.spreadsheets.values.clear({
      spreadsheetId: config.spreadsheetId,
      range: `'${SHEET_SCHEDULE}'!A2:L`,
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.spreadsheetId,
      range: `'${SHEET_SCHEDULE}'!A1:L1`,
      valueInputOption: "RAW",
      requestBody: { values: [SCHEDULE_HEADER] },
    });
    this.invalidateSlotsCache();
  }

  /**
   * Очищает «Расписание» и личные листы тренеров (записи клиентов).
   * Работники / Услуги / Клиенты не трогает.
   */
  async clearScheduleAndBookings(): Promise<void> {
    await this.resetSchedule();
    const workers = await this.listWorkers(false);
    for (const w of workers) {
      await this.syncTrainerSheet(w.name).catch(console.error);
    }
  }

  /** Демо-данные: 3 работника, 3 услуги, слоты на 7 дней */
  async seedDemoData(): Promise<{ workers: number; services: number; slots: number }> {
    await this.ensureStructure();

    const existingWorkers = await this.listWorkers(false);
    let workersAdded = 0;
    if (existingWorkers.length === 0) {
      for (const name of DEMO_WORKERS) {
        await this.addWorker(name);
        workersAdded += 1;
      }
    }

    const existingServices = await this.listServices(false);
    let servicesAdded = 0;
    if (existingServices.length === 0) {
      for (const [name, dur, price] of DEMO_SERVICES) {
        await this.addService(name, dur, price);
        servicesAdded += 1;
      }
    }

    const slots = await this.generateSchedule(7);
    await this.syncAllTrainerSheets().catch(console.error);
    return { workers: workersAdded, services: servicesAdded, slots };
  }

  async listWorkers(activeOnly = true): Promise<Worker[]> {
    await this.ensureSheetExists(SHEET_WORKERS);
    const sheets = await this.getClient();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: config.spreadsheetId,
      range: WORKERS_RANGE,
    });
    const values = response.data.values ?? [];
    const result: Worker[] = [];
    for (let i = 0; i < values.length; i++) {
      const row = values[i] as string[];
      if (i === 0 && (row[0] ?? "").toLowerCase().includes("имя")) continue;
      const name = (row[0] ?? "").trim();
      if (!name) continue;
      const active = isYes(row[1] ?? "да");
      if (activeOnly && !active) continue;
      const telegram = (row[2] ?? "").trim().replace(/^@/, "") || undefined;
      const sheetUrl = (row[3] ?? "").trim() || undefined;
      result.push({ rowIndex: i + 1, name, active, telegram, sheetUrl });
    }
    return result;
  }

  async findWorkerByTelegram(username?: string): Promise<Worker | null> {
    if (!username) return null;
    const u = username.replace(/^@/, "").toLowerCase();
    const all = await this.listWorkers(true);
    return (
      all.find((w) => w.telegram?.toLowerCase() === u) ?? null
    );
  }

  async addWorker(
    name: string,
    telegram = "",
  ): Promise<Worker & { updated?: boolean }> {
    const n = name.trim();
    if (!n) throw new Error("Имя работника пустое");
    const tg = telegram.trim().replace(/^@/, "");
    const existing = await this.listWorkers(false);

    // Уникальность — по Telegram-тегу
    if (tg) {
      const byTg = existing.find(
        (w) => w.telegram?.toLowerCase() === tg.toLowerCase(),
      );
      if (byTg) {
        if (byTg.name.toLowerCase() === n.toLowerCase()) {
          // тот же тренер — активируем, если был выключен
          if (!byTg.active) {
            const sheets = await this.getClient();
            await sheets.spreadsheets.values.update({
              spreadsheetId: config.spreadsheetId,
              range: cellRange(SHEET_WORKERS, "B", "B", byTg.rowIndex),
              valueInputOption: "RAW",
              requestBody: { values: [["да"]] },
            });
            byTg.active = true;
          }
          return { ...byTg, updated: true };
        }
        throw new Error(
          `Telegram @${tg} уже привязан к тренеру «${byTg.name}».\n` +
            "Один тег — один тренер.",
        );
      }
    }

    const byName = existing.find(
      (w) => w.name.toLowerCase() === n.toLowerCase(),
    );
    if (byName) {
      // Имя уже есть — обновляем Telegram-тег (и активируем)
      if (!tg) {
        throw new Error(
          `Тренер «${n}» уже есть.\n` +
            "Укажите Telegram-тег, чтобы обновить привязку, или выберите другое имя.",
        );
      }
      const sheets = await this.getClient();
      await sheets.spreadsheets.values.update({
        spreadsheetId: config.spreadsheetId,
        range: cellRange(SHEET_WORKERS, "B", "C", byName.rowIndex),
        valueInputOption: "RAW",
        requestBody: { values: [["да", tg]] },
      });
      const url =
        byName.sheetUrl || (await this.ensureTrainerSheet(byName.name));
      await this.syncTrainerSheet(byName.name).catch(console.error);
      return {
        rowIndex: byName.rowIndex,
        name: byName.name,
        active: true,
        telegram: tg,
        sheetUrl: url,
        updated: true,
      };
    }

    await this.ensureStructure();
    const sheets = await this.getClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: config.spreadsheetId,
      range: WORKERS_RANGE,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [[n, "да", tg, ""]] },
    });
    const url = await this.ensureTrainerSheet(n);
    await this.syncTrainerSheet(n);
    return {
      rowIndex: -1,
      name: n,
      active: true,
      telegram: tg || undefined,
      sheetUrl: url,
    };
  }

  async deactivateWorker(name: string): Promise<void> {
    const workers = await this.listWorkers(false);
    const w = workers.find(
      (x) => x.name.toLowerCase() === name.trim().toLowerCase(),
    );
    if (!w) throw new Error(`Работник «${name}» не найден`);
    const sheets = await this.getClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.spreadsheetId,
      range: cellRange(SHEET_WORKERS, "B", "B", w.rowIndex),
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [["нет"]] },
    });
  }

  async listServices(activeOnly = true): Promise<Service[]> {
    await this.ensureSheetExists(SHEET_SERVICES);
    const sheets = await this.getClient();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: config.spreadsheetId,
      range: SERVICES_RANGE,
    });
    const values = response.data.values ?? [];
    const result: Service[] = [];
    for (let i = 0; i < values.length; i++) {
      const row = values[i] as string[];
      if (i === 0 && (row[0] ?? "").toLowerCase().includes("назван")) continue;
      const name = (row[0] ?? "").trim();
      if (!name) continue;
      const durationMin = Number(row[1]) || 60;
      const price = Number(row[2]) || 0;
      const active = isYes(row[3] ?? "да");
      if (activeOnly && !active) continue;
      result.push({ rowIndex: i + 1, name, durationMin, price, active });
    }
    return result;
  }

  async addService(
    name: string,
    durationMin: number,
    price: number,
  ): Promise<Service> {
    const n = name.trim();
    if (!n) throw new Error("Название услуги пустое");
    const existing = await this.listServices(false);
    if (existing.some((s) => s.name.toLowerCase() === n.toLowerCase())) {
      throw new Error(`Услуга «${n}» уже есть`);
    }
    await this.ensureStructure();
    const sheets = await this.getClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: config.spreadsheetId,
      range: SERVICES_RANGE,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [[n, durationMin, price, "да"]] },
    });
    return {
      rowIndex: -1,
      name: n,
      durationMin,
      price,
      active: true,
    };
  }

  private async readAllSlots(force = false): Promise<Slot[]> {
    const now = Date.now();
    if (
      !force &&
      this.slotsCache &&
      now - this.slotsCache.at < GoogleSheetsService.SLOTS_TTL_MS
    ) {
      return this.slotsCache.slots.map((s) => ({ ...s }));
    }

    await this.ensureSheetExists(SHEET_SCHEDULE);
    const sheets = await this.getClient();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: config.spreadsheetId,
      range: SCHEDULE_RANGE,
      valueRenderOption: "UNFORMATTED_VALUE",
    });

    const values = response.data.values ?? [];
    const slots: Slot[] = [];
    for (let i = 0; i < values.length; i++) {
      const row = values[i] as unknown[];
      if (i === 0) {
        const first = String(row[0] ?? "").trim().toLowerCase();
        if (first === "дата" || first === "date") continue;
      }
      const slot = rowToSlot(row, i + 1);
      if (slot) slots.push(slot);
    }
    this.slotsCache = { at: now, slots };
    return slots.map((s) => ({ ...s }));
  }

  private findSlot(
    slots: Slot[],
    date: string,
    time: string,
    worker: string,
  ): Slot | undefined {
    const d = normalizeDate(date);
    const t = normalizeTime(time);
    const w = worker.trim().toLowerCase();
    return slots.find(
      (s) =>
        normalizeDate(s.date) === d &&
        normalizeTime(s.time) === t &&
        s.worker.trim().toLowerCase() === w,
    );
  }

  private async writeBookingColumns(slot: Slot): Promise<void> {
    const sheets = await this.getClient();
    const range = cellRange(SHEET_SCHEDULE, "D", "L", slot.rowIndex);
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.spreadsheetId,
      range,
      valueInputOption: "RAW",
      requestBody: {
        values: [
          [
            slot.service,
            slot.status,
            slot.clientName,
            slot.clientContact,
            slot.clientName2,
            slot.clientContact2,
            slot.note,
            slot.health1,
            slot.health2,
          ],
        ],
      },
    });
    this.invalidateSlotsCache();
  }

  async getAvailableSlots(options?: {
    daysAhead?: number;
    worker?: string;
    service?: string;
  }): Promise<Slot[]> {
    // Не чистим таблицу на каждый клик (дорого по квоте API)
    const now = Date.now();
    if (
      now - this.lastPastCleanupAt >
      GoogleSheetsService.PAST_CLEANUP_TTL_MS
    ) {
      this.lastPastCleanupAt = now;
      await this.removePastFreeSlots().catch(console.error);
    }

    const daysAhead = options?.daysAhead ?? 7;
    const slots = await this.readAllSlots();
    const from = todayInTimezone();
    const to = addDays(from, daysAhead + 1);
    const worker = options?.worker?.trim().toLowerCase();

    return slots
      .filter((s) => {
        if (s.freeSeats <= 0) return false;
        if (!isDateInRange(s.date, from, to)) return false;
        if (isSlotInPast(s.date, s.time)) return false;
        if (worker && s.worker.trim().toLowerCase() !== worker) return false;
        return true;
      })
      .sort((a, b) => {
        const da = parseSheetDate(a.date)?.getTime() ?? 0;
        const db = parseSheetDate(b.date)?.getTime() ?? 0;
        if (da !== db) return da - db;
        return normalizeTime(a.time).localeCompare(normalizeTime(b.time));
      });
  }

  /** Удаляет из таблицы прошедшие полностью свободные слоты */
  async removePastFreeSlots(): Promise<number> {
    const slots = await this.readAllSlots();
    const toDelete = slots
      .filter((s) => s.bookedCount === 0 && isSlotInPast(s.date, s.time))
      .sort((a, b) => b.rowIndex - a.rowIndex);

    if (toDelete.length === 0) return 0;

    const sheets = await this.getClient();
    const sheetId = await this.getSheetIdByTitle(SHEET_SCHEDULE);
    const requests = toDelete.map((s) => ({
      deleteDimension: {
        range: {
          sheetId,
          dimension: "ROWS" as const,
          startIndex: s.rowIndex - 1,
          endIndex: s.rowIndex,
        },
      },
    }));

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.spreadsheetId,
      requestBody: { requests },
    });
    this.invalidateSlotsCache();

    const workers = [...new Set(toDelete.map((s) => s.worker).filter(Boolean))];
    for (const w of workers) {
      await this.syncTrainerSheet(w).catch(console.error);
    }
    return toDelete.length;
  }

  async getAvailableDates(worker: string, daysAhead = 7): Promise<string[]> {
    const slots = await this.getAvailableSlots({ worker, daysAhead });
    return [...new Set(slots.map((s) => s.date))];
  }

  async getAvailableTimes(worker: string, date: string): Promise<Slot[]> {
    const slots = await this.getAvailableSlots({ worker, daysAhead: 14 });
    const d = normalizeDate(date);
    return slots.filter((s) => normalizeDate(s.date) === d);
  }

  async bookSlot(
    date: string,
    time: string,
    worker: string,
    service: string,
    name: string,
    phone: string,
    telegramId?: number,
    username?: string,
  ): Promise<Slot> {
    const slots = await this.readAllSlots();
    const slot = this.findSlot(slots, date, time, worker);
    if (!slot) {
      throw new SlotNotFoundError(date, time, worker);
    }
    if (slot.freeSeats <= 0) {
      throw new SlotAlreadyBookedError(date, time, worker);
    }

    const n = name.trim();
    const p = phone.trim();

    // нельзя занять оба места одним и тем же Telegram-аккаунтом
    if (telegramId) {
      const ids = parseSeatTelegramIds(slot.note);
      const id = String(telegramId);
      if (ids.seat1 === id || ids.seat2 === id) {
        throw new Error("Вы уже записаны на этот слот");
      }
    }

    let seat: 1 | 2;
    if (!slot.clientName && !slot.clientContact) {
      slot.clientName = n;
      slot.clientContact = p;
      seat = 1;
    } else if (!slot.clientName2 && !slot.clientContact2) {
      slot.clientName2 = n;
      slot.clientContact2 = p;
      seat = 2;
    } else {
      throw new SlotAlreadyBookedError(date, time, worker);
    }

    if (!slot.service) {
      slot.service = service.trim();
    }

    slot.note = buildNoteWithSeats(slot.note, seat, telegramId);

    let healthIssues = "";
    if (telegramId) {
      const profile = await this.getClientProfile(telegramId);
      healthIssues = profile?.healthIssues?.trim() || "";
      await this.upsertClientProfile({
        telegramId,
        name: n,
        phone: p,
        username: username || undefined,
        healthIssues,
      });
    }
    if (seat === 1) slot.health1 = healthIssues;
    else slot.health2 = healthIssues;

    slot.bookedCount =
      (slot.clientName || slot.clientContact ? 1 : 0) +
      (slot.clientName2 || slot.clientContact2 ? 1 : 0);
    slot.freeSeats = config.slotCapacity - slot.bookedCount;
    slot.status = statusFromCount(slot.bookedCount);

    await this.writeBookingColumns(slot);
    await this.syncTrainerSheet(worker).catch(console.error);
    return slot;
  }

  async cancelUserBooking(
    date: string,
    time: string,
    worker: string,
    contact: string,
    telegramId?: number,
  ): Promise<Slot> {
    const slots = await this.readAllSlots();
    const slot = this.findSlot(slots, date, time, worker);
    if (!slot) {
      throw new SlotNotFoundError(date, time, worker);
    }

    const ids = parseSeatTelegramIds(slot.note);
    const id = telegramId ? String(telegramId) : "";

    let seat: 1 | 2 | null = null;
    if (id && ids.seat1 === id) seat = 1;
    else if (id && ids.seat2 === id) seat = 2;
    else if (contactsMatch(slot.clientContact, contact)) seat = 1;
    else if (contactsMatch(slot.clientContact2, contact)) seat = 2;

    if (!seat) {
      throw new Error("Ваша запись в этом слоте не найдена");
    }

    if (seat === 1) {
      slot.clientName = slot.clientName2;
      slot.clientContact = slot.clientContact2;
      slot.health1 = slot.health2;
      slot.clientName2 = "";
      slot.clientContact2 = "";
      slot.health2 = "";
    } else {
      slot.clientName2 = "";
      slot.clientContact2 = "";
      slot.health2 = "";
    }
    slot.note = clearSeatFromNote(slot.note, seat);

    slot.bookedCount =
      (slot.clientName || slot.clientContact ? 1 : 0) +
      (slot.clientName2 || slot.clientContact2 ? 1 : 0);
    slot.freeSeats = config.slotCapacity - slot.bookedCount;
    slot.status = statusFromCount(slot.bookedCount);

    await this.writeBookingColumns(slot);
    await this.syncTrainerSheet(worker).catch(console.error);
    return slot;
  }

  async clearSlot(date: string, time: string, worker: string): Promise<Slot> {
    const slots = await this.readAllSlots();
    const slot = this.findSlot(slots, date, time, worker);
    if (!slot) {
      throw new SlotNotFoundError(date, time, worker);
    }

    slot.service = "";
    slot.clientName = "";
    slot.clientContact = "";
    slot.clientName2 = "";
    slot.clientContact2 = "";
    slot.note = "";
    slot.health1 = "";
    slot.health2 = "";
    slot.bookedCount = 0;
    slot.freeSeats = config.slotCapacity;
    slot.status = STATUS_FREE;

    await this.writeBookingColumns(slot);
    await this.syncTrainerSheet(worker).catch(console.error);
    return slot;
  }

  async addSlot(
    date: string,
    time: string,
    worker: string,
    service = "",
  ): Promise<Slot> {
    const normalizedDate = normalizeDate(date);
    const normalizedTime = normalizeTime(time);
    const w = worker.trim();

    if (!parseSheetDate(normalizedDate)) {
      throw new Error("Неверный формат даты. Ожидается ДД.ММ.ГГГГ");
    }
    if (!/^\d{2}:\d{2}$/.test(normalizedTime)) {
      throw new Error("Неверный формат времени. Ожидается ЧЧ:ММ");
    }
    if (!w) throw new Error("Укажите работника");

    const existing = await this.readAllSlots();
    const duplicate = this.findSlot(
      existing,
      normalizedDate,
      normalizedTime,
      w,
    );
    if (duplicate) {
      throw new Error(
        `Слот ${normalizedDate} ${normalizedTime} у «${w}» уже есть`,
      );
    }

    await this.ensureStructure();
    const sheets = await this.getClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: config.spreadsheetId,
      range: SCHEDULE_RANGE,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [
          scheduleRowValues({
            date: normalizedDate,
            time: normalizedTime,
            worker: w,
            service: service.trim(),
            status: STATUS_FREE,
          }),
        ],
      },
    });
    this.invalidateSlotsCache();

    await this.syncTrainerSheet(w).catch(console.error);

    return {
      rowIndex: -1,
      date: normalizedDate,
      time: normalizedTime,
      worker: w,
      service: service.trim(),
      status: STATUS_FREE,
      clientName: "",
      clientContact: "",
      clientName2: "",
      clientContact2: "",
      note: "",
      health1: "",
      health2: "",
      bookedCount: 0,
      freeSeats: config.slotCapacity,
    };
  }

  async generateSchedule(daysAhead = 7, workerFilter?: string): Promise<number> {
    await this.ensureStructure();
    const workers = await this.listWorkers(true);
    const targets = workerFilter
      ? workers.filter(
          (w) => w.name.toLowerCase() === workerFilter.trim().toLowerCase(),
        )
      : workers;

    if (targets.length === 0) {
      throw new Error(
        "Нет активных работников. Добавьте через админ-панель или /seed_demo",
      );
    }

    const existing = await this.readAllSlots();
    const existingKeys = new Set(
      existing.map(
        (s) =>
          `${normalizeDate(s.date)}|${normalizeTime(s.time)}|${s.worker.trim().toLowerCase()}`,
      ),
    );

    const times = buildDayTimes();
    const from = todayInTimezone();
    const rows: string[][] = [];

    for (let d = 0; d < daysAhead; d++) {
      const dateKey = formatDateKey(addDays(from, d));
      for (const worker of targets) {
        for (const time of times) {
          const key = `${dateKey}|${time}|${worker.name.trim().toLowerCase()}`;
          if (existingKeys.has(key)) continue;
          rows.push(
            scheduleRowValues({
              date: dateKey,
              time,
              worker: worker.name,
              status: STATUS_FREE,
            }),
          );
          existingKeys.add(key);
        }
      }
    }

    if (rows.length === 0) return 0;

    const sheets = await this.getClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: config.spreadsheetId,
      range: SCHEDULE_RANGE,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: rows },
    });
    this.invalidateSlotsCache();

    const names = workerFilter
      ? [workerFilter]
      : targets.map((t) => t.name);
    for (const name of names) {
      await this.syncTrainerSheet(name).catch(console.error);
    }

    return rows.length;
  }

  /** Слоты на один день для одного тренера */
  async generateDay(workerName: string, date: string): Promise<number> {
    const normalizedDate = normalizeDate(date);
    if (!parseSheetDate(normalizedDate)) {
      throw new Error("Неверный формат даты. Ожидается ДД.ММ.ГГГГ");
    }
    await this.ensureStructure();
    const workers = await this.listWorkers(true);
    const worker = workers.find(
      (w) => w.name.toLowerCase() === workerName.trim().toLowerCase(),
    );
    if (!worker) throw new Error(`Тренер «${workerName}» не найден`);

    const existing = await this.readAllSlots();
    const existingKeys = new Set(
      existing.map(
        (s) =>
          `${normalizeDate(s.date)}|${normalizeTime(s.time)}|${s.worker.trim().toLowerCase()}`,
      ),
    );

    const rows: string[][] = [];
    for (const time of buildDayTimes()) {
      const key = `${normalizedDate}|${time}|${worker.name.trim().toLowerCase()}`;
      if (existingKeys.has(key)) continue;
      rows.push(
        scheduleRowValues({
          date: normalizedDate,
          time,
          worker: worker.name,
          status: STATUS_FREE,
        }),
      );
    }

    if (rows.length === 0) return 0;

    const sheets = await this.getClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: config.spreadsheetId,
      range: SCHEDULE_RANGE,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: rows },
    });
    this.invalidateSlotsCache();
    await this.syncTrainerSheet(worker.name).catch(console.error);
    return rows.length;
  }

  /** Удалить строку слота полностью */
  async deleteSlot(
    date: string,
    time: string,
    worker: string,
  ): Promise<void> {
    const slots = await this.readAllSlots();
    const slot = this.findSlot(slots, date, time, worker);
    if (!slot) throw new SlotNotFoundError(date, time, worker);

    const sheets = await this.getClient();
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: config.spreadsheetId,
      fields: "sheets.properties",
    });
    const sheet = (meta.data.sheets ?? []).find(
      (s) => s.properties?.title === SHEET_SCHEDULE,
    );
    const sheetId = sheet?.properties?.sheetId;
    if (sheetId == null) throw new Error("Лист Расписание не найден");

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.spreadsheetId,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId,
                dimension: "ROWS",
                startIndex: slot.rowIndex - 1,
                endIndex: slot.rowIndex,
              },
            },
          },
        ],
      },
    });
    this.invalidateSlotsCache();
    await this.syncTrainerSheet(worker).catch(console.error);
  }

  async listBookingsByWorker(workerName: string): Promise<Slot[]> {
    const slots = await this.readAllSlots();
    const from = todayInTimezone();
    const w = workerName.trim().toLowerCase();
    return slots
      .filter((s) => {
        if (s.worker.trim().toLowerCase() !== w) return false;
        if (s.bookedCount <= 0) return false;
        const parsed = parseSheetDate(s.date);
        return parsed != null && parsed >= from;
      })
      .sort((a, b) => {
        const da = parseSheetDate(a.date)?.getTime() ?? 0;
        const db = parseSheetDate(b.date)?.getTime() ?? 0;
        if (da !== db) return da - db;
        return normalizeTime(a.time).localeCompare(normalizeTime(b.time));
      });
  }

  async listUpcomingSlotsByWorker(
    workerName: string,
    daysAhead = 7,
  ): Promise<Slot[]> {
    return this.getAvailableSlots({ worker: workerName, daysAhead });
  }

  async deactivateService(name: string): Promise<void> {
    const services = await this.listServices(false);
    const s = services.find(
      (x) => x.name.toLowerCase() === name.trim().toLowerCase(),
    );
    if (!s) throw new Error(`Услуга «${name}» не найдена`);
    const sheets = await this.getClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.spreadsheetId,
      range: cellRange(SHEET_SERVICES, "D", "D", s.rowIndex),
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [["нет"]] },
    });
  }

  async getBookingsForDays(days: number[]): Promise<Slot[]> {
    const slots = await this.readAllSlots();
    const today = todayInTimezone();
    const targetDates = new Set(
      days.map((d) => formatDateKey(addDays(today, d))),
    );

    return slots
      .filter(
        (s) =>
          s.bookedCount > 0 && targetDates.has(normalizeDate(s.date)),
      )
      .sort((a, b) => {
        const da = parseSheetDate(a.date)?.getTime() ?? 0;
        const db = parseSheetDate(b.date)?.getTime() ?? 0;
        if (da !== db) return da - db;
        return normalizeTime(a.time).localeCompare(normalizeTime(b.time));
      });
  }

  async findUserActiveBooking(
    contact: string,
    clientName?: string,
    telegramId?: number,
  ): Promise<{ slot: Slot; seat: 1 | 2 } | null> {
    const all = await this.listUserBookings(contact, clientName, telegramId);
    if (all.length === 0) return null;
    const first = all[0]!;
    const ids = parseSeatTelegramIds(first.note);
    const id = telegramId ? String(telegramId) : "";
    let seat: 1 | 2 = 1;
    if (id && ids.seat2 === id) seat = 2;
    else if (id && ids.seat1 === id) seat = 1;
    else if (contactsMatch(first.clientContact2, contact)) seat = 2;
    else if (
      clientName &&
      first.clientName2.trim().toLowerCase() === clientName.trim().toLowerCase()
    ) {
      seat = 2;
    }
    return { slot: first, seat };
  }

  async listUserBookings(
    contact?: string,
    _clientName?: string,
    telegramId?: number,
  ): Promise<Array<Slot & { displayName: string }>> {
    const slots = await this.readAllSlots();
    const from = todayInTimezone();
    const id = telegramId ? String(telegramId) : "";
    const result: Array<Slot & { displayName: string }> = [];

    for (const s of slots) {
      const parsed = parseSheetDate(s.date);
      if (!parsed || parsed < from) continue;
      if (isSlotInPast(s.date, s.time)) continue;

      const ids = parseSeatTelegramIds(s.note);
      let matched = false;

      if (id && ids.seat1 === id && (s.clientName || s.clientContact)) {
        result.push({ ...s, displayName: s.clientName || s.clientContact });
        matched = true;
      }
      if (id && ids.seat2 === id && (s.clientName2 || s.clientContact2)) {
        result.push({
          ...s,
          displayName: s.clientName2 || s.clientContact2,
        });
        matched = true;
      }
      if (matched) continue;

      // Запасной путь: телефон/@username этого места (без совпадения по имени)
      if (contact) {
        if (contactsMatch(s.clientContact, contact) && (s.clientName || s.clientContact)) {
          result.push({ ...s, displayName: s.clientName || s.clientContact });
        } else if (
          contactsMatch(s.clientContact2, contact) &&
          (s.clientName2 || s.clientContact2)
        ) {
          result.push({
            ...s,
            displayName: s.clientName2 || s.clientContact2,
          });
        }
      }
    }

    return result.sort((a, b) => {
      const da = parseSheetDate(a.date)?.getTime() ?? 0;
      const db = parseSheetDate(b.date)?.getTime() ?? 0;
      if (da !== db) return da - db;
      return normalizeTime(a.time).localeCompare(normalizeTime(b.time));
    });
  }

  async getClientProfile(telegramId: number | string): Promise<ClientProfile | null> {
    const id = String(telegramId);
    const rows = await this.listClientProfiles();
    return rows.find((r) => r.telegramId === id) ?? null;
  }

  private async listClientProfiles(force = false): Promise<ClientProfile[]> {
    const now = Date.now();
    if (
      !force &&
      this.clientsCache &&
      now - this.clientsCache.at < GoogleSheetsService.CLIENTS_TTL_MS
    ) {
      return this.clientsCache.rows;
    }

    await this.ensureSheetExists(SHEET_CLIENTS);
    const sheets = await this.getClient();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: config.spreadsheetId,
      range: CLIENTS_RANGE,
    });
    const values = response.data.values ?? [];
    const rows: ClientProfile[] = [];
    for (let i = 0; i < values.length; i++) {
      const row = values[i] as string[];
      if (i === 0 && String(row[0] ?? "").toLowerCase().includes("telegram")) {
        continue;
      }
      const telegramId = String(row[0] ?? "").trim();
      if (!telegramId) continue;
      rows.push({
        rowIndex: i + 1,
        telegramId,
        name: fromSheetText(row[1] ?? ""),
        phone: fromSheetText(row[2] ?? ""),
        username: fromSheetText(row[3] ?? ""),
        healthIssues: fromSheetText(row[4] ?? ""),
        updatedAt: fromSheetText(row[5] ?? ""),
      });
    }
    this.clientsCache = { at: now, rows };
    return rows;
  }

  async upsertClientProfile(input: {
    telegramId: number | string;
    name?: string;
    phone?: string;
    username?: string;
    healthIssues?: string;
  }): Promise<ClientProfile> {
    await this.ensureSheetExists(SHEET_CLIENTS);
    const id = String(input.telegramId);
    const existing = await this.getClientProfile(id);

    const nextName = input.name ?? existing?.name ?? "";
    const nextPhone = input.phone ?? existing?.phone ?? "";
    const nextUsername = (
      input.username ??
      existing?.username ??
      ""
    ).replace(/^@/, "");
    const nextHealth =
      input.healthIssues !== undefined
        ? input.healthIssues.trim()
        : existing?.healthIssues ?? "";

    // Без изменений — не пишем в API
    if (
      existing &&
      existing.name === nextName &&
      existing.phone === nextPhone &&
      existing.username === nextUsername &&
      existing.healthIssues === nextHealth
    ) {
      return existing;
    }

    const now = nowInTimezone();
    const updatedAt = `${formatDateKey(now)} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

    const next: ClientProfile = {
      rowIndex: existing?.rowIndex ?? -1,
      telegramId: id,
      name: nextName,
      phone: nextPhone,
      username: nextUsername,
      healthIssues: nextHealth,
      updatedAt,
    };

    const row = [
      next.telegramId,
      next.name,
      next.phone,
      next.username,
      next.healthIssues,
      next.updatedAt,
    ];

    const sheets = await this.getClient();
    if (existing) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: config.spreadsheetId,
        range: cellRange(SHEET_CLIENTS, "A", "F", existing.rowIndex),
        valueInputOption: "RAW",
        requestBody: { values: [row] },
      });
      next.rowIndex = existing.rowIndex;
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId: config.spreadsheetId,
        range: CLIENTS_RANGE,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: [row] },
      });
    }
    this.invalidateClientsCache();
    return next;
  }

  async setHealthIssues(
    telegramId: number | string,
    healthIssues: string,
    meta?: { name?: string; phone?: string; username?: string },
  ): Promise<ClientProfile> {
    const profile = await this.upsertClientProfile({
      telegramId,
      name: meta?.name,
      phone: meta?.phone,
      username: meta?.username,
      healthIssues,
    });
    await this.applyHealthToUpcomingBookings(telegramId, profile.healthIssues);
    return profile;
  }

  /** Обновляет колонки «Здоровье» во всех будущих записях клиента */
  async applyHealthToUpcomingBookings(
    telegramId: number | string,
    healthIssues: string,
  ): Promise<number> {
    const id = String(telegramId);
    const text = healthIssues.trim();
    const slots = await this.readAllSlots();
    const touchedWorkers = new Set<string>();
    let updated = 0;

    for (const slot of slots) {
      if (isSlotInPast(slot.date, slot.time)) continue;
      const ids = parseSeatTelegramIds(slot.note);
      let changed = false;
      if (ids.seat1 === id) {
        slot.health1 = text;
        changed = true;
      }
      if (ids.seat2 === id) {
        slot.health2 = text;
        changed = true;
      }
      if (!changed) continue;
      await this.writeBookingColumns(slot);
      touchedWorkers.add(slot.worker);
      updated += 1;
    }

    for (const worker of touchedWorkers) {
      await this.syncTrainerSheet(worker).catch(console.error);
    }
    return updated;
  }
}

export const googleSheets = new GoogleSheetsService();
