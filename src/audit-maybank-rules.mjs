#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import * as api from '@actual-app/api';
import {
  applyMaybankTransactionRules,
  classifyMaybankTransaction,
} from './maybank-rules.mjs';
import { normalizeInput } from './transactions.mjs';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input') args.input = argv[++index];
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

async function resolveAccountId(parsed) {
  if (parsed.account_id) return parsed.account_id;
  const configuredId = process.env.ACTUAL_ACCOUNT_ID?.trim();
  if (configuredId) return configuredId;
  const name = parsed.account_name ?? required('ACTUAL_ACCOUNT_NAME');
  const matches = (await api.getAccounts()).filter(
    account => account.name.toLowerCase() === name.toLowerCase(),
  );
  if (matches.length !== 1) throw new Error(`Expected exactly one Actual account named "${name}"`);
  return matches[0].id;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write('Usage: npm run audit:maybank -- --input <audit.json>\n');
    return;
  }
  if (!args.input) throw new Error('--input is required');
  loadEnv();

  const parsed = JSON.parse(await readFile(path.resolve(args.input), 'utf8'));
  const ruled = {
    ...parsed,
    transactions: parsed.transactions.map(applyMaybankTransactionRules),
  };
  const normalized = normalizeInput(ruled);
  const dataDir = path.resolve(process.env.ACTUAL_DATA_DIR?.trim() || '.actual-cache');
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
    const accountId = await resolveAccountId(parsed);
    const dates = normalized.transactions.map(item => item.date).sort();
    const [ledger, payees, categories] = await Promise.all([
      api.getTransactions(accountId, dates[0], dates.at(-1)),
      api.getPayees(),
      api.getCategories(),
    ]);
    const liveByImportedId = new Map(ledger.map(item => [item.imported_id, item]));
    const payeeNameById = new Map(payees.map(item => [item.id, item.name]));
    const categoryNameById = new Map(categories.map(item => [item.id, item.name]));
    const parsedBySourceId = new Map(parsed.transactions.map(item => [item.source_id, item]));

    const differences = [];
    const missing = [];
    for (const normalizedTransaction of normalized.transactions) {
      const sourceId = normalizedTransaction.imported_id.slice(`pdf:${normalized.source}:`.length);
      const statementTransaction = parsedBySourceId.get(sourceId);
      const live = liveByImportedId.get(normalizedTransaction.imported_id);
      if (!live) {
        missing.push({ importedId: normalizedTransaction.imported_id, sourceId });
        continue;
      }

      const rule = classifyMaybankTransaction(
        statementTransaction.raw_description,
        statementTransaction.amount,
      );
      const actualPayee = live.payee ? (payeeNameById.get(live.payee) ?? live.payee) : null;
      const actualCategory = live.category
        ? (categoryNameById.get(live.category) ?? live.category)
        : null;
      const expectedCleared = statementTransaction.cleared ?? true;
      const changedFields = [];
      if (actualPayee !== rule.payee) changedFields.push('payee');
      if (actualCategory !== rule.categoryName) changedFields.push('category');
      if (live.date !== normalizedTransaction.date) changedFields.push('date');
      if (live.amount !== normalizedTransaction.amount) changedFields.push('amount');
      if ((live.notes || null) !== (normalizedTransaction.notes || null)) changedFields.push('notes');
      if (Boolean(live.cleared) !== expectedCleared) changedFields.push('cleared');
      if (changedFields.length) {
        differences.push({
          changedFields,
          statementDate: statementTransaction.date,
          actualDate: live.date,
          statementAmount: statementTransaction.amount,
          actualAmount: (live.amount / 100).toFixed(2),
          description: statementTransaction.raw_description,
          rulePayee: rule.payee,
          actualPayee,
          ruleCategory: rule.categoryName,
          actualCategory,
          ruleNotes: normalizedTransaction.notes || null,
          actualNotes: live.notes || null,
          ruleCleared: expectedCleared,
          actualCleared: Boolean(live.cleared),
        });
      }
    }

    process.stdout.write(`${JSON.stringify({
      compared: normalized.transactions.length,
      differences,
      missing,
    }, null, 2)}\n`);
  } finally {
    await api.shutdown();
  }
}

main().catch(error => {
  process.stderr.write(`Maybank rule audit failed: ${error.message}\n`);
  process.exitCode = 1;
});
