#!/usr/bin/env node
/**
 * Manual user creation for Snehal Leadgen (no signup UI on purpose).
 *
 * Usage:
 *   node scripts/create-user.js "owner@snehalprinters.in" "StrongPassword123" "Owner Name"
 *
 * Prints a ready-to-run `wrangler d1 execute` INSERT statement.
 * Password is hashed with PBKDF2-SHA256 (100000 iterations, 32-byte key),
 * matching worker/src/lib/auth.js so login verification works.
 */
const crypto = require('crypto');

const [, , email, password, name] = process.argv;

if (!email || !password) {
  console.error('Usage: node scripts/create-user.js <email> <password> [name]');
  process.exit(1);
}

const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex');

const sql = `INSERT INTO users (email, password_hash, password_salt, name, role) VALUES ('${email.replace(/'/g, "''")}', '${hash}', '${salt}', '${(name || '').replace(/'/g, "''")}', 'admin');`;

console.log('\nRun this against your D1 database:\n');
console.log(`wrangler d1 execute snehal-leadgen --remote --command="${sql}"\n`);
console.log('Or save to a file and use --file=create-user.sql\n');
console.log('SQL:\n' + sql);
