import { Analysis, max, toDays, toMonths } from '../risk/analysis';
import { ContractRiskReport, FindingEvidence } from '../risk/types';
import { ContractUnderstandingResult } from '../understanding/types';
import { extractAmounts, extractCurrencies, extractDates, extractDurations } from '../understanding/conflictDetector';
import { Resolver } from './evidence';
import { ExtractedItem, ReportStatus } from './types';

/** Everything the section builders need. All derived from data already produced in this request. */
export interface Ctx {
  a: Analysis;
  u: ContractUnderstandingResult;
  risk: ContractRiskReport;
  resolver: Resolver;
}

interface PartResult {
  key: string;
  status: ReportStatus;
  summary: string;
  evidence: FindingEvidence[];
  unverified: boolean;
  notes?: string;
}

/**
 * One understanding fact -> one report status.
 *   FOUND + verified quote            -> explicit
 *   FOUND without a verified quote    -> unclear (never presented as confirmed)
 *   AMBIGUOUS                         -> unclear
 *   CONFLICTING (with verified quote) -> conflicting
 *   NOT_FOUND                         -> not_found, but only when the WHOLE document was analyzed; otherwise unclear
 *   NOT_APPLICABLE                    -> not_applicable
 *   (fact absent from the result)     -> unclear: it was not analyzed, which is not the same as not found
 */
/**
 * Where an extracted fact cites only a heading (for example "RESTRICTIVE COVENANTS"), the report cites the clause
 * under it that contains this wording instead, because a heading alone does not show what the contract says.
 */
const FOCUS: Record<string, RegExp> = {
  non_compete: /compet/i,
  non_solicit: /solicit/i,
  wc_exclusivity: /exclusiv/i,
  conf_definition: /confiden/i,
  conf_duration: /confiden|perpetu|surviv/i,
  conf_carveouts: /confiden|public/i,
  ip_ownership: /assign|own|work made for hire|work product/i,
  ip_preexisting: /pre-?existing|background|prior/i,
  ip_license: /licen[sc]e/i,
  indemnity_contractor: /indemnif/i,
  indemnity_client: /indemnif/i,
  liability_cap: /liabilit/i,
  indirect_damages: /consequential|indirect|incidental|punitive/i,
  warranties: /warrant/i,
  scope: /shall (provide|perform|render|deliver)|agrees to (provide|perform)|services/i,
  governing_law: /govern|laws of/i,
  term_convenience: /terminat/i,
  term_cause: /terminat|breach/i,
  dispute_method: /arbitrat|mediat|litigation|\bcourts?\b/i,
  venue: /venue|\bcourts?\b|jurisdiction/i,
  renewal: /renew/i,
  payment_terms: /pay|invoice|net\s*\d/i,
};

/** A summary written in capitals is a heading, not a statement about the contract. */
const isHeading = (s: string): boolean => !!s.trim() && !/[a-z]/.test(s);

export function factPart(ctx: Ctx, key: string): PartResult | null {
  const f = ctx.a.facts[key];
  if (!f) return { key, status: 'unclear', summary: '', evidence: [], unverified: false, notes: 'This item was not analyzed in this result.' };
  const focus = FOCUS[key];
  const verified = focus ? ctx.a.evidenceFocused(focus, f) : ctx.a.evidenceOf(f);
  const summary = isHeading(f.summary) && verified[0] ? verified[0].exact_quote : f.summary;
  switch (f.status) {
    case 'NOT_APPLICABLE':
      return { key, status: 'not_applicable', summary, evidence: verified, unverified: false };
    case 'NOT_FOUND':
      return ctx.a.fullCoverage
        ? { key, status: 'not_found', summary: '', evidence: [], unverified: false }
        : { key, status: 'unclear', summary: '', evidence: [], unverified: false, notes: 'Not found in the part of the document that was analyzed; it may appear elsewhere.' };
    case 'FOUND':
      return verified.length > 0
        ? { key, status: 'explicit', summary, evidence: verified, unverified: false }
        : { key, status: 'unclear', summary, evidence: [], unverified: true, notes: 'The supporting quote could not be verified, so this is not presented as confirmed.' };
    case 'CONFLICTING':
      return verified.length > 0
        ? { key, status: 'conflicting', summary, evidence: verified, unverified: false, notes: f.notes }
        : { key, status: 'unclear', summary, evidence: [], unverified: true, notes: 'Conflicting statements were reported but could not be verified.' };
    case 'AMBIGUOUS':
    default:
      return { key, status: 'unclear', summary, evidence: verified, unverified: false, notes: f.notes };
  }
}

const PRESENT: ReportStatus[] = ['explicit', 'unclear', 'conflicting'];

/** Combines several facts that together describe one report field. */
export function makeItem(
  ctx: Ctx,
  spec: { id: string; title: string; category: string; keys: string[]; value?: (parts: PartResult[]) => string | null }
): ExtractedItem {
  const parts = spec.keys.map((k) => factPart(ctx, k)).filter((p): p is PartResult => p !== null);
  const present = parts.filter((p) => PRESENT.includes(p.status));
  const coverageNote = `Not found in the analyzed part of the document (${ctx.risk.analysis.coverage_percentage}% analyzed); it may appear elsewhere.`;

  let status: ReportStatus;
  if (present.some((p) => p.status === 'conflicting')) status = 'conflicting';
  else if (present.length === 0) {
    if (parts.some((p) => p.status === 'not_applicable')) status = 'not_applicable';
    else if (parts.every((p) => p.status === 'not_found')) status = 'not_found';
    else status = 'unclear';
  } else if (present.every((p) => p.status === 'explicit')) status = 'explicit';
  else status = 'unclear';

  const evidence = ctx.resolver.list(present.flatMap((p) => p.evidence), 4);
  const defaultValue = (): string | null => {
    const texts = [...present].sort((x, y) => (x.status === 'explicit' ? -1 : 1) - (y.status === 'explicit' ? -1 : 1)).map((p) => p.summary.trim()).filter(Boolean);
    const unique = [...new Set(texts)];
    return unique.length ? unique.join('; ').slice(0, 500) : null;
  };
  const value = status === 'not_found' || status === 'not_applicable' ? null : (spec.value ? spec.value(present) : defaultValue());

  const notes = [...new Set(parts.map((p) => p.notes).filter(Boolean))].join(' ');
  const explanation =
    status === 'explicit' ? 'Stated in the contract.'
    : status === 'conflicting' ? 'Clauses of the contract disagree on this. Both statements are quoted.'
    : status === 'not_found' ? 'The contract does not state this.'
    : status === 'not_applicable' ? 'Marked as not applicable to this agreement.'
    : [present.length ? 'The contract addresses this only vaguely, or the supporting text could not be fully verified.' : coverageNote, notes].filter(Boolean).join(' ');

  return {
    id: spec.id,
    title: spec.title,
    value,
    status,
    explanation,
    evidence,
    category: spec.category,
    ...(present.some((p) => p.unverified) ? { evidence_unverified: true } : {}),
  };
}

/** Values parsed FROM the verified wording (never invented). */
export function structuredFrom(texts: string[]): ExtractedItem['structured'] | undefined {
  const text = texts.join(' ');
  const durations = extractDurations(text);
  const days = max(toDays(durations));
  const months = max(toMonths(durations).filter((m) => durations.size > 0));
  const business = [...durations].filter((d) => d.endsWith('business days')).map((d) => parseFloat(d));
  const amounts = [...extractAmounts(text)];
  const currencies = [...extractCurrencies(text)];
  const dates = [...extractDates(text)].sort();
  const out: NonNullable<ExtractedItem['structured']> = {};
  if (days !== undefined) out.days = days;
  if (business.length) out.business_days = Math.max(...business);
  // Months only when stated in months or years (a count of days is not a number of months)
  const my = [...durations].flatMap((d) => {
    const [n, unit] = d.split(' ');
    return unit === 'months' ? [parseFloat(n)] : unit === 'years' ? [parseFloat(n) * 12] : [];
  });
  if (my.length) out.months = Math.max(...my);
  if (amounts.length) out.amounts = amounts;
  if (currencies.length) out.currencies = currencies;
  if (dates.length) out.date = dates[0];
  void months;
  return Object.keys(out).length ? out : undefined;
}

export const evidenceTexts = (item: ExtractedItem): string[] => item.evidence.map((e) => e.exact_quote).concat(item.value ? [item.value] : []);
