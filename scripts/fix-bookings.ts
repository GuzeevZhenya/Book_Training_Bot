import { googleSheets } from "../src/services/googleSheets.js";

async function main(): Promise<void> {
  const notes = await googleSheets.normalizeBookingNotes();
  console.log("notes fixed:", notes);
  const past = await googleSheets.removePastFreeSlots();
  console.log("past free removed:", past);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
