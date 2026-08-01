import { readFileSync } from "node:fs";
import { google, sheets_v4 } from "googleapis";
import { config } from "../config.js";
import {
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
const SHEET_SCHEDULE = config.sheetName || "Расписание";

/** Расписание: Дата, Время, Работник, Услуга, Статус, Имя1, Тел1, Имя2, Тел2, Примечание */
const SCHEDULE_RANGE = `'${SHEET_SCHEDULE}'!A:J`;
const WORKERS_RANGE = `'${SHEET_WORKERS}'!A:D`;
const SERVICES_RANGE = `'${SHEET_SERVICES}'!A:D`;

const RESERVED_SHEETS = new Set([
  SHEET_SCHEDULE,
  SHEET_WORKERS,
  SHEET_SERVICES,
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
  if (/^\d{2}\.\d{2}\.\d{4}$/.test(s)) return s;
  const asNum = Number(s.replace(",", "."));
  if (Number.isFinite(asNum) && asNum > 1000 && !s.includes(":")) {
    return serialToDateString(asNum);
  }
  return fromSheetText(s);
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
  ];
}

function contactsMatch(a: string, b: string): boolean {
  const na = a.trim().toLowerCase().replace(/^@/, "").replace(/^\+/, "");
  const nb = b.trim().toLowerCase().replace(/^@/, "").replace(/^\+/, "");
  if (!na || !nb) return false;
  return na === nb || a.trim() === b.trim();
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

  private async getClient(): Promise<sheets_v4.Sheets> {
    if (this.sheets) return this.sheets;

    const credentials = JSON.parse(
      readFileSync(config.googleCredentialsPath, "utf-8"),
    );

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    this.sheets = google.sheets({ version: "v4", auth });
    return this.sheets;
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
    await this.syncAllTrainerSheets().catch(console.error);
    return out.length - 1;
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
                endColumnIndex: 10,
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
                endColumnIndex: 10,
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
        }),
      );
    }

    await sheets.spreadsheets.values.clear({
      spreadsheetId: config.spreadsheetId,
      range: `'${title}'!A:J`,
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
    const sheets = await this.getClient();
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: config.spreadsheetId,
      fields: "sheets.properties.title",
    });
    const exists = (meta.data.sheets ?? []).some(
      (s) => s.properties?.title === title,
    );
    if (exists) return;

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title } } }],
      },
    });
  }

  async ensureStructure(): Promise<void> {
    await this.ensureSheetExists(SHEET_WORKERS);
    await this.ensureSheetExists(SHEET_SERVICES);
    await this.ensureSheetExists(SHEET_SCHEDULE);

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

    // Всегда восстанавливаем правильную шапку Расписания (A–J)
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.spreadsheetId,
      range: `'${SHEET_SCHEDULE}'!A1:J1`,
      valueInputOption: "RAW",
      requestBody: { values: [SCHEDULE_HEADER] },
    });

    try {
      const sheetId = await this.getSheetIdByTitle(SHEET_SCHEDULE);
      await this.applyScheduleStyles(sheetId);
    } catch {
      // ignore style errors on first create
    }
  }

  /** Очистить все строки расписания кроме шапки (если колонки «поехали») */
  async resetSchedule(): Promise<void> {
    await this.ensureStructure();
    const sheets = await this.getClient();
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: config.spreadsheetId,
      fields: "sheets.properties",
    });
    const sheet = (meta.data.sheets ?? []).find(
      (s) => s.properties?.title === SHEET_SCHEDULE,
    );
    const sheetId = sheet?.properties?.sheetId;
    if (sheetId == null) return;

    const rows = await this.readAllSlots();
    if (rows.length === 0) return;

    // удаляем строки 2..last (1-based → 0-based index: start 1 end last+1)
    const lastRow = Math.max(...rows.map((r) => r.rowIndex));
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.spreadsheetId,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId,
                dimension: "ROWS",
                startIndex: 1,
                endIndex: lastRow,
              },
            },
          },
        ],
      },
    });
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

  async addWorker(name: string, telegram = ""): Promise<Worker> {
    const n = name.trim();
    if (!n) throw new Error("Имя работника пустое");
    const existing = await this.listWorkers(false);
    if (existing.some((w) => w.name.toLowerCase() === n.toLowerCase())) {
      throw new Error(`Работник «${n}» уже есть`);
    }
    await this.ensureStructure();
    const tg = telegram.trim().replace(/^@/, "");
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

  private async readAllSlots(): Promise<Slot[]> {
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
    return slots;
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
    const range = cellRange(SHEET_SCHEDULE, "D", "J", slot.rowIndex);
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
          ],
        ],
      },
    });
  }

  async getAvailableSlots(options?: {
    daysAhead?: number;
    worker?: string;
    service?: string;
  }): Promise<Slot[]> {
    const daysAhead = options?.daysAhead ?? 7;
    const slots = await this.readAllSlots();
    const from = todayInTimezone();
    const to = addDays(from, daysAhead + 1);
    const worker = options?.worker?.trim().toLowerCase();

    return slots
      .filter((s) => {
        if (s.freeSeats <= 0) return false;
        if (!isDateInRange(s.date, from, to)) return false;
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
    const tgTag = telegramId ? `tg:${telegramId}` : "";

    if (!slot.clientName && !slot.clientContact) {
      slot.clientName = n;
      slot.clientContact = p;
    } else if (!slot.clientName2 && !slot.clientContact2) {
      slot.clientName2 = n;
      slot.clientContact2 = p;
    } else {
      throw new SlotAlreadyBookedError(date, time, worker);
    }

    if (!slot.service) {
      slot.service = service.trim();
    }

    if (tgTag) {
      const notes = slot.note
        .split("|")
        .map((x) => x.trim())
        .filter(Boolean);
      if (!notes.includes(tgTag)) notes.push(tgTag);
      slot.note = notes.join(" | ");
    }

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
  ): Promise<Slot> {
    const slots = await this.readAllSlots();
    const slot = this.findSlot(slots, date, time, worker);
    if (!slot) {
      throw new SlotNotFoundError(date, time, worker);
    }

    const match1 = contactsMatch(slot.clientContact, contact);
    const match2 = contactsMatch(slot.clientContact2, contact);

    if (!match1 && !match2) {
      throw new Error("Ваша запись в этом слоте не найдена");
    }

    if (match1) {
      slot.clientName = slot.clientName2;
      slot.clientContact = slot.clientContact2;
      slot.clientName2 = "";
      slot.clientContact2 = "";
    } else {
      slot.clientName2 = "";
      slot.clientContact2 = "";
    }

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
    const slots = await this.readAllSlots();
    const from = todayInTimezone();
    const matches: { slot: Slot; seat: 1 | 2 }[] = [];
    const nameKey = clientName?.trim().toLowerCase();
    const tgTag = telegramId ? `tg:${telegramId}` : "";

    for (const s of slots) {
      const parsed = parseSheetDate(s.date);
      if (!parsed || parsed < from) continue;

      const noteHasTg = tgTag && s.note.includes(tgTag);

      if (
        contactsMatch(s.clientContact, contact) ||
        (nameKey && s.clientName.trim().toLowerCase() === nameKey) ||
        noteHasTg
      ) {
        matches.push({ slot: s, seat: 1 });
      } else if (
        contactsMatch(s.clientContact2, contact) ||
        (nameKey && s.clientName2.trim().toLowerCase() === nameKey)
      ) {
        matches.push({ slot: s, seat: 2 });
      }
    }

    if (matches.length === 0) return null;
    matches.sort((a, b) => {
      const da = parseSheetDate(a.slot.date)?.getTime() ?? 0;
      const db = parseSheetDate(b.slot.date)?.getTime() ?? 0;
      if (da !== db) return da - db;
      return normalizeTime(a.slot.time).localeCompare(
        normalizeTime(b.slot.time),
      );
    });
    return matches[0] ?? null;
  }

  async listUserBookings(
    contact?: string,
    clientName?: string,
    telegramId?: number,
  ): Promise<Array<Slot & { displayName: string }>> {
    const slots = await this.readAllSlots();
    const from = todayInTimezone();
    const nameKey = clientName?.trim().toLowerCase();
    const tgTag = telegramId ? `tg:${telegramId}` : "";
    const result: Array<Slot & { displayName: string }> = [];

    for (const s of slots) {
      const parsed = parseSheetDate(s.date);
      if (!parsed || parsed < from) continue;

      const noteHasTg = Boolean(tgTag && s.note.includes(tgTag));

      const seat1 =
        (contact && contactsMatch(s.clientContact, contact)) ||
        (nameKey && s.clientName.trim().toLowerCase() === nameKey) ||
        noteHasTg;
      const seat2 =
        (contact && contactsMatch(s.clientContact2, contact)) ||
        (nameKey && s.clientName2.trim().toLowerCase() === nameKey);

      if (seat1 && (s.clientName || s.clientContact)) {
        result.push({ ...s, displayName: s.clientName || s.clientContact });
      } else if (seat2 && (s.clientName2 || s.clientContact2)) {
        result.push({ ...s, displayName: s.clientName2 || s.clientContact2 });
      }
    }

    return result.sort((a, b) => {
      const da = parseSheetDate(a.date)?.getTime() ?? 0;
      const db = parseSheetDate(b.date)?.getTime() ?? 0;
      if (da !== db) return da - db;
      return normalizeTime(a.time).localeCompare(normalizeTime(b.time));
    });
  }
}

export const googleSheets = new GoogleSheetsService();
