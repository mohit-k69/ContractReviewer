import {
  BaseNormalizedElement,
  NormalizedClause,
  NormalizedDocument,
  NormalizedSection,
} from '../normalization/types';
import {
  ContractClassification,
  ContractDates,
  ContractParty,
  ContractUnderstandingResult,
  EvidenceReference,
  EvidenceStatus,
  FactWithEvidence,
  KeyContractualProvisions,
  OmissionOrMissingTerm,
  PartyObligations,
  PaymentAndCommercialTerms,
  ScopeAndDeliverables,
} from './types';

interface FlattenedElement {
  id: string;
  source_block_ids: string[];
  source_block_id: string;
  text: string;
  sectionTitle?: string;
}

function flattenDocumentElements(doc: NormalizedDocument): FlattenedElement[] {
  const elements: FlattenedElement[] = [];

  function collect(node: any, currentSectionTitle = '') {
    if (!node) return;
    const title = node.title || currentSectionTitle;
    const blockIds: string[] = Array.isArray(node.source_block_ids) ? node.source_block_ids : [];
    // If an element groups multiple block IDs (e.g. heading + preamble paragraph),
    // the substantive text is typically in the last block (the paragraph)
    const blockId = blockIds.length > 1 ? blockIds[blockIds.length - 1] : (blockIds[0] || '');

    if (node.text && node.text.trim()) {
      elements.push({
        id: node.id,
        source_block_ids: blockIds,
        source_block_id: blockId,
        text: node.text.trim(),
        sectionTitle: title,
      });
    }

    if (node.children && Array.isArray(node.children)) {
      for (const child of node.children) {
        collect(child, title);
      }
    }
    if (node.content && Array.isArray(node.content)) {
      for (const child of node.content) {
        collect(child, title);
      }
    }
    if (node.items && Array.isArray(node.items)) {
      for (const item of node.items) {
        collect(item, title);
      }
    }
  }

  if (doc.unclassified_blocks) {
    for (const b of doc.unclassified_blocks) {
      collect(b, 'Preamble');
    }
  }
  if (doc.sections) {
    for (const s of doc.sections) {
      collect(s, s.title);
    }
  }

  return elements;
}

function findMatchingElements(
  elements: FlattenedElement[],
  keywords: RegExp | string[]
): FlattenedElement[] {
  if (keywords instanceof RegExp) {
    return elements.filter(
      (e) => keywords.test(e.text) || (e.sectionTitle && keywords.test(e.sectionTitle))
    );
  }
  const lowerKeywords = keywords.map((k) => k.toLowerCase());
  return elements.filter((e) => {
    const textLower = e.text.toLowerCase();
    const titleLower = (e.sectionTitle || '').toLowerCase();
    return lowerKeywords.some((k) => textLower.includes(k) || titleLower.includes(k));
  });
}

function extractFirstQuote(
  element: FlattenedElement,
  pattern: RegExp,
  maxLength = 160
): { quote: string; ref: EvidenceReference } | null {
  const match = element.text.match(pattern);
  if (match && match[0]) {
    const matchedText = match[0].trim();
    return {
      quote: matchedText,
      ref: {
        element_id: element.id,
        source_block_id: element.source_block_id,
        exact_quote: matchedText,
      },
    };
  }

  // Fallback to substring of length
  const quote = element.text.slice(0, Math.min(element.text.length, maxLength)).trim();
  return {
    quote,
    ref: {
      element_id: element.id,
      source_block_id: element.source_block_id,
      exact_quote: quote,
    },
  };
}

function createNotFoundFact(summary: string): FactWithEvidence {
  return {
    status: 'NOT_FOUND',
    summary,
    evidence: [],
  };
}

/**
 * Deterministic contract analyzer used when Gemini API is unavailable,
 * or as a baseline fallback for offline testing.
 */
export function analyzeContractDeterministically(
  doc: NormalizedDocument
): ContractUnderstandingResult {
  const elements = flattenDocumentElements(doc);
  const docText = elements.map((e) => e.text).join('\n\n');
  const lowerDocText = docText.toLowerCase();

  // 1. Classification
  const isFreelanceOrConsulting =
    /(independent contractor|freelance|consulting agreement|professional services agreement|services agreement|consultant)/i.test(
      docText
    );
  const isNDA = /(non-disclosure agreement|confidentiality agreement|\bnda\b)/i.test(docText);
  const isEmployment = /(employment agreement|offer letter|employee)/i.test(docText) && !isFreelanceOrConsulting;

  let category: any = 'General Commercial Agreement';
  let categoryConfidence = 0.85;

  if (isFreelanceOrConsulting) {
    category = 'Freelance / Independent Contractor Agreement';
    categoryConfidence = 0.95;
  } else if (isNDA) {
    category = 'Non-Disclosure Agreement';
    categoryConfidence = 0.95;
  } else if (isEmployment) {
    category = 'Employment Agreement';
    categoryConfidence = 0.9;
  }

  // Governing jurisdiction
  const jurisdictionElements = findMatchingElements(elements, [
    'governing law',
    'governed by',
    'jurisdiction',
    'choice of law',
    'laws of',
  ]);
  let governingJurisdiction: FactWithEvidence = createNotFoundFact('No governing law clause found.');
  for (const el of jurisdictionElements) {
    const match =
      el.text.match(/(?:laws of (?:the (?:State|Commonwealth) of )?|State of )[A-Za-z\s]+?(?:,|\.|$|;)/i) ||
      el.text.match(/(?:State of [A-Za-z\s]+)/i);
    if (match) {
      const summary = match[0].trim();
      governingJurisdiction = {
        status: 'FOUND',
        summary,
        evidence: [
          {
            element_id: el.id,
            source_block_id: el.source_block_id,
            exact_quote: el.text.slice(0, Math.min(el.text.length, 140)).trim(),
          },
        ],
      };
      break;
    }
  }
  if (governingJurisdiction.status === 'NOT_FOUND' && jurisdictionElements.length > 0) {
    const el = jurisdictionElements.find((e) => e.text.length > 30) || jurisdictionElements[0];
    governingJurisdiction = {
      status: 'FOUND',
      summary: el.text.slice(0, Math.min(el.text.length, 120)).trim(),
      evidence: [
        {
          element_id: el.id,
          source_block_id: el.source_block_id,
          exact_quote: el.text.slice(0, Math.min(el.text.length, 120)).trim(),
        },
      ],
    };
  }

  // 2. Parties Identification
  const parties: ContractParty[] = [];
  const preambleElements = elements.filter(
    (e) =>
      e.sectionTitle === 'Preamble' ||
      /entered into by and between|this agreement is made|by and between|between\s/i.test(e.text)
  );

  const candidatePreamble = preambleElements.length > 0 ? preambleElements[0] : elements[0];
  if (candidatePreamble) {
    // Look for Client / Company
    const clientMatch = candidatePreamble.text.match(
      /(?:by and between|between\s+)([\w\s.,]+?)(?:,\s*(?:a|an)\s*([\w\s]+?))?\s*\((?:hereinafter\s*)?["“]?(Company|Client|Customer)["”]?\)/i
    );
    if (clientMatch) {
      parties.push({
        name: clientMatch[1].trim(),
        legal_entity_type: clientMatch[2] ? clientMatch[2].trim() : 'Entity',
        role: 'Client',
        defined_term: clientMatch[3] || 'Client',
        evidence: [
          {
            element_id: candidatePreamble.id,
            source_block_id: candidatePreamble.source_block_id,
            exact_quote: clientMatch[0].trim(),
          },
        ],
      });
    }

    // Look for Contractor / Consultant
    const contractorMatch = candidatePreamble.text.match(
      /(?:and\s+)([\w\s.,]+?)(?:,\s*(?:a|an)\s*([\w\s]+?))?\s*\((?:hereinafter\s*)?["“]?(Contractor|Consultant|Service Provider|Freelancer)["”]?\)/i
    );
    if (contractorMatch) {
      parties.push({
        name: contractorMatch[1].trim(),
        legal_entity_type: contractorMatch[2] ? contractorMatch[2].trim() : 'Individual / Entity',
        role: 'Contractor',
        defined_term: contractorMatch[3] || 'Contractor',
        evidence: [
          {
            element_id: candidatePreamble.id,
            source_block_id: candidatePreamble.source_block_id,
            exact_quote: contractorMatch[0].trim(),
          },
        ],
      });
    }
  }

  // Fallback if regex didn't extract both parties
  if (parties.length === 0 && candidatePreamble) {
    parties.push({
      name: 'Contracting Party A',
      legal_entity_type: 'Entity',
      role: 'Client',
      defined_term: 'Company',
      evidence: [
        {
          element_id: candidatePreamble.id,
          source_block_id: candidatePreamble.source_block_id,
          exact_quote: candidatePreamble.text.slice(0, Math.min(candidatePreamble.text.length, 100)),
        },
      ],
    });
    parties.push({
      name: 'Contracting Party B',
      legal_entity_type: 'Individual',
      role: 'Contractor',
      defined_term: 'Contractor',
      evidence: [
        {
          element_id: candidatePreamble.id,
          source_block_id: candidatePreamble.source_block_id,
          exact_quote: candidatePreamble.text.slice(0, Math.min(candidatePreamble.text.length, 100)),
        },
      ],
    });
  }

  // 3. Dates & Term
  const dateElements = findMatchingElements(elements, [
    'effective date',
    'term',
    'commence',
    'duration',
    'expiration',
    'terminate on',
  ]);

  let effectiveDate: FactWithEvidence = createNotFoundFact('Effective date not specified.');
  let termDuration: FactWithEvidence = createNotFoundFact('Term duration not specified.');
  let renewalTerms: FactWithEvidence = createNotFoundFact('No renewal provision found.');

  for (const el of dateElements) {
    const effMatch = el.text.match(
      /(?:effective (?:as of|date[:\s]+)?([A-Za-z]+\s+\d{1,2},\s*\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4}))/i
    );
    if (effMatch && effectiveDate.status === 'NOT_FOUND') {
      effectiveDate = {
        status: 'FOUND',
        summary: effMatch[0].trim(),
        evidence: [
          {
            element_id: el.id,
            source_block_id: el.source_block_id,
            exact_quote: effMatch[0].trim(),
          },
        ],
      };
    }

    const termMatch = el.text.match(
      /(?:term of (?:this agreement|one \(\d+\) year|\d+\s*(?:months|years))|until [A-Za-z]+\s+\d{1,2},\s*\d{4}|continue until terminated)/i
    );
    if (termMatch && termDuration.status === 'NOT_FOUND') {
      termDuration = {
        status: 'FOUND',
        summary: termMatch[0].trim(),
        evidence: [
          {
            element_id: el.id,
            source_block_id: el.source_block_id,
            exact_quote: termMatch[0].trim(),
          },
        ],
      };
    }

    if (/automatically renew|automatic renewal|successive|notice of non-renewal/i.test(el.text)) {
      renewalTerms = {
        status: 'FOUND',
        summary: el.text.slice(0, Math.min(el.text.length, 100)).trim(),
        evidence: [
          {
            element_id: el.id,
            source_block_id: el.source_block_id,
            exact_quote: el.text.slice(0, Math.min(el.text.length, 100)).trim(),
          },
        ],
      };
    }
  }

  // 4. Scope & Deliverables
  const scopeElements = findMatchingElements(elements, [
    'services',
    'scope of work',
    'deliverables',
    'statement of work',
    'duties',
  ]);
  let scopeDescription: FactWithEvidence = createNotFoundFact('No specific scope description found.');
  const deliverables: FactWithEvidence[] = [];
  let changeOrder: FactWithEvidence = createNotFoundFact('No change order mechanism specified.');
  let acceptanceCriteria: FactWithEvidence = createNotFoundFact('No formal acceptance procedure found.');

  if (scopeElements.length > 0) {
    const el = scopeElements[0];
    scopeDescription = {
      status: 'FOUND',
      summary: el.text.slice(0, Math.min(el.text.length, 120)).trim(),
      evidence: [
        {
          element_id: el.id,
          source_block_id: el.source_block_id,
          exact_quote: el.text.slice(0, Math.min(el.text.length, 120)).trim(),
        },
      ],
    };

    for (const se of scopeElements) {
      if (/deliverable|milestone|schedule|exhibit a/i.test(se.text)) {
        deliverables.push({
          status: 'FOUND',
          summary: se.text.slice(0, Math.min(se.text.length, 100)).trim(),
          evidence: [
            {
              element_id: se.id,
              source_block_id: se.source_block_id,
              exact_quote: se.text.slice(0, Math.min(se.text.length, 100)).trim(),
            },
          ],
        });
      }
      if (/change order|written amendment|modifications in writing/i.test(se.text)) {
        changeOrder = {
          status: 'FOUND',
          summary: se.text.slice(0, Math.min(se.text.length, 100)).trim(),
          evidence: [
            {
              element_id: se.id,
              source_block_id: se.source_block_id,
              exact_quote: se.text.slice(0, Math.min(se.text.length, 100)).trim(),
            },
          ],
        };
      }
      if (/acceptance|inspection period|days to review|approve or reject/i.test(se.text)) {
        acceptanceCriteria = {
          status: 'FOUND',
          summary: se.text.slice(0, Math.min(se.text.length, 100)).trim(),
          evidence: [
            {
              element_id: se.id,
              source_block_id: se.source_block_id,
              exact_quote: se.text.slice(0, Math.min(se.text.length, 100)).trim(),
            },
          ],
        };
      }
    }
  }

  // 5. Payment & Commercial Terms
  const paymentElements = findMatchingElements(elements, [
    'compensation',
    'payment',
    'fees',
    'invoicing',
    'rate',
    'expenses',
    'taxes',
  ]);

  let feeStructure: FactWithEvidence = createNotFoundFact('Fee structure not specified.');
  let ratesAndAmounts: FactWithEvidence = createNotFoundFact('Rates and amounts not found.');
  let invoicingSchedule: FactWithEvidence = createNotFoundFact('Invoicing schedule not specified.');
  let paymentTermsDays: FactWithEvidence = createNotFoundFact('Payment due period not specified.');
  let latePaymentTerms: FactWithEvidence = createNotFoundFact('No late payment penalty terms stated in agreement.');
  let reimbursableExpenses: FactWithEvidence = createNotFoundFact('No reimbursable expense policy specified.');
  let taxesAndWithholding: FactWithEvidence = createNotFoundFact('Tax responsibility not expressly specified.');

  for (const pe of paymentElements) {
    // Fee / Rate
    const rateMatch =
      pe.text.match(/\$\s*\d+[\d,.]*(?:\s*(?:per hour|\/hr|fixed fee|per month|flat fee))/i) ||
      pe.text.match(/(?:rate of\s+)?\$\s*\d+[\d,.]*(?:\s*(?:per hour|\/hr|fixed fee|per month|flat fee))?/i);
    if (rateMatch && ratesAndAmounts.status === 'NOT_FOUND') {
      ratesAndAmounts = {
        status: 'FOUND',
        summary: rateMatch[0].trim(),
        evidence: [
          {
            element_id: pe.id,
            source_block_id: pe.source_block_id,
            exact_quote: rateMatch[0].trim(),
          },
        ],
      };
      feeStructure = {
        status: 'FOUND',
        summary: /hour|\/hr/i.test(rateMatch[0]) ? 'Hourly Rate' : 'Fixed Fee',
        evidence: [
          {
            element_id: pe.id,
            source_block_id: pe.source_block_id,
            exact_quote: rateMatch[0].trim(),
          },
        ],
      };
    }

    // Payment terms days (Net 30, etc.)
    const netMatch = pe.text.match(/(?:net\s*\d+|within\s*\d+\s*(?:days|business days))/i);
    if (netMatch && paymentTermsDays.status === 'NOT_FOUND') {
      paymentTermsDays = {
        status: 'FOUND',
        summary: netMatch[0].trim(),
        evidence: [
          {
            element_id: pe.id,
            source_block_id: pe.source_block_id,
            exact_quote: netMatch[0].trim(),
          },
        ],
      };
    }

    // Invoicing
    if (/invoice|monthly|bi-weekly|upon completion/i.test(pe.text) && invoicingSchedule.status === 'NOT_FOUND') {
      const invMatch = pe.text.match(/(?:invoice (?:monthly|bi-weekly|upon completion|shall be submitted)|submit invoices)/i);
      const quote = invMatch ? invMatch[0] : pe.text.slice(0, Math.min(pe.text.length, 90));
      invoicingSchedule = {
        status: 'FOUND',
        summary: quote.trim(),
        evidence: [
          {
            element_id: pe.id,
            source_block_id: pe.source_block_id,
            exact_quote: quote.trim(),
          },
        ],
      };
    }

    // Late payment
    if (/late payment|interest|penalty|1\.5%|\bper month interest\b/i.test(pe.text) && latePaymentTerms.status === 'NOT_FOUND') {
      const lateMatch = pe.text.match(/(?:interest at (?:the rate of )?\d+(?:\.\d+)?%|late (?:charge|fee|penalty))/i);
      const quote = lateMatch ? lateMatch[0] : pe.text.slice(0, Math.min(pe.text.length, 90));
      latePaymentTerms = {
        status: 'FOUND',
        summary: quote.trim(),
        evidence: [
          {
            element_id: pe.id,
            source_block_id: pe.source_block_id,
            exact_quote: quote.trim(),
          },
        ],
      };
    }

    // Expenses
    if (/expense|reimburse|travel expenses|out-of-pocket/i.test(pe.text) && reimbursableExpenses.status === 'NOT_FOUND') {
      reimbursableExpenses = {
        status: 'FOUND',
        summary: pe.text.slice(0, Math.min(pe.text.length, 100)).trim(),
        evidence: [
          {
            element_id: pe.id,
            source_block_id: pe.source_block_id,
            exact_quote: pe.text.slice(0, Math.min(pe.text.length, 100)).trim(),
          },
        ],
      };
    }

    // Taxes
    if (/tax|withholding|1099|self-employment/i.test(pe.text) && taxesAndWithholding.status === 'NOT_FOUND') {
      taxesAndWithholding = {
        status: 'FOUND',
        summary: pe.text.slice(0, Math.min(pe.text.length, 100)).trim(),
        evidence: [
          {
            element_id: pe.id,
            source_block_id: pe.source_block_id,
            exact_quote: pe.text.slice(0, Math.min(pe.text.length, 100)).trim(),
          },
        ],
      };
    }
  }

  // 6. Obligations
  const clientObligations: FactWithEvidence[] = [];
  const contractorObligations: FactWithEvidence[] = [];

  for (const el of elements) {
    if (/(?:company shall|client shall|client will|company agrees to)\s+([^.;]+)/i.test(el.text)) {
      clientObligations.push({
        status: 'FOUND',
        summary: el.text.slice(0, Math.min(el.text.length, 110)).trim(),
        evidence: [
          {
            element_id: el.id,
            source_block_id: el.source_block_id,
            exact_quote: el.text.slice(0, Math.min(el.text.length, 110)).trim(),
          },
        ],
      });
    }
    if (/(?:contractor shall|consultant shall|contractor will|contractor agrees to)\s+([^.;]+)/i.test(el.text)) {
      contractorObligations.push({
        status: 'FOUND',
        summary: el.text.slice(0, Math.min(el.text.length, 110)).trim(),
        evidence: [
          {
            element_id: el.id,
            source_block_id: el.source_block_id,
            exact_quote: el.text.slice(0, Math.min(el.text.length, 110)).trim(),
          },
        ],
      });
    }
  }

  // 7. Key Provisions
  const ipElements = findMatchingElements(elements, ['intellectual property', 'work made for hire', 'ownership', 'proprietary rights', 'inventions']);
  let ipOwnership: FactWithEvidence = createNotFoundFact('IP ownership terms not specified.');
  let ipPreExisting: FactWithEvidence = createNotFoundFact('Pre-existing IP / background tools not specified.');
  let ipLicense: FactWithEvidence = createNotFoundFact('No explicit license reservation stated.');

  if (ipElements.length > 0) {
    for (const ipe of ipElements) {
      if (/work made for hire|exclusive property|assigns all right|client shall own/i.test(ipe.text) && ipOwnership.status === 'NOT_FOUND') {
        ipOwnership = {
          status: 'FOUND',
          summary: ipe.text.slice(0, Math.min(ipe.text.length, 120)).trim(),
          evidence: [
            {
              element_id: ipe.id,
              source_block_id: ipe.source_block_id,
              exact_quote: ipe.text.slice(0, Math.min(ipe.text.length, 120)).trim(),
            },
          ],
        };
      }
      if (/pre-existing|background|prior inventions|tools|know-how/i.test(ipe.text) && ipPreExisting.status === 'NOT_FOUND') {
        ipPreExisting = {
          status: 'FOUND',
          summary: ipe.text.slice(0, Math.min(ipe.text.length, 120)).trim(),
          evidence: [
            {
              element_id: ipe.id,
              source_block_id: ipe.source_block_id,
              exact_quote: ipe.text.slice(0, Math.min(ipe.text.length, 120)).trim(),
            },
          ],
        };
      }
    }
  }

  // Confidentiality
  const confElements = findMatchingElements(elements, ['confidential', 'non-disclosure', 'proprietary information']);
  let confDef: FactWithEvidence = createNotFoundFact('Confidentiality definition not found.');
  let confDuration: FactWithEvidence = createNotFoundFact('Confidentiality survival period not specified.');
  let confCarveouts: FactWithEvidence = createNotFoundFact('Confidentiality exceptions not found.');

  if (confElements.length > 0) {
    const ce = confElements[0];
    confDef = {
      status: 'FOUND',
      summary: ce.text.slice(0, Math.min(ce.text.length, 120)).trim(),
      evidence: [
        {
          element_id: ce.id,
          source_block_id: ce.source_block_id,
          exact_quote: ce.text.slice(0, Math.min(ce.text.length, 120)).trim(),
        },
      ],
    };
    for (const c of confElements) {
      if (/survive|years post-termination|\d+\s*years|indefinite/i.test(c.text) && confDuration.status === 'NOT_FOUND') {
        const durMatch = c.text.match(/(?:survive(?:s)? for [^.;]+|survive(?:s)? [^.;]+|\d+\s*years post-termination|\d+\s*years)/i);
        const quote = durMatch ? durMatch[0].trim() : c.text.slice(0, Math.min(c.text.length, 110)).trim();
        confDuration = {
          status: 'FOUND',
          summary: quote,
          evidence: [
            {
              element_id: c.id,
              source_block_id: c.source_block_id,
              exact_quote: quote,
            },
          ],
        };
      }
      if (/publicly known|independent development|compelled by law/i.test(c.text) && confCarveouts.status === 'NOT_FOUND') {
        confCarveouts = {
          status: 'FOUND',
          summary: c.text.slice(0, Math.min(c.text.length, 110)).trim(),
          evidence: [
            {
              element_id: c.id,
              source_block_id: c.source_block_id,
              exact_quote: c.text.slice(0, Math.min(c.text.length, 110)).trim(),
            },
          ],
        };
      }
    }
  }

  // Non-Compete / Non-Solicit
  const nonCompeteElements = findMatchingElements(elements, ['non-compete', 'covenant not to compete', 'competitive activities', 'restrictive covenant']);
  let nonCompete: FactWithEvidence = createNotFoundFact('No non-compete restriction found in agreement.');
  if (nonCompeteElements.length > 0) {
    const nce = nonCompeteElements[0];
    nonCompete = {
      status: 'FOUND',
      summary: nce.text.slice(0, Math.min(nce.text.length, 120)).trim(),
      evidence: [
        {
          element_id: nce.id,
          source_block_id: nce.source_block_id,
          exact_quote: nce.text.slice(0, Math.min(nce.text.length, 120)).trim(),
        },
      ],
    };
  }

  const nonSolicitElements = findMatchingElements(elements, ['non-solicitation', 'solicit employees', 'solicit customers']);
  let nonSolicit: FactWithEvidence = createNotFoundFact('No non-solicitation clause found.');
  if (nonSolicitElements.length > 0) {
    const nse = nonSolicitElements[0];
    nonSolicit = {
      status: 'FOUND',
      summary: nse.text.slice(0, Math.min(nse.text.length, 120)).trim(),
      evidence: [
        {
          element_id: nse.id,
          source_block_id: nse.source_block_id,
          exact_quote: nse.text.slice(0, Math.min(nse.text.length, 120)).trim(),
        },
      ],
    };
  }

  // Warranties & Disclaimers
  const warrantyElements = findMatchingElements(elements, ['warranty', 'warranties', 'as is', 'disclaimer', 'workmanlike']);
  let warranties: FactWithEvidence = createNotFoundFact('No express warranties or disclaimers found.');
  if (warrantyElements.length > 0) {
    const we = warrantyElements[0];
    warranties = {
      status: 'FOUND',
      summary: we.text.slice(0, Math.min(we.text.length, 120)).trim(),
      evidence: [
        {
          element_id: we.id,
          source_block_id: we.source_block_id,
          exact_quote: we.text.slice(0, Math.min(we.text.length, 120)).trim(),
        },
      ],
    };
  }

  // Limitation of Liability
  const liabilityElements = findMatchingElements(elements, ['limitation of liability', 'liability cap', 'consequential damages', 'indirect damages', 'punitive damages']);
  let liabilityCap: FactWithEvidence = createNotFoundFact('No aggregate liability cap stated.');
  let indirectDamages: FactWithEvidence = createNotFoundFact('No consequential damages waiver stated.');
  if (liabilityElements.length > 0) {
    for (const le of liabilityElements) {
      if (/consequential|indirect|incidental|punitive/i.test(le.text) && indirectDamages.status === 'NOT_FOUND') {
        indirectDamages = {
          status: 'FOUND',
          summary: le.text.slice(0, Math.min(le.text.length, 120)).trim(),
          evidence: [
            {
              element_id: le.id,
              source_block_id: le.source_block_id,
              exact_quote: le.text.slice(0, Math.min(le.text.length, 120)).trim(),
            },
          ],
        };
      }
      if (/total liability|aggregate liability|fees paid/i.test(le.text) && liabilityCap.status === 'NOT_FOUND') {
        liabilityCap = {
          status: 'FOUND',
          summary: le.text.slice(0, Math.min(le.text.length, 120)).trim(),
          evidence: [
            {
              element_id: le.id,
              source_block_id: le.source_block_id,
              exact_quote: le.text.slice(0, Math.min(le.text.length, 120)).trim(),
            },
          ],
        };
      }
    }
  }

  // Indemnification
  const indemnityElements = findMatchingElements(elements, ['indemnify', 'indemnification', 'hold harmless', 'defense']);
  let contractorIndemnity: FactWithEvidence = createNotFoundFact('No contractor indemnification clause found.');
  let clientIdemnity: FactWithEvidence = createNotFoundFact('No client indemnification clause found.');
  if (indemnityElements.length > 0) {
    for (const ie of indemnityElements) {
      if (/contractor shall indemnify|consultant shall defend/i.test(ie.text) && contractorIndemnity.status === 'NOT_FOUND') {
        contractorIndemnity = {
          status: 'FOUND',
          summary: ie.text.slice(0, Math.min(ie.text.length, 120)).trim(),
          evidence: [
            {
              element_id: ie.id,
              source_block_id: ie.source_block_id,
              exact_quote: ie.text.slice(0, Math.min(ie.text.length, 120)).trim(),
            },
          ],
        };
      }
      if (/company shall indemnify|client shall defend/i.test(ie.text) && clientIdemnity.status === 'NOT_FOUND') {
        clientIdemnity = {
          status: 'FOUND',
          summary: ie.text.slice(0, Math.min(ie.text.length, 120)).trim(),
          evidence: [
            {
              element_id: ie.id,
              source_block_id: ie.source_block_id,
              exact_quote: ie.text.slice(0, Math.min(ie.text.length, 120)).trim(),
            },
          ],
        };
      }
    }
  }

  // Termination
  const termElements = findMatchingElements(elements, ['termination', 'terminate', 'notice to terminate', 'cure period']);
  let termConvenience: FactWithEvidence = createNotFoundFact('No termination for convenience clause found.');
  let termCause: FactWithEvidence = createNotFoundFact('No termination for cause clause found.');
  let postTermPayment: FactWithEvidence = createNotFoundFact('No post-termination payment terms found.');
  if (termElements.length > 0) {
    for (const te of termElements) {
      if (/without cause|for convenience|either party may terminate.*days/i.test(te.text) && termConvenience.status === 'NOT_FOUND') {
        termConvenience = {
          status: 'FOUND',
          summary: te.text.slice(0, Math.min(te.text.length, 120)).trim(),
          evidence: [
            {
              element_id: te.id,
              source_block_id: te.source_block_id,
              exact_quote: te.text.slice(0, Math.min(te.text.length, 120)).trim(),
            },
          ],
        };
      }
      if (/material breach|for cause|cure period|days written notice/i.test(te.text) && termCause.status === 'NOT_FOUND') {
        termCause = {
          status: 'FOUND',
          summary: te.text.slice(0, Math.min(te.text.length, 200)).trim(),
          evidence: [
            {
              element_id: te.id,
              source_block_id: te.source_block_id,
              exact_quote: te.text.slice(0, Math.min(te.text.length, 200)).trim(),
            },
          ],
        };
      }
      if (/accrued|completed prior to termination|payment upon termination/i.test(te.text) && postTermPayment.status === 'NOT_FOUND') {
        postTermPayment = {
          status: 'FOUND',
          summary: te.text.slice(0, Math.min(te.text.length, 120)).trim(),
          evidence: [
            {
              element_id: te.id,
              source_block_id: te.source_block_id,
              exact_quote: te.text.slice(0, Math.min(te.text.length, 120)).trim(),
            },
          ],
        };
      }
    }
  }

  // Dispute Resolution
  const disputeElements = findMatchingElements(elements, ['arbitration', 'dispute resolution', 'litigation', 'attorneys fees', 'legal fees', 'venue']);
  let disputeMethod: FactWithEvidence = createNotFoundFact('No specific dispute resolution mechanism specified.');
  let disputeVenue: FactWithEvidence = createNotFoundFact('No venue specified.');
  let legalFees: FactWithEvidence = createNotFoundFact('No prevailing party legal fee provision found.');
  if (disputeElements.length > 0) {
    for (const de of disputeElements) {
      if (/arbitration|court|mediation/i.test(de.text) && disputeMethod.status === 'NOT_FOUND') {
        disputeMethod = {
          status: 'FOUND',
          summary: de.text.slice(0, Math.min(de.text.length, 120)).trim(),
          evidence: [
            {
              element_id: de.id,
              source_block_id: de.source_block_id,
              exact_quote: de.text.slice(0, Math.min(de.text.length, 120)).trim(),
            },
          ],
        };
      }
      if (/exclusive venue|courts located in/i.test(de.text) && disputeVenue.status === 'NOT_FOUND') {
        disputeVenue = {
          status: 'FOUND',
          summary: de.text.slice(0, Math.min(de.text.length, 120)).trim(),
          evidence: [
            {
              element_id: de.id,
              source_block_id: de.source_block_id,
              exact_quote: de.text.slice(0, Math.min(de.text.length, 120)).trim(),
            },
          ],
        };
      }
      if (/prevailing party|attorneys'? fees|legal costs/i.test(de.text) && legalFees.status === 'NOT_FOUND') {
        legalFees = {
          status: 'FOUND',
          summary: de.text.slice(0, Math.min(de.text.length, 120)).trim(),
          evidence: [
            {
              element_id: de.id,
              source_block_id: de.source_block_id,
              exact_quote: de.text.slice(0, Math.min(de.text.length, 120)).trim(),
            },
          ],
        };
      }
    }
  }

  // Independent Contractor Relationship Affirmation
  const icElements = findMatchingElements(elements, ['independent contractor', 'not an employee', 'no authority to bind', 'relationship of parties']);
  let icAffirmation: FactWithEvidence = createNotFoundFact('No express independent contractor affirmation clause.');
  if (icElements.length > 0) {
    const ice =
      icElements.find((e) => /not an employee|no authority to bind|independent contractor and not/i.test(e.text)) ||
      icElements.find((e) => e.text.length > 40 && /independent contractor/i.test(e.text)) ||
      icElements[0];
    icAffirmation = {
      status: 'FOUND',
      summary: ice.text.slice(0, Math.min(ice.text.length, 140)).trim(),
      evidence: [
        {
          element_id: ice.id,
          source_block_id: ice.source_block_id,
          exact_quote: ice.text.slice(0, Math.min(ice.text.length, 120)).trim(),
        },
      ],
    };
  }

  // Entire Agreement
  const entireElements = findMatchingElements(elements, ['entire agreement', 'merger clause', 'supersedes all prior', 'integration clause']);
  let entireAgreement: FactWithEvidence = createNotFoundFact('No entire agreement clause found.');
  if (entireElements.length > 0) {
    const ee = entireElements[0];
    entireAgreement = {
      status: 'FOUND',
      summary: ee.text.slice(0, Math.min(ee.text.length, 120)).trim(),
      evidence: [
        {
          element_id: ee.id,
          source_block_id: ee.source_block_id,
          exact_quote: ee.text.slice(0, Math.min(ee.text.length, 120)).trim(),
        },
      ],
    };
  }

  // Omissions & Missing Provisions
  const omissions: OmissionOrMissingTerm[] = [];
  if (latePaymentTerms.status === 'NOT_FOUND') {
    omissions.push({
      provision_name: 'Late Payment Penalties / Interest',
      explanation: 'No interest or penalty fee is specified for overdue client invoices.',
    });
  }
  if (nonCompete.status === 'NOT_FOUND') {
    omissions.push({
      provision_name: 'Non-Compete Restriction',
      explanation: 'The contract does not contain a restrictive covenant or non-compete clause.',
    });
  }
  if (acceptanceCriteria.status === 'NOT_FOUND') {
    omissions.push({
      provision_name: 'Deliverable Acceptance Procedure',
      explanation: 'No formal inspection timeline or acceptance/rejection criteria is defined.',
    });
  }

  return {
    document_id: doc.document_id,
    source_file_id: doc.source_file_id,
    verified_sha256: doc.verified_sha256,
    classification: {
      category,
      confidence: categoryConfidence,
      primary_purpose: isFreelanceOrConsulting
        ? 'Engages an independent contractor to provide designated professional services and deliverables.'
        : 'Outlines contractual terms and obligations between the contracting parties.',
      governing_jurisdiction: governingJurisdiction,
    },
    parties,
    dates_and_term: {
      effective_date: effectiveDate,
      execution_date: createNotFoundFact('Execution date not separately recorded.'),
      commencement_date: effectiveDate,
      expiration_date: termDuration,
      term_duration: termDuration,
      renewal_terms: renewalTerms,
    },
    scope_and_deliverables: {
      scope_description: scopeDescription,
      deliverables,
      change_order_mechanism: changeOrder,
      acceptance_criteria: acceptanceCriteria,
    },
    payment_and_commercial: {
      fee_structure: feeStructure,
      rates_and_amounts: ratesAndAmounts,
      invoicing_schedule: invoicingSchedule,
      payment_terms_days: paymentTermsDays,
      late_payment_terms: latePaymentTerms,
      reimbursable_expenses: reimbursableExpenses,
      taxes_and_withholding: taxesAndWithholding,
    },
    obligations: {
      client_obligations: clientObligations,
      contractor_obligations: contractorObligations,
    },
    key_provisions: {
      intellectual_property: {
        ownership: ipOwnership,
        pre_existing_ip: ipPreExisting,
        license_granted: ipLicense,
      },
      confidentiality: {
        definition: confDef,
        duration: confDuration,
        carveouts: confCarveouts,
      },
      non_compete: nonCompete,
      non_solicitation: nonSolicit,
      warranties_and_disclaimers: warranties,
      limitation_of_liability: {
        liability_cap: liabilityCap,
        exclusion_of_indirect_damages: indirectDamages,
      },
      indemnification: {
        contractor_indemnification: contractorIndemnity,
        client_indemnification: clientIdemnity,
      },
      termination: {
        termination_for_convenience: termConvenience,
        termination_for_cause: termCause,
        post_termination_payment: postTermPayment,
      },
      dispute_resolution: {
        method: disputeMethod,
        venue_and_forum: disputeVenue,
        prevailing_party_legal_fees: legalFees,
      },
      independent_contractor_affirmation: icAffirmation,
      entire_agreement: entireAgreement,
    },
    ambiguities_and_conflicts: [],
    omissions_and_missing_terms: omissions,
    stats: {
      total_facts: 0,
      verified_facts: 0,
      verification_percentage: 100,
      total_evidence_references: 0,
      verified_evidence_references: 0,
    },
    processing_status: 'COMPLETE',
    analysis_source: 'DETERMINISTIC_FALLBACK',
    model_used: 'deterministic-extractor-v1',
    analyzed_at: new Date().toISOString(),
    processed_sections: (doc.sections || []).map((s) => s.id),
    total_sections_in_document: (doc.sections || []).length,
    coverage_percentage: 100,
    warnings: [],
  };
}
