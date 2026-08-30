/**
 * The indexer's public surface.
 *
 * `apps/web` drives one ingest cycle from `/api/cron/ingest`, so the pieces it
 * needs are exported here and consumed by package name. It used to reach in by
 * relative path (`../../../../../../indexer/src/ingest`), which worked locally
 * and broke on Vercel: the build has Root Directory set to `apps/web`, and a
 * path that escapes that root is not guaranteed to be in the build context.
 *
 * `main.ts` stays out of this on purpose — importing it would start the daemon's
 * loops inside a serverless function.
 */
export { ingestWindows, type IngestResult, type IngestedWindow } from "./ingest";
export {
  ingestCalls,
  catchUpClosedWindows,
  aggregateFills,
  type IngestTarget,
  type IngestCallsResult,
} from "./ingest-calls";
export { reconcile, type ReconcileResult } from "./reconcile";
