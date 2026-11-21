import assert from 'node:assert/strict';
import test from 'node:test';
import { buildImportOptions, normalizeInput, parseAmount } from '../src/transactions.mjs';
import {
  applyMaybankTransactionRules,
  classifyMaybankTransaction,
} from '../src/maybank-rules.mjs';

test('converts major currency units and directions to Actual integer amounts', () => {
  assert.equal(parseAmount('1,234.56', 'outflow', 1), -123456);
  assert.equal(parseAmount('42.50', 'inflow', 1), 4250);
  assert.equal(parseAmount(-12.34, undefined, 1), -1234);
  assert.equal(parseAmount('(9.99)', undefined, 1), -999);
});

test('creates stable IDs and removes exact duplicates within one input', () => {
  const item = { date: '2026-10-01', amount: -10, payee: 'Cafe' };
  const result = normalizeInput({ source: 'card-1234', transactions: [item, item] });
  assert.equal(result.transactions.length, 1);
  assert.equal(result.duplicateInputCount, 1);
  assert.match(result.transactions[0].imported_id, /^pdf:card-1234:sha256:[a-f0-9]{32}$/);
});

test('uses a statement-provided source ID when available', () => {
  const result = normalizeInput({
    source: 'card-1234',
    transactions: [{ source_id: 'bank-ref-7', date: '2026-10-01', amount: 10, payee: 'Refund' }],
  });
  assert.equal(result.transactions[0].imported_id, 'pdf:card-1234:bank-ref-7');
});

test('reimports a statement transaction that was deleted in Actual', () => {
  assert.deepEqual(buildImportOptions({ dryRun: false }), {
    dryRun: false,
    reimportDeleted: true,
    defaultCleared: true,
    payeeNameNormalization: 'original',
  });
});

test('does not create a payee from a raw statement description', () => {
  const result = normalizeInput([{
    date: '2026-10-01',
    amount: -10,
    raw_description: 'MERCHANT REFERENCE 12345',
  }]);
  assert.equal(result.transactions[0].imported_payee, 'MERCHANT REFERENCE 12345');
  assert.equal(result.transactions[0].payee_name, undefined);
});

test('rejects invalid dates and precision', () => {
  assert.throws(
    () => normalizeInput([{ date: '2026-02-30', amount: 1, payee: 'Cafe' }]),
    /not a real calendar date/,
  );
  assert.throws(() => parseAmount(1.234, undefined, 1), /at most two decimal places/);
  assert.throws(() => parseAmount(null, undefined, 1), /amount must be a number/);
  assert.throws(() => parseAmount('', undefined, 1), /amount must be a number/);
  assert.throws(() => parseAmount(false, undefined, 1), /amount must be a number/);
});

test('rejects conflicting duplicate import IDs', () => {
  assert.throws(
    () => normalizeInput({
      source: 'card-1234',
      transactions: [
        { source_id: 'bank-ref-7', date: '2026-10-01', amount: 10, payee: 'Cafe' },
        { source_id: 'bank-ref-7', date: '2026-10-02', amount: 20, payee: 'Cafe' },
      ],
    }),
    /duplicate import ID conflicts/,
  );
});

test('maps Maybank descriptions to existing payees and categories', () => {
  assert.deepEqual(
    classifyMaybankTransaction('GRAB* A-REFERENCE SINGAPORE', '-23.40'),
    { payee: 'GrabTransport', categoryName: 'S:Transport' },
  );
  assert.deepEqual(
    classifyMaybankTransaction('GRAB* A-REFERENCE SINGAPORE', '-43.10'),
    { payee: 'GrabFood', categoryName: 'S:Food' },
  );
  assert.deepEqual(
    classifyMaybankTransaction('BUS/MRT 123456 SINGAPORE', '-13.00'),
    { payee: 'TransitLink', categoryName: 'S:Public Transport' },
  );
  assert.deepEqual(
    classifyMaybankTransaction('FF CASHBACK', '114.16'),
    { payee: 'Maybank', categoryName: 'Cashback and Rebates' },
  );
  assert.deepEqual(
    classifyMaybankTransaction('UNKNOWN MERCHANT 123', '-9.99'),
    { payee: null, categoryName: null },
  );
});

test('applies recurring Best Denki installment details learned from manual edits', () => {
  assert.deepEqual(
    applyMaybankTransactionRules({
      date: '2026-10-03',
      amount: '-183.29',
      raw_description: '0%IPP - BEST DENKI (S) P L 003/024 INS',
    }),
    {
      date: '2026-10-02',
      amount: '-183.29',
      raw_description: '0%IPP - BEST DENKI (S) P L 003/024 INS',
      payee: 'Instalments',
      category_name: 'Instalment Payments',
      notes: 'LG System 3 Aircon',
    },
  );
});
