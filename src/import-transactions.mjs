#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import * as api from '@actual-app/api';
import { buildImportOptions, normalizeInput } from './transactions.mjs';

function usage() {
  return `Usage: npm run import -- --input <transactions.json> [--dry-run]

Options:
  --input, -i <path>  JSON transaction list to import (required)
  --dry-run           Reconcile and report without changing the budget
  --help, -h          Show this help
`;
}

function parseArguments(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input' || arg === '-i') {
      if (!argv[i + 1]) throw new Error(`${arg} requires a file path`);
      args.input = argv[++i];
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function requireEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function loadEnvironmentFile() {
  try {
    // Node preserves values that are already present in process.env, so shell
    // variables can still override settings from the project-local .env file.
    process.loadEnvFile(path.resolve('.env'));
  } catch (error) {
    // Keep supporting deployments that provide all configuration through the
    // process environment and therefore do not need a .env file.
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function resolveAccount(input) {
  const accountId = input.accountId ?? process.env.ACTUAL_ACCOUNT_ID?.trim();
  if (accountId) return accountId;

  const accountName = input.accountName ?? process.env.ACTUAL_ACCOUNT_NAME?.trim();
  if (!accountName) {
    throw new Error('Set account_id/account_name in the input or ACTUAL_ACCOUNT_ID/ACTUAL_ACCOUNT_NAME');
  }

  const matches = (await api.getAccounts()).filter(
    account => account.name.toLocaleLowerCase('en-US') === accountName.toLocaleLowerCase('en-US'),
  );
  if (matches.length === 0) throw new Error(`No Actual account named "${accountName}" was found`);
  if (matches.length > 1) throw new Error(`More than one Actual account is named "${accountName}"; use its account_id`);
  return matches[0].id;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  if (!args.input) throw new Error(`--input is required\n\n${usage()}`);

  loadEnvironmentFile();
  const parsed = JSON.parse(await readFile(path.resolve(args.input), 'utf8'));
  const input = normalizeInput(parsed);
  const serverURL = requireEnvironment('ACTUAL_SERVER_URL');
  const password = requireEnvironment('ACTUAL_PASSWORD');
  const syncId = requireEnvironment('ACTUAL_SYNC_ID');
  const dataDir = path.resolve(process.env.ACTUAL_DATA_DIR?.trim() || '.actual-cache');

  let initialized = false;
  try {
    await api.init({ serverURL, password, dataDir });
    initialized = true;
    const budgetPassword = process.env.ACTUAL_BUDGET_PASSWORD?.trim();
    await api.downloadBudget(syncId, budgetPassword ? { password: budgetPassword } : undefined);
    const accountId = await resolveAccount(input);

    const result = await api.importTransactions(
      accountId,
      input.transactions,
      buildImportOptions({ dryRun: args.dryRun }),
    );

    if (result.errors?.length) {
      throw new Error(`Actual rejected the import: ${JSON.stringify(result.errors)}`);
    }

    if (!args.dryRun) {
      await api.sync();
    }

    process.stdout.write(`${JSON.stringify({
      dryRun: args.dryRun,
      submitted: input.transactions.length,
      skippedDuplicatesInInput: input.duplicateInputCount,
      added: result.added?.length ?? 0,
      updated: result.updated?.length ?? 0,
    }, null, 2)}\n`);
  } finally {
    if (initialized) await api.shutdown();
  }
}

main().catch(error => {
  const code = error?.code ? ` (${error.code})` : '';
  process.stderr.write(`Import failed${code}: ${error.message}\n`);
  process.exitCode = 1;
});
