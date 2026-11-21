#!/usr/bin/env python3
"""Extract Maybank Family & Friends statement transactions as normalized JSON."""

import argparse
import json
import re
from collections import Counter
from datetime import date
from decimal import Decimal

import pdfplumber


ROW = re.compile(
    r"^(\d{2}[A-Z]{3})\s+(\d{2}[A-Z]{3})\s+(.+?)\s+([\d,]+\.\d{2})(CR)?$"
)
STATEMENT_HEADER = re.compile(
    r"\b(\d{2}/\d{2}/\d{4})\s+\d{2}/\d{2}/\d{4}\s+([\d,]+\.\d{2})\s+"
)
PREVIOUS_BALANCE = re.compile(
    r"OUTSTANDING\s+BALANCE\s+BROUGHT\s+FORWARD\s+([\d,]+\.\d{2})"
)
MONTHS = {
    "JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
    "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12,
}


def money(value: str) -> Decimal:
    return Decimal(value.replace(",", ""))


def parse_short_date(value: str, statement_date: date) -> str:
    month = MONTHS[value[2:]]
    year = statement_date.year - 1 if month > statement_date.month else statement_date.year
    return date(year, month, int(value[:2])).isoformat()


def clean_line(value: str) -> str:
    return " ".join(value.replace("†", " ").split())


def extract(pdf_path: str) -> dict:
    transactions = []
    occurrences = Counter()
    statement_date = None
    total_due = None
    previous_balance = None

    with pdfplumber.open(pdf_path) as pdf:
        for page_index, page in enumerate(pdf.pages):
            text = page.extract_text(x_tolerance=2, y_tolerance=3) or ""
            lines = [clean_line(line) for line in text.splitlines()]

            if page_index == 0:
                header = next((STATEMENT_HEADER.search(line) for line in lines if STATEMENT_HEADER.search(line)), None)
                prior = next((PREVIOUS_BALANCE.search(line) for line in lines if PREVIOUS_BALANCE.search(line)), None)
                if not header or not prior:
                    raise ValueError("This does not look like a supported Maybank card statement")
                day, month, year = map(int, header.group(1).split("/"))
                statement_date = date(year, month, day)
                total_due = money(header.group(2))
                previous_balance = money(prior.group(1))

            for line in lines:
                match = ROW.match(line)
                if not match:
                    continue
                transaction_date, posting_date, description, amount_text, credit = match.groups()
                amount = money(amount_text)
                signed_amount = amount if credit else -amount
                transaction_iso = parse_short_date(transaction_date, statement_date)
                posting_iso = parse_short_date(posting_date, statement_date)
                identity = f"{transaction_iso}|{posting_iso}|{description}|{signed_amount:.2f}"
                occurrences[identity] += 1
                transactions.append({
                    "source_id": f"{identity}|{occurrences[identity]}",
                    "date": transaction_iso,
                    "amount": f"{signed_amount:.2f}",
                    "raw_description": description,
                    "cleared": True,
                })

    if not transactions:
        raise ValueError("No transaction rows were found")

    charges = -sum((money(item["amount"]) for item in transactions if money(item["amount"]) < 0), Decimal("0"))
    credits = sum((money(item["amount"]) for item in transactions if money(item["amount"]) > 0), Decimal("0"))
    calculated_due = previous_balance + charges - credits
    if calculated_due != total_due:
        raise ValueError(
            f"Statement validation failed: {previous_balance} + {charges} - {credits} "
            f"= {calculated_due}, expected {total_due}"
        )

    return {
        "source": "maybank-family-friends-card-0002",
        "statement": {
            "date": statement_date.isoformat(),
            "previous_balance": f"{previous_balance:.2f}",
            "charges": f"{charges:.2f}",
            "credits": f"{credits:.2f}",
            "total_due": f"{total_due:.2f}",
            "transaction_count": len(transactions),
        },
        "transactions": transactions,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("pdf")
    args = parser.parse_args()
    print(json.dumps(extract(args.pdf), indent=2))


if __name__ == "__main__":
    main()
