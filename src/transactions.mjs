import { createHash } from 'node:crypto';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function buildImportOptions({ dryRun = false } = {}) {
  return {
    dryRun,
    // Actual keeps tombstones for deleted imported transactions. Ignoring
    // those tombstones lets a later statement import restore the transaction.
    reimportDeleted: true,
    defaultCleared: true,
    payeeNameNormalization: 'original',
  };
}

export function parseAmount(value, direction, rowNumber) {
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    (typeof value === 'string' && value.trim() === '')
  ) {
    throw new Error(`Transaction ${rowNumber}: amount must be a number`);
  }

  let normalized = value;
  let parenthesized = false;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    parenthesized = /^\(.*\)$/.test(trimmed);
    normalized = trimmed.replace(/[,$\s]/g, '').replace(/^\((.*)\)$/, '$1');
  }

  const amount = Number(normalized);
  if (!Number.isFinite(amount)) {
    throw new Error(`Transaction ${rowNumber}: amount must be a number`);
  }

  let signedAmount = parenthesized ? -Math.abs(amount) : amount;
  if (direction !== undefined) {
    if (direction !== 'outflow' && direction !== 'inflow') {
      throw new Error(`Transaction ${rowNumber}: direction must be "outflow" or "inflow"`);
    }
    signedAmount = direction === 'outflow' ? -Math.abs(amount) : Math.abs(amount);
  }

  const cents = Math.round((signedAmount + Number.EPSILON) * 100);
  if (Math.abs(signedAmount * 100 - cents) > 1e-7) {
    throw new Error(`Transaction ${rowNumber}: amount may have at most two decimal places`);
  }
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`Transaction ${rowNumber}: amount is outside the supported range`);
  }
  return cents;
}

function validateDate(date, rowNumber) {
  if (typeof date !== 'string' || !DATE_PATTERN.test(date)) {
    throw new Error(`Transaction ${rowNumber}: date must use YYYY-MM-DD`);
  }
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error(`Transaction ${rowNumber}: date is not a real calendar date`);
  }
  return date;
}

function optionalString(value, field, rowNumber) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Transaction ${rowNumber}: ${field} must be a string`);
  }
  return value.trim();
}

function fingerprint(source, transaction) {
  const components = [
    source,
    transaction.date,
    String(transaction.amount),
    (transaction.imported_payee ?? transaction.payee_name ?? '').toLocaleLowerCase('en-US'),
    (transaction.notes ?? '').toLocaleLowerCase('en-US'),
  ];
  return createHash('sha256').update(JSON.stringify(components)).digest('hex').slice(0, 32);
}

export function normalizeInput(parsed) {
  const envelope = Array.isArray(parsed) ? { transactions: parsed } : parsed;
  if (!envelope || typeof envelope !== 'object' || !Array.isArray(envelope.transactions)) {
    throw new Error('Input must be a JSON array or an object containing a transactions array');
  }
  if (envelope.transactions.length === 0) {
    throw new Error('Input contains no transactions');
  }

  const source = optionalString(envelope.source, 'source', 'input') ?? 'pdf-statement';
  const seen = new Map();
  const transactions = [];
  let duplicateInputCount = 0;

  for (const [index, raw] of envelope.transactions.entries()) {
    const row = index + 1;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`Transaction ${row}: must be an object`);
    }

    const payeeName = optionalString(raw.payee ?? raw.payee_name, 'payee', row);
    const importedPayee = optionalString(raw.raw_description ?? raw.imported_payee, 'raw_description', row);
    if (!payeeName && !importedPayee) {
      throw new Error(`Transaction ${row}: payee or raw_description is required`);
    }

    const transaction = {
      date: validateDate(raw.date, row),
      amount: parseAmount(raw.amount, raw.direction, row),
      imported_payee: importedPayee ?? payeeName,
    };
    // `payee` is an intentional, normalized name. A raw bank description is
    // retained for matching/rules but must not create a new payee by default.
    if (payeeName) transaction.payee_name = payeeName;

    const notes = optionalString(raw.notes, 'notes', row);
    const category = optionalString(raw.category_id ?? raw.category, 'category_id', row);
    if (notes) transaction.notes = notes;
    if (category) transaction.category = category;
    if (raw.cleared !== undefined) {
      if (typeof raw.cleared !== 'boolean') {
        throw new Error(`Transaction ${row}: cleared must be a boolean`);
      }
      transaction.cleared = raw.cleared;
    }

    const sourceId = optionalString(raw.source_id ?? raw.imported_id, 'source_id', row);
    transaction.imported_id = sourceId
      ? `pdf:${source}:${sourceId}`
      : `pdf:${source}:sha256:${fingerprint(source, transaction)}`;

    const prior = seen.get(transaction.imported_id);
    if (prior) {
      if (JSON.stringify(prior.transaction) !== JSON.stringify(transaction)) {
        throw new Error(
          `Transaction ${row}: duplicate import ID conflicts with transaction ${prior.row}`,
        );
      }
      duplicateInputCount += 1;
      continue;
    }
    seen.set(transaction.imported_id, { row, transaction });
    transactions.push(transaction);
  }

  return {
    accountId: optionalString(envelope.account_id, 'account_id', 'input'),
    accountName: optionalString(envelope.account_name, 'account_name', 'input'),
    source,
    transactions,
    duplicateInputCount,
  };
}
