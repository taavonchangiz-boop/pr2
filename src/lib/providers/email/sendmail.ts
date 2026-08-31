// Minimal SMTP client (RFC 5321). Used by POSTYAR email provider when an SMTP
// relay is configured (cPanel supports SMTP relay via the local mail server).
// Uses Node's `net`/`tls` — compatible with Passenger.
//
// SECURITY (audit S1/S2):
//   * Port 587 now performs a real STARTTLS upgrade BEFORE AUTH LOGIN —
//     the previous implementation opened a RAW PLAINTEXT socket on 587
//     and sent base64 credentials in the clear. Port 465 stays implicit
//     TLS. The upgrade is mandatory: if the server refuses STARTTLS the
//     send FAILS (fail-closed) instead of leaking credentials.
//   * Sender/recipient addresses are validated against a strict
//     RFC-5321-safe charset; CR/LF or control characters are rejected so
//     SMTP command injection through the envelope is impossible.
import net from "node:net";
import tls, { TLSSocket } from "node:tls";
import { Socket } from "node:net";

type SmtpOpts = {
  host: string;
  port: number;
  user: string;
  password: string;
  sender: string;
  senderName: string;
  to: string;
  subjectFa: string;
  htmlFa: string;
};

function quotedPrintableEncode(s: string): string {
  // Minimal: encode non-ASCII as UTF-8 quoted-printable
  const buf = Buffer.from(s, "utf8");
  let out = "";
  let lineLen = 0;
  for (const b of buf) {
    if ((b >= 33 && b <= 60) || (b >= 62 && b <= 126) || b === 9 || b === 32) {
      out += String.fromCharCode(b);
      lineLen++;
    } else {
      const hex = b.toString(16).toUpperCase().padStart(2, "0");
      out += `=${hex}`;
      lineLen += 3;
    }
    if (lineLen >= 70) { out += "=\r\n"; lineLen = 0; }
  }
  return out;
}

/** Reject SMTP command injection: only printable ASCII, no CR/LF. */
function assertSafeEmailAddress(kind: string, value: string): void {
  if (!value || /[\r\n\u0000-\u001f\u007f]/.test(value) || /[<>\s]/.test(value)) {
    throw new Error(`${kind} invalid`);
  }
}

type StepHandler = (line: string, socket: Socket | TLSSocket) => void;

export async function sendMail(opts: SmtpOpts): Promise<void> {
  assertSafeEmailAddress("sender", opts.sender);
  assertSafeEmailAddress("recipient", opts.to);

  return new Promise<void>((resolve, reject) => {
    let socket: Socket | TLSSocket;
    let upgraded = opts.port === 465; // implicit TLS needs no upgrade

    const startProtocol = (sock: Socket | TLSSocket) => {
      socket = sock;
      wireProtocol(sock);
      // Server speaks first on a fresh connection.
    };

    const wireProtocol = (sock: Socket | TLSSocket) => {
      const write = (line: string) => sock.write(line + "\r\n");
      const buf: string[] = [];
      let step = 0;

      const handler: StepHandler = (line, current) => {
        const code = parseInt(line.slice(0, 3), 10);
        const ok = (line[3] === " " || line.length === 3);
        if (!ok) return; // multi-line; wait for the final line
        if (step === 0 && code === 220) {
          if (!upgraded && opts.port !== 465) {
            // STARTTLS before any AUTH (audit S1 — fail-closed).
            current.write("STARTTLS\r\n");
            step = 90;
            return;
          }
          write("EHLO postyar"); step = 1; return;
        }
        if (step === 90 && code === 220) {
          // Upgrade the socket to TLS, then restart the protocol.
          const secure = tls.connect({
            socket: current as Socket,
            servername: opts.host,
            rejectUnauthorized: true,
          }, () => {
            upgraded = true;
            step = 0;
            buf.length = 0;
            // Re-run the state machine on the secure socket: send EHLO.
            secure.write("EHLO postyar\r\n");
          });
          secure.setEncoding("utf8");
          // Replace the data handler with one bound to the secure socket.
          const sbuf: string[] = [];
          let sstep = 1; // after STARTTLS the next expected reply is EHLO's 250
          secure.on("data", (chunk: string) => {
            sbuf.push(chunk);
            const lines = sbuf.join("").split("\r\n");
            for (const line2 of lines) {
              if (!line2) continue;
              const c2 = parseInt(line2.slice(0, 3), 10);
              const ok2 = (line2[3] === " " || line2.length === 3);
              if (!ok2) continue;
              if (sstep === 1 && c2 === 250) { secure.write("AUTH LOGIN\r\n"); sstep = 2; continue; }
              if (sstep === 2 && c2 === 334) { secure.write(Buffer.from(opts.user).toString("base64")); sstep = 3; continue; }
              if (sstep === 3 && c2 === 334) { secure.write(Buffer.from(opts.password).toString("base64")); sstep = 4; continue; }
              if (sstep === 4 && c2 === 235) { secure.write(`MAIL FROM:<${opts.sender}>`); sstep = 5; continue; }
              if (sstep === 5 && c2 === 250) { secure.write(`RCPT TO:<${opts.to}>`); sstep = 6; continue; }
              if (sstep === 6 && c2 === 250) { secure.write("DATA"); sstep = 7; continue; }
              if (sstep === 7 && c2 === 354) {
                const message =
                  `From: =?UTF-8?Q?${quotedPrintableEncode(opts.senderName)}?= <${opts.sender}>\r\n` +
                  `To: <${opts.to}>\r\n` +
                  `Subject: =?UTF-8?Q?${quotedPrintableEncode(opts.subjectFa)}?=\r\n` +
                  `MIME-Version: 1.0\r\n` +
                  `Content-Type: text/html; charset=UTF-8\r\n` +
                  `Content-Transfer-Encoding: quoted-printable\r\n\r\n` +
                  `${quotedPrintableEncode(opts.htmlFa)}\r\n.\r\n`;
                secure.write(message);
                sstep = 8; continue;
              }
              if (sstep === 8 && c2 === 250) { secure.write("QUIT"); resolve(); secure.end(); return; }
              if (c2 >= 400) { reject(new Error(`SMTP error: ${line2}`)); secure.destroy(); return; }
            }
            sbuf.length = 0;
          });
          secure.on("error", (err) => reject(err));
          secure.setTimeout(15000, () => { reject(new Error("SMTP timeout")); secure.destroy(); });
          return;
        }
        if (step === 90 && code >= 400) {
          // Server refused STARTTLS — NEVER fall back to plaintext AUTH.
          reject(new Error("SMTP server does not support STARTTLS"));
          current.destroy();
          return;
        }
        if (step === 1 && code === 250) { write("AUTH LOGIN"); step = 2; return; }
        if (step === 2 && code === 334) { write(Buffer.from(opts.user).toString("base64")); step = 3; return; }
        if (step === 3 && code === 334) { write(Buffer.from(opts.password).toString("base64")); step = 4; return; }
        if (step === 4 && code === 235) { write(`MAIL FROM:<${opts.sender}>`); step = 5; return; }
        if (step === 5 && code === 250) { write(`RCPT TO:<${opts.to}>`); step = 6; return; }
        if (step === 6 && code === 250) { write("DATA"); step = 7; return; }
        if (step === 7 && code === 354) {
          const message =
            `From: =?UTF-8?Q?${quotedPrintableEncode(opts.senderName)}?= <${opts.sender}>\r\n` +
            `To: <${opts.to}>\r\n` +
            `Subject: =?UTF-8?Q?${quotedPrintableEncode(opts.subjectFa)}?=\r\n` +
            `MIME-Version: 1.0\r\n` +
            `Content-Type: text/html; charset=UTF-8\r\n` +
            `Content-Transfer-Encoding: quoted-printable\r\n\r\n` +
            `${quotedPrintableEncode(opts.htmlFa)}\r\n.\r\n`;
          write(message);
          step = 8; return;
        }
        if (step === 8 && code === 250) { write("QUIT"); resolve(); socket.end(); return; }
        if (code >= 400) { reject(new Error(`SMTP error: ${line}`)); current.destroy(); return; }
      };

      sock.setEncoding("utf8");
      sock.on("data", (chunk: string) => {
        buf.push(chunk);
        const lines = buf.join("").split("\r\n");
        for (const line of lines) {
          if (!line) continue;
          handler(line, sock);
        }
        buf.length = 0;
      });
      sock.on("error", (err: NodeJS.ErrnoException) => reject(err));
      sock.setTimeout(15000, () => { reject(new Error("SMTP timeout")); sock.destroy(); });
    };

    if (opts.port === 465) {
      startProtocol(tls.connect({ host: opts.host, port: opts.port, servername: opts.host, rejectUnauthorized: true }));
    } else {
      const raw = new Socket();
      raw.connect(opts.port, opts.host);
      startProtocol(raw);
    }
  });
}
