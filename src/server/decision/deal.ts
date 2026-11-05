import { extractCurrencies, extractDates, extractDurations } from '../understanding/conflictDetector';
import { Ctx, evidenceTexts, makeItem, structuredFrom } from './items';
import { DealGroup, DealItem, DealSection, ExtractedItem } from './types';

const CLIENT_ROLES = new Set(['Client', 'Customer']);
const FREELANCER_ROLES = new Set(['Contractor', 'Consultant', 'Service Provider']);

export type Holder = 'freelancer' | 'client' | 'either_party';

/** Who holds a termination-type right, judged from the clause's own wording. */
export function holderOf(text: string): Holder | undefined {
  const t = text.toLowerCase();
  if (/(either|both|each) part(y|ies)/.test(t)) return 'either_party';
  const client = /\b(client|company|customer)\b[^.]{0,80}\b(may|can|has the right to|reserves the right to)\s+terminate/.test(t);
  const contractor = /\b(contractor|consultant|freelancer)\b[^.]{0,80}\b(may|can|has the right to|shall have the right to)\s+terminate/.test(t) && !/(contractor|consultant)[^.]{0,40}(may|shall|can) not terminate/.test(t);
  if (client && contractor) return 'either_party';
  if (client) return 'client';
  if (contractor) return 'freelancer';
  return undefined;
}

const add = (group: DealGroup, item: ExtractedItem, extra: Partial<DealItem> = {}): DealItem => ({ ...item, group, ...extra });

export function buildDeal(ctx: Ctx): DealSection {
  const { a, u } = ctx;
  const items: DealItem[] = [];

  // ---- Contract name and type
  items.push(add('contract', makeItem(ctx, { id: 'contract.name', title: 'Contract name', category: 'contract', keys: ['deal_title'] })));

  const category = u.classification?.category;
  const typeEvidence = a.searchEvidence(/independent contractor|freelanc\w+|consult(ing|ant)|services agreement|professional services/i, 1);
  items.push(
    add('contract', {
      id: 'contract.type',
      title: 'Contract type',
      value: category ?? null,
      status: category && typeEvidence.length ? 'explicit' : category ? 'unclear' : 'not_found',
      explanation: typeEvidence.length
        ? 'The contract identifies itself as this kind of agreement.'
        : 'Classified from the contract’s content; the contract does not name its own type.',
      evidence: ctx.resolver.list(typeEvidence, 1),
      category: 'contract',
    })
  );

  // ---- Parties (roles come from the understanding stage; evidence is the verified quote)
  const byRole: Record<'client' | 'freelancer' | 'other', number> = { client: 0, freelancer: 0, other: 0 };
  for (const p of u.parties || []) {
    const role: 'client' | 'freelancer' | 'other' = CLIENT_ROLES.has(p.role) ? 'client' : FREELANCER_ROLES.has(p.role) ? 'freelancer' : 'other';
    byRole[role]++;
    const ev = a.toEvidence(p.evidence);
    const details = [p.legal_entity_type && p.legal_entity_type !== 'Unspecified' ? p.legal_entity_type : null, p.defined_term ? `referred to as “${p.defined_term}”` : null, p.address_or_location || null]
      .filter(Boolean)
      .join(', ');
    items.push(
      add(
        'parties',
        {
          id: `party.${role}.${byRole[role]}`,
          title: role === 'client' ? 'Client' : role === 'freelancer' ? 'Freelancer / contractor' : `Other party (${p.role})`,
          value: `${p.name}${details ? ` — ${details}` : ''}`,
          status: ev.length ? 'explicit' : 'unclear',
          explanation: ev.length ? `Named in the contract with the role “${p.role}”.` : 'The quote naming this party could not be verified, so the role is not presented as confirmed.',
          evidence: ctx.resolver.list(ev, 2),
          category: 'parties',
          ...(ev.length ? {} : { evidence_unverified: true }),
        },
        { party_role: role }
      )
    );
  }
  for (const role of ['client', 'freelancer'] as const) {
    if (byRole[role] === 0) {
      items.push(
        add('parties', {
          id: `party.${role}`,
          title: role === 'client' ? 'Client' : 'Freelancer / contractor',
          value: null,
          status: a.fullCoverage ? 'not_found' : 'unclear',
          explanation: a.fullCoverage ? 'No party with this role was identified in the contract.' : 'No party with this role was identified in the analyzed part of the document.',
          evidence: [],
          category: 'parties',
        }, { party_role: role })
      );
    }
  }

  // ---- Engagement
  const engagement = makeItem(ctx, { id: 'engagement.description', title: 'Engagement and services', category: 'engagement', keys: ['scope'] });
  // A heading alone ("SERVICES AND SCOPE OF WORK") does not describe the engagement: look for the sentence that does
  if (engagement.status === 'explicit' && !engagement.evidence.some((e) => /\b(shall|agrees? to|will)\s+(provide|perform|render|deliver|develop|design|create)/i.test(e.exact_quote))) {
    const sentence = a.searchEvidence(/\b(shall|agrees? to|will)\s+(provide|perform|render|deliver|develop|design|create)\b/i, 1);
    if (sentence.length) {
      engagement.evidence = ctx.resolver.list(sentence, 1);
      engagement.value = sentence[0].exact_quote.slice(0, 500);
    }
  }
  const deliverables = (u.scope_and_deliverables?.deliverables || []).filter((d) => a.isEstablished(d));
  if (deliverables.length) {
    engagement.structured = { ...(engagement.structured || {}), deliverables: deliverables.map((d) => d.summary).slice(0, 10) };
    if (engagement.status === 'not_found') {
      engagement.status = 'explicit';
      engagement.value = deliverables.map((d) => d.summary).slice(0, 3).join('; ');
      engagement.explanation = 'Described through the deliverables listed in the contract.';
      engagement.evidence = ctx.resolver.list(deliverables.flatMap((d) => a.evidenceOf(d)), 3);
    }
  }
  items.push(add('engagement', engagement));

  // ---- Timeline
  const start = makeItem(ctx, { id: 'timeline.start_date', title: 'Start date', category: 'timeline', keys: ['effective_date', 'commencement_date'] });
  start.structured = structuredFrom(evidenceTexts(start));
  items.push(add('timeline', start));

  const duration = makeItem(ctx, { id: 'timeline.duration', title: 'Duration', category: 'timeline', keys: ['term_duration'] });
  duration.structured = structuredFrom(evidenceTexts(duration));
  items.push(add('timeline', duration));

  const end = makeItem(ctx, { id: 'timeline.end_date', title: 'End date', category: 'timeline', keys: ['expiration_date'] });
  const endStated = [...extractDates(evidenceTexts(end).join(' '))].sort()[0];
  if (endStated) {
    end.structured = { date: endStated };
  } else if (end.status !== 'not_found') {
    // The fact is a duration, not a date: say so instead of presenting it as an end date
    end.value = null;
    end.status = a.fullCoverage ? 'not_found' : 'unclear';
    end.explanation = 'The contract states a duration but no end date.';
    end.evidence = [];
  }
  const startIso = start.structured?.date;
  const months = duration.structured?.months;
  if (!endStated && startIso && months !== undefined && duration.status === 'explicit' && start.status === 'explicit') {
    const [y, m, d] = startIso.split('-').map(Number);
    const calc = new Date(Date.UTC(y, m - 1 + months, d)).toISOString().slice(0, 10);
    end.value = `About ${calc} (calculated)`;
    end.status = 'unclear';
    end.explanation = 'Not stated as a date. Calculated from the stated start date and duration; confirm it with the other party.';
    end.evidence = [...start.evidence.slice(0, 1), ...duration.evidence.slice(0, 1)];
    end.structured = { calculated_date: calc };
  }
  items.push(add('timeline', end));

  // ---- Governing law
  items.push(add('contract', makeItem(ctx, { id: 'legal.governing_law', title: 'Governing law', category: 'legal', keys: ['governing_law'] })));

  // ---- Money
  const comp = makeItem(ctx, { id: 'money.compensation', title: 'Compensation', category: 'money', keys: ['rates'] });
  comp.structured = structuredFrom(evidenceTexts(comp));
  items.push(add('money', comp));

  // Currency: a named currency is explicit; a bare symbol is unclear because it does not say which currency
  const currency = makeItem(ctx, { id: 'money.currency', title: 'Currency', category: 'money', keys: ['deal_currency'] });
  const named = [...extractCurrencies(`${comp.value ?? ''} ${evidenceTexts(comp).join(' ')}`)];
  if (currency.status === 'not_found' && named.length) {
    currency.status = 'explicit';
    currency.value = named.join(', ');
    currency.explanation = 'Named alongside the stated amounts.';
    currency.evidence = comp.evidence.slice(0, 1);
  } else if (currency.status === 'unclear' && !currency.explanation.includes('symbol')) {
    currency.explanation = 'Amounts use a currency symbol (such as “$”) without naming the currency.';
    const symbol = /[$€£¥]\s?[\d][\d,.]*/.exec(`${comp.value ?? ''} ${evidenceTexts(comp).join(' ')} ${currency.value ?? ''}`)?.[0];
    if (symbol) currency.value = symbol;
  }
  items.push(add('money', currency));

  items.push(add('money', makeItem(ctx, { id: 'money.payment_structure', title: 'Payment structure', category: 'money', keys: ['fee_structure'] })));

  // ---- Invoicing and payment
  items.push(add('invoicing', makeItem(ctx, { id: 'invoicing.invoice_requirements', title: 'Invoicing', category: 'invoicing', keys: ['invoicing', 'deal_invoice'] })));
  const deadline = makeItem(ctx, { id: 'invoicing.payment_deadline', title: 'Payment deadline', category: 'invoicing', keys: ['payment_terms'] });
  deadline.structured = structuredFrom(evidenceTexts(deadline));
  items.push(add('invoicing', deadline));
  items.push(add('invoicing', makeItem(ctx, { id: 'invoicing.late_payment', title: 'Late payment', category: 'invoicing', keys: ['late_payment'] })));
  items.push(add('invoicing', makeItem(ctx, { id: 'invoicing.milestones', title: 'Milestones', category: 'invoicing', keys: ['deal_milestones'] })));
  items.push(add('invoicing', makeItem(ctx, { id: 'invoicing.payment_conditions', title: 'Conditions for payment', category: 'invoicing', keys: ['deal_pay_conditions'] })));

  // ---- Expenses and tax
  items.push(add('money', makeItem(ctx, { id: 'money.expenses', title: 'Expenses and reimbursement', category: 'money', keys: ['expenses'] })));
  items.push(add('money', makeItem(ctx, { id: 'money.tax', title: 'Tax provisions', category: 'money', keys: ['taxes', 'tax_income', 'tax_withholding', 'tax_indirect', 'tax_indemnity'] })));
  items.push(add('money', makeItem(ctx, { id: 'money.tax_basis', title: 'Whether amounts include tax', category: 'money', keys: ['tax_basis'] })));

  // ---- Termination
  const notice = makeItem(ctx, { id: 'termination.notice', title: 'Termination notice period', category: 'termination', keys: ['term_convenience'] });
  notice.structured = { ...(structuredFrom(evidenceTexts(notice)) || {}) };
  const holder = holderOf(evidenceTexts(notice).join(' '));
  if (holder) notice.structured = { ...notice.structured, holder };
  items.push(add('termination_renewal', notice));
  items.push(add('termination_renewal', makeItem(ctx, { id: 'termination.contractor_right', title: 'Your right to terminate', category: 'termination', keys: ['deal_contractor_term'] })));
  items.push(add('termination_renewal', makeItem(ctx, { id: 'termination.conditions', title: 'Termination for cause', category: 'termination', keys: ['term_cause'] })));
  items.push(add('termination_renewal', makeItem(ctx, { id: 'termination.payment_on_termination', title: 'Payment when the contract ends', category: 'termination', keys: ['post_term_payment'] })));

  // ---- Renewal. An explicit "will not renew" is a statement, so it is not_applicable (not "not found").
  const renewal = makeItem(ctx, { id: 'renewal.terms', title: 'Renewal', category: 'renewal', keys: ['renewal', 'ren_auto', 'ren_duration', 'ren_notice', 'ren_unilateral', 'ren_pricing'] });
  if (renewal.status === 'not_found') {
    const noRenew = a.searchEvidence(/(shall|will|does)\s+not\s+(automatically\s+)?(renew|be renewed)|no (automatic )?renewal/i, 1);
    if (noRenew.length) {
      renewal.status = 'not_applicable';
      renewal.value = 'The contract states that it does not renew.';
      renewal.explanation = 'Renewal does not apply: the contract says it will not renew.';
      renewal.evidence = ctx.resolver.list(noRenew, 1);
    }
  }
  renewal.structured = structuredFrom(evidenceTexts(renewal));
  items.push(add('termination_renewal', renewal));

  // Safety net: the extraction stage can miss a clause with unusual wording. Before an item is reported as "not
  // found", the document text is searched; if matching wording exists it is shown as unclear with the quote
  // (or explicit for a stated date), never as an absence.
  for (const item of items) {
    const pattern = CORROBORATE[item.id];
    if (!pattern || item.status !== 'not_found') continue;
    const found = a.searchEvidence(pattern, 1);
    if (found.length === 0) continue;
    const evidence = ctx.resolver.list(found, 1);
    item.evidence = evidence;
    item.value = evidence[0].exact_quote.slice(0, 500);
    if (item.id === 'timeline.start_date') {
      const date = [...extractDates(evidence[0].exact_quote)].sort()[0];
      if (date) {
        item.status = 'explicit';
        item.explanation = 'Stated in the contract.';
        item.structured = { date };
        continue;
      }
    }
    item.status = 'unclear';
    item.explanation = 'The analysis did not identify this term, but the contract contains wording that may address it (quoted). Confirm that it covers this item.';
  }

  return { items };
}

const MONTHS = '(?:January|February|March|April|May|June|July|August|September|October|November|December)';
const CORROBORATE: Record<string, RegExp> = {
  'timeline.start_date': new RegExp(`(?:effective|commenc\\w+|dated|start(?:s|ing)?)\\b[^.]{0,40}\\b${MONTHS}\\s+\\d{1,2},?\\s+\\d{4}|(?:effective|commenc\\w+)[^.]{0,40}\\d{4}-\\d{2}-\\d{2}`, 'i'),
  'legal.governing_law': /governed by|governing law|laws of (the )?(state|commonwealth|republic|england|india)/i,
  'money.compensation': /[$€£]\s?\d|\b(usd|eur|gbp|inr)\s?\d|\d+\s?(dollars|per (hour|day|month|week))|hourly rate|fixed (fee|price)|flat fee/i,
  'invoicing.payment_deadline': /\bnet\s*\d+|within\s+\w+(\s*\(\d+\))?\s+(business\s+)?days\s+(of|after|from)|payable\s+(within|upon)|due\s+(on|upon)\s+receipt/i,
  'invoicing.late_payment': /late\s+(fee|charge|payment)|interest\s+(on|at)\b|overdue/i,
  'money.expenses': /reimburs|out-of-pocket/i,
  'termination.notice': /terminat[^.]{0,80}(notice|without cause|convenience|any time)|(notice|convenience)[^.]{0,80}terminat/i,
  'termination.payment_on_termination': /(paid|payment|compensat)[^.]{0,80}(terminat|prior to|up to)|terminat[^.]{0,120}(paid|payment|compensat|fees)/i,
  'renewal.terms': /\brenew/i,
};

export { extractDurations };
