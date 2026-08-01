import { readFileSync } from "node:fs";
import { google } from "googleapis";
import { config } from "../src/config.js";
import { googleSheets } from "../src/services/googleSheets.js";

async function main(): Promise<void> {
  const credentials = JSON.parse(
    readFileSync(config.googleCredentialsPath, "utf-8"),
  );
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  const meta = await sheets.spreadsheets.get({
    spreadsheetId: config.spreadsheetId,
    fields: "sheets.properties,sheets.tables",
  });

  const deleteRequests: object[] = [];
  for (const s of meta.data.sheets ?? []) {
    const title = s.properties?.title ?? "?";
    const tables = (s as { tables?: Array<{ tableId?: string; name?: string }> })
      .tables ?? [];
    console.log(`Лист «${title}»: таблиц ${tables.length}`);
    for (const t of tables) {
      console.log(`  - ${t.name} id=${t.tableId}`);
      if (t.tableId) {
        deleteRequests.push({ deleteTable: { tableId: t.tableId } });
      }
    }
  }

  // Сначала чиним данные (без строк-разделителей), потом снимаем Table-объекты
  console.log("Перезаписываю «Расписание» чистыми строками…");
  const n = await googleSheets.repairScheduleDisplay();
  console.log(`Строк данных: ${n}`);

  // Перечитать tables после repair (могли остаться)
  const meta2 = await sheets.spreadsheets.get({
    spreadsheetId: config.spreadsheetId,
    fields: "sheets.tables",
  });
  const reqs: object[] = [];
  for (const s of meta2.data.sheets ?? []) {
    const tables = (s as { tables?: Array<{ tableId?: string; name?: string }> })
      .tables ?? [];
    for (const t of tables) {
      if (t.tableId) {
        console.log(`Удаляю объект таблицы «${t.name}»…`);
        // deleteTable удаляет и данные — поэтому сначала сохранили через repair.
        // На всякий случай ещё раз снимем структуру после повторного repair ниже.
        reqs.push({ deleteTable: { tableId: t.tableId } });
      }
    }
  }

  if (reqs.length) {
    // Сохраним текущие значения до deleteTable
    const scheduleName = config.sheetName || "Расписание";
    const saved = await sheets.spreadsheets.values.get({
      spreadsheetId: config.spreadsheetId,
      range: `'${scheduleName}'!A:L`,
      valueRenderOption: "FORMATTED_VALUE",
    });
    const values = saved.data.values ?? [];

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.spreadsheetId,
      requestBody: { requests: reqs },
    });
    console.log(`Удалено Table-объектов: ${reqs.length}`);

    if (values.length) {
      await sheets.spreadsheets.values.clear({
        spreadsheetId: config.spreadsheetId,
        range: `'${scheduleName}'!A:Z`,
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId: config.spreadsheetId,
        range: `'${scheduleName}'!A1`,
        valueInputOption: "RAW",
        requestBody: { values },
      });
      console.log("Данные возвращены без Table.");
    }

    await googleSheets.repairScheduleDisplay();
  } else {
    console.log("Table-объектов не найдено (уже обычный диапазон).");
  }

  console.log("✅ Готово. Не форматируйте лист как «Таблица» — бот пишет обычные ячейки.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
