/* ============================================================
 * make-credentials.js
 * Generates the officer authentication file (officers.auth.json)
 * with salted SHA-256 password hashes — no plaintext stored.
 *
 * Configure officers and passwords via environment variables before
 * running (no real credentials are hardcoded in this script):
 *
 *   OFFICER_1_USERNAME=juma.ismail OFFICER_1_PASSWORD=... \
 *   OFFICER_1_IDENTITY=Org1MSP::juma.ismail OFFICER_1_ROLE=admin \
 *   OFFICER_2_USERNAME=asha.mwakea OFFICER_2_PASSWORD=... \
 *   OFFICER_2_IDENTITY=Org1MSP::asha.mwakea OFFICER_2_ROLE=officer \
 *   OFFICER_3_USERNAME=peter.kessy OFFICER_3_PASSWORD=... \
 *   OFFICER_3_IDENTITY=Org2MSP::peter.kessy OFFICER_3_ROLE=officer \
 *   node make-credentials.js
 *
 * Add more officers by continuing the OFFICER_<n>_* numbering. ROLE is
 * optional and defaults to 'officer'; 'admin' can see the infrastructure/
 * network details (Network & Ledger admin panels, topology card) when the
 * backend's SHOW_INFRA flag is also on — everything else (evidence
 * access, signing, custody transfer) is identical between roles.
 *
 * Any officer left unconfigured (no *_PASSWORD set) is skipped with a
 * warning rather than written with a guessable default — there is no
 * fallback password baked into this script.
 *
 * NOTE FOR PRODUCTION: salted SHA-256 is a reasonable prototype choice
 * but a production system should use a slow KDF such as bcrypt, scrypt,
 * or Argon2, and store credentials in a secrets manager rather than a
 * JSON file.
 * ============================================================ */
'use strict';
const crypto = require('crypto');
const fs = require('fs');

function loadOfficersFromEnv() {
  const officers = {};
  for (let i = 1; ; i++) {
    const username = process.env[`OFFICER_${i}_USERNAME`];
    if (!username) break;
    const password = process.env[`OFFICER_${i}_PASSWORD`];
    const identityId = process.env[`OFFICER_${i}_IDENTITY`];
    const role = process.env[`OFFICER_${i}_ROLE`] || 'officer';
    if (!password || !identityId) {
      console.warn(`[skip] OFFICER_${i}_USERNAME=${username} set but ` +
        `OFFICER_${i}_PASSWORD or OFFICER_${i}_IDENTITY is missing — skipped.`);
      continue;
    }
    officers[username] = { password, identityId, role };
  }
  return officers;
}

function hash(password, salt) {
  return crypto.createHash('sha256').update(salt + ':' + password).digest('hex');
}

const OFFICERS = loadOfficersFromEnv();
if (Object.keys(OFFICERS).length === 0) {
  console.error('No officers configured. Set OFFICER_1_USERNAME / ' +
    '_PASSWORD / _IDENTITY (and optionally _ROLE) — see the header comment ' +
    'in this file for the full pattern — then re-run.');
  process.exit(1);
}

const out = {};
for (const [user, info] of Object.entries(OFFICERS)) {
  const salt = crypto.randomBytes(16).toString('hex');
  out[user] = {
    salt,
    hash: hash(info.password, salt),
    identityId: info.identityId,
    displayName: user.split('.').map(s => s[0].toUpperCase() + s.slice(1)).join(' '),
    role: info.role || 'officer',
  };
}

fs.writeFileSync('officers.auth.json', JSON.stringify(out, null, 2));
console.log('Wrote officers.auth.json for:', Object.keys(out).join(', '));
console.log('Give each officer the username/password you set via their ' +
  'OFFICER_<n>_* environment variables — this script never prints or ' +
  'stores the passwords itself.');
