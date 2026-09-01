/**
 * `@predictarena/ai` — the AI forecaster.
 *
 * The angle is deliberately not "AI that advises you". It is a forecaster that
 * PLAYS: it holds its own wallet, places real calls on the real venue, and is
 * ranked by the same Brier score and edge as every human on the board. That
 * makes its performance checkable rather than claimed — if it has no edge, the
 * leaderboard says so.
 *
 * The parts are kept separable on purpose:
 *   `prompt.ts`  what the model is told          (pure)
 *   `decide.ts`  whether an estimate is tradable (pure)
 *   `provider.ts` which backend, and how it authenticates
 *   `forecast.ts` the one API call               (fails to null)
 *   `agent.ts`   the pass over the live board
 */
export { decide, bpsToUnits, unitsToBps, edgeRequirementX10, MIN_EDGE_BPS, MIN_ASK_BPS, MAX_ASK_BPS } from "./decide";
export { forecastWindow, isConfigured, type ForecastResult } from "./forecast";
export {
  activeProvider, createForecastClient, describeProvider, modelId,
  type Provider, type ForecastClient,
} from "./provider";
export { buildPrompt, parseForecast, SYSTEM_PROMPT, FORECAST_SCHEMA, type WindowContext, type HistoricalWindow } from "./prompt";
export { runAgent, type AgentOptions, type AgentRun } from "./agent";
export {
  BPS_UNIT,
  type Forecast, type Confidence, type Decision, type PlaceDecision, type PassDecision,
  type PassReason, type BookPrices, type Direction,
} from "./types";
