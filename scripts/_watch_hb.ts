import { config } from "dotenv";
config({ quiet: true });
import { createDb, getSyncState } from "@predictarena/db";
async function main(): Promise<void> {
  const db = createDb(process.env["DATABASE_URL"]!);
  // Sample every 90s for ~7 minutes. If GitHub's */5 schedule is honoured, the
  // heartbeat should refresh at least once in that window.
  for (let i = 0; i < 5; i += 1) {
    try {
      const v = await getSyncState(db, "heartbeat");
      const c = (v as { cursor?: string } | null)?.cursor;
      const mins = c ? ((Date.now() - new Date(c).getTime()) / 60000).toFixed(1) : "-";
      console.log(`  sample ${i + 1}: heartbeat ${mins} min old`);
    } catch { console.log(`  sample ${i + 1}: db busy`); }
    if (i < 4) await new Promise((r) => setTimeout(r, 90_000));
  }
  process.exit(0);
}
void main();
