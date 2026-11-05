import { DocumentExtractionResult } from '../extraction/types';
import { NormalizedDocument } from '../normalization/types';
import { Analysis } from '../risk/analysis';
import { buildClauseIndex } from '../risk/clauseIndex';
import { DISCLAIMER } from '../risk/riskEngine';
import { ContractRiskReport } from '../risk/types';
import { ContractUnderstandingResult } from '../understanding/types';
import { buildAttention } from './attention';
import { buildCommitments } from './commitments';
import { buildDeal } from './deal';
import { gateEvidence, makeVerifier, Resolver } from './evidence';
import { Ctx } from './items';
import { buildRightsAndNextSteps } from './rights';
import { buildScenarios } from './scenarios';
import { DecisionFinding, DecisionReport, ExtractedItem } from './types';

export * from './types';

export const EVIDENCE_POLICY: string[] = [
  'A statement about what the contract says is marked “explicit” or “conflicting” only when it carries at least one quote that was checked word-for-word against the uploaded document.',
  'If a quote cannot be verified, the statement is shown as “unclear” and flagged, never as a confirmed term.',
  'Something the contract does not mention is reported as “not found” and never carries a quote. It is only reported when the whole document was analyzed.',
  'Rights and remedies that may exist under law outside the contract are not assessed. They are labelled “outside the contract”.',
  'Dates are shown only when the contract states them or when they can be calculated from stated dates and periods; calculated dates are labelled.',
  'Page numbers are shown only for PDF documents. For Word and text documents the clause reference (for example “Section 5 › 5.1”) is shown instead.',
  'Example wording marked “illustrative” is a suggestion for discussion. It is not a benchmark, a legal requirement or a term of your contract.',
];

/** Which finding categories concern which report item category. An item is only linked to findings of its own subject. */
const SUBJECT: Record<string, string[]> = {
  money: ['Payment', 'Tax'],
  invoicing: ['Payment'],
  payment: ['Payment'],
  expenses: ['Payment'],
  timeline: ['Termination', 'Renewal'],
  termination: ['Termination'],
  renewal: ['Renewal'],
  legal: ['Dispute Resolution & Governing Law'],
  engagement: ['Scope of Work'],
  delivery: ['Scope of Work'],
  cooperation: ['Scope of Work'],
  acceptance: ['Scope of Work'],
  confidentiality: ['Confidentiality'],
  ip: ['Intellectual Property'],
  restrictions: ['Non-Compete, Exclusivity & Non-Solicitation'],
  control: ['Worker Classification'],
  liability: ['Liability & Indemnification'],
  warranties: ['Warranties'],
  insurance: ['Insurance'],
  data: ['Data Protection & Security'],
  subcontracting: ['Subcontracting & Delegation'],
  tax: ['Tax'],
};

/** Links items to the findings that concern them. Items that rest on clauses a contradiction cites become `conflicting`. */
function linkFindings(items: ExtractedItem[], findings: DecisionFinding[]): void {
  for (const item of items) {
    const elements = new Set(item.evidence.map((e) => e.element_id));
    if (elements.size === 0) continue;
    const subjects = SUBJECT[item.category] ?? [];
    const related = findings.filter((f) => subjects.includes(f.category) && f.evidence.some((e) => elements.has(e.element_id)));
    if (related.length === 0) continue;
    item.related_finding_ids = related.map((f) => f.id).slice(0, 6);
    const contradiction = related.find((f) => f.type === 'contradictory' && f.evidence.length >= 2);
    if (contradiction && item.status === 'explicit') {
      item.status = 'conflicting';
      item.explanation = `Clauses of the contract disagree on this (see “${contradiction.title}”). Both statements are quoted.`;
      const have = new Set(item.evidence.map((e) => `${e.element_id}::${e.exact_quote}`));
      for (const e of contradiction.evidence) {
        if (item.evidence.length >= 4) break;
        if (!have.has(`${e.element_id}::${e.exact_quote}`)) item.evidence.push(e);
      }
    }
  }
}

/**
 * Builds the Contract Decision Report from data produced earlier in the SAME request.
 * Pure and deterministic: no network, no AI call, no storage. Every quote in the result is re-verified with the
 * same validator the understanding stage uses before the report is returned.
 */
export function buildDecisionReport(
  understanding: ContractUnderstandingResult,
  risk: ContractRiskReport,
  normalized: NormalizedDocument,
  extraction: DocumentExtractionResult
): DecisionReport {
  const clauses = buildClauseIndex(normalized, extraction);
  const a = new Analysis(understanding, clauses);
  const resolver = new Resolver(normalized, extraction, clauses);
  const ctx: Ctx = { a, u: understanding, risk, resolver };

  const deal = buildDeal(ctx);
  const commitments = buildCommitments(ctx);
  const attention = buildAttention(ctx);
  linkFindings([...deal.items, ...commitments.freelancer.flatMap((g) => g.items), ...commitments.client.flatMap((g) => g.items)], attention.findings);
  const scenarios = buildScenarios(ctx, attention.findings);
  const rights_and_next_steps = buildRightsAndNextSteps(ctx, deal, attention);

  const report: DecisionReport = {
    schema_version: '1.0',
    document_id: risk.document_id,
    source_file_id: risk.source_file_id,
    verified_sha256: risk.verified_sha256,
    generated_at: new Date().toISOString(),
    coverage: {
      analysis_source: risk.analysis.analysis_source,
      processing_status: risk.analysis.processing_status,
      coverage_percentage: risk.analysis.coverage_percentage,
      evidence_verification_percentage: risk.analysis.evidence_verification_percentage,
      absences_assessed: risk.analysis.missing_provisions_assessed,
      source_format: normalized.source_format as 'pdf' | 'docx' | 'txt',
    },
    deal,
    commitments,
    attention,
    scenarios,
    rights_and_next_steps,
    limitations: [
      ...risk.limitations,
      'This report is built only from the text of the uploaded document. Terms in exhibits, emails or other documents are not considered.',
      'Rights that may exist under law outside this contract are not assessed.',
    ],
    disclaimer: DISCLAIMER,
    evidence_policy: EVIDENCE_POLICY,
    warnings: [],
  };

  const { warnings } = gateEvidence(report, makeVerifier(normalized, extraction));
  report.warnings = warnings;
  return report;
}
