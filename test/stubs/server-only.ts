/**
 * Stub for Next's `server-only` marker.
 *
 * That package exists to make importing a server module from a client
 * component a BUILD error. Vitest does not model that boundary, so tests alias
 * it here. The real guard is unaffected: `next build` still refuses the import.
 */
export {};
