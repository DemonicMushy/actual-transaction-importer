#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import * as api from '@actual-app/api';
import { applyMaybankTransactionRules } from './maybank-rules.mjs';
import { buildImportOptions, normalizeInput } from './transactions.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  return `Usage: npm run maybank -- --pdf <statement.pdf> [--apply] [--output <file.json>]

Default behavior is a dry run. Use --apply only after reviewing the summary.
`;
}

function parseArgs(argv) {
  const args = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--pdf') args.pdf = argv[++index];
    else if (arg === '--output') args.output = argv[++index];
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function loadEnv() {
  try {
    process.loadEnvFile(path.resolve('.env'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function extractStatement(pdfPath) {
  const python = process.env.PYTHON?.trim() || 'python3';
  const result = spawnSync(python, [path.join(scriptDir, 'parse-maybank-statement.py'), pdfPath], {
    encoding: 'utf8',
  });
  if (result.error?.code === 'ENOENT') {
    throw new Error(`Python executable not found: ${python}`);
  }
  if (result.status !== 0) {
    throw new Error(`PDF extraction failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return JSON.parse(result.stdout);
}

async function resolveAccountId(input) {
  if (input.accountId) return input.accountId;
  const configuredId = process.env.ACTUAL_ACCOUNT_ID?.trim();
  if (configuredId) return configuredId;
  const name = input.accountName ?? required('ACTUAL_ACCOUNT_NAME');
  const matches = (await api.getAccounts()).filter(
    account => account.name.toLowerCase() === name.toLowerCase(),
  );
  if (matches.length !== 1) throw new Error(`Expected exactly one Actual account named "${name}"`);
  return matches[0].id;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return process.stdout.write(usage());
  if (!args.pdf) throw new Error(`--pdf is required\n\n${usage()}`);
  loadEnv();

  const pdfPath = path.resolve(args.pdf);
  const extracted = extractStatement(pdfPath);
  extracted.transactions = extracted.transactions.map(applyMaybankTransactionRules);

  const outputPath = path.resolve(
    args.output || path.join('output', 'transactions', `${path.parse(pdfPath).name}.json`),
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(extracted, null, 2)}\n`);

  const dataDir = path.resolve(process.env.ACTUAL_DATA_DIR?.trim() || '.actual-cache');
  await mkdir(dataDir, { recursive: true });
  await api.init({
    serverURL: required('ACTUAL_SERVER_URL'),
    password: required('ACTUAL_PASSWORD'),
    dataDir,
    verbose: false,
  });

  try {
    const budgetPassword = process.env.ACTUAL_BUDGET_PASSWORD?.trim();
    await api.downloadBudget(
      required('ACTUAL_SYNC_ID'),
      budgetPassword ? { password: budgetPassword } : undefined,
    );
    const accountId = await resolveAccountId(extracted);
    const [payees, categories] = await Promise.all([api.getPayees(), api.getCategories()]);
    const payeeIdByName = new Map(payees.map(item => [item.name.toLowerCase(), item.id]));
    const categoryIdByName = new Map(categories.map(item => [item.name.toLowerCase(), item.id]));

    for (const transaction of extracted.transactions) {
      if (transaction.category_name) {
        const categoryId = categoryIdByName.get(transaction.category_name.toLowerCase());
        if (!categoryId) throw new Error(`Existing category not found: ${transaction.category_name}`);
        transaction.category_id = categoryId;
      }
    }

    const input = normalizeInput(extracted);
    for (const transaction of input.transactions) {
      if (transaction.payee_name) {
        const payeeId = payeeIdByName.get(transaction.payee_name.toLowerCase());
        if (!payeeId) throw new Error(`Existing payee not found: ${transaction.payee_name}`);
        transaction.payee = payeeId;
        delete transaction.payee_name;
      }
    }

    const result = await api.importTransactions(
      accountId,
      input.transactions,
      buildImportOptions({ dryRun: !args.apply }),
    );
    if (result.errors?.length) throw new Error(JSON.stringify(result.errors));

    let verification;
    if (args.apply) {
      await api.sync();

      const dates = input.transactions.map(item => item.date).sort();
      const ledger = await api.getTransactions(accountId, dates[0], dates.at(-1));
      const importedIds = new Set(ledger.map(item => item.imported_id));
      const missing = input.transactions.filter(item => !importedIds.has(item.imported_id));
      verification = { verified: input.transactions.length - missing.length, missing: missing.length };
      if (missing.length) throw new Error(`Verification failed: ${missing.length} imported IDs missing`);
    }

    process.stdout.write(`${JSON.stringify({
      mode: args.apply ? 'applied' : 'dry-run',
      statement: extracted.statement,
      output: outputPath,
      submitted: input.transactions.length,
      added: result.added?.length ?? 0,
      updated: result.updated?.length ?? 0,
      verification,
    }, null, 2)}\n`);
  } finally {
    await api.shutdown();
  }
}

main().catch(error => {
  process.stderr.write(`Maybank import failed: ${error.message}\n`);
  process.exitCode = 1;
});
