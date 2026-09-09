/**
 * Minimal SMTP server (EHLO/MAIL/RCPT/DATA/QUIT) on port 2525.
 * Captures the magic-link email body and extracts the link, then stops.
 * No third-party dependencies — uses Node's built-in net module.
 */

import type { Server } from "node:net";
import { createServer } from "node:net";

/** Pattern for any HTTP(S) URL that contains /magic in its path. */
const MAGIC_LINK_RE = /https?:\/\/[^\s"<>]+\/magic[^\s"<>]*/;

/**
 * Extract the first magic-link URL from an email body string.
 * Returns null when no matching URL is found.
 */
export function extractMagicLink(body: string): string | null {
  return MAGIC_LINK_RE.exec(body)?.[0] ?? null;
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
