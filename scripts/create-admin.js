'use strict';

/*
 * Create or reset the single admin account, and enrol TOTP.
 *
 *   node scripts/create-admin.js you@example.com "Eric J. Dean" "a long passphrase"
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

const [email, name, password] = args;
if (!email || !name || !password) {
  console.error('Usage: node scripts/create-admin.js <email> <name> <password>');
  process.exit(1);
}
if (password.length < 12) {
  console.error('Use at least 12 characters. This is the only credential on the site.');
  process.exit(1);
}

const existing = auth.findUserByEmail(email);
let id;
if (existing) {
  db.run('UPDATE user SET name = ?, password_hash = ? WHERE id = ?', name, auth.hashPassword(password), existing.id);
  id = existing.id;
  console.log(`Updated ${email}`);
} else {
  id = auth.createUser({ email, name, password });
  console.log(`Created ${email}`);
}

const secret = auth.generateTotpSecret();
auth.setTotpSecret(id, secret, 0);

console.log('\nTOTP secret (enrolled, not yet required):');
console.log(`  ${secret}`);
console.log('\nAdd this to your authenticator:');
console.log(`  ${auth.totpUri(secret, email)}`);
console.log('\nThen confirm it, which is what makes it required at sign in:');
console.log(`  node scripts/create-admin.js --confirm ${email} <6-digit-code>`);
console.log('\nUntil you confirm, the account signs in with the password alone.');
