'use strict';

/*
 * Create or reset the single admin account, and enrol TOTP.
 *
 *   node scripts/create-admin.js you@example.com "Eric J. Dean" "a long passphrase"
 *
 * Flags:
 *   --temp         accept a short hand-over password and flag the account so
 *                  every admin page warns until it is replaced at /admin/account
 *   --reset-totp   mint a new TOTP secret even though one is already confirmed
 *
 * Prints an otpauth:// URI. Paste it into your authenticator, then confirm the
 * first code with:  node scripts/create-admin.js --confirm you@example.com 123456
 */

const db = require('../src/db');
const auth = require('../src/auth');

db.assertEnvironment();
db.migrate();

const args = process.argv.slice(2);

if (args[0] === '--confirm') {
  const [, email, code] = args;
  const user = auth.findUserByEmail(email);
  if (!user) { console.error(`No account for ${email}`); process.exit(1); }
  if (!user.totp_secret) { console.error('No TOTP secret enrolled yet.'); process.exit(1); }
  if (!auth.verifyTotp(user.totp_secret, code)) {
    console.error('That code did not verify. Codes expire every thirty seconds; try the next one.');
    process.exit(1);
  }
  auth.setTotpSecret(user.id, user.totp_secret, 1);
  console.log('TOTP confirmed. It is now required at sign in.');
  process.exit(0);
}

const [email, name, password] = args.filter((a) => !a.startsWith('--'));
if (!email || !name || !password) {
  console.error('Usage: node scripts/create-admin.js <email> <name> <password>');
  process.exit(1);
}
/*
 * Twelve characters is the floor for a real credential. --temp exists for the
 * one legitimate exception: handing over a throwaway password so someone can
 * reach the admin before choosing their own. It sets must_change_password,
 * which puts a warning on every admin page until the password is replaced, so
 * a hand-over cannot quietly become the permanent credential.
 */
const TEMP = args.includes('--temp');
if (password.length < 12 && !TEMP) {
  console.error('Use at least 12 characters. This is the only credential on the site.');
  console.error('For a hand-over password that must be changed at first sign in, add --temp.');
  process.exit(1);
}

const existing = auth.findUserByEmail(email);
let id;
if (existing) {
  db.run(
    'UPDATE user SET name = ?, password_hash = ?, must_change_password = ? WHERE id = ?',
    name, auth.hashPassword(password), TEMP ? 1 : 0, existing.id
  );
  id = existing.id;
  console.log(`Updated ${email}`);
} else {
  id = auth.createUser({ email, name, password });
  if (TEMP) db.run('UPDATE user SET must_change_password = 1 WHERE id = ?', id);
  console.log(`Created ${email}`);
}

if (TEMP) {
  console.log('\nTEMPORARY password set. The account is flagged must_change_password,');
  console.log('so every admin page carries a warning banner until it is replaced at');
  console.log('/admin/account. The admin is not locked: the point of a hand-over');
  console.log('password is that it works.');
}

/*
 * A confirmed second factor is NOT replaced by a routine password reset.
 *
 * This script used to mint a fresh secret unconditionally, which meant running
 * it to change a password also set totp_confirmed back to 0: the account
 * silently dropped to one factor, and the only visible sign was a new secret
 * scrolling past in the same output as the success message. Re-enrolment is
 * now something you ask for.
 */
const current = auth.findUserByEmail(email);
const RESET_TOTP = args.includes('--reset-totp');

if (current && current.totp_confirmed && !RESET_TOTP) {
  console.log('\nTOTP is confirmed on this account and was left alone.');
  console.log('It is still required at sign in. To replace the secret, re-run with --reset-totp.');
} else {
  const secret = auth.generateTotpSecret();
  auth.setTotpSecret(id, secret, 0);

  console.log('\nTOTP secret (enrolled, not yet required):');
  console.log(`  ${secret}`);
  console.log('\nAdd this to your authenticator:');
  console.log(`  ${auth.totpUri(secret, email)}`);
  console.log('\nThen confirm it, which is what makes it required at sign in:');
  console.log(`  node scripts/create-admin.js --confirm ${email} <6-digit-code>`);
  console.log('\nUntil you confirm, the account signs in with the password alone.');
  console.log('\nThe same enrolment is available in the admin at /admin/account.');
}
