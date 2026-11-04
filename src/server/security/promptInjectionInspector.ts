import { PromptInjectionInspectionResult } from './types';

// Patterns commonly used in prompt injection, jailbreaks, and instructions override attacks
const SUSPICIOUS_AI_DIRECTIVES = [
  { pattern: /ignore\s+(all\s+)?(previous|prior)\s+(instructions|directives|prompts)/i, label: 'Instruction-Override-Directive' },
  { pattern: /disregard\s+(the\s+)?(above|previous|system)\s+(instructions|rules|context)/i, label: 'Context-Disregard-Directive' },
  { pattern: /system\s+prompt\s+override/i, label: 'System-Prompt-Override' },
  { pattern: /you\s+are\s+now\s+(in\s+developer\s+mode|dan|an\s+unfiltered\s+ai)/i, label: 'Persona-Jailbreak-Attempt' },
  { pattern: /output\s+(the\s+)?(api[_\s]key|secret[_\s]key|system\s+instructions)/i, label: 'Secret-Extraction-Attempt' },
  { pattern: /reveal\s+(your\s+)?(initial\s+prompt|system\s+prompt)/i, label: 'Prompt-Leak-Attempt' },
  { pattern: /<!--\s*ai:ignore\s*-->/i, label: 'Hidden-Prompt-Comment' },
  { pattern: /\[\s*system\s*:\s*execute/i, label: 'Simulated-System-Tag' },
];

export function inspectPromptInjection(
  buffer: Buffer,
  format: 'pdf' | 'docx' | 'txt' | 'unknown'
): PromptInjectionInspectionResult {
  const details: string[] = [];
  const flaggedPatterns: string[] = [];

  let textContent = '';

  if (format === 'txt') {
    textContent = buffer.toString('utf8');
  } else if (format === 'pdf' || format === 'docx') {
    // Extract readable ascii strings from raw binary representation
    // to detect adversarial instructions placed in streams or XML
    textContent = buffer.toString('latin1');
  }

  for (const { pattern, label } of SUSPICIOUS_AI_DIRECTIVES) {
    if (pattern.test(textContent)) {
      flaggedPatterns.push(label);
      details.push(`Suspicious prompt injection directive detected: "${label}"`);
    }
  }

  const passed = flaggedPatterns.length === 0;
  let riskLevel: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' = 'NONE';

  if (flaggedPatterns.length >= 2) {
    riskLevel = 'HIGH';
  } else if (flaggedPatterns.length === 1) {
    riskLevel = 'MEDIUM';
  }

  if (passed) {
    details.push('No prompt-injection directives or instruction overrides detected.');
  }

  return {
    passed,
    flaggedPatterns,
    riskLevel,
    details,
  };
}
