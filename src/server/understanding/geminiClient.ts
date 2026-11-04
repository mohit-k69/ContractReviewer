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
 * Core function to run Contract Understanding using Google Gemini.
 * Falls back to deterministic rule-based analysis if GEMINI_API_KEY is not configured.
 * Performs rigorous post-generation evidence verification against the source document.
 */
export async function understandContractWithGemini(
  normalized: NormalizedDocument,
  extraction: DocumentExtractionResult
): Promise<ContractUnderstandingResult> {
  const modelName = process.env.GEMINI_CONTRACT_MODEL || DEFAULT_GEMINI_MODEL;
  const serializedDoc = serializeNormalizedDocument(normalized);
  const userPrompt = buildUnderstandingPrompt(serializedDoc);

  // 1. Check if mock generator is provided (for automated tests)
  if (customGeneratorMock) {
    try {
      const rawText = await customGeneratorMock(
        userPrompt,
        UNDERSTANDING_SYSTEM_PROMPT,
        modelName
      );
      const parsed = JSON.parse(cleanJsonText(rawText));
      const merged: ContractUnderstandingResult = {
        document_id: normalized.document_id,
        source_file_id: normalized.source_file_id,
        verified_sha256: normalized.verified_sha256,
        model_used: modelName,
        analyzed_at: new Date().toISOString(),
        processing_status: 'COMPLETE',
        warnings: [],
        ...parsed,
      };
      return validateUnderstandingResult(merged, normalized, extraction);
    } catch (err: any) {
      console.warn('[GeminiUnderstanding] Custom mock failed, falling back:', err.message);
    }
  }

  // 2. Check if live Gemini API key is configured
  const ai = createGeminiClient();
  if (!ai) {
    console.info(
      `[GeminiUnderstanding] GEMINI_API_KEY not configured in environment. Using deterministic contract understanding engine.`
    );
    const baseline = analyzeContractDeterministically(normalized);
    baseline.warnings.push(
      'Analysis completed using local deterministic engine (GEMINI_API_KEY not set in environment).'
    );
    return validateUnderstandingResult(baseline, normalized, extraction);
  }

  // 3. Invoke Google Gemini
  try {
    const response = await ai.models.generateContent({
      model: modelName,
      contents: userPrompt,
      config: {
        systemInstruction: UNDERSTANDING_SYSTEM_PROMPT,
        responseMimeType: 'application/json',
      },
    });

    const responseText = response.text;
    if (!responseText) {
      throw new Error('Gemini API returned an empty response.');
    }

    const parsedJson = JSON.parse(cleanJsonText(responseText));

    const result: ContractUnderstandingResult = {
      document_id: normalized.document_id,
      source_file_id: normalized.source_file_id,
      verified_sha256: normalized.verified_sha256,
      classification: parsedJson.classification || {
        category: 'General Commercial Agreement',
        confidence: 0.8,
        primary_purpose: 'Commercial Agreement',
        governing_jurisdiction: { status: 'NOT_FOUND', summary: '', evidence: [] },
      },
      parties: parsedJson.parties || [],
      dates_and_term: parsedJson.dates_and_term || ({} as any),
      scope_and_deliverables: parsedJson.scope_and_deliverables || ({} as any),
      payment_and_commercial: parsedJson.payment_and_commercial || ({} as any),
      obligations: parsedJson.obligations || { client_obligations: [], contractor_obligations: [] },
      key_provisions: parsedJson.key_provisions || ({} as any),
      ambiguities_and_conflicts: parsedJson.ambiguities_and_conflicts || [],
      omissions_and_missing_terms: parsedJson.omissions_and_missing_terms || [],
      stats: {
        total_facts: 0,
        verified_facts: 0,
        verification_percentage: 0,
        total_evidence_references: 0,
        verified_evidence_references: 0,
      },
      processing_status: 'COMPLETE',
      model_used: modelName,
      analyzed_at: new Date().toISOString(),
      warnings: [],
    };

    // 4. Validate all evidence references strictly
    return validateUnderstandingResult(result, normalized, extraction);
  } catch (err: any) {
    console.error(`[GeminiUnderstanding] Gemini call failed: ${err.message}. Falling back to deterministic engine.`);
    const fallback = analyzeContractDeterministically(normalized);
    fallback.warnings.push(
      `Gemini API invocation encountered an error (${err.message}). Analysis completed via backup deterministic engine.`
    );
    return validateUnderstandingResult(fallback, normalized, extraction);
  }
}
