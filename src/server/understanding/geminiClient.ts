import { GoogleGenAI } from '@google/genai';
import { NormalizedDocument } from '../normalization/types';
import { DocumentExtractionResult } from '../extraction/types';
import { ContractUnderstandingResult } from './types';
import {
  serializeNormalizedDocument,
  UNDERSTANDING_SYSTEM_PROMPT,
  buildUnderstandingPrompt,
} from './promptBuilder';
import { validateUnderstandingResult } from './evidenceValidator';
import { analyzeContractDeterministically } from './deterministicAnalyzer';
import { validateGeminiUnderstandingResponse } from './responseValidator';
import { chunkNormalizedDocument, mergeChunkResults } from './longDocumentProcessor';

// Configurable model name with gemini-3.8-flash default
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

// Test override hook for deterministic testing
type GeminiGeneratorMock = (
  prompt: string,
  systemInstruction: string,
  model: string
) => Promise<string>;

let customGeneratorMock: GeminiGeneratorMock | null = null;

export function setGeminiGeneratorMock(mock: GeminiGeneratorMock | null): void {
  customGeneratorMock = mock;
}

/**
 * Initializes GoogleGenAI client with server-side API key and User-Agent telemetry.
 */
function createGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return null;
  }

  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function cleanJsonText(rawText: string): string {
  let cleaned = rawText.trim();
  // Strip Markdown code fencing if returned
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.replace(/^```json\s*/i, '').replace(/\s*```$/, '');
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
  }
  return cleaned.trim();
}

/**
 * Strips provider secrets, authorization headers, or sensitive query params
 */
function sanitizeErrorMessage(rawMsg: string): string {
  return rawMsg
    .replace(/key=[A-Za-z0-9_-]+/gi, 'key=REDACTED')
    .replace(/bearer\s+[A-Za-z0-9_.-]+/gi, 'Bearer REDACTED')
    .replace(/AIza[0-9A-Za-z-_]{35}/g, 'AIzaREDACTED');
}

/**
 * Core function to run Contract Understanding using Google Gemini.
 * - Handles long documents via chunking without breaking elements
 * - Strictly validates Gemini output schema before accepting
 * - Distinguishes GEMINI vs DETERMINISTIC_FALLBACK analysis sources
 * - Performs post-generation evidence verification against the source document.
 */
export async function understandContractWithGemini(
  normalized: NormalizedDocument,
  extraction: DocumentExtractionResult
): Promise<ContractUnderstandingResult> {
  const modelName = process.env.GEMINI_CONTRACT_MODEL || DEFAULT_GEMINI_MODEL;
  const sections = normalized.sections || [];
  const totalSections = sections.length;
  const allSectionIds = sections.map((s) => s.id);

  // 1. Chunk document if necessary
  const chunks = chunkNormalizedDocument(normalized);

  // 2. Check client availability
  const ai = createGeminiClient();
  if (!ai && !customGeneratorMock) {
    const fallback = analyzeContractDeterministically(normalized);
    fallback.analysis_source = 'DETERMINISTIC_FALLBACK';
    fallback.model_used = 'deterministic-fallback-v1';
    fallback.warnings.push(
      'Analysis completed using local deterministic engine (GEMINI_API_KEY not configured).'
    );
    return validateUnderstandingResult(fallback, normalized, extraction);
  }

  // 3. Process each chunk
  const chunkResults: ContractUnderstandingResult[] = [];
  let fallbackNeeded = false;
  let fallbackReason = '';

  for (const chunk of chunks) {
    const serializedDoc = serializeNormalizedDocument(chunk.docSubset, chunk.sharedContext);
    const userPrompt = buildUnderstandingPrompt(serializedDoc, {
      chunkIndex: chunk.chunkIndex,
      totalChunks: chunk.totalChunks,
      hasSharedContext: chunk.sharedContext.length > 0,
    });

    try {
      let rawText = '';
      if (customGeneratorMock) {
        rawText = await customGeneratorMock(
          userPrompt,
          UNDERSTANDING_SYSTEM_PROMPT,
          modelName
        );
      } else if (ai) {
        const response = await ai.models.generateContent({
          model: modelName,
          contents: userPrompt,
          config: {
            systemInstruction: UNDERSTANDING_SYSTEM_PROMPT,
            responseMimeType: 'application/json',
          },
        });
        rawText = response.text || '';
      }

      if (!rawText || !rawText.trim()) {
        throw new Error('Model returned an empty response.');
      }

      const parsedJson = JSON.parse(cleanJsonText(rawText));

      // Strict schema validation of response
      const validationReport = validateGeminiUnderstandingResponse(parsedJson);
      if (!validationReport.isValid) {
        throw new Error(
          `Model output failed schema validation: ${validationReport.errors.slice(0, 3).join('; ')}`
        );
      }

      const chunkResult: ContractUnderstandingResult = {
        document_id: normalized.document_id,
        source_file_id: normalized.source_file_id,
        verified_sha256: normalized.verified_sha256,
        classification: parsedJson.classification,
        parties: parsedJson.parties,
        dates_and_term: parsedJson.dates_and_term,
        scope_and_deliverables: parsedJson.scope_and_deliverables,
        payment_and_commercial: parsedJson.payment_and_commercial,
        obligations: parsedJson.obligations,
        key_provisions: parsedJson.key_provisions,
        ambiguities_and_conflicts: parsedJson.ambiguities_and_conflicts,
        omissions_and_missing_terms: parsedJson.omissions_and_missing_terms,
        stats: {
          total_facts: 0,
          verified_facts: 0,
          verification_percentage: 100,
          total_evidence_references: 0,
          verified_evidence_references: 0,
        },
        processing_status: 'COMPLETE',
        analysis_source: 'GEMINI',
        model_used: modelName,
        analyzed_at: new Date().toISOString(),
        processed_sections: chunk.sectionIds,
        total_sections_in_document: totalSections,
        coverage_percentage: totalSections === 0 ? 100 : Math.round((chunk.sectionIds.length / totalSections) * 100),
        warnings: [],
      };

      chunkResults.push(chunkResult);
    } catch (err: any) {
      fallbackNeeded = true;
      fallbackReason = sanitizeErrorMessage(err.message || 'Model execution error');
      break;
    }
  }

  // 4. If any chunk failed or model threw, fallback to deterministic engine
  if (fallbackNeeded || chunkResults.length === 0) {
    const fallback = analyzeContractDeterministically(normalized);
    fallback.analysis_source = 'DETERMINISTIC_FALLBACK';
    fallback.model_used = 'deterministic-fallback-v1';
    fallback.warnings.push(
      `Gemini model execution failed (${fallbackReason}). Analysis completed via deterministic fallback engine.`
    );
    return validateUnderstandingResult(fallback, normalized, extraction);
  }

  // 5. Merge all chunk results deterministically
  const merged = mergeChunkResults(chunkResults, totalSections, allSectionIds);

  // 6. Post-generation strict evidence verification against original extraction blocks
  return validateUnderstandingResult(merged, normalized, extraction);
}
