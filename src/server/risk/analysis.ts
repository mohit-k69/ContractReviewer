import {
  ContractUnderstandingResult,
  EvidenceReference,
  FactWithEvidence,
} from '../understanding/types';
import { extractDurations } from '../understanding/conflictDetector';
import { forEachIntelligenceFact, IntelligenceGroupKey } from '../understanding/intelligenceSchema';
import { ClauseIndex } from './clauseIndex';
import {
  ConfidenceLevel,
  FindingConfidence,
  FindingEvidence,
  FindingKind,
  RiskCategory,
  RiskFinding,
  RiskSeverity,
  FindingRelevance,
} from './types';
import { relevanceFor } from './relevance';

export const SEVERITY_RANK: Record<RiskSeverity, number> = { High: 3, Medium: 2, Low: 1 };
export const KIND_RANK: Record<FindingKind, number> = {
  CONTRADICTORY_PROVISIONS: 4,
  RISK: 3,
  MISSING_PROVISION: 2,
  AMBIGUOUS_TERM: 1,
};

// ---------------------------------------------------------------------------
// Fact registry (every fact the report can talk about)
// ---------------------------------------------------------------------------

export interface FactRef {
  key: string;
  label: string;
  category: RiskCategory;
  fact: FactWithEvidence | undefined;
}

const INTELLIGENCE_CATEGORY: Record<IntelligenceGroupKey, RiskCategory> = {
  worker_classification: 'Worker Classification',
  data_protection: 'Data Protection & Security',
  insurance: 'Insurance',
  subcontracting: 'Subcontracting & Delegation',
  tax_details: 'Tax',
  renewal_details: 'Renewal',
  warranty_details: 'Warranties',
  deal_terms: 'Payment',
  obligation_details: 'Scope of Work',
};

/** Per-field category overrides where a field belongs to a different area than its group. */
const FIELD_CATEGORY: Record<string, RiskCategory> = {
  'deal_terms.contractor_termination_right': 'Termination',
};

/** Short prefixes for the intelligence fact keys (e.g. wc_hours) */
export const INTEL_KEYS: Record<string, string> = {
  'worker_classification.prescribed_hours': 'wc_hours',
  'worker_classification.mandatory_location': 'wc_location',
  'worker_classification.direct_supervision': 'wc_supervision',
  'worker_classification.exclusivity': 'wc_exclusivity',
  'worker_classification.no_delegation': 'wc_no_delegation',
  'worker_classification.client_equipment': 'wc_equipment',
  'worker_classification.independent_business_restrictions': 'wc_business',
  'worker_classification.control_over_timing_and_manner': 'wc_control',
  'data_protection.handles_personal_data': 'dp_personal',
  'data_protection.permitted_purposes': 'dp_purposes',
  'data_protection.security_obligations': 'dp_security',
  'data_protection.breach_notification': 'dp_breach',
  'data_protection.return_or_deletion': 'dp_return',
  'data_protection.third_party_access': 'dp_third_party',
  'data_protection.cross_border_transfer': 'dp_cross_border',
  'data_protection.processing_agreement': 'dp_agreement',
  'insurance.professional_indemnity': 'ins_pi',
  'insurance.general_liability': 'ins_gl',
  'insurance.cyber': 'ins_cyber',
  'insurance.minimum_coverage': 'ins_min',
  'insurance.additional_insured': 'ins_additional',
  'insurance.evidence_of_insurance': 'ins_evidence',
  'insurance.post_termination_maintenance': 'ins_post',
  'subcontracting.prohibition': 'sub_prohibition',
  'subcontracting.approval_requirement': 'sub_approval',
  'subcontracting.permission': 'sub_permission',
  'subcontracting.delegation_restriction': 'sub_delegation',
  'subcontracting.responsibility_for_subcontractors': 'sub_responsibility',
  'subcontracting.liability_for_subcontractors': 'sub_liability',
  'subcontracting.flow_down_obligations': 'sub_flowdown',
  'tax_details.contractor_income_tax': 'tax_income',
  'tax_details.client_withholding': 'tax_withholding',
  'tax_details.indirect_taxes': 'tax_indirect',
  'tax_details.tax_indemnification': 'tax_indemnity',
  'tax_details.amounts_tax_basis': 'tax_basis',
  'renewal_details.auto_renewal': 'ren_auto',
  'renewal_details.renewal_duration': 'ren_duration',
  'renewal_details.non_renewal_notice': 'ren_notice',
  'renewal_details.unilateral_renewal': 'ren_unilateral',
  'renewal_details.renewal_pricing': 'ren_pricing',
  'warranty_details.performance_guarantee': 'war_performance',
  'warranty_details.outcome_guarantee': 'war_outcome',
  'warranty_details.warranty_duration': 'war_duration',
  'warranty_details.repair_replace': 'war_repair',
  'warranty_details.post_termination_warranty': 'war_post',
  'deal_terms.contract_title': 'deal_title',
  'deal_terms.currency': 'deal_currency',
  'deal_terms.milestones': 'deal_milestones',
  'deal_terms.invoice_requirements': 'deal_invoice',
  'deal_terms.payment_conditions': 'deal_pay_conditions',
  'deal_terms.contractor_termination_right': 'deal_contractor_term',
  'obligation_details.delivery_deadlines': 'obl_deadlines',
  'obligation_details.revisions': 'obl_revisions',
  'obligation_details.client_resources': 'obl_client_resources',
  'obligation_details.client_review_feedback': 'obl_client_review',
};

function collectIntelligenceFacts(u: ContractUnderstandingResult): FactRef[] {
  const out: FactRef[] = [];
  forEachIntelligenceFact(u, (fact, group, field, topic) => {
    const key = INTEL_KEYS[`${group}.${field}`] ?? `${group}.${field}`;
    out.push({ key, label: topic, category: FIELD_CATEGORY[`${group}.${field}`] ?? INTELLIGENCE_CATEGORY[group], fact });
  });
  return out;
}

export function collectFacts(u: ContractUnderstandingResult): FactRef[] {
  const kp = u.key_provisions;
  const pc = u.payment_and_commercial;
  const sd = u.scope_and_deliverables;
  const dt = u.dates_and_term;
  const core: FactRef[] = [
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
    { key: 'renewal', label: 'Renewal terms', category: 'Renewal', fact: dt?.renewal_terms },
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
    { key: 'warranties', label: 'Warranties and disclaimers', category: 'Warranties', fact: kp?.warranties_and_disclaimers },
    { key: 'conf_definition', label: 'Confidential information definition', category: 'Confidentiality', fact: kp?.confidentiality?.definition },
    { key: 'conf_duration', label: 'Confidentiality duration', category: 'Confidentiality', fact: kp?.confidentiality?.duration },
    { key: 'conf_carveouts', label: 'Confidentiality exclusions', category: 'Confidentiality', fact: kp?.confidentiality?.carveouts },
    { key: 'non_compete', label: 'Non-compete', category: 'Non-Compete, Exclusivity & Non-Solicitation', fact: kp?.non_compete },
    { key: 'non_solicit', label: 'Non-solicitation', category: 'Non-Compete, Exclusivity & Non-Solicitation', fact: kp?.non_solicitation },
    { key: 'dispute_method', label: 'Dispute resolution method', category: 'Dispute Resolution & Governing Law', fact: kp?.dispute_resolution?.method },
    { key: 'venue', label: 'Venue and forum', category: 'Dispute Resolution & Governing Law', fact: kp?.dispute_resolution?.venue_and_forum },
    { key: 'legal_fees', label: 'Legal fees', category: 'Dispute Resolution & Governing Law', fact: kp?.dispute_resolution?.prevailing_party_legal_fees },
  ];
  return [...core, ...collectIntelligenceFacts(u)];
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
  'scope.no_acceptance': /(accept(ance|ed)?|approv(e|al|ed)|reject(ed|ion)?)\s+(of\s+)?(the\s+|each\s+|any\s+)?(deliverables?|work|services|milestones?)|deliverables?[^.]{0,60}(accept|approv|reject)|(accept|approv|reject)[^.]{0,40}(deliverables?|work product)|review period|acceptance (criteria|test)/i,
  'termination.no_convenience': /terminat[^.]{0,80}(notice|without cause|convenience|any time)|(notice|convenience)[^.]{0,80}terminat/i,
  'termination.no_final_payment': /(paid|payment|compensat)[^.]{0,80}(terminat|prior to|up to)|terminat[^.]{0,120}(paid|payment|compensat|fees)/i,
  'ip.no_ownership': /\b(owns?|owned|ownership)\b[^.]{0,60}(deliverables?|work product|intellectual property|rights?|inventions?|works?)|(deliverables?|work product|intellectual property|inventions?)[^.]{0,80}(owned by|property of|belong|assign)|\bassigns?\b[^.]{0,80}(rights?|work product|deliverables?|intellectual property|title)|work(s)? made for hire|copyright/i,
  'ip.no_preexisting': /pre-?existing|prior (work|inventions|ip)|background (ip|materials)|retain(s)? (all )?(rights|ownership)/i,
  'liability.no_cap': /liabilit(y|ies)(?!\s+compan)[^.]{0,100}(limit|exceed|\bcap\b)|(limit(ed|ation)?|\bcap(ped)?\b)[^.]{0,60}liabilit(y|ies)(?!\s+compan)|aggregate liability/i,
  'liability.no_indirect_exclusion': /(consequential|indirect|incidental|special|punitive)\s+damages|lost profits/i,
  'liability.no_client_indemnity': /(company|client|customer)[^.]{0,40}(indemnify|hold harmless)/i,
  'confidentiality.no_clause': /confidential|non-?disclosure|proprietary information/i,
  'confidentiality.no_exclusions': /publicly (known|available)|public domain|independently developed|already (known|in (its|the) possession)|required by law/i,
  'dispute.no_governing_law': /governed by|governing law|laws of (the )?(state|commonwealth|republic)|jurisdiction/i,
  'data.no_breach_notification': /(data|security|privacy)\s+(breach|incident)|unauthori[sz]ed (access|disclosure)/i,
  'data.no_security_standard': /security (measures|controls|safeguards|requirements)|\bencrypt|safeguard/i,
  'data.no_return_deletion': /(return|destroy|delete|erase)[^.]{0,80}(data|information|materials|records)/i,
  'data.no_purpose_limit': /(solely|only|exclusively)\s+(for|to)[^.]{0,60}(purpose|services|perform)/i,
  'data.no_processing_agreement': /data processing|\b(controller|processor)\b|\bdpa\b|data protection (agreement|addendum)/i,
  'data.no_subcontractor_data_terms': /(subcontractors?|third part(y|ies))[^.]{0,80}(data|confidential)/i,
  'insurance.no_limits': /(insurance|coverage)[^.]{0,200}(\$|usd|eur|£|€)\s?\d/i,
  'subcontracting.no_responsibility': /(responsible|liable)[^.]{0,60}subcontractors?|subcontractors?[^.]{0,60}(responsible|liable)/i,
  'subcontracting.no_flowdown': /subcontractors?[^.]{0,120}(bound|confidential|obligations|no less)/i,
  'tax.no_allocation': /\btax(es)?\b|\bvat\b|\bgst\b/i,
  'tax.basis_unclear': /(inclusive|exclusive)[^.]{0,40}(tax|vat|gst)|(tax|vat|gst)[^.]{0,40}(included|excluded|additional)/i,
  'renewal.no_notice_period': /(non-?renew|not (to )?renew)[^.]{0,80}(notice|days)|notice[^.]{0,60}(non-?renew|not to renew)/i,
  'renewal.no_duration': /renew[^.]{0,100}(year|month|week)s?/i,
  'warranty.no_duration': /warrant\w*[^.]{0,100}(days?|months?|years?)|(days?|months?|years?)[^.]{0,60}warrant/i,
  'dispute.no_process': /arbitrat|mediat|\bcourts?\b|venue|jurisdiction|litigation/i,
};

// ---------------------------------------------------------------------------
// Analysis context: verified evidence + text helpers
// ---------------------------------------------------------------------------

/**
 * Separates a suggestion's example wording ("for example ...", "such as ...", "(commonly ...)") from the action.
 * The example is returned as an illustrative alternative: a suggestion that can be shown as such, never as a
 * benchmark or a stated term. The action itself stays grounded and free of example values.
 */
export function splitIllustration(suggestion: string): { action: string; illustration?: string } {
  const examples: string[] = [];
  let action = suggestion;
  // Parenthetical examples: "(for example 14–30 days)", "(such as ...)", "(commonly ...)", "(or 15 days for ...)"
  action = action.replace(/\s*\((?:for example|such as|e\.g\.|commonly|or )([^)]*)\)/gi, (_m, inner) => {
    examples.push(inner.trim());
    return '';
  });
  // Trailing examples after a comma: ", for example “...”" / ", such as 72 hours"
  action = action.replace(/,?\s+(?:for example|such as|e\.g\.)\s+([^.]*?)(?=\.|$)/gi, (_m, inner) => {
    examples.push(inner.trim());
    return '';
  });
  action = action.replace(/\s+([.,])/g, '$1').replace(/\s{2,}/g, ' ').trim();
  if (!/[.!?]$/.test(action)) action += '.';
  return examples.length ? { action, illustration: examples.join('; ') } : { action };
}

/** The sentence of `text` containing the match at [index, index+length) - always a verbatim substring. */
export function sentenceAround(text: string, index: number, length: number): string {
  const start = Math.max(text.lastIndexOf('. ', index) + 1, 0);
  const endIdx = text.indexOf('. ', index + length);
  const end = endIdx === -1 ? text.length : endIdx + 1;
  return text.slice(start, end).trim();
}

export class Analysis {
  readonly findings: RiskFinding[] = [];
  /** Informational observations: absent provisions that nothing in the contract makes relevant */
  readonly observations: RiskFinding[] = [];
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
  findInDocument(pattern: RegExp, limit = 2, filter?: (sentence: string) => boolean): FindingEvidence[] {
    const out: FindingEvidence[] = [];
    const seen = new Set<string>();
    const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    for (const [elementId, info] of this.clauses) {
      for (const block of info.blocks) {
        global.lastIndex = 0;
        let m: RegExpExecArray | null;
        // Examine EVERY match: the first one in a paragraph is often its heading ("8.1 Governing Law.")
        while ((m = global.exec(block.text)) !== null) {
          if (m[0].length === 0) { global.lastIndex++; continue; }
          // Quote the whole sentence containing the match (a verbatim substring of the block).
          const quote = sentenceAround(block.text, m.index, m[0].length);
          if (!quote || !block.text.includes(quote)) continue;
          if (filter && !filter(quote)) continue;
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
    }
    return out;
  }

  /** True when source-block text is available (extraction was supplied with the clause index). */
  hasDocumentText(): boolean {
    for (const info of this.clauses.values()) if (info.blocks.length > 0) return true;
    return false;
  }

  /**
   * Finds sentences matching `pattern`, in the real document text when available. When no source text is
   * supplied (e.g. extraction no longer cached) it falls back to the VERIFIED quotes of the extracted facts,
   * so cross-clause rules still work from what was verified, but never from anything unverified.
   */
  searchEvidence(pattern: RegExp, limit = 2, filter?: (sentence: string) => boolean): FindingEvidence[] {
    if (this.hasDocumentText()) return this.findInDocument(pattern, limit, filter);
    const out: FindingEvidence[] = [];
    const seen = new Set<string>();
    for (const ref of this.factRefs) {
      const f = ref.fact;
      if (!f || f.status === 'NOT_FOUND' || f.status === 'NOT_APPLICABLE') continue;
      for (const e of this.toEvidence(f.evidence)) {
        const probe = new RegExp(pattern.source, pattern.flags.replace('g', ''));
        if (!probe.test(e.exact_quote)) continue;
        if (filter && !filter(e.exact_quote)) continue;
        const key = `${e.element_id}::${e.exact_quote}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(e);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  /** Does the document (or, without source text, the verified facts) contain wording matching `pattern`? */
  searchHas(pattern: RegExp): boolean {
    if (this.hasDocumentText()) return this.documentHas(pattern);
    return this.searchEvidence(pattern, 1).length > 0;
  }

  /** Missing-provision findings may only be asserted when the WHOLE document was analyzed. */
  isMissing(f: FactWithEvidence | undefined): boolean {
    return this.fullCoverage && !!f && f.status === 'NOT_FOUND';
  }

  /** All unique source-block texts of the document (empty when no extraction blocks were supplied). */
  documentText(): string {
    const seen = new Set<string>();
    const parts: string[] = [];
    for (const info of this.clauses.values()) {
      for (const b of info.blocks) {
        if (!seen.has(b.id)) {
          seen.add(b.id);
          parts.push(b.text);
        }
      }
    }
    return parts.join('\n');
  }

  /** Does the real document contain wording matching `pattern`? (false when the document text is unavailable) */
  documentHas(pattern: RegExp): boolean {
    return pattern.test(this.documentText());
  }

  /** Is a fact present AND backed by verified evidence? Convenience for rule code. */
  has(key: string): boolean {
    return this.isEstablished(this.facts[key]);
  }

  /** The fact's status, or undefined when the field was not analyzed at all (never treated as NOT_FOUND). */
  status(key: string): string | undefined {
    return this.facts[key]?.status;
  }

  /**
   * Reports two provisions that genuinely disagree. Both sides must carry verified evidence from DIFFERENT
   * source text; otherwise nothing is reported (we never contradict a clause with itself or without proof).
   * Skips findings that merely restate an already-reported contradiction (same category, shared element).
   */
  addContradiction(p: {
    rule_id: string;
    category: RiskCategory;
    title: string;
    explanation: string;
    why?: string;
    suggestion?: string;
    sideA: FindingEvidence[];
    sideB: FindingEvidence[];
    severity?: RiskSeverity;
    patternBased?: boolean;
  }): void {
    if (p.sideA.length === 0 || p.sideB.length === 0) return;
    const key = (e: FindingEvidence) => `${e.element_id}::${e.source_block_id}::${e.exact_quote}`;
    const aKeys = new Set(p.sideA.map(key));
    const sideB = p.sideB.filter((e) => !aKeys.has(key(e)));
    if (sideB.length === 0) return; // identical text on both sides: not a contradiction

    const elements = new Set([...p.sideA, ...sideB].map((e) => e.element_id));
    const alreadyReported = this.findings.some(
      (f) =>
        f.kind === 'CONTRADICTORY_PROVISIONS' &&
        f.category === p.category &&
        f.evidence.filter((e) => elements.has(e.element_id)).length >= Math.min(2, elements.size)
    );
    if (alreadyReported) return;

    this.add({
      rule_id: p.rule_id,
      category: p.category,
      kind: 'CONTRADICTORY_PROVISIONS',
      severity: p.severity ?? (HIGH_STAKES.has(p.category) ? 'High' : 'Medium'),
      title: p.title,
      explanation: p.explanation,
      why: p.why ?? WHY_BY_CATEGORY[p.category],
      suggestion:
        p.suggestion ??
        'Ask for the contract to be corrected so that only one version of this term applies, and do not sign until the conflict is resolved in writing.',
      evidence: [...p.sideA, ...sideB],
      patternBased: p.patternBased ?? true,
      uncertainty: 'Whether the terms truly conflict can depend on facts or exhibits outside this text.',
    });
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
    if (this.findings.some((f) => f.id === p.rule_id) || this.observations.some((f) => f.id === p.rule_id)) return;
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

    // Relevance gate: an absent provision is only a material concern when the contract makes it relevant
    let relevance: FindingRelevance | undefined;
    if (p.kind === 'MISSING_PROVISION') {
      const r = relevanceFor(p.rule_id, this);
      relevance = { material: r.material, reason: r.reason, trigger_evidence: r.evidence };
    }
    const informational = relevance !== undefined && !relevance.material;
    const { action, illustration } = splitIllustration(p.suggestion);

    (informational ? this.observations : this.findings).push({
      id: p.rule_id,
      rule_id: p.rule_id,
      category: p.category,
      kind: p.kind,
      severity: informational ? 'Low' : p.severity,
      title: p.title,
      explanation: informational
        ? `${p.explanation} Noted for completeness only: ${relevance!.reason}`
        : p.explanation,
      why_it_matters: p.why,
      evidence,
      evidence_note:
        p.kind === 'MISSING_PROVISION'
          ? `No clause was found for ${p.searched || 'this term'}, so no contract text is cited. This finding reflects an absence, not a quotation.`
          : evidence.length === 0
          ? 'No verified quote is available for this finding.'
          : undefined,
      suggestion: action,
      ...(illustration ? { illustrative_alternative: illustration } : {}),
      ...(p.kind === 'MISSING_PROVISION' ? { topic: p.searched || 'this term' } : {}),
      ...(relevance ? { relevance } : {}),
      confidence: this.confidence(p.kind, evidence, { patternBased: p.patternBased }),
      uncertainty: uncertaintyParts.length ? uncertaintyParts.join(' ') : undefined,
    });
  }
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

export function toDays(values: Set<string>): number[] {
  const out: number[] = [];
  for (const v of values) {
    const [n, unit] = v.split(' ');
    if (unit === 'days') out.push(parseFloat(n));
  }
  return out;
}

export function toMonths(values: Set<string>): number[] {
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

/**
 * The longest period stated in `text`, in the contract's own words and unit (for example "five (5) years").
 * Used so a finding quotes the period as written instead of a converted figure.
 */
export function statedPeriod(text: string): string | undefined {
  const re = /\b(?:\d+(?:\.\d+)?|[a-z]+(?:[- ][a-z]+)?)\s*(?:\(\d+\)\s*)?(?:business\s+)?(?:days?|weeks?|months?|years?)\b/gi;
  let best: { text: string; months: number } | undefined;
  for (const m of text.matchAll(re)) {
    const months = max(toMonths(extractDurations(m[0])));
    if (months !== undefined && (!best || months > best.months)) best = { text: m[0].trim(), months };
  }
  return best?.text;
}

export const max = (xs: number[]): number | undefined => (xs.length ? Math.max(...xs) : undefined);
export const min = (xs: number[]): number | undefined => (xs.length ? Math.min(...xs) : undefined);


export const HIGH_STAKES = new Set<RiskCategory>([
  'Payment',
  'Scope of Work',
  'Termination',
  'Intellectual Property',
  'Liability & Indemnification',
  'Non-Compete, Exclusivity & Non-Solicitation',
  'Dispute Resolution & Governing Law',
  'Worker Classification',
  'Data Protection & Security',
  'Subcontracting & Delegation',
  'Renewal',
  'Warranties',
]);

export const WHY_BY_CATEGORY: Record<RiskCategory, string> = {
  Payment: 'Unclear payment terms make it hard to know what you will be paid and when.',
  'Scope of Work': 'Unclear scope makes it difficult to know what you are expected to deliver for the agreed fee.',
  Termination: 'Unclear exit terms affect how and when the engagement can end and what you are paid.',
  'Intellectual Property': 'Unclear ownership terms can lead to disputes over who may use the work.',
  'Liability & Indemnification': 'Unclear liability terms can leave you responsible for more than you expect.',
  Confidentiality: 'Unclear confidentiality terms make it hard to know what you may and may not disclose.',
  'Non-Compete, Exclusivity & Non-Solicitation': 'Unclear restrictions could limit the clients you may work with.',
  'Dispute Resolution & Governing Law': 'Unclear dispute terms add cost and uncertainty if a disagreement arises.',
  'Worker Classification': 'Unclear control terms make it hard to tell whether you are really working as an independent contractor.',
  'Data Protection & Security': 'Unclear data terms can leave you responsible for protecting data without knowing the standard you must meet.',
  Insurance: 'Unclear insurance terms can commit you to cover or limits you did not expect.',
  'Subcontracting & Delegation': 'Unclear delegation terms affect whether you may use help and what you answer for.',
  Tax: 'Unclear tax terms can leave you bearing taxes or costs you did not price in.',
  Renewal: 'Unclear renewal terms can lock you in or change what you are paid without a clear exit.',
  Warranties: 'Unclear warranty terms can leave you responsible for results or for long periods you did not price in.',
};
