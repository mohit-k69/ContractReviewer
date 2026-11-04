import {
  ContractUnderstandingResult,
  EvidenceReference,
  EvidenceStatus,
  FactWithEvidence,
} from '../understanding/types';
import { extractDurations, extractPlaces } from '../understanding/conflictDetector';
import { ClauseIndex } from './clauseIndex';
import {
  CategoryIndicator,
  ChecklistItem,
  ConfidenceLevel,
  ContractRiskReport,
  FindingConfidence,
  FindingEvidence,
  FindingKind,
  IndicatorLevel,
  KeyTerm,
  RISK_CATEGORIES,
  RiskCategory,
  RiskFinding,
  RiskSeverity,
} from './types';

export const DISCLAIMER =
  'This automated review highlights terms to clarify before signing. It is not legal advice and does not determine whether any term is enforceable. Consider having a qualified lawyer review the contract, especially any High-priority items.';

export const OVERALL_RULE =
  'Review priority is the highest severity among all findings (High if any High finding, otherwise Medium if any Medium finding, otherwise Low). It is a rule-based summary, not a numerical score.';

const SEVERITY_RANK: Record<RiskSeverity, number> = { High: 3, Medium: 2, Low: 1 };
const KIND_RANK: Record<FindingKind, number> = {
  CONTRADICTORY_PROVISIONS: 4,
  RISK: 3,
  MISSING_PROVISION: 2,
  AMBIGUOUS_TERM: 1,
};

// ---------------------------------------------------------------------------
// Fact registry (every fact the report can talk about)
// ---------------------------------------------------------------------------

interface FactRef {
  key: string;
  label: string;
  category: RiskCategory;
  fact: FactWithEvidence | undefined;
}

function collectFacts(u: ContractUnderstandingResult): FactRef[] {
  const kp = u.key_provisions;
  const pc = u.payment_and_commercial;
  const sd = u.scope_and_deliverables;
  const dt = u.dates_and_term;
  return [
    { key: 'governing_law', label: 'Governing law', category: 'Dispute Resolution & Governing Law', fact: u.classification?.governing_jurisdiction },
    { key: 'fee_structure', label: 'Fee structure', category: 'Payment', fact: pc?.fee_structure },
    { key: 'rates', label: 'Rates and amounts', category: 'Payment', fact: pc?.rates_and_amounts },
    { key: 'invoicing', label: 'Invoicing schedule', category: 'Payment', fact: pc?.invoicing_schedule },
    { key: 'payment_terms', label: 'Payment terms', category: 'Payment', fact: pc?.payment_terms_days },
    { key: 'late_payment', label: 'Late payment terms', category: 'Payment', fact: pc?.late_payment_terms },
    { key: 'expenses', label: 'Reimbursable expenses', category: 'Payment', fact: pc?.reimbursable_expenses },
    { key: 'taxes', label: 'Taxes and withholding', category: 'Payment', fact: pc?.taxes_and_withholding },
    { key: 'scope', label: 'Scope of work', category: 'Scope of Work', fact: sd?.scope_description },
    { key: 'change_order', label: 'Change-order process', category: 'Scope of Work', fact: sd?.change_order_mechanism },
    { key: 'acceptance', label: 'Acceptance criteria', category: 'Scope of Work', fact: sd?.acceptance_criteria },
    { key: 'effective_date', label: 'Effective date', category: 'Termination', fact: dt?.effective_date },
    { key: 'execution_date', label: 'Execution date', category: 'Termination', fact: dt?.execution_date },
    { key: 'commencement_date', label: 'Commencement date', category: 'Termination', fact: dt?.commencement_date },
    { key: 'expiration_date', label: 'Expiration date', category: 'Termination', fact: dt?.expiration_date },
    { key: 'term_duration', label: 'Term / duration', category: 'Termination', fact: dt?.term_duration },
    { key: 'renewal', label: 'Renewal terms', category: 'Termination', fact: dt?.renewal_terms },
    { key: 'term_convenience', label: 'Termination for convenience', category: 'Termination', fact: kp?.termination?.termination_for_convenience },
    { key: 'term_cause', label: 'Termination for cause', category: 'Termination', fact: kp?.termination?.termination_for_cause },
    { key: 'post_term_payment', label: 'Payment after termination', category: 'Termination', fact: kp?.termination?.post_termination_payment },
    { key: 'ip_ownership', label: 'IP ownership', category: 'Intellectual Property', fact: kp?.intellectual_property?.ownership },
    { key: 'ip_preexisting', label: 'Pre-existing IP', category: 'Intellectual Property', fact: kp?.intellectual_property?.pre_existing_ip },
    { key: 'ip_license', label: 'IP license', category: 'Intellectual Property', fact: kp?.intellectual_property?.license_granted },
    { key: 'liability_cap', label: 'Liability cap', category: 'Liability & Indemnification', fact: kp?.limitation_of_liability?.liability_cap },
    { key: 'indirect_damages', label: 'Exclusion of indirect damages', category: 'Liability & Indemnification', fact: kp?.limitation_of_liability?.exclusion_of_indirect_damages },
    { key: 'indemnity_contractor', label: 'Contractor indemnification', category: 'Liability & Indemnification', fact: kp?.indemnification?.contractor_indemnification },
    { key: 'indemnity_client', label: 'Client indemnification', category: 'Liability & Indemnification', fact: kp?.indemnification?.client_indemnification },
    { key: 'warranties', label: 'Warranties and disclaimers', category: 'Liability & Indemnification', fact: kp?.warranties_and_disclaimers },
    { key: 'conf_definition', label: 'Confidential information definition', category: 'Confidentiality', fact: kp?.confidentiality?.definition },
    { key: 'conf_duration', label: 'Confidentiality duration', category: 'Confidentiality', fact: kp?.confidentiality?.duration },
    { key: 'conf_carveouts', label: 'Confidentiality exclusions', category: 'Confidentiality', fact: kp?.confidentiality?.carveouts },
    { key: 'non_compete', label: 'Non-compete', category: 'Non-Compete, Exclusivity & Non-Solicitation', fact: kp?.non_compete },
    { key: 'non_solicit', label: 'Non-solicitation', category: 'Non-Compete, Exclusivity & Non-Solicitation', fact: kp?.non_solicitation },
    { key: 'dispute_method', label: 'Dispute resolution method', category: 'Dispute Resolution & Governing Law', fact: kp?.dispute_resolution?.method },
    { key: 'venue', label: 'Venue and forum', category: 'Dispute Resolution & Governing Law', fact: kp?.dispute_resolution?.venue_and_forum },
    { key: 'legal_fees', label: 'Legal fees', category: 'Dispute Resolution & Governing Law', fact: kp?.dispute_resolution?.prevailing_party_legal_fees },
  ];
}


/**
 * Safety net for missing-provision claims. The extraction stage can miss a clause that uses unusual
 * wording, so before reporting "missing" the engine searches the real document text for wording that
 * may address the topic. If found, the finding is downgraded to an unconfirmed term that cites that clause.
 */
const CORROBORATION: Record<string, RegExp> = {
  'payment.no_fee': /\$\s?\d|\b(usd|eur|gbp)\s?\d|\d+\s?(dollars|per (hour|day|month|week)|\/\s?(hr|hour))|hourly rate|fixed (fee|price)|flat fee|rate of|compensation|retainer/i,
  'payment.no_rate': /\$\s?\d|rate of|per (hour|day|month)|\/\s?(hr|hour)|fixed (fee|price)/i,
  'payment.no_deadline': /\bnet\s*\d+|within\s+\w+(\s*\(\d+\))?\s+(business\s+)?days|days\s+(of|after|from)\s+(the\s+)?(receipt|invoice)|due\s+(on|upon)\s+receipt|payable\s+(within|upon)/i,
  'payment.no_late_fee': /late\s+(fee|charge|payment)|interest\s+(on|at)|overdue/i,
  'payment.no_expenses': /reimburs|out-of-pocket|expenses/i,
  'payment.no_invoicing': /\binvoic/i,
  'scope.no_scope': /\bservices\b|deliverable|statement of work|exhibit a\b/i,
  'scope.no_change_order': /change\s+(order|request)|modif(y|ication)[^.]{0,40}scope|\bamend/i,
  'scope.no_acceptance': /\baccept(ance|ed)?\b|\bapprov(e|al)\b|review period|\breject/i,
  'termination.no_convenience': /terminat[^.]{0,80}(notice|without cause|convenience|any time)|(notice|convenience)[^.]{0,80}terminat/i,
  'termination.no_final_payment': /(paid|payment|compensat)[^.]{0,80}(terminat|prior to|up to)|terminat[^.]{0,120}(paid|payment|compensat|fees)/i,
  'ip.no_ownership': /\bown(s|ed|ership)?\b|\bassign|work(s)? made for hire|work product|intellectual property|copyright/i,
  'ip.no_preexisting': /pre-?existing|prior (work|inventions|ip)|background (ip|materials)|retain(s)? (all )?(rights|ownership)/i,
  'liability.no_cap': /liabilit(y|ies)(?!\s+compan)[^.]{0,100}(limit|exceed|\bcap\b)|(limit(ed|ation)?|\bcap(ped)?\b)[^.]{0,60}liabilit(y|ies)(?!\s+compan)|aggregate liability/i,
  'liability.no_indirect_exclusion': /(consequential|indirect|incidental|special|punitive)\s+damages|lost profits/i,
  'liability.no_client_indemnity': /(company|client|customer)[^.]{0,40}(indemnify|hold harmless)/i,
  'confidentiality.no_clause': /confidential|non-?disclosure|proprietary information/i,
  'confidentiality.no_exclusions': /publicly (known|available)|public domain|independently developed|already (known|in (its|the) possession)|required by law/i,
  'dispute.no_governing_law': /governed by|governing law|laws of (the )?(state|commonwealth|republic)|jurisdiction/i,
  'dispute.no_process': /arbitrat|mediat|\bcourts?\b|venue|jurisdiction|litigation/i,
};

// ---------------------------------------------------------------------------
// Analysis context: verified evidence + text helpers
// ---------------------------------------------------------------------------

/** The sentence of `text` containing the match at [index, index+length) - always a verbatim substring. */
function sentenceAround(text: string, index: number, length: number): string {
  const start = Math.max(text.lastIndexOf('. ', index) + 1, 0);
  const endIdx = text.indexOf('. ', index + length);
  const end = endIdx === -1 ? text.length : endIdx + 1;
  return text.slice(start, end).trim();
}

class Analysis {
  readonly findings: RiskFinding[] = [];
  readonly facts: Record<string, FactWithEvidence | undefined> = {};
  readonly fallback: boolean;
  readonly fullCoverage: boolean;
  readonly sectionCount: number;
  readonly factRefs: FactRef[];

  constructor(readonly u: ContractUnderstandingResult, readonly clauses: ClauseIndex) {
    this.fallback = u.analysis_source === 'DETERMINISTIC_FALLBACK';
    this.sectionCount = u.total_sections_in_document ?? u.processed_sections?.length ?? 0;
    this.fullCoverage =
      u.processing_status === 'COMPLETE' && (u.coverage_percentage === undefined || u.coverage_percentage >= 100);
    this.factRefs = collectFacts(u);
    for (const f of this.factRefs) this.facts[f.key] = f.fact;
  }

  /** Verified references only: unverified quotes are never shown or used as evidence. */
  verifiedRefs(refs: EvidenceReference[] | undefined): EvidenceReference[] {
    return (refs || []).filter((r) => r && r.is_verified === true);
  }

  /**
   * Converts verified references into report evidence. If a reference only cites a heading (for example a
   * section title) and a `focus` pattern is given, the specific child clause that matches the focus is cited
   * instead, because a heading alone does not show what the contract actually says.
   */
  toEvidence(refs: EvidenceReference[] | undefined, focus?: RegExp): FindingEvidence[] {
    const seen = new Set<string>();
    const out: FindingEvidence[] = [];
    const push = (e: FindingEvidence) => {
      const key = `${e.element_id}::${e.source_block_id}::${e.exact_quote}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(e);
    };

    for (const r of this.verifiedRefs(refs)) {
      const clause = this.clauses.get(r.element_id);
      const base: FindingEvidence = {
        element_id: r.element_id,
        source_block_id: r.source_block_id,
        exact_quote: r.exact_quote,
        clause_label: clause?.label,
        clause_text: clause?.text,
      };

      const headingOnly =
        !!clause && clause.descendant_ids.length > 0 && clause.text.trim().length <= r.exact_quote.trim().length + 2;
      if (headingOnly && focus) {
        const children: FindingEvidence[] = [];
        for (const did of clause!.descendant_ids) {
          const d = this.clauses.get(did);
          if (!d) continue;
          for (const block of d.blocks) {
            if (!focus.test(block.text)) continue;
            const quote = block.text.trim().slice(0, 400);
            if (quote) {
              children.push({
                element_id: did,
                source_block_id: block.id,
                exact_quote: quote,
                clause_label: d.label,
                clause_text: d.text,
              });
            }
          }
        }
        if (children.length > 0) {
          children.slice(0, 2).forEach(push);
          continue; // the heading adds nothing once the real clause is cited
        }
      }
      // Point the highlighted quote at the wording that triggered the finding when the stored quote
      // (e.g. just "Net 75") does not contain it. Still a verbatim substring of the source block.
      if (focus && clause && !new RegExp(focus.source, focus.flags.replace('g', '')).test(r.exact_quote)) {
        const block = clause.blocks.find((b) => b.id === r.source_block_id);
        const m = block ? new RegExp(focus.source, focus.flags.replace('g', '')).exec(block.text) : null;
        if (block && m) {
          const sentence = sentenceAround(block.text, m.index, m[0].length);
          if (sentence && block.text.includes(sentence)) {
            push({ ...base, exact_quote: sentence });
            continue;
          }
        }
      }
      push(base);
    }
    return out;
  }

  evidenceOf(...facts: Array<FactWithEvidence | undefined>): FindingEvidence[] {
    return this.toEvidence(facts.flatMap((f) => f?.evidence || []));
  }

  /** Like evidenceOf, but resolves heading-only citations to the child clause matching `focus`. */
  evidenceFocused(focus: RegExp, ...facts: Array<FactWithEvidence | undefined>): FindingEvidence[] {
    return this.toEvidence(facts.flatMap((f) => f?.evidence || []), focus);
  }

  /** Does this fact say FOUND and is it backed by at least one verified quote? */
  isEstablished(f: FactWithEvidence | undefined): f is FactWithEvidence {
    return !!f && f.status === 'FOUND' && this.verifiedRefs(f.evidence).length > 0;
  }

  /** Searchable text: the model/extractor summary plus verified quotes (narrow) and full clause text (wide). */
  text(f: FactWithEvidence | undefined, wide = true): string {
    if (!f) return '';
    const parts = [f.summary || ''];
    for (const r of this.verifiedRefs(f.evidence)) {
      parts.push(r.exact_quote || '');
      if (wide) parts.push(this.clauses.get(r.element_id)?.full_text || '');
    }
    return parts.join(' ').toLowerCase();
  }

  /**
   * Searches the real document text (word-for-word) for wording matching `pattern`. Every returned quote is
   * a verbatim substring of one of the element's own source blocks, so it satisfies Phase 2C verification.
   */
  findInDocument(pattern: RegExp, limit = 2): FindingEvidence[] {
    const out: FindingEvidence[] = [];
    const seen = new Set<string>();
    for (const [elementId, info] of this.clauses) {
      for (const block of info.blocks) {
        const m = pattern.exec(block.text);
        if (!m) continue;
        // Quote the whole sentence containing the match (a verbatim substring of the block).
        const quote = sentenceAround(block.text, m.index, m[0].length);
        if (!quote || !block.text.includes(quote)) continue;
        const key = `${block.id}::${quote}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          element_id: elementId,
          source_block_id: block.id,
          exact_quote: quote,
          clause_label: info.label,
          clause_text: info.text,
        });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  /** Missing-provision findings may only be asserted when the WHOLE document was analyzed. */
  isMissing(f: FactWithEvidence | undefined): boolean {
    return this.fullCoverage && !!f && f.status === 'NOT_FOUND';
  }

  private confidence(
    kind: FindingKind,
    evidence: FindingEvidence[],
    opts: { patternBased?: boolean }
  ): FindingConfidence {
    const reasons: string[] = [];
    let level: ConfidenceLevel = 'High';
    const downgrade = (to: ConfidenceLevel) => {
      const order: ConfidenceLevel[] = ['Low', 'Medium', 'High'];
      if (order.indexOf(to) < order.indexOf(level)) level = to;
    };

    if (kind === 'MISSING_PROVISION') {
      reasons.push(
        `All ${this.sectionCount || 'analyzed'} sections were analyzed and no matching provision was found.`
      );
    } else if (evidence.length === 0) {
      downgrade('Low');
      reasons.push('No verified quote supports this finding.');
    } else {
      reasons.push(
        `${evidence.length} supporting quote${evidence.length === 1 ? '' : 's'} verified word-for-word against the contract text.`
      );
    }

    if (opts.patternBased) {
      downgrade('Medium');
      reasons.push('Flagged from the wording of the clause; the exact legal effect depends on the full text.');
    }
    if (this.fallback) {
      downgrade('Medium');
      reasons.push('Terms were extracted by the built-in rule engine because AI analysis was unavailable.');
    }
    if (kind === 'AMBIGUOUS_TERM' || kind === 'CONTRADICTORY_PROVISIONS') {
      reasons.push('Carried over from the contract-understanding stage, which could not settle on a single reading.');
    }
    return { level, reasons };
  }

  add(p: {
    rule_id: string;
    category: RiskCategory;
    kind: FindingKind;
    severity: RiskSeverity;
    title: string;
    explanation: string;
    why: string;
    suggestion: string;
    evidence?: FindingEvidence[];
    searched?: string; // for missing provisions
    patternBased?: boolean;
    uncertainty?: string;
  }): void {
    if (this.findings.some((f) => f.id === p.rule_id)) return;

    // Cross-check a "missing" claim against the real document text before asserting it.
    let corroboration: FindingEvidence[] = [];
    if (p.kind === 'MISSING_PROVISION' && CORROBORATION[p.rule_id]) {
      corroboration = this.findInDocument(CORROBORATION[p.rule_id]);
    }
    if (corroboration.length > 0) {
      if (p.severity === 'Low') return; // wording exists; a Low "missing" claim would only be noise
      const topic = p.searched || 'this term';
      this.addResolved({
        ...p,
        rule_id: `${p.rule_id}.unconfirmed`,
        kind: 'AMBIGUOUS_TERM',
        severity: 'Medium',
        title: `Possible clause on ${topic} found but not confirmed`,
        explanation: `The contract analysis did not identify ${topic}, but the document contains wording that may address it (see the cited clause). It could not be confirmed automatically.`,
        suggestion: `Read the cited clause and confirm it clearly covers ${topic}. If it does not, ask for it to be added or clarified.`,
        evidence: corroboration,
        patternBased: true,
        uncertainty: 'Matched by wording; the cited clause may not actually cover this topic.',
      });
      return;
    }
    this.addResolved(p);
  }

  private addResolved(p: {
    rule_id: string;
    category: RiskCategory;
    kind: FindingKind;
    severity: RiskSeverity;
    title: string;
    explanation: string;
    why: string;
    suggestion: string;
    evidence?: FindingEvidence[];
    searched?: string;
    patternBased?: boolean;
    uncertainty?: string;
  }): void {
    if (this.findings.some((f) => f.id === p.rule_id)) return;
    // Hard rule: a missing provision NEVER carries evidence.
    const evidence = p.kind === 'MISSING_PROVISION' ? [] : p.evidence || [];
    const uncertaintyParts: string[] = [];
    if (p.kind === 'MISSING_PROVISION') {
      uncertaintyParts.push(
        'The term may appear under unusual wording or in an exhibit or separate document that is not part of this text.'
      );
    }
    if (p.patternBased) {
      uncertaintyParts.push('This is flagged from phrase matching; read the full clause to confirm.');
    }
    if (this.fallback) {
      uncertaintyParts.push('AI-assisted extraction was unavailable, so a nuance may have been missed.');
    }
    if (p.uncertainty) uncertaintyParts.push(p.uncertainty);

    this.findings.push({
      id: p.rule_id,
      rule_id: p.rule_id,
      category: p.category,
      kind: p.kind,
      severity: p.severity,
      title: p.title,
      explanation: p.explanation,
      why_it_matters: p.why,
      evidence,
      evidence_note:
        p.kind === 'MISSING_PROVISION'
          ? `No clause was found for ${p.searched || 'this term'}, so no contract text is cited. This finding reflects an absence, not a quotation.`
          : evidence.length === 0
          ? 'No verified quote is available for this finding.'
          : undefined,
      suggestion: p.suggestion,
      confidence: this.confidence(p.kind, evidence, { patternBased: p.patternBased }),
      uncertainty: uncertaintyParts.length ? uncertaintyParts.join(' ') : undefined,
    });
  }
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function toDays(values: Set<string>): number[] {
  const out: number[] = [];
  for (const v of values) {
    const [n, unit] = v.split(' ');
    if (unit === 'days') out.push(parseFloat(n));
  }
  return out;
}

function toMonths(values: Set<string>): number[] {
  const out: number[] = [];
  for (const v of values) {
    const [n, ...rest] = v.split(' ');
    const unit = rest.join(' ');
    const num = parseFloat(n);
    if (unit === 'months') out.push(num);
    else if (unit === 'years') out.push(num * 12);
    else if (unit === 'days') out.push(num / 30);
  }
  return out;
}

const max = (xs: number[]): number | undefined => (xs.length ? Math.max(...xs) : undefined);
const min = (xs: number[]): number | undefined => (xs.length ? Math.min(...xs) : undefined);

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const CONDITIONAL_PAYMENT = new RegExp(
  "pay[- ]when[- ]paid|pay[- ]if[- ]paid|paid (by|from) (the |its |their )?(own )?(end[- ])?(client|customer)|conditioned (up)?on[^.]{0,60}(being |is |has been )?paid|upon (the )?(client\'?s |company\'?s )?(receipt of )?payment from|sole discretion|satisfaction of the (client|company)|client\'?s satisfaction|company\'?s satisfaction|subject to (the )?(client\'?s |company\'?s )?approval",
  'i'
);

function paymentRules(a: Analysis): void {
  const c: RiskCategory = 'Payment';
  const { fee_structure, rates, payment_terms, late_payment, expenses, invoicing } = a.facts;

  if (a.isMissing(fee_structure) && a.isMissing(rates)) {
    a.add({
      rule_id: 'payment.no_fee',
      category: c, kind: 'MISSING_PROVISION', severity: 'High',
      title: 'No fee or rate found',
      explanation: 'The contract does not state how much you will be paid or how fees are calculated.',
      why: 'Without an agreed price, you have little to rely on if the client later disputes what you are owed.',
      suggestion: 'Ask for the rate (hourly, fixed, or milestone amounts) and currency to be written into the contract before you start work.',
      searched: 'fees, rates or compensation',
    });
  } else if (a.isMissing(rates)) {
    a.add({
      rule_id: 'payment.no_rate',
      category: c, kind: 'MISSING_PROVISION', severity: 'Medium',
      title: 'No specific rate or amount found',
      explanation: 'A fee structure is mentioned, but no specific rate or amount was found.',
      why: 'An unspecified amount invites disagreement about what each invoice should be.',
      suggestion: 'Ask for the exact amount or rate to be stated, or for a schedule of fees to be attached.',
      searched: 'a specific rate or amount',
    });
  }

  if (a.isMissing(payment_terms)) {
    a.add({
      rule_id: 'payment.no_deadline',
      category: c, kind: 'MISSING_PROVISION', severity: 'Medium',
      title: 'No payment deadline found',
      explanation: 'The contract does not say how many days the client has to pay an invoice.',
      why: 'Without a deadline, late payment is hard to challenge and your cash flow becomes unpredictable.',
      suggestion: 'Ask for a clear deadline, for example “payment within 30 days of receiving an invoice”.',
      searched: 'a payment deadline',
    });
  }

  if (a.isEstablished(payment_terms)) {
    const wideText = a.text(payment_terms);
    const days = max(toDays(extractDurations(a.text(payment_terms, false)))) ?? max(toDays(extractDurations(wideText)));
    const conditional = CONDITIONAL_PAYMENT.test(wideText);

    if (conditional) {
      a.add({
        rule_id: 'payment.conditional',
        category: c, kind: 'RISK', severity: 'High',
        title: 'Payment depends on a condition the client controls',
        explanation: 'Payment appears to depend on the client’s approval, satisfaction, or on the client being paid by someone else.',
        why: 'You could do the work and still not be paid if the condition is not met, even though the delay is not your fault.',
        suggestion: 'Ask for payment to be due on a fixed date after invoicing, regardless of third-party payment, and for approval to be deemed given after a set number of days.',
        evidence: a.evidenceFocused(CONDITIONAL_PAYMENT, payment_terms), patternBased: true,
      });
    }
    if (days !== undefined && days > 60) {
      a.add({
        rule_id: 'payment.long_terms',
        category: c, kind: 'RISK', severity: 'High',
        title: `Very long payment period (${days} days)`,
        explanation: `The contract gives the client ${days} days to pay an invoice.`,
        why: 'Waiting more than two months to be paid strains cash flow and increases the chance of non-payment.',
        suggestion: 'Ask for payment within 30 days (or 15 days for smaller projects), or for milestone or upfront payments.',
        evidence: a.evidenceFocused(/\bnet[\s-]*\d+|\d+\s*(business\s+)?days?/i, payment_terms),
      });
    } else if (days !== undefined && days > 45) {
      a.add({
        rule_id: 'payment.long_terms',
        category: c, kind: 'RISK', severity: 'Medium',
        title: `Long payment period (${days} days)`,
        explanation: `The contract gives the client ${days} days to pay an invoice.`,
        why: 'A longer payment window delays your income compared with the common 15–30 day terms.',
        suggestion: 'Ask whether payment can be made within 30 days, or whether part can be paid upfront.',
        evidence: a.evidenceFocused(/\bnet[\s-]*\d+|\d+\s*(business\s+)?days?/i, payment_terms),
      });
    }
  }

  if (a.isMissing(late_payment)) {
    a.add({
      rule_id: 'payment.no_late_fee',
      category: c, kind: 'MISSING_PROVISION', severity: 'Low',
      title: 'No late-payment consequence found',
      explanation: 'The contract does not say what happens if the client pays late.',
      why: 'With no interest, late fee, or right to pause work, there is little incentive for the client to pay on time.',
      suggestion: 'Ask for a late fee or interest on overdue invoices, and the right to pause work while an invoice is overdue.',
      searched: 'late-payment interest or fees',
    });
  }
  if (a.isMissing(expenses)) {
    a.add({
      rule_id: 'payment.no_expenses',
      category: c, kind: 'MISSING_PROVISION', severity: 'Low',
      title: 'No expense reimbursement found',
      explanation: 'The contract does not say whether the client reimburses expenses such as software, travel, or materials.',
      why: 'Without it, you may bear costs that arise from the client’s project.',
      suggestion: 'Ask whether expenses are reimbursable and, if so, whether they need pre-approval.',
      searched: 'expense reimbursement',
    });
  }
  if (a.isMissing(invoicing)) {
    a.add({
      rule_id: 'payment.no_invoicing',
      category: c, kind: 'MISSING_PROVISION', severity: 'Low',
      title: 'No invoicing schedule found',
      explanation: 'The contract does not say when you should invoice (for example monthly or at milestones).',
      why: 'Unclear invoicing timing can delay the start of the payment period.',
      suggestion: 'Ask for an invoicing schedule, such as monthly in arrears or on milestone completion.',
      searched: 'an invoicing schedule',
    });
  }
}

function scopeRules(a: Analysis): void {
  const c: RiskCategory = 'Scope of Work';
  const { scope, change_order, acceptance } = a.facts;

  if (a.isMissing(scope)) {
    a.add({
      rule_id: 'scope.no_scope',
      category: c, kind: 'MISSING_PROVISION', severity: 'High',
      title: 'No description of the work found',
      explanation: 'The contract does not describe the services or deliverables you are expected to provide.',
      why: 'Without a defined scope, the client can keep adding work for the same fee and it is hard to show what you agreed to.',
      suggestion: 'Ask for a written description of the services and deliverables, or an attached statement of work.',
      searched: 'a description of services or deliverables',
    });
  }

  if (a.isEstablished(scope)) {
    const t = a.text(scope);
    if (
      /as (requested|directed|needed|required|assigned)|from time to time|other (duties|services|tasks)|additional (services|work)|any (other|additional)|reasonably (requested|required)|unlimited revisions|any number of revisions|until (the )?(client|company) is satisfied/.test(t)
    ) {
      a.add({
        rule_id: 'scope.open_ended',
        category: c, kind: 'RISK', severity: 'Medium',
        title: 'Open-ended scope of work',
        explanation: 'The description of the work uses open-ended wording (for example “as requested” or “additional services”).',
        why: 'Open-ended scope makes it easy for the client to expand the work without extra pay (scope creep).',
        suggestion: 'Ask to list the specific deliverables, limit revisions to a set number, and require extra work to be agreed in writing at an agreed rate.',
        evidence: a.evidenceFocused(/as (requested|directed|needed|required|assigned)|from time to time|additional|unlimited|any (other|additional)|until/i, scope), patternBased: true,
      });
    }
  }

  if (a.isMissing(change_order)) {
    a.add({
      rule_id: 'scope.no_change_order',
      category: c, kind: 'MISSING_PROVISION', severity: 'Medium',
      title: 'No process for changing the scope found',
      explanation: 'The contract does not explain how changes to the work or the price are agreed.',
      why: 'Without a change process, extra requests may be treated as included in the original price.',
      suggestion: 'Ask for a rule that scope or fee changes must be agreed in writing before the extra work starts.',
      searched: 'a change-order process',
    });
  }
  if (a.isMissing(acceptance)) {
    a.add({
      rule_id: 'scope.no_acceptance',
      category: c, kind: 'MISSING_PROVISION', severity: 'Medium',
      title: 'No acceptance criteria found',
      explanation: 'The contract does not say how or when the client accepts your work.',
      why: 'If acceptance is undefined, the client may delay approval indefinitely, which can hold up your payment.',
      suggestion: 'Ask for objective acceptance criteria and a deadline (for example 5–10 business days) after which work is treated as accepted.',
      searched: 'acceptance criteria or a review period',
    });
  }
  if (a.isEstablished(acceptance) && /sole discretion|satisf(action|ied)|to the (client|company)'?s (satisfaction|approval)/.test(a.text(acceptance))) {
    a.add({
      rule_id: 'scope.subjective_acceptance',
      category: c, kind: 'RISK', severity: 'Medium',
      title: 'Acceptance is at the client’s discretion',
      explanation: 'Your work is accepted only if it satisfies the client, without objective criteria.',
      why: 'A subjective test lets the client reject work and withhold payment without a clear reason.',
      suggestion: 'Ask for objective criteria and a deemed-acceptance period if the client does not respond.',
      evidence: a.evidenceFocused(/sole discretion|satisf/i, acceptance), patternBased: true,
    });
  }
}

function terminationRules(a: Analysis): { highRisk: boolean } {
  const c: RiskCategory = 'Termination';
  const { term_convenience, term_cause, post_term_payment } = a.facts;
  let highRisk = false;

  if (a.isMissing(term_convenience)) {
    a.add({
      rule_id: 'termination.no_convenience',
      category: c, kind: 'MISSING_PROVISION', severity: 'Medium',
      title: 'No right to end the contract without cause found',
      explanation: 'The contract does not say whether either side can end it without a reason, or how much notice is required.',
      why: 'Without clear exit terms, you may be unable to leave a bad engagement, or the client may end it abruptly.',
      suggestion: 'Ask for mutual termination on a reasonable written notice period (for example 14–30 days).',
      searched: 'termination without cause or a notice period',
    });
  }

  if (a.isEstablished(term_convenience)) {
    const t = a.text(term_convenience);
    const narrow = a.text(term_convenience, false);
    const noticeDays = min(toDays(extractDurations(narrow))) ?? min(toDays(extractDurations(t)));
    const mutual = /(either|both|each) part(y|ies)|contractor (may|can|shall have the right to) terminate|consultant (may|can) terminate/.test(t);
    const clientOnly = /\b(client|company|customer)\b[^.]{0,80}\b(may|can|has the right to|reserves the right to) terminate/.test(t) && !mutual;
    const immediate = /immediate(ly)?|without (prior )?(written )?notice|at any time/.test(t) && noticeDays === undefined;

    if (clientOnly) {
      highRisk = true;
      a.add({
        rule_id: 'termination.one_sided',
        category: c, kind: 'RISK', severity: immediate ? 'High' : 'Medium',
        title: immediate ? 'Client can end the contract immediately; you cannot' : 'Only the client can end the contract without cause',
        explanation: immediate
          ? 'The client may terminate at any time or without notice, and no equivalent right is given to you.'
          : 'The right to terminate without cause appears to belong to the client only.',
        why: 'You could lose the engagement and income with little warning, while being locked in yourself.',
        suggestion: 'Ask for the right to terminate to be mutual and for a minimum written notice period (for example 14–30 days).',
        evidence: a.evidenceFocused(/terminat/i, term_convenience), patternBased: true,
      });
    } else if (immediate) {
      highRisk = true;
      a.add({
        rule_id: 'termination.no_notice',
        category: c, kind: 'RISK', severity: 'Medium',
        title: 'Termination without notice',
        explanation: 'The contract allows termination at any time or immediately, with no notice period.',
        why: 'Immediate termination leaves no time to wind down work, arrange new income, or invoice for work in progress.',
        suggestion: 'Ask for a minimum notice period (for example 14–30 days) for termination without cause.',
        evidence: a.evidenceFocused(/terminat/i, term_convenience), patternBased: true,
      });
    } else if (noticeDays !== undefined && noticeDays < 7) {
      a.add({
        rule_id: 'termination.short_notice',
        category: c, kind: 'RISK', severity: 'Medium',
        title: `Very short termination notice (${noticeDays} day${noticeDays === 1 ? '' : 's'})`,
        explanation: `Termination without cause needs only ${noticeDays} day${noticeDays === 1 ? '' : 's'} notice.`,
        why: 'A very short notice period gives you little time to replace the income.',
        suggestion: 'Ask for at least 14–30 days’ notice.',
        evidence: a.evidenceFocused(/notice/i, term_convenience),
      });
    }
  }

  if (a.isEstablished(term_cause)) {
    const t = a.text(term_cause);
    if (/immediate(ly)?|without (prior )?(written )?notice/.test(t) && !/cure|remed(y|ied)|rectif/.test(t)) {
      a.add({
        rule_id: 'termination.no_cure',
        category: c, kind: 'RISK', severity: 'Medium',
        title: 'No chance to fix a problem before termination for cause',
        explanation: 'The contract allows termination for cause immediately, without a period to correct the problem.',
        why: 'A minor or disputed issue could end the contract and affect payment without you being able to fix it.',
        suggestion: 'Ask for written notice and a cure period (for example 10–30 days) before termination for breach.',
        evidence: a.evidenceFocused(/immediate|without (prior )?(written )?notice/i, term_cause), patternBased: true,
      });
    }
  }

  if (a.isMissing(post_term_payment)) {
    a.add({
      rule_id: 'termination.no_final_payment',
      category: c, kind: 'MISSING_PROVISION', severity: highRisk ? 'High' : 'Medium',
      title: 'No promise to pay for work done before termination',
      explanation: 'The contract does not say that you are paid for work completed up to the termination date.',
      why: 'If the contract ends early, you could be left unpaid for work already performed.',
      suggestion: 'Ask for payment of all fees for work performed and expenses incurred up to the termination date, including work in progress.',
      searched: 'payment for work done before termination',
    });
  }
  if (a.isEstablished(post_term_payment) && /forfeit|no (further )?(payment|compensation)|not be entitled to (any )?(payment|compensation)|shall not be (paid|compensated)/.test(a.text(post_term_payment))) {
    a.add({
      rule_id: 'termination.forfeit_payment',
      category: c, kind: 'RISK', severity: 'High',
      title: 'You may lose payment if the contract ends',
      explanation: 'The contract appears to say you receive no further payment or compensation after termination.',
      why: 'Work you have already done could go unpaid.',
      suggestion: 'Ask for payment of all work performed up to the termination date.',
      evidence: a.evidenceFocused(/forfeit|no (further )?(payment|compensation)|not be entitled|shall not be (paid|compensated)/i, post_term_payment), patternBased: true,
    });
  }
  return { highRisk };
}

function ipRules(a: Analysis): void {
  const c: RiskCategory = 'Intellectual Property';
  const { ip_ownership, ip_preexisting } = a.facts;

  if (a.isMissing(ip_ownership)) {
    a.add({
      rule_id: 'ip.no_ownership',
      category: c, kind: 'MISSING_PROVISION', severity: 'Medium',
      title: 'No statement of who owns the work',
      explanation: 'The contract does not say who owns the work product you create.',
      why: 'Ownership disputes are costly. By default, a freelancer often keeps rights unless they are assigned in writing, which may not match what either side expects.',
      suggestion: 'Ask for ownership to be stated clearly, ideally transferring on full payment.',
      searched: 'ownership of work product',
    });
  }

  const broad =
    a.isEstablished(ip_ownership) &&
    (/whether or not[^.]{0,60}(related|connected|made|created|conceived)|regardless of whether[^.]{0,60}(related|connected)|including (without limitation )?(any )?(pre-?existing|prior|background)|all (of )?(contractor'?s|your) (tools|inventions|intellectual property)/.test(a.text(ip_ownership)));

  if (broad) {
    a.add({
      rule_id: 'ip.broad_assignment',
      category: c, kind: 'RISK', severity: 'High',
      title: 'IP assignment may reach beyond this project',
      explanation: 'The ownership clause appears to cover work that may be unrelated to the project, or your own pre-existing or background materials.',
      why: 'You could unintentionally give away tools, code libraries, or earlier work you rely on for other clients.',
      suggestion: 'Ask to limit the assignment to deliverables created specifically for this project and to carve out your pre-existing materials and general know-how.',
      evidence: a.evidenceFocused(/whether or not|regardless of whether|pre-?existing|prior|background/i, ip_ownership), patternBased: true,
    });
  }

  if (a.isEstablished(ip_ownership)) {
    const t = a.text(ip_ownership);
    const onPayment = /(upon|after|subject to|conditioned on)[^.]{0,30}(full |final |complete )?payment/.test(t);
    const early = /hereby assign|upon creation|as (it is|they are) created|immediately|automatically/.test(t);
    if (early && !onPayment) {
      a.add({
        rule_id: 'ip.transfer_before_payment',
        category: c, kind: 'RISK', severity: 'Medium',
        title: 'Rights transfer before you are paid',
        explanation: 'Ownership appears to pass to the client as the work is created, not when you are paid.',
        why: 'If the client does not pay, they may still own and use your work.',
        suggestion: 'Ask for ownership to transfer only on full payment of the fees.',
        evidence: a.evidenceFocused(/hereby assign|upon creation|immediately|automatically|(it is|they are) created/i, ip_ownership), patternBased: true,
      });
    }
  }

  if (a.isMissing(ip_preexisting)) {
    a.add({
      rule_id: 'ip.no_preexisting',
      category: c, kind: 'MISSING_PROVISION', severity: broad ? 'High' : 'Medium',
      title: 'No protection for your pre-existing tools and materials',
      explanation: 'The contract does not say that you keep ownership of tools, code, or materials you owned before this project.',
      why: 'Without a carve-out, a broad ownership clause may be read to give the client your reusable tools and know-how.',
      suggestion: 'Ask for a clause confirming you keep your pre-existing materials and grant the client only a licence to use any that are embedded in the deliverables.',
      searched: 'ownership of pre-existing materials',
    });
  }
}

function liabilityRules(a: Analysis): void {
  const c: RiskCategory = 'Liability & Indemnification';
  const { liability_cap, indirect_damages, indemnity_contractor, indemnity_client, warranties } = a.facts;
  const contractorIndemnityFound = a.isEstablished(indemnity_contractor);

  if (a.isMissing(liability_cap)) {
    a.add({
      rule_id: 'liability.no_cap',
      category: c, kind: 'MISSING_PROVISION', severity: contractorIndemnityFound ? 'High' : 'Medium',
      title: 'No limit on your liability',
      explanation: 'The contract does not cap the amount you could owe if something goes wrong.',
      why: 'Without a cap, a single dispute could expose you to losses far larger than the fees you earn.',
      suggestion: 'Ask for your total liability to be capped at the fees paid under the contract (or a defined multiple).',
      searched: 'a limit on liability',
    });
  }
  if (a.isEstablished(liability_cap)) {
    const t = a.text(liability_cap);
    if (/unlimited|no (limit|cap)|not (be )?limited|uncapped/.test(t) && !/shall not exceed|capped at|limited to/.test(t)) {
      a.add({
        rule_id: 'liability.unlimited',
        category: c, kind: 'RISK', severity: 'High',
        title: 'Liability is unlimited',
        explanation: 'The contract states that liability is not limited.',
        why: 'You could be responsible for losses far beyond what you are paid.',
        suggestion: 'Ask for a cap equal to the fees paid under the contract.',
        evidence: a.evidenceFocused(/unlimited|no (limit|cap)|not (be )?limited|uncapped/i, liability_cap), patternBased: true,
      });
    } else if (/(two|three|four|five|2|3|4|5|ten|10)\s*(x|times|-fold)?\s*(\(\d+\)\s*)?(times )?(the )?(total )?(fees|amounts?|compensation)/.test(t)) {
      a.add({
        rule_id: 'liability.high_cap',
        category: c, kind: 'RISK', severity: 'Medium',
        title: 'Liability cap is a multiple of your fees',
        explanation: 'Your liability cap appears to be a multiple of the fees you earn.',
        why: 'A cap above your fees means you could lose more than the project is worth.',
        suggestion: 'Ask for the cap to equal the fees paid or payable under the contract.',
        evidence: a.evidenceFocused(/times|\dx|fees/i, liability_cap), patternBased: true,
      });
    }
  }

  if (a.isMissing(indirect_damages)) {
    a.add({
      rule_id: 'liability.no_indirect_exclusion',
      category: c, kind: 'MISSING_PROVISION', severity: 'Medium',
      title: 'No exclusion of indirect or consequential damages',
      explanation: 'The contract does not exclude indirect losses such as lost profits.',
      why: 'These losses can be very large and unpredictable compared with a freelance fee.',
      suggestion: 'Ask for a mutual exclusion of indirect, consequential, and punitive damages.',
      searched: 'an exclusion of indirect or consequential damages',
    });
  }

  if (contractorIndemnityFound) {
    const t = a.text(indemnity_contractor);
    const broadIndemnity = /any and all|all (claims|losses|liabilities|damages)|arising (out of|from|in connection with)[^.]{0,60}(services|agreement|work)|regardless of|including[^.]{0,20}(attorneys'?|legal) fees/.test(t) &&
      !/negligen|wilful|willful|gross|fraud|infring/.test(t);
    a.add({
      rule_id: 'liability.contractor_indemnity',
      category: c, kind: 'RISK', severity: broadIndemnity ? 'High' : 'Medium',
      title: broadIndemnity ? 'Broad indemnity: you cover the client’s losses' : 'You must indemnify the client',
      explanation: broadIndemnity
        ? 'You agree to cover the client’s losses and legal costs from a wide range of claims, not limited to your own fault.'
        : 'You agree to indemnify (reimburse) the client for certain claims.',
      why: 'An indemnity can make you pay for third-party claims and legal fees, potentially well beyond your fees.',
      suggestion: 'Ask to limit the indemnity to claims caused by your negligence, wilful misconduct or IP infringement, subject to the liability cap.',
      evidence: a.evidenceFocused(/indemnif|hold harmless/i, indemnity_contractor), patternBased: true,
    });
    if (a.isMissing(indemnity_client)) {
      a.add({
        rule_id: 'liability.no_client_indemnity',
        category: c, kind: 'MISSING_PROVISION', severity: 'Medium',
        title: 'Indemnity is one-way',
        explanation: 'You indemnify the client, but the contract does not give you a matching indemnity from the client.',
        why: 'If the client’s materials or instructions cause a third-party claim, you would carry the cost.',
        suggestion: 'Ask for a reciprocal indemnity covering claims caused by the client’s materials, instructions, or breach.',
        searched: 'an indemnity from the client',
      });
    }
  }

  if (a.isEstablished(warranties) && /guarantee|error[- ]free|uninterrupted|fit(ness)? for (a )?(particular )?purpose|free (from|of) (all )?(defects|errors|bugs)|meet(s)? all|perpetual(ly)?/.test(a.text(warranties))) {
    a.add({
      rule_id: 'liability.broad_warranty',
      category: c, kind: 'RISK', severity: 'Medium',
      title: 'Broad warranties or guarantees',
      explanation: 'The contract asks you to guarantee results such as error-free or fit-for-purpose work.',
      why: 'No complex work is entirely defect-free, so such guarantees can expose you to claims.',
      suggestion: 'Ask to limit warranties to performing services in a professional manner, with a defined fix-or-refund remedy.',
      evidence: a.evidenceFocused(/guarantee|error[- ]free|uninterrupted|fit|free (from|of)|meet|perpetual/i, warranties), patternBased: true,
    });
  }
}

function confidentialityRules(a: Analysis): void {
  const c: RiskCategory = 'Confidentiality';
  const { conf_definition, conf_duration, conf_carveouts } = a.facts;

  if (a.isMissing(conf_definition)) {
    a.add({
      rule_id: 'confidentiality.no_clause',
      category: c, kind: 'MISSING_PROVISION', severity: 'Low',
      title: 'No confidentiality clause found',
      explanation: 'The contract has no confidentiality terms.',
      why: 'Neither side is bound by contract to protect the other’s information, including your own proprietary methods.',
      suggestion: 'If you share non-public information, ask for a mutual confidentiality clause.',
      searched: 'confidentiality terms',
    });
  }

  if (a.isEstablished(conf_duration)) {
    const t = a.text(conf_duration);
    const months = max(toMonths(extractDurations(a.text(conf_duration, false))));
    const perpetual = /perpetual|indefinite|in perpetuity|forever|without (time )?limit/.test(t);
    if (perpetual || (months !== undefined && months >= 60)) {
      a.add({
        rule_id: 'confidentiality.perpetual',
        category: c, kind: 'RISK', severity: 'Medium',
        title: 'Confidentiality obligations last indefinitely',
        explanation: 'Your confidentiality duty has no end date, or lasts five years or more.',
        why: 'You remain restricted long after the engagement ends, which can limit later work.',
        suggestion: 'Ask for a fixed term (for example 2–3 years after the contract ends).',
        evidence: a.evidenceFocused(/perpetu|indefinite|forever|\byears?\b|\bmonths?\b/i, conf_duration), patternBased: true,
      });
    }
  }

  if (a.isEstablished(conf_definition) && a.isMissing(conf_carveouts)) {
    const broadDefinition = /all (non-public |confidential |proprietary )?information|any information|whether or not (marked|labeled|designated)/.test(a.text(conf_definition));
    a.add({
      rule_id: 'confidentiality.no_exclusions',
      category: c, kind: 'MISSING_PROVISION', severity: broadDefinition ? 'Medium' : 'Low',
      title: 'No standard exclusions from confidentiality',
      explanation: 'The contract does not exclude information that is public, already known to you, or independently developed.',
      why: 'Without exclusions you could breach the contract by using information that is publicly available or that you already knew.',
      suggestion: 'Ask for the usual exclusions: public information, information you already had, independently developed information, and legally required disclosures.',
      searched: 'standard confidentiality exclusions',
    });
  }
}

function restrictionRules(a: Analysis): void {
  const c: RiskCategory = 'Non-Compete, Exclusivity & Non-Solicitation';
  const { non_compete, non_solicit, scope } = a.facts;

  if (a.isEstablished(non_compete)) {
    const t = a.text(non_compete);
    const months = max(toMonths(extractDurations(a.text(non_compete, false)))) ?? max(toMonths(extractDurations(t)));
    const wideGeo = /worldwide|global|anywhere|nationwide|any (geographic|territory|location)|entire (world|country)/.test(t);
    const broadScope = /any (business|company|entity|person|client|customer)|competing|similar (business|services)|directly or indirectly/.test(t);
    const severe = (months !== undefined && months >= 12) || wideGeo;
    a.add({
      rule_id: 'restrictions.non_compete',
      category: c, kind: 'RISK', severity: severe ? 'High' : 'Medium',
      title: severe ? 'Broad non-compete restriction' : 'Non-compete restriction',
      explanation: `The contract restricts you from competing or working for others${months !== undefined ? ` for about ${Math.round(months * 10) / 10} month${months === 1 ? '' : 's'}` : ''}${wideGeo ? ' with a very wide geographic reach' : ''}${broadScope && !wideGeo ? ' and uses broad wording about competing activity' : ''}.`,
      why: 'As a freelancer your income depends on working for several clients, so a non-compete can directly limit your livelihood.',
      suggestion: 'Ask to remove the non-compete or narrow it to named competitors, the duration of the contract only, and a specific region. Rules on enforceability vary by location, so check local law.',
      evidence: a.evidenceFocused(/compet|covenant/i, non_compete), patternBased: true,
    });
  }

  // Exclusivity: look for "exclusive services" wording in the facts that describe commitment, never in IP clauses.
  const candidates = [non_compete, scope, ...(a.u.obligations?.contractor_obligations || [])];
  const exclusive = candidates.find(
    (f) =>
      a.isEstablished(f) &&
      /exclusive(ly)? (services|basis|engagement|provider)|(provide|perform|render) (any )?services (exclusively )?(only )?to (the )?(client|company)|shall not (provide|perform|render)[^.]{0,40}services (to|for) (any )?(other|third)|devote (his|her|your|its)? ?(full|entire|substantially all)/.test(a.text(f)),
  );
  if (exclusive) {
    a.add({
      rule_id: 'restrictions.exclusivity',
      category: c, kind: 'RISK', severity: 'High',
      title: 'Exclusivity: limits work for other clients',
      explanation: 'The contract appears to require you to work only for this client, or to devote most of your time to it.',
      why: 'Exclusivity removes your ability to take other clients, which is a core part of independent contracting, and may not be compatible with independent-contractor status.',
      suggestion: 'Ask to remove exclusivity, or pay a premium and limit it to a defined period and a defined competitor list.',
      evidence: a.evidenceFocused(/exclusive/i, exclusive), patternBased: true,
    });
  }

  if (a.isEstablished(non_solicit)) {
    const t = a.text(non_solicit);
    const months = max(toMonths(extractDurations(a.text(non_solicit, false)))) ?? max(toMonths(extractDurations(t)));
    const broad = (months !== undefined && months >= 12) || /any (client|customer)|directly or indirectly|all (clients|customers)/.test(t);
    a.add({
      rule_id: 'restrictions.non_solicit',
      category: c, kind: 'RISK', severity: broad ? 'Medium' : 'Low',
      title: 'Non-solicitation of clients or staff',
      explanation: `You agree not to solicit the client’s customers or staff${months !== undefined ? ` for about ${Math.round(months * 10) / 10} months` : ''}.`,
      why: 'Broad non-solicitation terms can stop you approaching people or companies you might legitimately work with.',
      suggestion: 'Ask to limit it to customers you dealt with through this contract and to a duration of 6–12 months.',
      evidence: a.evidenceFocused(/solicit/i, non_solicit), patternBased: true,
    });
  }
}

function disputeRules(a: Analysis): void {
  const c: RiskCategory = 'Dispute Resolution & Governing Law';
  const { governing_law, dispute_method, venue, legal_fees } = a.facts;

  if (a.isMissing(governing_law)) {
    a.add({
      rule_id: 'dispute.no_governing_law',
      category: c, kind: 'MISSING_PROVISION', severity: 'Medium',
      title: 'No governing law stated',
      explanation: 'The contract does not say which jurisdiction’s law applies.',
      why: 'Disagreements about which law applies add cost and uncertainty if a dispute arises.',
      suggestion: 'Ask for governing law to be specified, ideally the law of the place where you live or work.',
      searched: 'a governing law or jurisdiction',
    });
  }
  if (a.isMissing(venue) && a.isMissing(dispute_method)) {
    a.add({
      rule_id: 'dispute.no_process',
      category: c, kind: 'MISSING_PROVISION', severity: 'Low',
      title: 'No dispute resolution process found',
      explanation: 'The contract does not say where or how disputes are resolved (courts, arbitration, or mediation).',
      why: 'Without an agreed process, even a small disagreement may require a court case.',
      suggestion: 'Ask for a simple process: written notice, good-faith negotiation, then mediation or a defined forum.',
      searched: 'a dispute resolution method or venue',
    });
  }

  if (a.isEstablished(dispute_method) && /binding arbitration|arbitrat/.test(a.text(dispute_method))) {
    a.add({
      rule_id: 'dispute.arbitration',
      category: c, kind: 'RISK', severity: 'Low',
      title: 'Disputes go to arbitration',
      explanation: 'Disputes must be resolved through arbitration instead of the courts.',
      why: 'Arbitration can be faster, but it limits appeal rights, may be costly for you, and usually removes the option of a jury or class action.',
      suggestion: 'Ask who pays the arbitration costs and whether the location is reasonable for you.',
      evidence: a.evidenceFocused(/arbitrat/i, dispute_method), patternBased: true,
    });
  }

  // Venue far from the contractor (only when both locations are known states/countries)
  if (a.isEstablished(venue)) {
    const venuePlaces = extractPlaces(a.text(venue, false));
    const contractorLocation = (a.u.parties || [])
      .filter((p) => /contractor|consultant|service provider/i.test(p.role))
      .map((p) => `${p.address_or_location || ''}`)
      .join(' ');
    const homePlaces = extractPlaces(contractorLocation);
    if (venuePlaces.size > 0 && homePlaces.size > 0 && ![...venuePlaces].some((p) => homePlaces.has(p))) {
      a.add({
        rule_id: 'dispute.distant_venue',
        category: c, kind: 'RISK', severity: 'Medium',
        title: 'Disputes must be brought away from your location',
        explanation: `The contract sets the venue in ${[...venuePlaces].join(', ')}, which differs from your listed location (${[...homePlaces].join(', ')}).`,
        why: 'Travelling to another jurisdiction to enforce your rights makes small claims impractical.',
        suggestion: 'Ask for the venue to be where you live or work, or for remote hearings.',
        evidence: a.evidenceFocused(/venue|court|arbitrat|jurisdiction/i, venue), patternBased: true,
      });
    }
  }

  if (a.isEstablished(legal_fees) && /contractor shall (pay|reimburse|bear)[^.]{0,80}(attorney|legal|lawyer)/.test(a.text(legal_fees)) && !/prevailing party/.test(a.text(legal_fees))) {
    a.add({
      rule_id: 'dispute.one_way_fees',
      category: c, kind: 'RISK', severity: 'Medium',
      title: 'You pay the client’s legal fees',
      explanation: 'The contract requires you, not both sides, to pay legal fees in a dispute.',
      why: 'This discourages you from enforcing your rights because losing could be costly.',
      suggestion: 'Ask for fees to be awarded to the winning party, or for each side to bear its own costs.',
      evidence: a.evidenceFocused(/attorney|legal|lawyer/i, legal_fees), patternBased: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Ambiguous & contradictory provisions (carried over from Phase 2C)
// ---------------------------------------------------------------------------

const HIGH_STAKES = new Set<RiskCategory>([
  'Payment',
  'Scope of Work',
  'Termination',
  'Intellectual Property',
  'Liability & Indemnification',
  'Non-Compete, Exclusivity & Non-Solicitation',
  'Dispute Resolution & Governing Law',
]);

const WHY_BY_CATEGORY: Record<RiskCategory, string> = {
  Payment: 'Unclear payment terms make it hard to know what you will be paid and when.',
  'Scope of Work': 'Unclear scope makes it difficult to know what you are expected to deliver for the agreed fee.',
  Termination: 'Unclear exit terms affect how and when the engagement can end and what you are paid.',
  'Intellectual Property': 'Unclear ownership terms can lead to disputes over who may use the work.',
  'Liability & Indemnification': 'Unclear liability terms can leave you responsible for more than you expect.',
  Confidentiality: 'Unclear confidentiality terms make it hard to know what you may and may not disclose.',
  'Non-Compete, Exclusivity & Non-Solicitation': 'Unclear restrictions could limit the clients you may work with.',
  'Dispute Resolution & Governing Law': 'Unclear dispute terms add cost and uncertainty if a disagreement arises.',
};

export function categoryForText(text: string): RiskCategory {
  const t = text.toLowerCase();
  if (/payment|invoice|fee|rate|compensation|expense|tax/.test(t)) return 'Payment';
  if (/terminat|renew|term duration|notice/.test(t)) return 'Termination';
  if (/intellectual|\bip\b|ownership|licen[sc]e|work product|work made/.test(t)) return 'Intellectual Property';
  if (/liabilit|indemn|warrant|damages/.test(t)) return 'Liability & Indemnification';
  if (/confiden/.test(t)) return 'Confidentiality';
  if (/compet|solicit|exclusiv/.test(t)) return 'Non-Compete, Exclusivity & Non-Solicitation';
  if (/governing|jurisdiction|venue|forum|dispute|arbitrat|mediat|legal fee/.test(t)) return 'Dispute Resolution & Governing Law';
  return 'Scope of Work';
}

function evidenceKeys(ev: FindingEvidence[]): string[] {
  return ev.map((e) => `${e.element_id}::${e.exact_quote}`);
}

function ambiguityRules(a: Analysis): void {
  const reported = new Set<string>();

  const push = (p: {
    id: string; category: RiskCategory; contradictory: boolean; title: string; explanation: string;
    evidence: FindingEvidence[]; topic: string;
  }) => {
    const contradictory = p.contradictory;
    const high = HIGH_STAKES.has(p.category);
    a.add({
      rule_id: p.id,
      category: p.category,
      kind: contradictory ? 'CONTRADICTORY_PROVISIONS' : 'AMBIGUOUS_TERM',
      severity: contradictory ? (high ? 'High' : 'Medium') : high ? 'Medium' : 'Low',
      title: p.title,
      explanation: p.explanation,
      why: WHY_BY_CATEGORY[p.category],
      suggestion: contradictory
        ? 'Ask for the contract to be corrected so that only one version of this term applies, and do not sign until the conflict is resolved in writing.'
        : 'Ask the other party to clarify this term in writing, using specific numbers, dates, or conditions.',
      evidence: p.evidence,
      uncertainty: contradictory
        ? 'Whether the terms genuinely conflict can depend on facts or exhibits outside this text.'
        : undefined,
    });
    evidenceKeys(p.evidence).forEach((k) => reported.add(k));
  };

  // 1. Facts the understanding stage flagged directly
  for (const ref of a.factRefs) {
    const f = ref.fact;
    if (!f) continue;
    if (f.status === 'CONFLICTING') {
      push({
        id: `conflict.${ref.key}`, category: ref.category, contradictory: true, topic: ref.label,
        title: `Contradictory terms: ${ref.label}`,
        explanation: [f.summary, f.notes].filter(Boolean).join(' '),
        evidence: a.evidenceOf(f),
      });
    } else if (f.status === 'AMBIGUOUS') {
      const evidence = a.evidenceOf(f);
      // An AMBIGUOUS placeholder with no evidence only means "partial coverage"; not a real finding.
      if (evidence.length === 0 && /partial|not identified|incomplete/i.test(f.summary || '')) continue;
      push({
        id: `ambiguity.${ref.key}`, category: ref.category, contradictory: false, topic: ref.label,
        title: `Unclear term: ${ref.label}`,
        explanation: [f.summary, f.notes].filter(Boolean).join(' '),
        evidence,
      });
    }
  }

  // 2. Phase 2C ambiguity/conflict records not already represented above
  (a.u.ambiguities_and_conflicts || []).forEach((item, idx) => {
    const evidence = a.toEvidence(item.evidence);
    const keys = evidenceKeys(evidence);
    if (keys.length > 0 && keys.some((k) => reported.has(k))) return;
    const blob = `${item.topic} ${item.description}`;
    const contradictory = /conflict|contradict|inconsisten|incompatib/i.test(blob);
    push({
      id: `phase2c.${idx}`, category: categoryForText(item.topic || item.description), contradictory,
      topic: item.topic,
      title: `${contradictory ? 'Contradictory terms' : 'Unclear term'}: ${item.topic}`,
      explanation: item.description,
      evidence,
    });
  });
}

// ---------------------------------------------------------------------------
// Key terms, checklist, overview
// ---------------------------------------------------------------------------

function buildKeyTerms(a: Analysis): KeyTerm[] {
  const u = a.u;
  const term = (label: string, f: FactWithEvidence | undefined): KeyTerm | null => {
    if (!f) return null;
    const value =
      f.status === 'NOT_FOUND' ? 'Not found in the contract'
      : f.status === 'NOT_APPLICABLE' ? 'Not applicable'
      : f.summary || 'See supporting clause';
    return { label, value, status: f.status as EvidenceStatus, evidence: a.evidenceOf(f) };
  };
  const dates = u.dates_and_term;
  const kp = u.key_provisions;
  const terms: Array<KeyTerm | null> = [
    term('Effective date', dates?.effective_date),
    term('Term', dates?.term_duration),
    term('Renewal', dates?.renewal_terms),
    term('Fee structure', u.payment_and_commercial?.fee_structure),
    term('Rate / amount', u.payment_and_commercial?.rates_and_amounts),
    term('Invoicing', u.payment_and_commercial?.invoicing_schedule),
    term('Payment deadline', u.payment_and_commercial?.payment_terms_days),
    term('Scope of work', u.scope_and_deliverables?.scope_description),
    term('Termination without cause', kp?.termination?.termination_for_convenience),
    term('Termination for cause', kp?.termination?.termination_for_cause),
    term('IP ownership', kp?.intellectual_property?.ownership),
    term('Liability cap', kp?.limitation_of_liability?.liability_cap),
    term('Confidentiality duration', kp?.confidentiality?.duration),
    term('Non-compete', kp?.non_compete),
    term('Governing law', u.classification?.governing_jurisdiction),
    term('Dispute resolution', kp?.dispute_resolution?.method),
  ];
  return terms.filter((t): t is KeyTerm => t !== null);
}

function buildChecklist(a: Analysis, findings: RiskFinding[]): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  for (const f of findings) {
    if (f.severity === 'Low') continue;
    items.push({
      id: `check.${f.id}`,
      priority: f.severity,
      text: `${f.title}: ${f.suggestion}`,
      finding_id: f.id,
      category: f.category,
    });
  }
  const parties = a.u.parties || [];
  if (parties.length > 0) {
    items.push({
      id: 'check.parties',
      priority: 'Medium',
      text: `Confirm the legal names and roles are correct: ${parties.map((p) => `${p.name} (${p.role})`).join('; ')}.`,
    });
  }
  const entire = a.facts.entire_agreement ?? a.u.key_provisions?.entire_agreement;
  if (a.isEstablished(entire)) {
    items.push({
      id: 'check.entire_agreement',
      priority: 'Medium',
      text: 'The contract says it is the entire agreement. Make sure anything promised verbally or by email is written into the contract.',
    });
  }
  const hasHigh = findings.some((f) => f.severity === 'High');
  items.push({
    id: 'check.legal_review',
    priority: hasHigh ? 'High' : 'Low',
    text: hasHigh
      ? 'Have a qualified lawyer review this contract before you sign, focusing on the High-priority items above.'
      : 'Consider a quick review by a qualified lawyer if the contract is important to your income.',
  });
  return items.sort((x, y) => SEVERITY_RANK[y.priority] - SEVERITY_RANK[x.priority]);
}

function buildOverview(a: Analysis, findings: RiskFinding[]) {
  const counts_by_severity: Record<RiskSeverity, number> = { High: 0, Medium: 0, Low: 0 };
  const counts_by_kind: Record<FindingKind, number> = {
    RISK: 0, MISSING_PROVISION: 0, AMBIGUOUS_TERM: 0, CONTRADICTORY_PROVISIONS: 0,
  };
  for (const f of findings) {
    counts_by_severity[f.severity]++;
    counts_by_kind[f.kind]++;
  }
  const review_priority: RiskSeverity =
    counts_by_severity.High > 0 ? 'High' : counts_by_severity.Medium > 0 ? 'Medium' : 'Low';

  const rationale: string[] = [
    `${counts_by_severity.High} High, ${counts_by_severity.Medium} Medium and ${counts_by_severity.Low} Low priority finding${findings.length === 1 ? '' : 's'}.`,
  ];
  const drivers = findings.filter((f) => f.severity === 'High').slice(0, 3).map((f) => f.title);
  if (drivers.length) rationale.push(`Main drivers: ${drivers.join('; ')}.`);
  if (counts_by_kind.CONTRADICTORY_PROVISIONS > 0) {
    rationale.push(`${counts_by_kind.CONTRADICTORY_PROVISIONS} contradictory provision${counts_by_kind.CONTRADICTORY_PROVISIONS === 1 ? '' : 's'} must be resolved before signing.`);
  }
  if (counts_by_kind.MISSING_PROVISION > 0) {
    rationale.push(`${counts_by_kind.MISSING_PROVISION} commonly expected protection${counts_by_kind.MISSING_PROVISION === 1 ? ' is' : 's are'} missing.`);
  }
  if (findings.length === 0) rationale.push('No review rule was triggered by the terms found in this document.');
  if (!a.fullCoverage) {
    rationale.push('Only part of the document was analyzed, so this priority is a minimum and missing provisions could not be assessed.');
  }

  const category_indicators: CategoryIndicator[] = RISK_CATEGORIES.map((category) => {
    const inCat = findings.filter((f) => f.category === category);
    let level: IndicatorLevel;
    let summary: string;
    if (inCat.length > 0) {
      const top = inCat.reduce((m, f) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[m] ? f.severity : m), 'Low' as RiskSeverity);
      level = top;
      summary = `${inCat.length} finding${inCat.length === 1 ? '' : 's'}; highest severity ${top}.`;
    } else if (!a.fullCoverage) {
      level = 'Not assessed';
      summary = 'Only part of the document was analyzed.';
    } else {
      level = 'None';
      summary = 'No review rule was triggered for this area.';
    }
    return { category, level, summary, finding_ids: inCat.map((f) => f.id) };
  });

  return { review_priority, rule: OVERALL_RULE, rationale, counts_by_severity, counts_by_kind, category_indicators };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Turns a verified Phase 2C contract understanding into an evidence-backed review report.
 * Pure and deterministic: no network, no AI calls, no mutation of the input.
 */
export function analyzeContractRisk(
  understanding: ContractUnderstandingResult,
  clauses: ClauseIndex = new Map()
): ContractRiskReport {
  const a = new Analysis(understanding, clauses);

  paymentRules(a);
  scopeRules(a);
  terminationRules(a);
  ipRules(a);
  liabilityRules(a);
  confidentialityRules(a);
  restrictionRules(a);
  disputeRules(a);
  ambiguityRules(a);

  const findings = [...a.findings].sort(
    (x, y) =>
      SEVERITY_RANK[y.severity] - SEVERITY_RANK[x.severity] ||
      KIND_RANK[y.kind] - KIND_RANK[x.kind] ||
      RISK_CATEGORIES.indexOf(x.category) - RISK_CATEGORIES.indexOf(y.category) ||
      x.id.localeCompare(y.id)
  );

  const unverifiedFacts = Math.max(
    0,
    (understanding.stats?.total_facts ?? 0) - (understanding.stats?.verified_facts ?? 0)
  );
  const limitations: string[] = [
    'Findings come from rules about terms freelancers commonly negotiate; they are not specific to your location or circumstances.',
    'A finding can only be as complete as the text provided. Terms in exhibits, emails, or other documents are not considered.',
  ];
  if (understanding.classification?.category !== 'Freelance / Independent Contractor Agreement') {
    limitations.push(
      `These rules are designed for Freelance / Independent Contractor Agreements. This document was classified as “${understanding.classification?.category ?? 'unknown'}”, so some findings may not apply.`
    );
  }
  if (!a.fullCoverage) {
    limitations.push(
      `Only ${understanding.coverage_percentage ?? 0}% of the document was analyzed. Missing-provision checks were skipped because a provision may exist in the unanalyzed part.`
    );
  }
  if (a.fallback) {
    limitations.push('AI analysis was unavailable, so the built-in rule engine extracted the terms. It may miss unusual wording.');
  }
  if (unverifiedFacts > 0) {
    limitations.push(
      `${unverifiedFacts} extracted item${unverifiedFacts === 1 ? '' : 's'} could not be verified word-for-word and ${unverifiedFacts === 1 ? 'was' : 'were'} not used as evidence.`
    );
  }

  return {
    document_id: understanding.document_id,
    source_file_id: understanding.source_file_id,
    verified_sha256: understanding.verified_sha256,
    contract_type: understanding.classification?.category ?? 'Unknown',
    generated_at: new Date().toISOString(),
    parties: (understanding.parties || []).map((p) => ({ name: p.name, role: p.role, defined_term: p.defined_term })),
    overview: buildOverview(a, findings),
    findings,
    key_terms: buildKeyTerms(a),
    checklist: buildChecklist(a, findings),
    analysis: {
      analysis_source: understanding.analysis_source,
      model_used: understanding.model_used,
      processing_status: understanding.processing_status,
      coverage_percentage: understanding.coverage_percentage ?? 100,
      evidence_verification_percentage: understanding.stats?.verification_percentage ?? 0,
      missing_provisions_assessed: a.fullCoverage,
    },
    limitations,
    disclaimer: DISCLAIMER,
  };
}
