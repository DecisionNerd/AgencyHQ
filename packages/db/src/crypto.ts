/**
 * AES-256-GCM encryption helpers for credential storage.
 *
 * encryptSecret / decryptSecret wrap Node's built-in crypto so that the
 * callers (repos/project-credentials.ts) handle key material — this module
 * never reads environment variables or logs secret values.
 *
 * KEY FORMAT: 64 lower-case hex characters representing 32 bytes (256 bits).
 * The caller retrieves AGENCYHQ_SECRETS_KEY from the environment.
 *
 * SECURITY INVARIANT: secret values never appear in thrown errors, log output,
 * JSON summaries, or test snapshots. Only ids, key lengths, purposes, and
 * non-sensitive metadata are safe to surface.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit IV recommended for GCM
const TAG_BYTES = 16; // 128-bit authentication tag
const KEY_HEX_LEN = 64; // 32 bytes = 256 bits encoded as hex

/** Parsed row shape returned by decryptSecret for DB round-trips. */
export interface EncryptedRow {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  key_version: number;
}

/**
 * Parse a 64-hex string into a 32-byte Buffer.
 * Throws if the key is the wrong length — never logs the key value.
 */
function parseKey(hexKey: string): Buffer {
  if (hexKey.length !== KEY_HEX_LEN) {
    throw new Error(
      `encryptSecret: key must be ${KEY_HEX_LEN} hex characters (${KEY_HEX_LEN / 2} bytes); got length ${hexKey.length}`,
    );
  }
  return Buffer.from(hexKey, "hex");
}

/**
 * Encrypt `plaintext` with AES-256-GCM using a random 12-byte IV.
 *
 * @param plaintext - The secret string to encrypt (e.g. an auth token).
 * @param hexKey    - 64 hex-character string representing the 32-byte key.
 *                    Retrieved by the caller from AGENCYHQ_SECRETS_KEY.
 * @returns An EncryptedRow suitable for storage in project_credentials.
 */
export function encryptSecret(
  plaintext: string,
  hexKey: string,
): Omit<EncryptedRow, "key_version"> {
  const key = parseKey(hexKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext, iv, tag };
}

/**
 * Decrypt a row produced by encryptSecret.
 *
 * @param row    - The encrypted row from project_credentials.
 * @param hexKey - 64 hex-character string representing the 32-byte key.
 * @returns The original plaintext string.
 * @throws If authentication fails (wrong key, tampered ciphertext, or bad IV).
 *         The error message does NOT reveal the key or plaintext.
 */
export function decryptSecret(row: EncryptedRow, hexKey: string): string {
  const key = parseKey(hexKey);
  if (row.iv.length !== IV_BYTES) {
    throw new Error(`decryptSecret: unexpected iv length ${row.iv.length}`);
  }
  if (row.tag.length !== TAG_BYTES) {
    throw new Error(`decryptSecret: unexpected tag length ${row.tag.length}`);
  }
  const decipher = createDecipheriv(ALGORITHM, key, row.iv);
  decipher.setAuthTag(row.tag);
  try {
    const plaintext = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    // Do not include any key material, iv, or ciphertext bytes in the message.
    throw new Error("decryptSecret: authentication failed — wrong key or tampered ciphertext");
  }
}
