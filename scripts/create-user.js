#!/usr/bin/env node
/**
 * Manual user creation for Snehal Leadgen (no signup UI on purpose).
 *
 * Usage:
 *   node scripts/create-user.js "owner@snehalprinters.in" "StrongPassword123" "Owner Name"
 *
 * Writes a ready-to-run .sql file (NOT a --command string) and prints the exact
 * `wrangler d1 execute --remote --file=...` command to run it, then prints a
 * verify command too. Password is hashed with PBKDF2-SHA256 (100000 iterations,
 * 32-byte key), matching worker/src/lib/auth.js so login verification works.
 *
 * IMPORTANT — the #1 cause of "invalid credentials" after this step:
 * forgetting `--remote`. Without it, wrangler writes to a local sqlite file on
 * your machine that the deployed Worker never reads from — the user "exists"
 * on your laptop but not in the database your live site actually queries.
 * Always run with --remote (this script's printed command already includes it).
 *
 * Passwords/emails with $, `, ", ', ! etc. also frequently get mangled by the
 * shell when passed inline as --command="..."; writing to a .sql file (as this
 * script now does) avoids that entirely.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const [, , email, password, name] = process.argv;

if (!email || !password) {
  console.error('Usage: node scripts/create-user.js <email> <password> [name]');
  process.exit(1);
}

const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex');

const esc = (s) => String(s || '').replace(/'/g, "''");

const sql =
  `DELETE FROM users WHERE email = '${esc(email)}';\n` +
  `INSERT INTO users (email, password_hash, password_salt, name, role) VALUES ('${esc(email)}', '${hash}', '${salt}', '${esc(name)}', 'admin');\n`;

const outFile = path.join(__dirname, `create-user-${Date.now()}.sql`);
fs.writeFileSync(outFile, sql, 'utf8');

console.log('\nWrote SQL to:', outFile);
console.log('\n1) Run this against your REMOTE (production) D1 database:\n');
console.log(`   wrangler d1 execute snehal-leadgen --remote --file="${outFile}"\n`);
console.log('2) Verify the user actually landed in the remote DB:\n');
console.log(`   wrangler d1 execute snehal-leadgen --remote --command="SELECT id, email, name, role, created_at FROM users WHERE email = '${esc(email)}';"\n`);
console.log('If step 2 returns no rows, step 1 was run without --remote (or against the');
console.log('wrong database) — that mismatch is what causes "invalid credentials" on login');
console.log('even though the script "succeeded".\n');
console.log('Delete the generated .sql file afterwards since it contains a password hash:');
console.log(`   rm "${outFile}"\n`);
