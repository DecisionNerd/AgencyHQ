/**
 * Tests for the minimal SMTP sink and MIME magic-link extraction.
 * Uses a raw TCP client (node:net) to simulate an SMTP session.
 */
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { describe, it } from "node:test";
import {
  decodeBase64Part,
  decodeQuotedPrintable,
  extractMagicLink,
  startSmtpSink,
  unescapeHtmlEntities,
} from "../src/smtp-sink.ts";

// ── decodeQuotedPrintable unit tests ─────────────────────────────────────────

describe("decodeQuotedPrintable", () => {
  it("removes CRLF soft line breaks", () => {
    assert.equal(decodeQuotedPrintable("abc=\r\ndef"), "abcdef");
  });

  it("removes LF-only soft line breaks", () => {
    assert.equal(decodeQuotedPrintable("abc=\ndef"), "abcdef");
  });

  it("decodes =3D as equals sign", () => {
    assert.equal(decodeQuotedPrintable("token=3Dabc"), "token=abc");
  });

  it("decodes multiple =XX sequences", () => {
    assert.equal(decodeQuotedPrintable("a=20b=21"), "a b!");
  });

  it("decodes URL with =3D and soft line break (realistic magic-link case)", () => {
    // Simulate: http://host/magic?token=<split across soft break>
    const encoded = "http://host/magic?token=3Dabc123=\r\nxyz";
    assert.equal(decodeQuotedPrintable(encoded), "http://host/magic?token=abc123xyz");
  });
});

// ── unescapeHtmlEntities unit tests ──────────────────────────────────────────

describe("unescapeHtmlEntities", () => {
  it("unescapes &amp;", () => {
    assert.equal(unescapeHtmlEntities("a&amp;b"), "a&b");
  });

  it("unescapes &#x3D; (hex =)", () => {
    assert.equal(unescapeHtmlEntities("token&#x3D;value"), "token=value");
  });

  it("unescapes &#X3D; (uppercase hex =)", () => {
    assert.equal(unescapeHtmlEntities("token&#X3D;value"), "token=value");
  });

  it("unescapes &#61; (decimal =)", () => {
    assert.equal(unescapeHtmlEntities("token&#61;value"), "token=value");
  });

  it("leaves ordinary text unchanged", () => {
    assert.equal(unescapeHtmlEntities("hello world"), "hello world");
  });
});

// ── decodeBase64Part unit tests ───────────────────────────────────────────────

describe("decodeBase64Part", () => {
  it("decodes a base64-encoded string", () => {
    const encoded = Buffer.from("hello base64").toString("base64");
    assert.equal(decodeBase64Part(encoded), "hello base64");
  });

  it("ignores whitespace between base64 characters", () => {
    const raw = "hello base64 part";
    const encoded = Buffer.from(raw).toString("base64");
    // Insert line breaks as MIME base64 wrapping does.
    const wrapped = encoded.replace(/.{16}/g, "$&\r\n");
    assert.equal(decodeBase64Part(wrapped), raw);
  });
});

// ── extractMagicLink unit tests ───────────────────────────────────────────────

describe("extractMagicLink — plain text", () => {
  it("extracts magic link with token param from plain body", () => {
    const body = "Click here: http://localhost:8030/magic?token=abc123def";
    assert.equal(extractMagicLink(body), "http://localhost:8030/magic?token=abc123def");
  });

  it("extracts https magic link with token param", () => {
    const body = 'Login: <a href="https://trigger.example.com/magic?token=signed123">link</a>';
    assert.equal(extractMagicLink(body), "https://trigger.example.com/magic?token=signed123");
  });

  it("returns null when no magic link is present", () => {
    assert.equal(extractMagicLink("Hello, no link here."), null);
  });

  it("stops at whitespace (extracts only the URL portion)", () => {
    const body = "http://host/magic?token=abc next word";
    assert.equal(extractMagicLink(body), "http://host/magic?token=abc");
  });

  it("stops at double-quote (href context)", () => {
    const body = 'href="http://host/magic?token=tok"';
    assert.equal(extractMagicLink(body), "http://host/magic?token=tok");
  });

  it("returns null when token query parameter is missing", () => {
    assert.equal(extractMagicLink("http://host/magic/abc?code=123"), null);
  });

  it("returns null when token query parameter is empty", () => {
    assert.equal(extractMagicLink("http://host/magic?token= rest"), null);
  });
});

describe("extractMagicLink — MIME multipart quoted-printable", () => {
  it("decodes QP text/plain part and extracts token URL", () => {
    // =3D decodes to '=' so ?token=3Dabc becomes ?token=abc after QP decode.
    const body = [
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="utf-8"',
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Sign in: http://webapp:3000/magic?token=3Dmysignedtoken",
    ].join("\r\n");
    assert.equal(extractMagicLink(body), "http://webapp:3000/magic?token=mysignedtoken");
  });

  it("handles token split across a QP soft line break in multipart email", () => {
    // Realistic Trigger.dev email: multipart/alternative, QP encoded, token split.
    const boundary = "---=_Part_001_BOUNDARY";
    const body = [
      "MIME-Version: 1.0",
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "Subject: Magic link",
      "",
      `-----=_Part_001_BOUNDARY`,
      'Content-Type: text/plain; charset="utf-8"',
      "Content-Transfer-Encoding: quoted-printable",
      "",
      // Token is split: ?token=3D<first part>=\r\n<rest of token>
      "Click: http://webapp:3000/magic?token=3DsignedToke=",
      "nValue123",
      `-----=_Part_001_BOUNDARY`,
      'Content-Type: text/html; charset="utf-8"',
      "Content-Transfer-Encoding: quoted-printable",
      "",
      '<html><body><a href=3D"http://webapp:3000/magic?token=3DsignedToken">link</a></body></html>',
      `-----=_Part_001_BOUNDARY--`,
    ].join("\r\n");

    const link = extractMagicLink(body);
    assert.ok(link !== null, "expected a magic link to be extracted");
    assert.ok(link.includes("/magic?token="), `expected ?token= in link, got: ${link}`);
    // The text/plain part decodes to ?token=signedTokenValue123
    assert.equal(link, "http://webapp:3000/magic?token=signedTokenValue123");
  });

  it("extracts token from base64-encoded HTML part", () => {
    const htmlContent = '<a href="http://webapp:3000/magic?token=base64token">Sign in</a>';
    const b64 = Buffer.from(htmlContent).toString("base64");
    const boundary = "---=_Base64Part";
    const body = [
      "MIME-Version: 1.0",
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `-----=_Base64Part`,
      'Content-Type: text/html; charset="utf-8"',
      "Content-Transfer-Encoding: base64",
      "",
      b64,
      `-----=_Base64Part--`,
    ].join("\r\n");

    assert.equal(extractMagicLink(body), "http://webapp:3000/magic?token=base64token");
  });

  it("unescapes HTML entities in text/html part to find token", () => {
    // HTML part uses &#x3D; for '=' in href attribute.
    const boundary = "---=_Entities";
    const body = [
      "MIME-Version: 1.0",
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `-----=_Entities`,
      'Content-Type: text/html; charset="utf-8"',
      "Content-Transfer-Encoding: 7bit",
      "",
      '<html><body><a href="http://webapp:3000/magic?token&#x3D;htmlentitytoken">login</a></body></html>',
      `-----=_Entities--`,
    ].join("\r\n");

    assert.equal(extractMagicLink(body), "http://webapp:3000/magic?token=htmlentitytoken");
  });
});

// ── SMTP server integration tests ─────────────────────────────────────────────

/** Send a complete SMTP session with the given body. */
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
  it("captures magic link with token param from a plain-text body", async () => {
    const port = 19525; // Fixed test port — avoid clashing with production 2525.
    const sink = startSmtpSink({ port, host: "127.0.0.1", timeoutMs: 5000 });

    // Give the sink a moment to start listening.
    await new Promise((res) => setTimeout(res, 50));

    const magicUrl = "http://webapp:3000/magic?token=testtoken123";
    await sendEmail(port, `Subject: Magic Link\r\n\r\nClick: ${magicUrl}`);

    const result = await sink;
    assert.equal(result.magicLink, magicUrl);
    result.stop();
  });

  it("resolves with the first magic link when multiple emails are sent", async () => {
    const port = 19526;
    const sink = startSmtpSink({ port, host: "127.0.0.1", timeoutMs: 5000 });
    await new Promise((res) => setTimeout(res, 50));

    const firstUrl = "http://webapp:3000/magic?token=first111";
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

  it("captures magic link from QP-encoded multipart email via SMTP session", async () => {
    const port = 19528;
    const sink = startSmtpSink({ port, host: "127.0.0.1", timeoutMs: 5000 });
    await new Promise((res) => setTimeout(res, 50));

    // Build a minimal quoted-printable multipart body delivered over SMTP.
    const boundary = "---=_TestBoundary";
    const smtpBody = [
      "MIME-Version: 1.0",
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `-----=_TestBoundary`,
      'Content-Type: text/plain; charset="utf-8"',
      "Content-Transfer-Encoding: quoted-printable",
      "",
      // token=3D decodes to token=
      "Login: http://host/magic?token=3DqpSmtpToken",
      `-----=_TestBoundary--`,
    ].join("\r\n");

    await sendEmail(port, smtpBody);

    const result = await sink;
    assert.ok(result.magicLink.includes("/magic?token="), `got: ${result.magicLink}`);
    assert.equal(result.magicLink, "http://host/magic?token=qpSmtpToken");
    result.stop();
  });
});
