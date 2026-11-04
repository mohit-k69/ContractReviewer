import fs from 'node:fs';
import path from 'node:path';
import { extractTxtContent } from '../extraction/txtExtractor';
import { normalizeExtraction } from '../normalization/normalizationEngine';
import { analyzeContractDeterministically } from '../understanding/deterministicAnalyzer';
import { validateUnderstandingResult } from '../understanding/evidenceValidator';
import { ContractUnderstandingResult } from '../understanding/types';
import { DocumentExtractionResult } from '../extraction/types';
import { NormalizedDocument } from '../normalization/types';
import { buildClauseIndex } from './clauseIndex';
import { analyzeContractRisk } from './riskEngine';
import { ContractRiskReport, RiskFinding } from './types';

/** Test-only helpers: run real contract text through the real (deterministic) pipeline. No network, no Gemini. */

export interface Reviewed {
  text: string;
  extraction: DocumentExtractionResult;
  normalized: NormalizedDocument;
  understanding: ContractUnderstandingResult;
  report: ContractRiskReport;
}

export function runPipeline(text: string): Reviewed {
  const out = extractTxtContent(Buffer.from(text, 'utf8'), 'fixture');
  const extraction: any = {
    document_id: 'doc',
    source_file_id: 'fixture',
    source_format: 'txt',
    verified_sha256: 'sha',
    blocks: out.blocks,
    extraction_status: 'COMPLETED',
    warnings: [],
    total_pages: 1,
    total_blocks: out.blocks.length,
  };
  const normalized = normalizeExtraction(extraction);
  const understanding = validateUnderstandingResult(analyzeContractDeterministically(normalized), normalized, extraction);
  const report = analyzeContractRisk(understanding, buildClauseIndex(normalized, extraction));
  return { text, extraction, normalized, understanding, report };
}

const PREAMBLE =
  'This Independent Contractor Services Agreement ("Agreement") is made effective as of May 1, 2026, by and between Acme Studio Inc., a Delaware corporation ("Company"), and Riley Park, an individual ("Contractor").';

/** Wraps clause sentences into a minimal but realistic freelance agreement (one numbered clause per entry). */
export function contractFrom(clauses: string[]): string {
  const body = clauses.map((c, i) => `1.${i + 1} Clause ${i + 1}. ${c}`).join('\n\n');
  return `INDEPENDENT CONTRACTOR SERVICES AGREEMENT\n\n${PREAMBLE}\n\nGENERAL TERMS\n\n${body}\n`;
}

/** Runs the pipeline on a contract made of the given clauses. */
export function review(...clauses: string[]): Reviewed {
  return runPipeline(contractFrom(clauses));
}

export function fixtureText(name: 'controlHeavy' | 'contradictory' | 'compatible'): string {
  return fs.readFileSync(path.resolve(process.cwd(), 'src/server/risk/fixtures', `${name}.txt`), 'utf8');
}

export const ids = (findings: RiskFinding[]): string[] => findings.map((f) => f.id);
export const find = (r: Reviewed, id: string): RiskFinding | undefined => r.report.findings.find((f) => f.id === id);
export const hasPrefix = (r: Reviewed, prefix: string): boolean => r.report.findings.some((f) => f.id.startsWith(prefix));
export const contradictions = (r: Reviewed): RiskFinding[] =>
  r.report.findings.filter((f) => f.kind === 'CONTRADICTORY_PROVISIONS');

/** The report with volatile fields removed, for stability comparisons. */
export function stable(report: ContractRiskReport): unknown {
  const { generated_at, ...rest } = report;
  return rest;
}
