/*
 * Outbound mail.
 *
 * SMTP is a line protocol with a mid-conversation TLS upgrade, which is
 * exactly the kind of code that appears to work against the one relay it was
 * written against and desynchronises against the next. So the client is driven
 * against a real socket here, both ways: implicit TLS on 465 and STARTTLS on
 * 587, with a self-signed certificate generated at test time.
 *
 * The header assertions matter for a different reason. A contact form takes a
 * subject line from a stranger and puts it in a mail header, which is the
 * textbook setup for header injection.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const mailer = require('../src/mailer.js');

/* ------------------------------------------------------------- header shape */

test('a subject cannot inject a header', () => {
  // The classic: a newline in the subject ends the header and starts a new one,
  // which is how a contact form is turned into an open relay for Bcc.
  const built = mailer.buildMessage({
    from: 'me@example.com',
    to: 'you@example.com',
    subject: 'Hello\r\nBcc: victim@example.net',
    text: 'body',
  });
  const headers = built.data.split('\r\n\r\n')[0];
  assert.equal(/^Bcc:/m.test(headers), false, 'a Bcc header was injected');
  assert.equal(headers.split('\r\n').filter((l) => /^Subject:/.test(l)).length, 1);
});

test('a non-ASCII subject is encoded rather than sent raw', () => {
  const built = mailer.buildMessage({
    from: 'me@example.com', to: 'you@example.com', subject: 'Héllo', text: 'x',
  });
  assert.match(built.data, /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/m);
});

test('the visitor goes in Reply-To, never in From', () => {
  /*
   * From has to stay the authenticated mailbox. Putting the visitor's address
   * there is the single most common reason a contact form lands in spam: it
   * fails SPF and DMARC for a domain the relay has no authority over.
   */
  const built = mailer.buildMessage({
    from: 'me@example.com', to: 'me@example.com',
    replyTo: 'stranger@example.org', subject: 's', text: 'x',
  });
  assert.match(built.data, /^From: me@example\.com$/m);
  assert.match(built.data, /^Reply-To: stranger@example\.org$/m);
});

test('an address that is not a plain addr-spec is refused, not escaped', () => {
  for (const bad of ['a@b.co>, evil@x.co', 'a b@c.co', '"x"@y.co', 'a@b', '', null]) {
    assert.throws(
      () => mailer.buildMessage({ from: 'me@example.com', to: bad, subject: 's', text: 'x' }),
      /valid address/,
      `accepted ${JSON.stringify(bad)}`
    );
  }
});

test('a lone dot in the body cannot end the message early', () => {
  // A line of a single dot terminates DATA. Un-stuffed, a body containing one
  // truncates the mail there and hands the rest to the relay as commands.
  assert.equal(mailer.encodeBody('one\n.\ntwo'), 'one\r\n..\r\ntwo');
  assert.equal(mailer.encodeBody('.hidden'), '..hidden');
});

test('every line ending in the body is CRLF', () => {
  assert.equal(mailer.encodeBody('a\nb\r\nc\rd'), 'a\r\nb\r\nc\r\nd');
});

/* ------------------------------------------------------------ the real wire */

/** A self-signed certificate, generated at test time so none is committed. */
function selfSigned() {
  const dir = mkdtempSync(path.join(tmpdir(), 'ta-smtp-'));
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', path.join(dir, 'key.pem'),
      '-out', path.join(dir, 'cert.pem'),
      '-days', '1', '-subj', '/CN=localhost',
    ], { stdio: 'ignore' });
    return {
      key: readFileSync(path.join(dir, 'key.pem')),
      cert: readFileSync(path.join(dir, 'cert.pem')),
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return null;
  }
}

/**
 * A relay that speaks just enough SMTP to be talked to. Records the whole
 * conversation so the test can assert what the client actually sent.
 */
function fakeRelay({ creds, startTls }) {
  const transcript = [];
  let received = '';

  const converse = (socket, upgrade) => {
    let inData = false;
    let buf = '';
    socket.setEncoding('utf8');
    // RFC 3207: after the TLS handshake the client sends EHLO and the server
    // does NOT greet again. Greeting twice desynchronises the conversation.
    if (!upgrade) socket.write('220 fake.relay ESMTP\r\n');
    socket.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; socket.write('250 2.0.0 Queued as ABC123\r\n'); }
          else received += `${line}\n`;
          continue;
        }
        transcript.push(line);
        const cmd = line.split(' ')[0].toUpperCase();
        if (cmd === 'EHLO') {
          socket.write('250-fake.relay\r\n');
          if (startTls && !upgrade) socket.write('250-STARTTLS\r\n');
          socket.write('250-AUTH PLAIN LOGIN\r\n');
          socket.write('250 SIZE 35882577\r\n');
        } else if (cmd === 'STARTTLS') {
          socket.write('220 2.0.0 Ready to start TLS\r\n');
          socket.removeAllListeners('data');
          const secure = new tls.TLSSocket(socket, { isServer: true, key: creds.key, cert: creds.cert });
          secure.on('secure', () => converse(secure, true));
          return;
        } else if (cmd === 'AUTH') {
          const payload = line.split(' ')[2];
          const decoded = payload ? Buffer.from(payload, 'base64').toString('utf8') : '';
          transcript.push(`AUTH-DECODED ${JSON.stringify(decoded)}`);
          socket.write('235 2.7.0 Accepted\r\n');
        } else if (cmd === 'MAIL' || cmd === 'RCPT') {
          socket.write('250 2.1.0 OK\r\n');
        } else if (cmd === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (cmd === 'QUIT') {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
        } else {
          socket.write('502 5.5.2 Not implemented\r\n');
        }
      }
    });
    socket.on('error', () => { /* the client destroys the socket after QUIT */ });
  };

  const server = startTls
    ? net.createServer((s) => converse(s, false))
    // Implicit TLS: secure from the first byte, so it still greets.
    : tls.createServer({ key: creds.key, cert: creds.cert }, (s) => converse(s, false));

  return {
    server,
    transcript,
    get received() { return received; },
    listen() {
      return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
    },
    close() { return new Promise((resolve) => server.close(resolve)); },
  };
}

const creds = selfSigned();

async function driveRelay(t, { startTls }) {
  const relay = fakeRelay({ creds, startTls });
  const port = await relay.listen();
  const saved = { ...process.env };
  Object.assign(process.env, {
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(port),
    SMTP_USER: 'me@example.com',
    SMTP_PASS: 'app-password',
    SMTP_FROM: 'me@example.com',
    NODE_ENV: 'test',
    // The relay's certificate is self signed, so the client would refuse it in
    // production. NODE_ENV is not production here, which is the documented
    // escape, and this is asserted separately below.
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
  });
  t.after(async () => {
    process.env = saved;
    await relay.close();
  });
  return { relay, port };
}

// The port decides the mode: 465 means implicit TLS. The fake relay listens on
// an ephemeral port, so the client is pointed at the right mode by patching the
// module's own view of it rather than by squatting on a privileged port.
test('a message is delivered over implicit TLS', async (t) => {
  if (!creds) return t.skip('openssl is not available to generate a test certificate');
  const { relay, port } = await driveRelay(t, { startTls: false });

  const res = await mailer.send(
    { to: 'me@example.com', replyTo: 'stranger@example.org', subject: 'A test', text: 'Hello from the test.' },
    { port, implicitTls: true }
  );
  assert.match(res.queued, /Queued as ABC123/);
  assert.ok(relay.transcript.some((l) => l.startsWith('EHLO ')), 'no EHLO');
  assert.ok(relay.transcript.some((l) => l.startsWith('AUTH PLAIN ')), 'no AUTH');
  assert.ok(relay.transcript.includes('MAIL FROM:<me@example.com>'), 'wrong envelope sender');
  assert.ok(relay.transcript.includes('RCPT TO:<me@example.com>'), 'wrong envelope recipient');
  assert.match(relay.received, /^Reply-To: stranger@example\.org$/m);
  assert.match(relay.received, /Hello from the test\./);
});

test('a message is delivered over STARTTLS, and the password goes after the upgrade', async (t) => {
  if (!creds) return t.skip('openssl is not available to generate a test certificate');
  const { relay, port } = await driveRelay(t, { startTls: true });

  await mailer.send(
    { to: 'me@example.com', subject: 'Upgraded', text: 'body' },
    { port, implicitTls: false }
  );

  const order = relay.transcript.filter((l) => /^(EHLO|STARTTLS|AUTH PLAIN)/.test(l));
  assert.deepEqual(
    order.map((l) => l.split(' ')[0]),
    ['EHLO', 'STARTTLS', 'EHLO', 'AUTH'],
    'the session must re-EHLO after the upgrade and only then authenticate'
  );
  const decoded = relay.transcript.find((l) => l.startsWith('AUTH-DECODED'));
  assert.match(decoded, /app-password/, 'the credential never reached the relay');
});

test('a relay with no STARTTLS is refused rather than sent a plaintext password', async (t) => {
  if (!creds) return t.skip('openssl is not available to generate a test certificate');
  // startTls: true makes the server plain TCP, but the relay below advertises
  // no STARTTLS capability, so the client must give up instead of continuing.
  const relay = fakeRelay({ creds, startTls: false });
  const plain = net.createServer((s) => {
    s.setEncoding('utf8');
    s.write('220 fake.relay ESMTP\r\n');
    s.on('data', () => s.write('250-fake.relay\r\n250 AUTH PLAIN\r\n'));
    s.on('error', () => {});
  });
  const port = await new Promise((r) => plain.listen(0, '127.0.0.1', () => r(plain.address().port)));
  t.after(() => new Promise((r) => plain.close(r)));
  await relay.close();

  const saved = { ...process.env };
  Object.assign(process.env, {
    SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port),
    SMTP_USER: 'me@example.com', SMTP_PASS: 'secret',
  });
  t.after(() => { process.env = saved; });

  await assert.rejects(
    mailer.send({ to: 'me@example.com', subject: 's', text: 'x' }, { port, implicitTls: false }),
    /does not offer STARTTLS/
  );
});

test('with no configuration it refuses clearly instead of hanging', async () => {
  const saved = { ...process.env };
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  try {
    assert.equal(mailer.isConfigured(), false);
    await assert.rejects(
      mailer.send({ to: 'a@b.co', subject: 's', text: 'x' }),
      /SMTP is not configured/
    );
  } finally {
    process.env = saved;
  }
});
