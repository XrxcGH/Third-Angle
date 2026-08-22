'use strict';

/*
 * Site settings an operator flips without a deploy.
 *
 * The key set is closed. A free-text settings table looks flexible right up
 * until a typo writes `pdf_veiwer` and the flag silently does nothing forever,
 * with no error anywhere: the read returns the default and the page renders
 * fine. An allowlist turns that into a throw at the write, which is the only
 * moment anyone is looking.
 */

const { get, all, run, nowIso } = require('./db');

/**
 * key -> { type, default, label, help }
 *
 * `type` is 'bool' or 'text'. Everything is stored as TEXT, because SQLite
 * STRICT would otherwise need a column per type and the coercion has to live
 * somewhere regardless.
 */
const DEFINITIONS = {
  pdf_viewer: {
    type: 'bool',
    default: true,
    label: 'Inline PDF viewer',
    help: 'Renders the resume and CV in the page. Turn it off to offer download '
        + 'and open-in-a-new-tab only. A PDF rendered inline is the residual '
        + 'vector once every other control is in place, which is why this is a '
        + 'switch rather than an assumption.',
  },
  linkedin_badge: {
    type: 'bool',
    default: false,
    label: "LinkedIn's own profile badge",
    help: 'Off by default. The badge is a script from platform.linkedin.com, so '
        + 'turning it on relaxes the Content Security Policy for that origin and '
        + 'gives LinkedIn a third party connection from every visitor. The '
        + 'profile card next to it is server rendered and needs neither.',
  },
  github_live: {
    type: 'bool',
    default: true,
    label: 'Live GitHub data',
    help: 'Fetches profile and repository data from the GitHub API, cached for '
        + 'an hour. Off means the page renders from the last cached copy, or '
        + 'from nothing on a first run.',
  },
  contact_forward: {
    type: 'bool',
    default: true,
    label: 'Forward contact messages by email',
    help: 'Every message is stored in the inbox either way. This controls '
        + 'whether it is also sent on. Needs SMTP configured in the environment.',
  },
  contact_to: {
    type: 'text',
    default: '',
    label: 'Forward messages to',
    help: 'Leave blank to use the admin account address.',
  },
};

const KEYS = Object.freeze(Object.keys(DEFINITIONS));

function coerce(key, raw) {
  const def = DEFINITIONS[key];
  if (def.type === 'bool') return raw === '1' || raw === 'true' || raw === true;
  return raw == null ? def.default : String(raw);
}

/** Every setting, with defaults filled in for anything never written. */
function allSettings() {
  const rows = all('SELECT key, value FROM setting');
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const out = {};
  for (const key of KEYS) {
    out[key] = key in stored ? coerce(key, stored[key]) : DEFINITIONS[key].default;
  }
  return out;
}

function getSetting(key) {
  if (!KEYS.includes(key)) throw new Error(`Unknown setting: ${key}`);
  const row = get('SELECT value FROM setting WHERE key = ?', key);
  return row ? coerce(key, row.value) : DEFINITIONS[key].default;
}

/** Throws on an unknown key rather than writing a row nothing will ever read. */
function setSetting(key, value) {
  if (!KEYS.includes(key)) throw new Error(`Unknown setting: ${key}`);
  const def = DEFINITIONS[key];
  const stored = def.type === 'bool' ? (value ? '1' : '0') : String(value == null ? '' : value);
  run(
    `INSERT INTO setting (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key, stored, nowIso()
  );
}

/**
 * Writes the whole form in one go. Absent booleans are false, because an
 * unchecked checkbox is simply not submitted: reading only what arrived would
 * make a box impossible to untick.
 */
function saveFromForm(body) {
  for (const key of KEYS) {
    const def = DEFINITIONS[key];
    if (def.type === 'bool') setSetting(key, Boolean(body[key]));
    else if (key in body) setSetting(key, body[key]);
  }
}

module.exports = { DEFINITIONS, KEYS, allSettings, getSetting, setSetting, saveFromForm };
