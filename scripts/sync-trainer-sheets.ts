import { googleSheets } from "../src/services/googleSheets.js";

async function main(): Promise<void> {
  console.log("Создаю вкладки тренеров...");
  const n = await googleSheets.syncAllTrainerSheets();
  console.log(`Готово. Листов: ${n}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
