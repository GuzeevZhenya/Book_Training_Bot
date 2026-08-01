import { googleSheets } from "../src/services/googleSheets.js";

async function main(): Promise<void> {
  console.log("Чиним лист «Расписание»...");
  const n = await googleSheets.repairScheduleDisplay();
  console.log(`Готово. Исправлено строк данных: ${n}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
