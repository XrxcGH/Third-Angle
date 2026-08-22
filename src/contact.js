'use strict';

/*
 * Contact form.
 *
 * No Turnstile and no captcha, deliberately. Both need a vendor account, both
 * add a third party script to a page whose CSP currently allows none, and
 * neither is necessary at this volume. Three cheap server side checks stop
 * essentially all of the automated traffic a personal site attracts:
 *
 *   1. A honeypot field that a human never sees and a naive bot always fills.
 *   2. A minimum time to submit. A form completed in under three seconds was
 *      not typed by a person.
 *   3. A per-IP rate limit, so the same source cannot flood the table.
 *
 * If real spam ever gets through, Turnstile is the documented escalation. It
 * is not needed on day one and it would be the only third party script on the
 * site, which is a real cost.
 */

const crypto = require('node:crypto');
const { get, all, run, nowIso } = require('./db');
const mailer = require('./mailer');
const settings = require('./settings');

const MIN_SECONDS = 3;
const MAX_SECONDS = 60 * 60 * 6;
const PER_IP_PER_HOUR = 5;

const LIMITS = { name: 120, email: 200, subject: 200, body: 5000 };

/**
 * A signed timestamp rather than a session, so the form works for a visitor
 * who has never been given a cookie. The signature is what stops a bot simply
 * posting a stale or fabricated time.
 */
function issueStamp() {
  const t = Date.now().toString(36);
  return `${t}.${sign(t)}`;
}

function sign(value) {
  const secret = process.env.SESSION_SECRET || 'dev-only-insecure-secret';
  return crypto.createHmac('sha256', secret).update(String(value)).digest('base64url').slice(0, 24);
}

function stampAgeSeconds(stamp) {
  const [t, sig] = String(stamp || '').split('.');
  if (!t || !sig) return null;
  const expected = sign(t);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const then = parseInt(t, 36);
  if (!Number.isFinite(then)) return null;
  return (Date.now() - then) / 1000;
}

/** Deliberately permissive: the goal is to catch a typo, not to police addresses. */
function looksLikeEmail(v) {
  const s = String(v || '').trim();
  return s.length >= 6 && s.length <= LIMITS.email && /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(s);
}

/**
 * Returns { ok, errors, values }. Never throws, because a contact form that
 * 500s is worse than one that spams.
 */
function validate(body, ip) {
  const errors = [];
  const v = {
    name: String(body.name || '').trim().slice(0, LIMITS.name),
    email: String(body.email || '').trim().slice(0, LIMITS.email),
    subject: String(body.subject || '').trim().slice(0, LIMITS.subject),
    message: String(body.message || '').trim().slice(0, LIMITS.body),
  };

  // The honeypot. Labelled "company" because that is what a form filler
  // expects to see, and hidden from humans in CSS rather than with
  // display:none alone, which some bots now check for.
  if (String(body.company || '').trim()) {
    errors.push('That did not go through. Try again, or email me directly.');
    return { ok: false, errors, values: v, reason: 'honeypot' };
  }

  const age = stampAgeSeconds(body.t);
  if (age === null) {
    errors.push('That form was not issued by this site. Reload the page and try again.');
    return { ok: false, errors, values: v, reason: 'bad-stamp' };
  }
  if (age < MIN_SECONDS) {
    errors.push('That was submitted very fast. Give it a moment and send again.');
    return { ok: false, errors, values: v, reason: 'too-fast' };
  }
  if (age > MAX_SECONDS) {
    errors.push('That form has been open a long time. Reload and send again.');
    return { ok: false, errors, values: v, reason: 'expired' };
  }

  if (!v.name) errors.push('A name helps me reply to the right person.');
  if (!looksLikeEmail(v.email)) errors.push('That email address does not look right. I cannot reply without it.');
  if (v.message.length < 10) errors.push('Tell me a little more than that.');

  if (errors.length) return { ok: false, errors, values: v, reason: 'invalid' };

  const recent = get(
    "SELECT COUNT(*) AS n FROM message WHERE ip = ? AND created_at > ?",
    ip, new Date(Date.now() - 3600_000).toISOString()
  );
  if (recent && recent.n >= PER_IP_PER_HOUR) {
    errors.push('That is several messages in an hour. Email me directly instead.');
    return { ok: false, errors, values: v, reason: 'rate-limited' };
  }

  return { ok: true, errors, values: v };
}

function store(values, { ip, userAgent } = {}) {
  const res = run(
    `INSERT INTO message (name, email, subject, body, ip, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    values.name, values.email, values.subject || null, values.message,
    ip || null, String(userAgent || '').slice(0, 300) || null, nowIso()
  );
  return Number(res.lastInsertRowid);
}

/* ---------------------------------------------------------------- forward
 *
 * The inbox is the system of record and the email is a copy, not the other way
 * round. Every message is stored before anything is sent, so a relay that is
 * down, misconfigured, or simply not set up yet costs a notification and never
 * a message. mail_status is what turns that from a silent loss into a row the
 * admin can see and retry.
 */

function recipient() {
  const configured = String(settings.getSetting('contact_to') || '').trim();
  if (configured) return configured;
  // Falls back to the admin account, which is by definition an address the
  // operator can read.
  const owner = get('SELECT email FROM user WHERE active = 1 ORDER BY id LIMIT 1');
  return owner ? owner.email : null;
}

/**
 * Send one stored message on. Resolves either way: the caller is a request
 * handler that has already answered the visitor, and a delivery problem is the
 * operator's to see, not the visitor's.
 */
async function forward(id) {
  const m = get('SELECT * FROM message WHERE id = ?', id);
  if (!m) return { ok: false, error: 'No such message.' };

  const setStatus = (status, error) => run(
    'UPDATE message SET mail_status = ?, mail_error = ?, mailed_at = ? WHERE id = ?',
    status, error || null, status === 'sent' ? nowIso() : null, id
  );

  if (!settings.getSetting('contact_forward')) {
    setStatus('off', 'Forwarding is switched off in the admin settings.');
    return { ok: false, error: 'Forwarding is off.' };
  }
  if (!mailer.isConfigured()) {
    setStatus('unconfigured', 'SMTP is not configured. The message is stored in the inbox.');
    return { ok: false, error: 'SMTP is not configured.' };
  }
  const to = recipient();
  if (!to) {
    setStatus('failed', 'No forwarding address. Set one in the admin settings.');
    return { ok: false, error: 'No forwarding address.' };
  }

  try {
    await mailer.send({
      to,
      // The visitor's address goes in Reply-To so a reply reaches them, while
      // From stays the authenticated mailbox. See src/mailer.js.
      replyTo: m.email,
      subject: m.subject ? `Portfolio: ${m.subject}` : `Portfolio message from ${m.name}`,
      text: mailer.formatContactMessage(m),
    });
    setStatus('sent', null);
    return { ok: true };
  } catch (err) {
    setStatus('failed', String(err && err.message || err).slice(0, 500));
    return { ok: false, error: String(err && err.message || err) };
  }
}

function listMessages(limit = 100) {
  return all('SELECT * FROM message ORDER BY created_at DESC LIMIT ?', limit);
}

/** Messages the operator has not been told about by email. */
function undeliveredCount() {
  return get("SELECT COUNT(*) AS n FROM message WHERE mail_status != 'sent'").n;
}

function unreadCount() {
  return get('SELECT COUNT(*) AS n FROM message WHERE read = 0').n;
}

function markRead(id) {
  run('UPDATE message SET read = 1 WHERE id = ?', id);
}

function remove(id) {
  run('DELETE FROM message WHERE id = ?', id);
}

module.exports = {
  issueStamp, stampAgeSeconds, validate, store,
  forward, recipient, undeliveredCount,
  listMessages, unreadCount, markRead, remove,
  looksLikeEmail, MIN_SECONDS, PER_IP_PER_HOUR, LIMITS,
};
