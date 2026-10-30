// npm run user:create
//
// Creates a user from the terminal: the first admin, or anyone while the
// users screen doesn't exist yet. If the phone number already has an account,
// offers to reset that account's password instead.
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { stdin, stdout } from 'node:process';
import { db } from '../src/core/db.js';
import { normalizePhone, formatPhone } from '../src/core/phone.js';
import { createUser, resetPassword } from '../src/modules/users/service.js';
import { ROLES } from '../src/core/permissions.js';

// Hide typed characters while entering a password: readline echoes through
// this output, which drops everything while `muted` is on.
let muted = false;
const output = new Writable({
  write(chunk, encoding, done) {
    if (!muted) stdout.write(chunk, encoding);
    done();
  },
});
output.columns = stdout.columns;
const rl = readline.createInterface({ input: stdin, output, terminal: stdin.isTTY });

// Typed (or piped) lines wait in a queue until a question takes them, so
// nothing is lost while the script is busy talking to the database.
const queued = [];
const waiting = [];
rl.on('line', (line) => (waiting.length ? waiting.shift()(line) : queued.push(line)));
let closed = false; // piped input closes as soon as it has all been read
rl.on('close', () => { closed = true; while (waiting.length) waiting.shift()(null); });

function nextLine() {
  return new Promise((resolve, reject) => {
    const give = (line) => (line === null ? reject(new Error('Cancelled.')) : resolve(line));
    if (queued.length) give(queued.shift());
    else if (closed) give(null);
    else waiting.push(give);
  });
}

function showPrompt(question) {
  if (closed) return stdout.write(question);
  rl.setPrompt(question);
  rl.prompt();
}

function ask(question) {
  showPrompt(question);
  return nextLine();
}

async function askHidden(question) {
  showPrompt(question);
  muted = true;
  try {
    return await nextLine();
  } finally {
    muted = false;
    stdout.write('\n');
  }
}

async function askPassword() {
  for (;;) {
    const first = await askHidden('Password (at least 8 characters): ');
    if (first.length < 8) { console.log('  Too short, try again.'); continue; }
    const second = await askHidden('Same password again: ');
    if (first !== second) { console.log('  They don’t match, try again.'); continue; }
    return first;
  }
}

try {
  console.log('\nCreate a Jome-Tech user\n');

  let phone;
  for (;;) {
    const raw = await ask('Phone number (login name), e.g. 0712 345 678: ');
    phone = normalizePhone(raw);
    if (phone) break;
    console.log('  That isn’t a phone number, try again.');
  }

  const existing = await db('users').where({ phone }).first('id', 'name');
  if (existing) {
    const yes = (await ask(`${formatPhone(phone)} already belongs to ${existing.name}. Reset their password? (y/N): `)).trim().toLowerCase() === 'y';
    if (yes) {
      await resetPassword(existing.id, await askPassword(), { mustChangePassword: false });
      console.log(`\nPassword reset for ${existing.name}. Any lock on the account is cleared.\n`);
    }
  } else {
    let name = '';
    while (!name) name = (await ask('Full name: ')).trim();
    const email = (await ask('Email (optional, press Enter to skip): ')).trim() || null;

    console.log('\nRoles: ' + ROLES.map((r) => `${r.key} (${r.description})`).join('\n       '));
    let roles;
    for (;;) {
      const raw = (await ask('Role(s), comma-separated [admin]: ')).trim() || 'admin';
      roles = raw.split(',').map((r) => r.trim().toLowerCase()).filter(Boolean);
      if (roles.every((key) => ROLES.some((r) => r.key === key))) break;
      console.log('  Use the role names listed above.');
    }

    const sites = await db('sites').where({ is_active: true }).orderBy('id').select('id', 'code', 'name');
    let siteIds = sites.map((s) => s.id);
    if (sites.length > 1) {
      console.log('\nSites: ' + sites.map((s) => `${s.code} (${s.name})`).join(', '));
      const raw = (await ask('Site codes, comma-separated [all]: ')).trim();
      if (raw) {
        const codes = raw.split(',').map((c) => c.trim().toUpperCase());
        siteIds = sites.filter((s) => codes.includes(s.code)).map((s) => s.id);
      }
    }

    const password = await askPassword();
    await createUser({ name, phone, email, password, roles, siteIds });
    console.log(`\nCreated ${name}. Log in with ${formatPhone(phone)} and the password you just set.\n`);
  }
} catch (err) {
  console.error(`\n${err.message}\n`);
  process.exitCode = 1;
} finally {
  rl.close();
  await db.destroy();
}
