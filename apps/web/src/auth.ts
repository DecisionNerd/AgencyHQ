// Pure auth helpers — no DOM dependency; storage is injected for testability.

export const TOKEN_STORAGE_KEY = "agencyhq.apiToken";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized: API token required or invalid");
    this.name = "UnauthorizedError";
  }
}

/** Get the stored token, returning null on any storage error. */
export function getStoredToken(storage: StorageLike): string | null {
  try {
    return storage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Store a token, silently ignoring storage errors. */
export function setStoredToken(storage: StorageLike, token: string): void {
  try {
    storage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // Ignore storage errors (e.g. private-browsing quota)
  }
}

/** Remove the stored token, silently ignoring storage errors. */
export function clearStoredToken(storage: StorageLike): void {
  try {
    storage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }
}

/** Build the Authorization header object for a request, or {} when no token. */
export function buildAuthHeaders(token: string | null): Record<string, string> {
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

/**
 * Handle a 401 response: clear the stored token and return an UnauthorizedError
 * ready to be thrown by the caller.
 */
export function handle401(storage: StorageLike): UnauthorizedError {
  clearStoredToken(storage);
  return new UnauthorizedError();
}
