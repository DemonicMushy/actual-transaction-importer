export function classifyMaybankTransaction(description, amount) {
  const raw = description.trim();
  const absoluteAmount = Math.abs(Number(amount));

  if (/^GRAB\*/i.test(raw)) {
    if (/^GRAB\*\s+\d/i.test(raw)) {
      return { payee: 'GrabPay', categoryName: 'Food' };
    }
    return absoluteAmount <= 28
      ? { payee: 'GrabTransport', categoryName: 'S:Transport' }
      : { payee: 'GrabFood', categoryName: 'S:Food' };
  }

  if (/^0%IPP\s+-\s+BEST DENKI\b/i.test(raw)) {
    const installmentNotes = new Map([
      [137.66, 'Miele Front Load Washer WCR860'],
      [183.29, 'LG System 3 Aircon'],
      [47.05, 'Panasonic Convection Microwave'],
    ]);
    return {
      payee: 'Instalments',
      categoryName: 'Instalment Payments',
      notes: installmentNotes.get(absoluteAmount) ?? null,
      dateOffsetDays: -1,
    };
  }

  const rules = [
    [/^BUS\/MRT\b/i, 'TransitLink', 'S:Public Transport'],
    [/^NETFLIX\.COM\b/i, 'Netflix', 'Subscriptions'],
    [/^VIRGIN ACTIVE\b/i, 'Virgin Active', 'S:Subscriptions'],
    [/^MYREPUBLIC\b/i, 'MyRepublic', 'Bills'],
    [/^GOMO BY SINGTEL\b/i, 'GOMO', 'Bills'],
    [/^SENOKO ENERGY\b/i, 'Senoko', 'Bills'],
    [/^STUFFD-/i, 'Stuffd', 'Food'],
    [/^MCDONALDS\b/i, 'McDonalds', 'S:Food'],
    [/^DIAMOND KITCHEN\b/i, 'Diamond Kitchen', 'Food'],
    [/^BAKERYCUISINE\b/i, 'Bakerycuisine', 'Food'],
    [/^TONKOTSU KING\b/i, 'Tonkotsu King (Hv)', 'S:Food'],
    [/^POKE THEOIRY\b/i, 'Poke Theoiry', 'Food'],
    [/^ORIENTAL KOPI-/i, 'Oriental Kopi-Mid', 'S:Food'],
    [/^SOGO MV SOUTHKEY\b/i, 'Sogo Mv Southkey', 'S:Clothes'],
    [/^YUMIDO-JBCC\b/i, 'Yumido-Jbcc', 'S:Food'],
    [/^KOREAN FAMILY RESTAURA\b/i, 'Korean Family Restaura', 'S:Food'],
    [/^CARING PHARMACY-/i, 'Caring Pharmacy-The Ma', 'S:General'],
    [/^VS PLAY GADGET STORE\b/i, 'Vs Play Gadget Store', 'Electronics'],
    [/^DBS BANKDBSBANKPAYMEN\b/i, 'DBS Joint Account', null],
  ];
  for (const [pattern, payee, categoryName] of rules) {
    if (pattern.test(raw)) return { payee, categoryName };
  }

  if (/^APPLE\.COM\/BILL\b/i.test(raw)) {
    return {
      payee: 'Apple',
      categoryName: absoluteAmount === 4.02 ? 'Subscriptions' : 'Entertainment',
    };
  }
  if (/^HELPLING\*/i.test(raw)) {
    return {
      payee: 'Helpling',
      categoryName: absoluteAmount === 66.4
        ? 'S:Subscriptions'
        : absoluteAmount === 76.4 ? 'Parents' : null,
    };
  }
  if (/^(OTHER|FF) CASHBACK$/i.test(raw)) {
    return { payee: 'Maybank', categoryName: 'Cashback and Rebates' };
  }

  return { payee: null, categoryName: null };
}

export function applyMaybankTransactionRules(transaction) {
  const classification = classifyMaybankTransaction(
    transaction.raw_description,
    transaction.amount,
  );
  const result = { ...transaction };
  if (classification.payee) result.payee = classification.payee;
  if (classification.categoryName) result.category_name = classification.categoryName;
  if (classification.notes) result.notes = classification.notes;
  if (classification.dateOffsetDays) {
    const date = new Date(`${result.date}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + classification.dateOffsetDays);
    result.date = date.toISOString().slice(0, 10);
  }
  return result;
}
