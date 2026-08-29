/**
 * Structured logging (pino). Every state transition is logged with the window
 * and wallet it concerns, so a settlement that went wrong can be traced without
 * a debugger.
 */
import pino from "pino";

export const log = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  base: { service: "indexer" },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof log;
