import "dotenv/config";
import { appendFileSync } from "node:fs";
import { createDexClient } from "@predictarena/dex";
const L = process.env["STAGE_LOG"]!;
const say = (m: string) => appendFileSync(L, m + "\n");
async function main() {
  say("start");
  const dex = createDexClient({
    indexerUrl: process.env["INDEXER_URL"]!,
    rpcHttpUrl: process.env["RPC_HTTP_URL"]!,
  });
  say("client constructed");
  let t0 = Date.now();
  try { await dex.clock.ensureFresh(); say(`clock.ensureFresh OK ${Date.now()-t0}ms`); }
  catch (e) { say(`clock.ensureFresh FAILED ${Date.now()-t0}ms: ${(e as Error).message.slice(0,80)}`); }
  t0 = Date.now();
  try {
    const page = await dex.exchange.client.listLiveBinaryMarkets({ asset: "BTC", orderBy: "closingSoon", limit: 5, offset: 0 });
    say(`listLiveBinaryMarkets -> ${page.length} in ${Date.now()-t0}ms`);
    if (page[0]) {
      t0 = Date.now();
      await dex.exchange.client.getMarketOnchain(page[0].marketId);
      say(`getMarketOnchain (one) ${Date.now()-t0}ms`);
    }
  } catch (e) { say(`listLiveBinaryMarkets FAILED ${Date.now()-t0}ms: ${(e as Error).message.slice(0,120)}`); }
  say("done");
}
void main();
