/**
 * Chain identity, and nothing else.
 *
 * The browser needs the chain to configure wagmi. Reaching it through this
 * package's index pulled the ENTIRE venue SDK into the initial JavaScript
 * bundle of every page — including the leaderboard, which never touches a
 * wallet. Measured cost: ~1.6MB of client JS and 770ms of blocking time.
 *
 * This module imports only the SDK's `chains` subpath, which is a handful of
 * constants, so a page that merely wants to know which network it is on does
 * not pay for an exchange client it will never construct.
 *
 * Keep it free of anything that reaches the SDK index.
 */
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";

export const SHANNON = somniaShannon;

/** Somnia Shannon testnet. Mainnet (5031) is forbidden everywhere. */
export const TESTNET_CHAIN_ID = somniaShannon.id;
