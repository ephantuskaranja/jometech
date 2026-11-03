// Every setting the app reads from the environment lives here, so the rest
// of the code imports `config` instead of touching process.env directly.
// Values come from .env (loaded by `node --env-file-if-exists=.env`).

import { fileURLToPath } from 'node:url';

const env = process.env.NODE_ENV ?? 'development';

export const config = {
  env,
  isProd: env === 'production',
  // Node's test runner sets NODE_TEST_CONTEXT in the processes it starts.
  isTest: Boolean(process.env.NODE_TEST_CONTEXT),
  port: Number(process.env.PORT ?? 3000),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  // Signs the login cookie. Must be long and random on the server.
  sessionSecret: process.env.SESSION_SECRET ?? (env === 'production' ? undefined : 'dev-only-not-secret'),
  // Uploaded and generated files (signatures, photos, backups). Not public: served
  // only through routes that check who is logged in. Include it in backups.
  storageDir: process.env.STORAGE_DIR || fileURLToPath(new URL('../storage', import.meta.url)),
  appName: process.env.APP_NAME || 'Jome-Tech',
  // Dates, times and yearly document numbers (CHK-2026-…) follow this zone, not the server's.
  timezone: process.env.TIMEZONE || 'Africa/Nairobi',
  // Letterhead on printed documents (receiving note, proformas; later invoices).
  // Defaults are from the paper Truck Receiving Document; moves to company settings when that screen exists.
  company: {
    name: process.env.COMPANY_NAME || 'Jome-Tech Engineering Ltd',
    // Address lines separated by "|"
    address: (process.env.COMPANY_ADDRESS || 'Eastern Bypass, Ruai|P.O. Box 14554 - 00400, Nairobi').split('|').map((line) => line.trim()).filter(Boolean),
    phone: process.env.COMPANY_PHONE || '0705 656 398',
    email: process.env.COMPANY_EMAIL || 'jometechltd@gmail.com',
    kraPin: process.env.COMPANY_KRA_PIN || 'P052233213I',
    // Who signs proformas ("For & on behalf of … Director")
    signatory: process.env.COMPANY_SIGNATORY || 'Director',
    // Bank details printed on proformas, from the paper proforma
    bank: {
      accountName: process.env.BANK_ACCOUNT_NAME || 'Jome-Tech Engineering Ltd',
      accountNumber: process.env.BANK_ACCOUNT_NUMBER || '01100210891001',
      bank: process.env.BANK_NAME || 'Co-operative Bank',
      branch: process.env.BANK_BRANCH || 'Githurai',
    },
  },
  // Prices include VAT; documents show how much of the total is VAT.
  vatRate: Number(process.env.VAT_RATE || 16),
  // Number of the first proforma made in the app: the next one after the last paper proforma.
  // Only read until the first proforma is saved; after that the numbers just count on.
  proformaFirstNumber: Number(process.env.PROFORMA_FIRST_NUMBER || 490),
  db: {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    database: process.env.DB_DATABASE ?? 'jometech',
    user: process.env.DB_USERNAME ?? 'jometech',
    password: process.env.DB_PASSWORD ?? '',
  },
};

if (!config.sessionSecret) {
  throw new Error('SESSION_SECRET is missing from .env. Generate one with: node -e "console.log(crypto.randomBytes(32).toString(\'hex\'))"');
}
