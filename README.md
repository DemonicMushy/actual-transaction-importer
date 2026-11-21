# Actual Budget transaction importer

This Node.js CLI imports a normalized JSON transaction list into a self-hosted Actual Budget instance. It uses Actual's official `importTransactions` API, so Actual applies rules and reconciles likely duplicates. Every input transaction also receives a stable `imported_id`, which makes rerunning the same statement idempotent.

## Requirements

- Node.js 22 or newer (required by the current official Actual API package)
- A self-hosted Actual Budget server reachable from this machine
- The budget Sync ID from **Settings → Show advanced settings**

Install the dependency:

```sh
nvm use
npm install
python3 -m pip install -r requirements.txt
```

## Configure

Create a `.env` file from the included example and fill in your Actual details:

```sh
cp .env.example .env
```

The importer automatically reads `.env` from the directory where you run it. Values already supplied by the shell take precedence over values in the file. `.env` is excluded from Git by `.gitignore`.

Use `ACTUAL_ACCOUNT_ID` instead of the name if account names are not unique. For an end-to-end encrypted budget, also set `ACTUAL_BUDGET_PASSWORD`.

## Monthly Maybank workflow

For a Maybank Family & Friends statement, one command now performs the complete workflow. It extracts the transaction pages, validates that previous balance + charges - credits equals the statement balance, assigns only known existing payees and categories, and reconciles against Actual.

Preview first (this is the default and does not change Actual):

```sh
npm run maybank -- --pdf "pdfs/Family & Friends Card_25 November 2026.pdf"
```

Review the counts, then apply the same statement:

```sh
npm run maybank -- --pdf "pdfs/Family & Friends Card_25 November 2026.pdf" --apply
```

The command writes an audit JSON file under `output/transactions/`, which is ignored by Git because it contains financial data. After an applied import, it verifies that every deterministic statement ID exists in Actual. Rerunning the same PDF is safe because those IDs are stable.

The Maybank-specific behavior is centralized in `src/maybank-rules.mjs`:

- Grab charges at S$28 or below map to `GrabTransport`; larger charges map to `GrabFood`.
- The statement's numeric GrabPay description maps to `GrabPay`.
- Known merchants reuse existing payees and established categories.
- Cashback uses the existing `Maybank` payee and `Cashback and Rebates` category.
- Known Best Denki installment amounts carry their recurring product note and use the manually established one-day-earlier date.
- The DBS card payment uses the existing transfer payee and no category.
- Unknown merchants remain without a payee or category instead of creating new ones.
- Posting dates are used only inside the stable source ID and are not copied into Notes.

If the PDF layout or desired mappings change, update the parser/rules and run `npm test` before applying a statement.

To compare a prior statement with later manual edits in Actual, run:

```sh
npm run audit:maybank -- --input "output/transactions/Family & Friends Card_25 October 2026.json"
```

This is read-only and reports changes to payee, category, date, amount, notes, and cleared state. Only stable, repeatable merchant patterns should be promoted into the rules.

## Input format

See `examples/transactions.json`. The top-level object supports:

- `source`: a stable card/source label; keep it the same across statements
- `account_id` or `account_name`: optional overrides for the environment setting
- `transactions`: the list to import

Each transaction requires:

- `date`: `YYYY-MM-DD`
- `amount`: decimal major units, such as `-42.50`; Actual uses positive inflows and negative outflows
- `payee` or `raw_description`

Optional fields are `source_id`, `direction`, `raw_description`, `notes`, `category_id`, and `cleared`. `direction` can be `outflow` or `inflow` and is useful when a PDF extractor emits unsigned amounts. A parenthesized string such as `(42.50)` is treated as negative.

Use `payee` only for an intentional normalized name, such as `GrabFood`, `GrabTransport`, or `Netflix`. Put the statement's unprocessed merchant text in `raw_description`. If only `raw_description` is supplied, Actual can apply existing rules, but the importer will not create a new payee from that raw text; an unmatched transaction is left without a payee.

Pass a statement/bank transaction reference as `source_id` whenever one exists. Without one, the script hashes the source, date, amount, payee/raw description, and notes. That fallback is stable, but two legitimate transactions with every one of those fields identical cannot be distinguished; give those transactions distinct `source_id` values.

## Run

Always preview first:

```sh
npm run import -- --input examples/transactions.json --dry-run
```

Then import:

```sh
npm run import -- --input path/to/processed-statement.json
```

The JSON summary reports submitted rows, duplicates removed from the input itself, additions, and updates. If an imported statement transaction was later deleted in Actual, a subsequent applied import restores it (`reimportDeleted: true`). Existing live transactions with the same stable import ID are still de-duplicated.

Run the local validation tests with:

```sh
npm test
```

## Deduplication behavior

There are two layers:

1. Stable `imported_id` values prevent the same source transaction being imported twice.
2. Actual's reconciliation also compares amount, nearby dates, and similar payees, which can match an existing manually entered transaction.

Use a stable `source` and `source_id` for the strongest result. A dry run still connects to and downloads the budget into `.actual-cache`, but it does not modify the budget.
