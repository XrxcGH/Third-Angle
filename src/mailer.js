'use strict';

/*
 * Outbound email, over SMTP, with no dependency.
 *
 * Same reasoning as scrypt and TOTP in src/auth.js: node:tls and node:net are
 * already here, SMTP submission is a short line protocol, and nodemailer would
 * be a large dependency for one code path that sends one kind of message.
 *
 * What this is NOT: a mail server. It is an SMTP *submission* client. It hands
 * a message to a relay that already accepts mail for you, authenticated. It
 * does not talk to recipient MX hosts, does not queue, and does not retry on a
 * schedule. Retry is a button in the admin, because the operator is the only
 * person who ever needs it and a background queue on a single writer SQLite box
 * is machinery this does not need.
 *
 * Configuration, all from the environment so no credential is ever in the
 * database or the repository:
 *
 *   SMTP_HOST      smtp.gmail.com
 *   SMTP_PORT      465 for implicit TLS, 587 for STARTTLS
 *   SMTP_USER      the mailbox
 *   SMTP_PASS      an app password, never the account password
 *   SMTP_FROM      optional; defaults to SMTP_USER
 *
 * costs.yml records that the planned mailbox, Zoho Mail Forever Free, ships
 * without an SMTP relay. So this is deliberately provider-agnostic: point it at
 * whatever relay is actually available, and if it is pointed at nothing the
 * contact form still stores every message and says so.
 */

const net = require('node:net');
const tls = require('node:tls');

const TIMEOUT_MS = 15_000;

function config() {
  const host = process.env.SMTP_HOST || '';
  const port = Number(process.env.SMTP_PORT || 465);
  const user = process.env.SMTP_USER || '';
  const pass = process.env.SMTP_PASS || '';
  return {
    host,
    port,
    user,
    pass,
    from: process.env.SMTP_FROM || user,
    // 465 is implicit TLS from the first byte. 587 opens in the clear and is
    // upgraded with STARTTLS, which is why the code has to handle both.
    implicitTls: port === 465,
    configured: Boolean(host && user && pass),
  };
}

const isConfigured = () => config().configured;

/* ----------------------------------------------------------------- headers */

/*
 * RFC 2047 encoded word, for any header value that is not plain ASCII.
 *
 * A raw UTF-8 subject line is not merely mangled: a bare newline or a
 * non-ASCII byte in a header is how header injection works, so this both
 * encodes and, by construction, cannot emit CR or LF.
 */
function encodeHeader(value) {
  const s = String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim();
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

/**
 * An address for a header. Anything that is not a plain addr-spec is rejected
 * rather than escaped, because a display name is never worth a header
 * injection, and every address this sends to is one the operator controls.
 */
function safeAddress(value) {
  const s = String(value == null ? '' : value).trim();
  if (!/^[^\s@<>,;:"']+@[^\s@<>,;:"']+\.[^\s@<>,;:"']+$/.test(s)) return null;
  return s;
}

/*
 * Dot stuffing, then CRLF line endings. A line consisting of a single dot ends
 * the DATA command, so a message body containing one would truncate the mail
 * at that point and leave the remainder to be parsed as SMTP commands.
 */
function encodeBody(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n?|\n/g, '\r\n')
    .split('\r\n')
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n');
}

function messageId(host) {
  const rand = require('node:crypto').randomBytes(12).toString('hex');
  return `<${Date.now().toString(36)}.${rand}@${host || 'localhost'}>`;
}

/**
 * Build the RFC 5322 message. Exported so a test can assert the header shape
 * without opening a socket.
 */
function buildMessage({ from, to, replyTo, subject, text }) {
  const fromAddr = safeAddress(from);
  const toAddr = safeAddress(to);
  if (!fromAddr) throw new Error('The From address is not a valid address.');
  if (!toAddr) throw new Error('The To address is not a valid address.');

  const headers = [
    `From: ${fromAddr}`,
    `To: ${toAddr}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId(fromAddr.split('@')[1])}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    'Auto-Submitted: auto-generated',
  ];

  /*
   * Reply-To carries the visitor's address; From stays the authenticated
   * mailbox. Putting the visitor in From is the single most common way a
   * contact form ends up in spam: it fails SPF and DMARC for their domain,
   * sent from a relay that has no authority over it.
   */
  const reply = safeAddress(replyTo);
  if (reply) headers.push(`Reply-To: ${reply}`);

  return { envelopeFrom: fromAddr, envelopeTo: toAddr, data: `${headers.join('\r\n')}\r\n\r\n${encodeBody(text)}` };
}

/* -------------------------------------------------------------------- wire */

/*
 * A reply reader over one socket.
 *
 * SMTP replies are multi-line: "250-STARTTLS" continues the reply and
 * "250 OK" ends it. Anything that reads a single line and moves on works
 * against some relays and desynchronises against others, which is the kind of
 * bug that only shows up against the one relay you did not test.
 */
function replyReader(socket) {
  let buffer = '';
  let lines = [];
  let waiter = null;
  let failure = null;

  const settleFailure = (err) => {
    failure = err;
    if (waiter) { const w = waiter; waiter = null; w.reject(err); }
  };

  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\r\n')) !== -1) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      const m = /^(\d{3})([ -])?(.*)$/.exec(line);
      if (!m) continue;
      lines.push(m[3]);
      if (m[2] !== '-') {
        const reply = { code: Number(m[1]), lines };
        lines = [];
        if (waiter) { const w = waiter; waiter = null; w.resolve(reply); }
      }
    }
  });

  return {
    read() {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => { waiter = { resolve, reject }; });
    },
    fail: settleFailure,
    /** Hand the buffered state to a reader over the upgraded socket. */
    reset() { buffer = ''; lines = []; waiter = null; },
  };
}

function connect(options, useTls) {
  return new Promise((resolve, reject) => {
    const socket = useTls ? tls.connect(options) : net.connect(options);
    const onError = (e) => reject(new Error(`SMTP connection failed: ${e.message}`));
    socket.once('error', onError);
    socket.once(useTls ? 'secureConnect' : 'connect', () => {
      socket.removeListener('error', onError);
      resolve(socket);
    });
  });
}

/**
 * One SMTP submission.
 *
 * Written as a straight sequence rather than a state machine, because the
 * protocol IS a straight sequence and the STARTTLS upgrade in the middle is
 * exactly the part a state machine makes hard to read.
 */
async function send({ to, replyTo, subject, text }, override) {
  /*
   * override exists so the client can be driven against a relay on an
   * ephemeral port. Reading process.env inside send() would make the transport
   * untestable without squatting on 465 and 587, and an SMTP client that has
   * never been run against a real socket is an SMTP client that does not work.
   */
  const cfg = { ...config(), ...(override || {}) };
  if (!cfg.configured) {
    throw new Error('SMTP is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS.');
  }

  const msg = buildMessage({ from: cfg.from, to, replyTo, subject, text });
  const me = hostname();

  let socket = await connect(
    cfg.implicitTls
      ? { host: cfg.host, port: cfg.port, servername: cfg.host }
      : { host: cfg.host, port: cfg.port },
    cfg.implicitTls
  );

  let reader = replyReader(socket);
  const timer = setTimeout(() => reader.fail(new Error('The SMTP relay did not answer in time.')), TIMEOUT_MS);
  socket.on('error', (e) => reader.fail(new Error(`SMTP connection failed: ${e.message}`)));
  socket.on('close', () => reader.fail(new Error('The SMTP relay closed the connection.')));

  // Never log a written line: the AUTH exchange carries the password.
  const write = (line) => socket.write(`${line}\r\n`);

  const expect = async (codes, what) => {
    const reply = await reader.read();
    if (!codes.includes(reply.code)) {
      // 535 is a bad credential; 534 is Google asking for an app password.
      const hint = (reply.code === 535 || reply.code === 534)
        ? ' The relay rejected the credential. With Gmail that means an app password is required, not the account password.'
        : '';
      throw new Error(`SMTP refused ${what}: ${reply.code} ${reply.lines.join(' ')}.${hint}`);
    }
    return reply;
  };

  try {
    await expect([220], 'the greeting');
    write(`EHLO ${me}`);
    let ehlo = await expect([250], 'EHLO');

    if (!cfg.implicitTls) {
      if (!ehlo.lines.some((l) => /^STARTTLS\b/i.test(l))) {
        throw new Error(
          `${cfg.host}:${cfg.port} does not offer STARTTLS. Refusing to send a password in the clear.`
        );
      }
      write('STARTTLS');
      await expect([220], 'STARTTLS');

      /*
       * servername is what makes verification mean anything. Without it the
       * handshake succeeds against a certificate issued for any other host,
       * which is precisely the attack STARTTLS is supposed to prevent.
       */
      const bare = socket;
      bare.removeAllListeners('data');
      bare.removeAllListeners('error');
      bare.removeAllListeners('close');
      socket = await connect({ socket: bare, servername: cfg.host }, true);
      if (!socket.authorized && process.env.NODE_ENV === 'production') {
        throw new Error(`The SMTP relay's certificate did not verify: ${socket.authorizationError}`);
      }
      reader = replyReader(socket);
      socket.on('error', (e) => reader.fail(new Error(`SMTP connection failed: ${e.message}`)));
      socket.on('close', () => reader.fail(new Error('The SMTP relay closed the connection.')));

      // The session resets across the upgrade, so EHLO is sent again.
      write(`EHLO ${me}`);
      ehlo = await expect([250], 'EHLO after STARTTLS');
    }

    const mechanisms = (ehlo.lines.find((l) => /^AUTH\b/i.test(l)) || '').toUpperCase();
    if (mechanisms && !mechanisms.includes('PLAIN') && !mechanisms.includes('LOGIN')) {
      throw new Error(`The relay offers only ${mechanisms.replace(/^AUTH\s*/, '')}, which this client does not implement.`);
    }

    if (!mechanisms || mechanisms.includes('PLAIN')) {
      write(`AUTH PLAIN ${Buffer.from(`\0${cfg.user}\0${cfg.pass}`, 'utf8').toString('base64')}`);
      await expect([235], 'authentication');
    } else {
      write('AUTH LOGIN');
      await expect([334], 'AUTH LOGIN');
      write(Buffer.from(cfg.user, 'utf8').toString('base64'));
      await expect([334], 'the username');
      write(Buffer.from(cfg.pass, 'utf8').toString('base64'));
      await expect([235], 'authentication');
    }

    write(`MAIL FROM:<${msg.envelopeFrom}>`);
    await expect([250], 'MAIL FROM');
    write(`RCPT TO:<${msg.envelopeTo}>`);
    await expect([250, 251], 'RCPT TO');
    write('DATA');
    await expect([354], 'DATA');
    write(`${msg.data}\r\n.`);
    const accepted = await expect([250], 'the message body');

    write('QUIT');
    return { queued: accepted.lines.join(' ').trim() };
  } finally {
    clearTimeout(timer);
    try { socket.destroy(); } catch { /* already gone */ }
  }
}

function hostname() {
  try {
    return require('node:os').hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'localhost';
  } catch {
    return 'localhost';
  }
}

/**
 * Format one contact message as plain text.
 *
 * Plain text and not HTML, on purpose: nothing here needs markup, and a
 * text/plain body cannot carry a tracking pixel or a payload into whatever
 * client the operator reads mail in.
 */
function formatContactMessage(m) {
  return [
    `From:    ${m.name} <${m.email}>`,
    `Subject: ${m.subject || '(none)'}`,
    `Sent:    ${m.created_at}`,
    m.ip ? `IP:      ${m.ip}` : null,
    '',
    m.body,
    '',
    '--',
    'Sent by the contact form on your portfolio. It is also stored in the admin inbox.',
  ].filter((l) => l !== null).join('\n');
}

module.exports = {
  config, isConfigured, send, buildMessage, formatContactMessage,
  encodeHeader, safeAddress, encodeBody,
};
