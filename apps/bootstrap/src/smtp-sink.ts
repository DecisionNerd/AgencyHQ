/**
 * Minimal SMTP server (EHLO/MAIL/RCPT/DATA/QUIT) on port 2525.
 * Captures the magic-link email body and extracts the link, then stops.
 * No third-party dependencies — uses Node's built-in net module.
 *
 * The email from Trigger.dev is a MIME multipart message sent via nodemailer
 * with quoted-printable encoding. This module decodes QP (soft line breaks,
 * =XX sequences) and HTML entities (&amp;, &#x3D;, &#61;) before searching
 * for a magic-link URL with a non-empty `token` query parameter.
 */

import type { Server } from "node:net";
import { createServer } from "node:net";

// ── MIME / encoding helpers ───────────────────────────────────────────────────

/**
 * Decode a quoted-printable encoded string.
 * Removes soft line breaks (=\r\n and =\n) and decodes =XX byte sequences.
 */
export function decodeQuotedPrintable(encoded: string): string {
  return encoded
    .replace(/=\r?\n/g, "") // remove soft line breaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Decode a base64-encoded MIME part (whitespace is ignored per MIME spec).
 */
export function decodeBase64Part(encoded: string): string {
  return Buffer.from(encoded.replace(/\s+/g, ""), "base64").toString("utf-8");
}

/**
 * Unescape common HTML entities used in HTML email parts.
 * Handles &amp;, &#x3D; / &#X3D; (= sign), and &#61; (= sign).
 */
export function unescapeHtmlEntities(html: string): string {
  return html
    .replace(/&amp;/g, "&")
    .replace(/&#[xX]3[Dd];/g, "=")
    .replace(/&#61;/g, "=");
}

/** Parse header field lines into a name→value map (names lowercased). */
function parseHeaderFields(headerText: string): Map<string, string> {
  const map = new Map<string, string>();
  // Unfold continuation lines (RFC 2822 §2.2.3: continuation starts with WSP).
  const unfolded = headerText.replace(/\r?\n[ \t]/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name) map.set(name, value);
  }
  return map;
}

/**
 * Split a MIME message into its header map and body string.
 * Looks for the blank-line separator (\r\n\r\n or \n\n).
 */
function parseMimeHeaders(text: string): { headers: Map<string, string>; body: string } {
  const crlf = text.indexOf("\r\n\r\n");
  if (crlf !== -1) {
    return {
      headers: parseHeaderFields(text.slice(0, crlf)),
      body: text.slice(crlf + 4),
    };
  }
  const lf = text.indexOf("\n\n");
  if (lf !== -1) {
    return {
      headers: parseHeaderFields(text.slice(0, lf)),
      body: text.slice(lf + 2),
    };
  }
  // No blank line — treat entire text as body with empty headers.
  return { headers: new Map(), body: text };
}

/** Extract the boundary value from a Content-Type header string. */
function extractBoundary(contentType: string): string | null {
  const m = /boundary=(?:"([^"]+)"|([^\s;]+))/i.exec(contentType);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

/** Split a multipart body by boundary into raw part strings. */
function splitMultipart(body: string, boundary: string): string[] {
  const sep = `--${boundary}`;
  const endMarker = `--${boundary}--`;
  const parts: string[] = [];
  let current: string[] = [];
  let inPart = false;

  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith(endMarker)) {
      if (inPart) parts.push(current.join("\r\n"));
      break;
    }
    if (line === sep || line.startsWith(`${sep}\r`)) {
      if (inPart) parts.push(current.join("\r\n"));
      current = [];
      inPart = true;
      continue;
    }
    if (inPart) current.push(line);
  }
  return parts;
}

/**
 * Decode a single MIME part: apply Content-Transfer-Encoding and
 * HTML entity unescaping for text/html parts.
 */
function decodePart(headers: Map<string, string>, body: string): string {
  const cte = (headers.get("content-transfer-encoding") ?? "").toLowerCase().trim();
  const ct = (headers.get("content-type") ?? "").toLowerCase();
  const isHtml = ct.includes("text/html");

  let text: string;
  if (cte === "quoted-printable") {
    text = decodeQuotedPrintable(body);
  } else if (cte === "base64") {
    text = decodeBase64Part(body);
  } else {
    text = body;
  }
  return isHtml ? unescapeHtmlEntities(text) : text;
}

/**
 * Decode all text bodies from a MIME message (which may be multipart).
 * Returns an array of decoded strings to search for the magic link.
 */
function getMimeTexts(rawBody: string): string[] {
  const { headers, body } = parseMimeHeaders(rawBody);
  const ct = headers.get("content-type") ?? "";
  const boundary = extractBoundary(ct);

  if (boundary) {
    const texts: string[] = [];
    for (const partRaw of splitMultipart(body, boundary)) {
      const { headers: ph, body: pb } = parseMimeHeaders(partRaw);
      const partCt = ph.get("content-type") ?? "";
      const partBoundary = extractBoundary(partCt);
      if (partBoundary) {
        // Nested multipart — recurse using the decoded part body.
        texts.push(...getMimeTexts(decodePart(ph, pb)));
      } else {
        texts.push(decodePart(ph, pb));
      }
    }
    return texts;
  }

  // Single part: decode and return.
  // If no Content-Type was declared, return the full raw body (legacy plain SMTP).
  if (!ct) return [rawBody];
  return [decodePart(headers, body)];
}

/** Find the first URL containing /magic in its path with a non-empty `token` param. */
function findMagicUrl(text: string): string | null {
  const re = /https?:\/\/[^\s"'<>]+\/magic[^\s"'<>]*/g;
  for (const m of text.matchAll(re)) {
    // Strip trailing punctuation that may appear in surrounding prose.
    const raw = m[0].replace(/[.,;:!?)\]]+$/, "");
    try {
      const parsed = new URL(raw);
      if (parsed.searchParams.get("token")) return raw;
    } catch {
      // Ignore malformed URLs.
    }
  }
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Extract the first magic-link URL from an email body.
 * Handles MIME multipart bodies with quoted-printable or base64 encoding
 * and HTML entity escaping. The URL must have a non-empty `token` query parameter.
 * Returns null when no matching URL is found.
 */
export function extractMagicLink(body: string): string | null {
  for (const text of getMimeTexts(body)) {
    const url = findMagicUrl(text);
    if (url) return url;
  }
  return null;
}

export interface SmtpSinkResult {
  /** The raw magic-link URL extracted from the email. */
  magicLink: string;
  /** Stop the SMTP server (idempotent). */
  stop(): void;
}

export interface SmtpSinkOptions {
  /** TCP port to listen on. Defaults to 2525. */
  port?: number;
  /** Bind address. Defaults to "0.0.0.0". */
  host?: string;
  /** How long to wait for the email before rejecting. Defaults to 120 000 ms. */
  timeoutMs?: number;
  /**
   * If provided and aborted before the email arrives, the promise rejects
   * immediately with a non-timeout error so the caller can fail fast without
   * waiting for the full SMTP timeout.
   */
  signal?: AbortSignal;
}

/**
 * Start a minimal SMTP sink and resolve with the first magic-link found in
 * an incoming email. Rejects when timeoutMs elapses without receiving a link.
 *
 * Call result.stop() when done if the caller wants to shut down early.
 */
export function startSmtpSink(options: SmtpSinkOptions = {}): Promise<SmtpSinkResult> {
  const port = options.port ?? 2525;
  const host = options.host ?? "0.0.0.0";
  const timeoutMs = options.timeoutMs ?? 120_000;

  return new Promise<SmtpSinkResult>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let server: Server;

    function settle(result: SmtpSinkResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    }

    function fail(err: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server?.close();
      reject(err);
    }

    function stopServer(): void {
      server?.close();
    }

    // If an AbortSignal is provided, reject immediately when it fires so the
    // caller can skip the SMTP wait after a failed magic-link request.
    if (options.signal) {
      const sig = options.signal;
      if (sig.aborted) {
        // Already aborted before we even started.
        reject(Object.assign(new Error("smtp-sink: aborted"), { errorCategory: "smtp_aborted" }));
        return;
      }
      sig.addEventListener(
        "abort",
        () =>
          fail(Object.assign(new Error("smtp-sink: aborted"), { errorCategory: "smtp_aborted" })),
        { once: true },
      );
    }

    server = createServer((socket) => {
      /** Single shared buffer for the entire connection. */
      let buf = "";
      /** True while accumulating DATA body lines. */
      let inData = false;

      function processBuffer(): void {
        while (true) {
          if (inData) {
            // DATA ends at a line containing only "."
            const endIdx = buf.indexOf("\r\n.\r\n");
            if (endIdx === -1) break;
            const body = buf.slice(0, endIdx);
            buf = buf.slice(endIdx + 5);
            inData = false;
            socket.write("250 OK\r\n");
            const link = extractMagicLink(body);
            if (link) {
              settle({ magicLink: link, stop: stopServer });
            }
          } else {
            const nlIdx = buf.indexOf("\r\n");
            if (nlIdx === -1) break;
            const line = buf.slice(0, nlIdx);
            buf = buf.slice(nlIdx + 2);
            const upper = line.toUpperCase().trimEnd();

            if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
              socket.write("250-bootstrap\r\n250 OK\r\n");
            } else if (upper.startsWith("MAIL FROM")) {
              socket.write("250 OK\r\n");
            } else if (upper.startsWith("RCPT TO")) {
              socket.write("250 OK\r\n");
            } else if (upper === "DATA") {
              socket.write("354 Start mail input; end with <CRLF>.<CRLF>\r\n");
              inData = true;
            } else if (upper.startsWith("NOOP")) {
              socket.write("250 OK\r\n");
            } else if (upper.startsWith("RSET")) {
              socket.write("250 OK\r\n");
              inData = false;
            } else if (upper.startsWith("QUIT")) {
              socket.write("221 Bye\r\n");
              socket.end();
            }
            // Unknown commands are silently ignored (no-op sink)
          }
        }
      }

      socket.write("220 bootstrap ESMTP\r\n");

      socket.on("data", (chunk) => {
        buf += chunk.toString("utf-8");
        processBuffer();
      });

      socket.on("error", () => {
        // Ignore individual socket errors; the server continues.
      });
    });

    timer = setTimeout(() => {
      fail(new Error("smtp-sink: timed out waiting for magic-link email"));
    }, timeoutMs);

    server.on("error", (err) => {
      fail(err);
    });

    server.listen(port, host, () => {
      // Listening — caller's Promise stays pending until email arrives.
    });
  });
}
