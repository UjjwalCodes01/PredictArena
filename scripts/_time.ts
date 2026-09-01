import "dotenv/config";
import { createDexClient, getWindows, getTopOfBook, headroomSecFor } from "@predictarena/dex";
async function main() {
  const dex = createDexClient({
    indexerUrl: process.env["INDEXER_URL"]!,
    rpcHttpUrl: process.env["RPC_HTTP_URL"]!,
  });
  for (const limit of [5, 20]) {
    const t0 = Date.now();
    try {
      const w = await getWindows(dex, { asset: "BTC", limit });
      const tradable = w.filter((x) => x.isTradable && x.secondsLeft > headroomSecFor(x.intervalSec ?? 0));
      console.log(`getWindows(limit=${limit}) -> ${w.length} windows, ${tradable.length} tradable  in ${Date.now()-t0}ms`);
      if (limit === 5 && tradable[0]) {
        const t1 = Date.now();
        await getTopOfBook(dex, tradable[0].pool);
        console.log(`  getTopOfBook -> ${Date.now()-t1}ms`);
      }
    } catch (e) {
      console.log(`getWindows(limit=${limit}) FAILED after ${Date.now()-t0}ms:`, e instanceof Error ? e.message.slice(0,120) : e);
    }
  }
}
void main();
