/**
 * Очищает только «Расписание» и листы тренеров (записи).
 * Листы Работники / Услуги / Клиенты не трогает.
 */
import { googleSheets } from "../src/services/googleSheets.js";

async function main(): Promise<void> {
  console.log("Очищаю «Расписание» и записи у тренеров…");
  await googleSheets.clearScheduleAndBookings();
  console.log("✅ Готово. Расписание пустое, записи клиентов сняты.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
