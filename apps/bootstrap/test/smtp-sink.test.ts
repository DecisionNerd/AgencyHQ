/**
 * Tests for the minimal SMTP sink.
 * Uses a raw TCP client (node:net) to simulate an SMTP session.
 */
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { describe, it } from "node:test";
import { extractMagicLink, startSmtpSink } from "../src/smtp-sink.ts";

// ── extractMagicLink unit tests ───────────────────────────────────────────────

describe("extractMagicLink", () => {
  it("extracts http magic link from plain body", () => {
    const body = "Click here: http://localhost:8030/magic/abc123def?code=xyz";
    assert.equal(extractMagicLink(body), "http://localhost:8030/magic/abc123def?code=xyz");
  });

  it("extracts https magic link", () => {
    const body = 'Login: <a href="https://trigger.example.com/magic/token?v=1">link</a>';
    assert.equal(extractMagicLink(body), "https://trigger.example.com/magic/token?v=1");
  });

  it("returns null when no magic link present", () => {
    assert.equal(extractMagicLink("Hello, no link here."), null);
  });

  it("stops at whitespace", () => {
    const body = "http://host/magic/abc next word";
    assert.equal(extractMagicLink(body), "http://host/magic/abc");
  });

  it("stops at double-quote", () => {
    const body = 'href="http://host/magic/tok"';
    assert.equal(extractMagicLink(body), "http://host/magic/tok");
  });
});

// ── SMTP server integration tests ─────────────────────────────────────────────

/** Send a complete SMTP session with the given body and return the raw magic link. */
async function sendEmail(port: number, bodyText: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = createConnection({ port, host: "127.0.0.1" }, () => {
      // nothing on connect — wait for banner
    });

    let buf = "";
    let step = 0;

    client.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\r\n");
      buf = lines.pop() ?? "";

      for (const line of lines) {
        if (!line) continue;
        // State machine: respond to each server greeting
        if (step === 0 && line.startsWith("220")) {
          client.write("EHLO testclient\r\n");
          step = 1;
        } else if (step === 1 && line.startsWith("250 OK")) {
          client.write(`MAIL FROM:<sender@example.com>\r\n`);
          step = 2;
        } else if (step === 2 && line.startsWith("250 OK")) {
          client.write(`RCPT TO:<recipient@example.com>\r\n`);
          step = 3;
        } else if (step === 3 && line.startsWith("250 OK")) {
          client.write("DATA\r\n");
          step = 4;
        } else if (step === 4 && line.startsWith("354")) {
          // Send the body followed by the end-of-data marker.
          client.write(`${bodyText}\r\n.\r\n`);
          step = 5;
        } else if (step === 5 && line.startsWith("250 OK")) {
          client.write("QUIT\r\n");
          step = 6;
        } else if (step === 6 && line.startsWith("221")) {
          client.end();
          resolve();
        }
      }
    });

    client.on("error", reject);
    client.on("close", () => {
      if (step < 6) reject(new Error(`connection closed at step ${step}`));
    });
  });
}

describe("startSmtpSink", () => {
  it("captures magic link from a plain-text body", async () => {
    const port = 19525; // Fixed test port — avoid clashing with production 2525.
    const sink = startSmtpSink({ port, host: "127.0.0.1", timeoutMs: 5000 });

    // Give the sink a moment to start listening.
    await new Promise((res) => setTimeout(res, 50));

    const magicUrl = "http://webapp:3000/magic/testtoken?code=abcdef";
    await sendEmail(port, `Subject: Magic Link\r\n\r\nClick: ${magicUrl}`);

    const result = await sink;
    assert.equal(result.magicLink, magicUrl);
    result.stop();
  });

  it("resolves with the first magic link when multiple emails are sent", async () => {
    const port = 19526;
    const sink = startSmtpSink({ port, host: "127.0.0.1", timeoutMs: 5000 });
    await new Promise((res) => setTimeout(res, 50));

    const firstUrl = "http://webapp:3000/magic/first?code=111";
    await sendEmail(port, `Click: ${firstUrl}`);

    const result = await sink;
    assert.equal(result.magicLink, firstUrl);
    result.stop();
  });

  it("rejects when no magic link arrives within the timeout", async () => {
    const port = 19527;
    const sink = startSmtpSink({ port, host: "127.0.0.1", timeoutMs: 200 });
    await new Promise((res) => setTimeout(res, 50));

    // Send an email without a magic link.
    await sendEmail(port, "Subject: No link here\r\n\r\nHello, no URL.");

    await assert.rejects(sink, (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /timed out/i);
      return true;
    });
  });

  it("handles EHLO multi-line response correctly", async () => {
    const port = 19528;
    const sink = startSmtpSink({ port, host: "127.0.0.1", timeoutMs: 5000 });
    await new Promise((res) => setTimeout(res, 50));

    const url = "http://host/magic/multi?tok=xyz";
    await sendEmail(port, url);

    const result = await sink;
    assert.ok(result.magicLink.includes("/magic/"));
    result.stop();
  });
});
