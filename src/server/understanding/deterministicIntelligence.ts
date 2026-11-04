import {
  DataProtectionTerms,
  FactWithEvidence,
  InsuranceTerms,
  RenewalTerms,
  SubcontractingTerms,
  TaxTerms,
  WarrantyTerms,
  WorkerClassificationIndicators,
} from './types';

/** The subset of the analyzer's flattened element that this module needs. */
export interface IntelElement {
  id: string;
  source_block_id: string;
  text: string;
}

/**
 * Deterministic (no-AI) extraction of the contractor-intelligence facts.
 *
 * Each fact is decided by sentence-level patterns over the real document text:
 *   FOUND     - a sentence states it; the sentence itself is the verbatim evidence quote
 *   AMBIGUOUS - a sentence addresses it but only vaguely (limited to the facts where that is meaningful)
 *   NOT_FOUND - no sentence in the WHOLE document states it
 * Nothing is defaulted: every fact is the result of examining every sentence.
 */

interface Sentence {
  element: IntelElement;
  text: string;
}

const SENTENCE_SPLIT = /(?<=[.;!?])\s+(?=[A-Z("“])/;

function toSentences(elements: IntelElement[]): Sentence[] {
  const out: Sentence[] = [];
  for (const el of elements) {
    // Section headings that are only a title never state terms; keep them out
    for (const part of el.text.split(SENTENCE_SPLIT)) {
      const text = part.trim();
      // A short numbered clause title ("6.3 Warranty Period.") names a topic but states no term
      if (text.length < 50 && /^\d+(\.\d+)*\.?\s+[A-Z][^.]*\.$/.test(text)) continue;
      if (text.length >= 12) out.push({ element: el, text });
    }
  }
  return out;
}

interface FactSpec {
  /** Sentence states the fact if ANY of these match... */
  include: RegExp[];
  /** ...and ALL of these also match (e.g. an obligation verb) */
  require?: RegExp[];
  /** ...and NONE of these match */
  exclude?: RegExp[];
  /** A matching sentence is only AMBIGUOUS when it matches this and lacks `specific` */
  vague?: RegExp;
  specific?: RegExp;
  notFound: string;
  /** How many distinct elements may back the fact (default 1) */
  maxEvidence?: number;
}

const MAX_QUOTE = 320;

function resolve(sentences: Sentence[], spec: FactSpec): FactWithEvidence {
  const hits: Sentence[] = [];
  for (const s of sentences) {
    if (!spec.include.some((re) => re.test(s.text))) continue;
    if (spec.require && !spec.require.every((re) => re.test(s.text))) continue;
    if (spec.exclude && spec.exclude.some((re) => re.test(s.text))) continue;
    hits.push(s);
  }
  if (hits.length === 0) return { status: 'NOT_FOUND', summary: spec.notFound, evidence: [] };

  const unique: Sentence[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    const key = `${h.element.id}::${h.text}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(h);
    }
  }
  const chosen = unique.slice(0, spec.maxEvidence ?? 1);
  const first = chosen[0];
  const isVague = !!spec.vague && spec.vague.test(first.text) && !(spec.specific && spec.specific.test(first.text));

  return {
    status: isVague ? 'AMBIGUOUS' : 'FOUND',
    summary: first.text.slice(0, 200),
    evidence: chosen.map((c) => ({
      element_id: c.element.id,
      source_block_id: c.element.source_block_id,
      // A trimmed sentence of the element is a verbatim substring of the source text.
      exact_quote: c.text.slice(0, MAX_QUOTE),
    })),
    ...(isVague ? { notes: 'The provision is stated vaguely and does not give specific terms.' } : {}),
  };
}

const NEG_RENEW = /\b(shall|will|does|do)\s+not\s+(automatically\s+)?(renew|extend)|no\s+(automatic\s+)?(renewal|extension)|not\s+(be\s+)?(automatically\s+)?renew/i;

// ---------------------------------------------------------------------------
// Worker classification indicators
// ---------------------------------------------------------------------------
const WORKER: Record<keyof WorkerClassificationIndicators, FactSpec> = {
  prescribed_hours: {
    include: [
      /(shall|must|required to|agrees to|will)\s+(work|be available|be on[- ]?site|be present|be online)[^.]{0,80}(\d{1,2}(:\d{2})?\s*(a\.?m|p\.?m)|\d+\s*hours?\s+(per|a|each)\s+(week|day)|monday|business hours|core hours|between\s+\d|regular (business )?hours)/i,
      /(set|fixed|prescribed|regular|standard|core)\s+(working\s+)?(hours|schedule)|(work(ing)?\s+hours)\s+(shall be|are|will be)/i,
      /(minimum|at least)\s+(of\s+)?\d+\s*hours?\s+(per|a|each)\s+(week|day)/i,
      /\b9\s*(a\.?m\.?)?\s*(to|-|–)\s*5\b/i,
    ],
    exclude: [/\b(invoice|billable|hourly rate|per hour|approved hours|hours worked)\b/i],
    notFound: 'No prescribed working hours or mandatory availability found.',
  },
  mandatory_location: {
    include: [
      /(shall|must|required to|agrees to|will)\s+(perform|work|provide|render|report|be present|be located|attend)[^.]{0,80}\b(at|from|to)\s+(the\s+)?(client'?s|company'?s|customer'?s)?\s*(office|offices|premises|facilit\w+|site|location|headquarters|campus)/i,
      /\bon[- ]?site\s+(at|during|\d)|(in[- ]office|in the office)\s+(\d|days|requirement)|remote work is not permitted|no remote work/i,
    ],
    notFound: 'No mandatory work location found.',
  },
  direct_supervision: {
    include: [
      /under the (direct\s+)?(supervision|direction|control|management) of/i,
      /\bsupervised by\b|report(s|ing)?\s+(directly\s+)?to\s+(the\s+)?(client'?s|company'?s)?\s*(manager|supervisor|director|team lead|lead)/i,
      /(client|company)\s+(shall|may|will|has the right to)\s+(direct|supervise|control|oversee|instruct)[^.]{0,60}(contractor|the work|services|methods|manner|performance|day[- ]to[- ]day)/i,
      /(follow|comply with)\s+(the\s+)?(client'?s|company'?s)\s+(instructions|directions|procedures|policies|methods|processes)/i,
      /(daily|weekly)\s+(stand-?ups?|check-?ins|status meetings?)\s+(are\s+)?(mandatory|required)/i,
    ],
    notFound: 'No direct supervision or control over working methods found.',
  },
  exclusivity: {
    include: [
      /exclusive(ly)?\s+(services|basis|engagement|provider)|(provide|perform|render)\s+(any\s+)?services\s+exclusively/i,
      /(shall|must)\s+not\s+(provide|perform|render|offer)[^.]{0,60}services\s+(to|for)\s+(any\s+)?(other|third|competing)/i,
      /may\s+not\s+(work|provide|perform)[^.]{0,40}\b(for|to)\s+(any\s+)?(other|third|competing)/i,
      /devote\s+(his|her|their|its|your)?\s*(full|entire|substantially all|all)\s+(business\s+)?(time|working time|attention)|full[- ]time\s+and\s+exclusive/i,
    ],
    exclude: [/exclusive (property|right of ownership|jurisdiction|remedy|license of)/i],
    notFound: 'No exclusivity or restriction on working for other clients found.',
  },
  no_delegation: {
    include: [
      /(shall|must)\s+(personally\s+)?perform[^.]{0,60}(personally|himself|herself|in person)|personally\s+(perform|provide|render)/i,
      /personal\s+services/i,
      /(shall|may|must)\s+not\s+(delegate|subcontract|sub-contract|assign|outsource)/i,
      /no\s+(subcontractors|delegation|substitutes)|not\s+(permitted|allowed)\s+to\s+(use|engage|delegate|subcontract)/i,
    ],
    notFound: 'No requirement of personal performance or ban on delegation found.',
  },
  client_equipment: {
    include: [
      /(shall|must|required to|will)\s+(use|work on|utili[sz]e|operate)[^.]{0,60}(client|company)[- ]?(provided|issued|supplied|owned)?\s*(equipment|laptop|computer|device|hardware|software|tools|systems|accounts)/i,
      /(client|company)\s+(will|shall)\s+(provide|supply|furnish|issue)[^.]{0,60}(equipment|laptop|computer|hardware|workstation)[^.]{0,80}(must|shall|required|exclusively|only)/i,
      /(only|exclusively)\s+(use|on)[^.]{0,40}(client|company)(-| )(provided|issued)|may not use (personal|own) (equipment|devices|computers|laptops)/i,
      /(shall|must|required to|will)\s+(use|work on|utili[sz]e|operate)[^.]{0,60}(equipment|laptop|computer|device|hardware|software|tools|systems)[^.]{0,40}(provided|issued|supplied|furnished)\s+by\s+(the\s+)?(client|company|customer)/i,
    ],
    notFound: 'No mandatory use of client-provided equipment found.',
  },
  independent_business_restrictions: {
    include: [
      /(shall not|may not|must not|agrees not to)\s+(advertise|market|promote|solicit|hold (himself|herself|themselves|itself) out|maintain|operate|engage in|start|establish|accept)[^.]{0,80}(business|clients?|customers?|work|engagements|projects|website|brand|company name|trade name|marketing|moonlight)/i,
      /(shall|must)\s+(be identified|hold (himself|herself|themselves) out|represent (himself|herself|themselves))[^.]{0,60}as\s+(a |an )?(employee|member of (the )?(client|company|team)|(client|company) (staff|team|personnel))/i,
      /prior\s+(written\s+)?(approval|consent)[^.]{0,40}(other|outside)\s+(work|engagements|business|clients)/i,
    ],
    notFound: 'No restriction on running an independent business found.',
  },
  control_over_timing_and_manner: {
    include: [
      /(client|company)\s+(shall|may|will|has the right to|reserves the right to)\s+(determine|dictate|prescribe|specify|control|direct|set)\s+(the\s+)?(time|timing|manner|method|means|sequence|order|priority|priorities|schedule|work process)/i,
      /(contractor|consultant)\s+shall\s+(follow|adhere to|comply with)\s+(the\s+)?(client'?s|company'?s)\s+(methodology|methodologies|processes|procedures|workflow|work(ing)?\s+(practices|methods|instructions)|standard operating procedures|sops?)/i,
      /(in the manner|at the times)\s+(directed|specified|determined|prescribed)\s+by\s+(the\s+)?(client|company)/i,
      /(timesheets?|daily reports?|attendance)\s+(shall be|must be|are)\s+(submitted|required|kept|recorded)\s+(daily|weekly)|approval for (vacation|time off|leave)/i,
    ],
    notFound: 'No control over how or when services are performed found.',
  },
};

// ---------------------------------------------------------------------------
// Data protection & security
// ---------------------------------------------------------------------------
const DATA_TERM = /(personal (data|information)|personally identifiable|\bpii\b|\bphi\b|protected health|sensitive (personal )?(data|information)|customer (data|records)|end[- ]?user data|user data|payment card|cardholder|financial (account )?(data|information)|health (data|information|records)|(client|company)\s+data|data subjects?|\bgdpr\b|\bccpa\b|\bhipaa\b)/i;
const DATA: Record<keyof DataProtectionTerms, FactSpec> = {
  handles_personal_data: {
    include: [DATA_TERM],
    require: [/(access|process|handle|receive|collect|store|use|disclos|provided|exposed|comply|compliance|processing|transfer)/i],
    notFound: 'No indication that the contractor accesses or processes personal or sensitive data.',
  },
  permitted_purposes: {
    include: [
      /(solely|only|exclusively)\s+(for|to)\s+(the\s+)?(purpose|purposes)\s+of\s+(performing|providing|the\s+services|this agreement)/i,
      /(use|process)[^.]{0,60}(only|solely)\s+(for|to)[^.]{0,60}(services|perform|agreement)/i,
      /(purpose limitation|permitted purposes?|authori[sz]ed purposes?)/i,
      /(shall|may)\s+not\s+(use|process)[^.]{0,60}(for any other purpose|other than)/i,
    ],
    require: [/(data|information)/i],
    notFound: 'No limit on the purposes for which data may be used.',
  },
  security_obligations: {
    include: [
      /(highest|strictest|state[- ]of[- ]the[- ]art|industry[- ]leading)\s+(standard|level)s?\s+of\s+security|(ensure|guarantee|warrant)[^.]{0,40}(no|any)\s+(security\s+)?(breach|incident|unauthori)/i,
      /security\s+(measures|controls|safeguards|requirements|standards|practices|program)|(technical|organi[sz]ational)\s+(and organi[sz]ational\s+)?measures/i,
      /(reasonable|appropriate|industry[- ]standard)\s+(security|safeguards|measures|protections)[^.]{0,60}(protect|safeguard|secure|prevent)/i,
      /\bencrypt(ion|ed)?\b|multi[- ]factor|access controls?|iso\s*27001|soc\s*2/i,
      /(safeguard|protect)[^.]{0,40}(data|information)[^.]{0,60}(unauthori[sz]ed|loss|theft|misuse|disclosure)/i,
    ],
    notFound: 'No data security obligations found.',
  },
  breach_notification: {
    include: [/(data|security|privacy)\s+(breach|incident)|breach of (security|data)|unauthori[sz]ed (access|disclosure|use)/i],
    require: [/\b(notify|notif\w+|notice|report|inform)\b/i],
    notFound: 'No data breach notification requirement found.',
  },
  return_or_deletion: {
    include: [
      /(return|destroy|delete|erase|purge)[^.]{0,100}(confidential information|personal data|data|materials|records|information|copies)/i,
    ],
    require: [/(terminat|expir|upon request|completion|conclusion|end of the|at the end)/i],
    notFound: 'No return or deletion of data after termination found.',
  },
  third_party_access: {
    include: [
      /(shall not|may not)\s+(disclose|share|transfer|provide|allow)[^.]{0,80}(third part(y|ies)|subcontractors?|affiliates|sub-?processors?)/i,
      /sub-?processors?/i,
      /(third[- ]part(y|ies)|subcontractors?)[^.]{0,60}(access|process|handle)[^.]{0,60}(data|information)/i,
      /(access|disclos\w+)[^.]{0,60}(limited|restricted)\s+to[^.]{0,40}(employees|personnel|need[- ]to[- ]know)/i,
    ],
    require: [/(data|information|confidential)/i],
    notFound: 'No terms on third-party or subcontractor access to data.',
  },
  cross_border_transfer: {
    include: [
      /(transfer|export|process|store|host)[^.]{0,80}(outside|out of|across|beyond)\s+(the\s+)?(country|jurisdiction|eea|european (economic area|union)|uk|united kingdom|united states|borders)/i,
      /cross[- ]border|international (data )?transfers?|standard contractual clauses|\bscc\b|data (residency|localization|localisation)|adequacy decision|binding corporate rules/i,
      /(data|information)[^.]{0,40}(shall|must)\s+(remain|be stored|be hosted)\s+(in|within)/i,
    ],
    notFound: 'No cross-border data transfer terms found.',
  },
  processing_agreement: {
    include: [
      /data processing (agreement|addendum)|\bdpa\b|data protection (agreement|addendum|terms)/i,
      /\b(controller|processor|sub-?processor|business associate)\b/i,
      /data sharing agreement|joint controllers?|article 28|\bbaa\b/i,
    ],
    notFound: 'No data processing agreement or controller/processor allocation found.',
  },
};

// ---------------------------------------------------------------------------
// Insurance
// ---------------------------------------------------------------------------
const INSURANCE_VERB = /\b(maintain|carry|obtain|procure|keep|provide|hold|have|purchase|in force)\b/i;
const INSURANCE: Record<keyof InsuranceTerms, FactSpec> = {
  professional_indemnity: {
    include: [/(professional\s+(indemnity|liability)|errors?\s*(and|&)\s*omissions|\be\s*&\s*o\b|malpractice)[^.]{0,160}(insurance|coverage|policy)|(insurance|coverage|policy)[^.]{0,160}(professional\s+(indemnity|liability)|errors?\s*(and|&)\s*omissions|\be\s*&\s*o\b)/i],
    require: [INSURANCE_VERB],
    notFound: 'No professional indemnity insurance requirement found.',
  },
  general_liability: {
    include: [/(commercial\s+)?general\s+liability|\bcgl\b|public\s+liability/i],
    require: [INSURANCE_VERB, /(insurance|coverage|policy)/i],
    notFound: 'No general liability insurance requirement found.',
  },
  cyber: {
    include: [/cyber(\s*(liability|security|risk))?\s*(insurance|coverage|policy)|(insurance|coverage|policy)[^.]{0,80}cyber|network security (and privacy )?(liability )?insurance|data breach (insurance|coverage)/i],
    require: [INSURANCE_VERB],
    notFound: 'No cyber insurance requirement found.',
  },
  minimum_coverage: {
    include: [
      /(insurance|coverage|policy|policies)[^.]{0,200}(\$|usd\s?|eur\s?|£|€)\s?\d[\d,.]*(\s?(million|m\b|k\b|thousand|billion))?/i,
      /(minimum|limits?)[^.]{0,60}(\$|usd\s?|eur\s?|£|€)\s?\d[\d,.]*/i,
      /(insurance|coverage)[^.]{0,100}(adequate|appropriate|sufficient|reasonable|as (may be )?required by)/i,
    ],
    require: [/(insurance|coverage|policy|policies)/i],
    vague: /(adequate|appropriate|sufficient|reasonable|as (may be )?required by)/i,
    specific: /(\$|usd\s?|eur\s?|£|€)\s?\d/i,
    notFound: 'No minimum insurance coverage limits found.',
  },
  additional_insured: {
    include: [/additional insured|named as (an )?additional insured|loss payee|waiver of subrogation/i],
    notFound: 'No additional-insured requirement found.',
  },
  evidence_of_insurance: {
    include: [
      /(certificates?|evidence|proof)\s+of\s+insurance|\bcoi\b/i,
      /(provide|furnish|deliver|submit)[^.]{0,60}(certificate|proof|evidence)[^.]{0,40}(insurance|coverage)/i,
    ],
    notFound: 'No certificate or evidence of insurance requirement found.',
  },
  post_termination_maintenance: {
    include: [
      /(maintain|keep|continue)[^.]{0,100}(insurance|coverage|policy)[^.]{0,120}(after|following|beyond|until)/i,
      /(insurance|coverage)[^.]{0,80}surviv/i,
      /\btail (coverage|policy)\b|extended reporting period/i,
      /(after|following)\s+(the\s+)?(termination|expiration)[^.]{0,100}(maintain|continue)[^.]{0,80}(insurance|coverage)/i,
    ],
    notFound: 'No post-termination insurance requirement found.',
  },
};

// ---------------------------------------------------------------------------
// Subcontracting
// ---------------------------------------------------------------------------
const SUB_NOUN = /(subcontract|sub-contract|delegat|outsourc|subcontractor|third part(y|ies)|assistants|sub-?consultants?)/i;
const CONSENT = /(consent|approval|authori[sz]ation|permission|approved in writing|written (notice|approval))/i;
const SUBCONTRACTING: Record<keyof SubcontractingTerms, FactSpec> = {
  prohibition: {
    include: [
      /(shall|may|must)\s+not\s+(subcontract|sub-contract|delegate|assign|outsource)/i,
      /(subcontracting|delegation|outsourcing)\s+(is|shall be)\s+(strictly\s+)?(prohibited|forbidden|not permitted)|not\s+(permitted|allowed)\s+to\s+(subcontract|delegate|assign|outsource)|no\s+subcontracting/i,
    ],
    // A route to consent makes it an approval requirement, not an absolute ban
    exclude: [/(without|unless|except|prior\s+(written\s+)?(consent|approval|authori[sz]ation)|with\s+(the\s+)?(client'?s\s+|company'?s\s+)?(consent|approval)|subject to)/i],
    notFound: 'No absolute prohibition on subcontracting or delegation found.',
  },
  approval_requirement: {
    include: [
      /(subcontract|sub-contract|delegate|outsource|engage\s+(any\s+)?(subcontractors|third part)|assign)[^.]{0,120}(consent|approval|authori[sz]ation|permission)/i,
      /(consent|approval|permission)[^.]{0,80}(subcontract|delegate|outsourc)/i,
    ],
    require: [SUB_NOUN],
    // Consent to disclose data/confidential information to a subcontractor is a data-access term, not a subcontracting approval
    exclude: [/(disclos\w*|personal (data|information)|confidential information|share|transfer)\b/i],
    notFound: 'No client approval requirement for subcontracting found.',
  },
  permission: {
    include: [
      /(may|is permitted to|is free to|shall be entitled to|has the right to|can)\s+(freely\s+)?(subcontract|sub-contract|delegate|engage|retain|use|hire|appoint)[^.]{0,60}(subcontractors?|third part(y|ies)|assistants|personnel|agents|sub-?consultants?)/i,
      /(use|engage|retain|hire)\s+of\s+(its\s+|his\s+|her\s+|their\s+)?(own\s+)?(subcontractors|assistants|personnel|sub-?consultants)\s+(is|shall be)\s+(permitted|allowed)/i,
      /(may|can)\s+(subcontract|sub-contract|delegate)/i,
    ],
    notFound: 'No express permission to subcontract or delegate found.',
  },
  delegation_restriction: {
    include: [
      /personal(ly)?\s+(services|perform)|(shall|must)\s+(personally|himself|herself)\s+perform/i,
      /delegat(e|ion)[^.]{0,80}(restrict|limited|only|not|except|prior)/i,
      /(shall|may)\s+not\s+delegate|key\s+personnel/i,
      /(replace|substitut)\w*\s+(of\s+)?(personnel|staff|key)[^.]{0,60}(consent|approval)/i,
    ],
    notFound: 'No restriction on delegation or replacement of personnel found.',
  },
  responsibility_for_subcontractors: {
    include: [
      /(responsible|liable|accountable)\s+for\s+(the\s+)?(acts?|omissions?|performance|work|actions?|default|breach|conduct|compliance)[^.]{0,60}(subcontractors?|sub-?consultants?|delegates?|assistants|personnel)/i,
      /(subcontractors?|delegates?)[^.]{0,80}(remain|shall remain|does not relieve|shall not relieve|not relieve)[^.]{0,60}(responsible|liable|obligations)/i,
      /(subcontract|delegation)[^.]{0,80}(not relieve|does not release|shall not release)/i,
    ],
    notFound: 'No statement of responsibility for subcontractor performance found.',
  },
  liability_for_subcontractors: {
    include: [
      /(liable|liability)[^.]{0,60}subcontractors?|subcontractors?[^.]{0,60}(claims|damages|losses|indemnif)|indemnif[^.]{0,80}subcontractor/i,
    ],
    notFound: 'No statement of liability for subcontractor actions found.',
  },
  flow_down_obligations: {
    include: [
      /(subcontractors?|delegates|assistants|sub-?consultants?)[^.]{0,120}(bound by|subject to|comply with|execute|sign)[^.]{0,120}(confidential|non-?disclosure|data|obligations|terms|intellectual|written agreement)/i,
      /(written agreement|binding)[^.]{0,60}(with|from)\s+(each\s+)?subcontractor[^.]{0,80}(no less|at least as|equivalent|same)/i,
    ],
    notFound: 'No requirement that subcontractors be bound by confidentiality, data or IP terms.',
  },
};

// ---------------------------------------------------------------------------
// Tax
// ---------------------------------------------------------------------------
const TAX: Record<keyof TaxTerms, FactSpec> = {
  contractor_income_tax: {
    include: [
      /(contractor|consultant)\s+(shall be|is|will be|agrees to be|shall remain)\s+(solely\s+)?(responsible|liable)\s+for[^.]{0,80}(taxes|income tax|self-employment|social security|payroll|tax(es)?\s+(obligations|liabilities|returns|reporting))/i,
      /(contractor|consultant)\s+(shall|will|must)\s+(pay|report|file|remit)[^.]{0,60}(taxes|income tax|self-employment)/i,
      /(no|not)[^.]{0,30}(taxes|social security|payroll)[^.]{0,40}(withheld|deducted|withhold)[^.]{0,60}(by\s+)?(the\s+)?(client|company)/i,
      /\b1099\b|self-employment tax/i,
    ],
    notFound: 'No statement that the contractor is responsible for its own income taxes.',
  },
  client_withholding: {
    include: [
      /(client|company|customer)\s+(may|shall|will|is entitled to|has the right to|is authori[sz]ed to|reserves the right to|must)\s+(deduct|withhold)[^.]{0,80}(tax|taxes|withholding|levies|duties)/i,
      /(withholding tax(es)?|backup withholding)/i,
      /(payments?|fees?|amounts?)[^.]{0,80}(subject to|net of|after|less)[^.]{0,40}(withholding|applicable (taxes|withholdings))/i,
    ],
    notFound: 'No client right to withhold taxes found.',
  },
  indirect_taxes: {
    include: [/\b(vat|value[- ]added tax|gst|goods and services tax|sales tax|use tax|consumption tax|turnover tax)\b/i],
    notFound: 'No VAT, GST or sales tax terms found.',
  },
  tax_indemnification: {
    include: [
      /(contractor|consultant)\s+(shall|will|agrees to)\s+(indemnif|hold harmless|reimburse|compensate)[^.]{0,100}(tax|taxes|penalt|withholding|assessment|levies)/i,
      /(indemnif|hold harmless)[^.]{0,100}(taxes|tax liabilit|tax (penalties|assessments)|withholding)/i,
    ],
    notFound: 'No tax indemnification found.',
  },
  amounts_tax_basis: {
    include: [
      /(inclusive of|including|exclusive of|exclud(e|es|ing)|plus|net of|before)\s+(all\s+)?(applicable\s+)?(taxes|vat|gst|sales tax|duties|levies)/i,
      /(fees|rates|amounts|compensation|prices?)[^.]{0,60}(are|is|shall be)\s+(inclusive|exclusive|stated (exclusive|inclusive))[^.]{0,30}(of\s+)?(all\s+)?(applicable\s+)?(taxes|vat|gst)/i,
      /taxes?\s+(are|is|shall be)\s+(included|excluded|additional|extra)|all[- ]inclusive/i,
    ],
    notFound: 'The contract does not say whether agreed amounts include or exclude taxes.',
  },
};

// ---------------------------------------------------------------------------
// Renewal
// ---------------------------------------------------------------------------
const RENEWAL: Record<keyof RenewalTerms, FactSpec> = {
  auto_renewal: {
    include: [
      /(automatic(ally)?|auto[- ]?)\s*(renew|extend|continue)/i,
      /(shall|will)\s+(automatically\s+)?(renew|be renewed|extend|continue)[^.]{0,80}(successive|additional|further|subsequent|each|for\s+(a\s+)?(period|term|one|two|\d|twelve))/i,
      /\bevergreen\b|renews?\s+(automatically|for successive)/i,
    ],
    exclude: [NEG_RENEW],
    notFound: 'No automatic renewal found.',
  },
  renewal_duration: {
    include: [
      /(renew|extend|continue|extension|renewal)[^.]{0,100}(for|of|by)\s+(an\s+)?(additional|successive|further|subsequent|consecutive|new|renewal)?[^.]{0,30}(term|period)s?\s+(of\s+)?(\w+\s*)?(\(\d+\)\s*)?(days?|weeks?|months?|years?)/i,
      /(successive|additional|renewal)\s+(terms?|periods?)\s+of\s+[^.]{0,30}(days?|weeks?|months?|years?)/i,
      /(renew|extend)[^.]{0,60}(for|by)\s+(an\s+)?(additional\s+)?(\w+\s*)?(\(\d+\)\s*)?(year|month|week)s?/i,
    ],
    exclude: [NEG_RENEW],
    notFound: 'No renewal period length found.',
  },
  non_renewal_notice: {
    include: [
      /(notice|notif\w*)[^.]{0,80}(non-?renew|not to renew|not renew|prevent (the )?renewal|elect not to renew|decline to renew|opt out of renewal)/i,
      /(non-?renewal|not to renew|not renew)[^.]{0,80}(notice|notif|prior to|before|at least|no later than|days)/i,
    ],
    notFound: 'No notice period for preventing renewal found.',
  },
  unilateral_renewal: {
    include: [
      /(client|company|customer)\s+(may|shall have the (sole )?(right|option)|has the (sole )?(right|option)|reserves the right)[^.]{0,80}(renew|extend)/i,
      /(renew|extend)[^.]{0,80}at\s+(the\s+)?(client|company)'?s?\s+(sole\s+)?(option|discretion)|unilateral(ly)?\s+(renew|extend)/i,
    ],
    notFound: 'No unilateral renewal right found.',
  },
  renewal_pricing: {
    include: [
      /(renew|renewal|extension|extended term|successive term)[^.]{0,120}(rates?|fees?|prices?|pricing|compensation|charges)[^.]{0,80}(same|unchanged|increase|decrease|reduc\w*|adjust|revis|fixed|frozen|cpi|escalat|not exceed|no (increase|change))/i,
      /(rates?|fees?|prices?|pricing|compensation)[^.]{0,80}(during|for|in|upon)\s+(any\s+)?(renewal|extended|successive)\s+(term|period)s?/i,
      /(renew|renewal|extension|extended term|successive term)[^.]{0,120}(reduc\w*|decreas\w*|adjust\w*|revis\w*|increas\w*|freez\w*)[^.]{0,40}(rates?|fees?|prices?|pricing|compensation)/i,
    ],
    notFound: 'No pricing terms for renewal periods found.',
  },
};

// ---------------------------------------------------------------------------
// Warranties
// ---------------------------------------------------------------------------
const WARRANTY: Record<keyof WarrantyTerms, FactSpec> = {
  performance_guarantee: {
    include: [
      /(warrant|guarantee|represent)s?[^.]{0,100}(error[- ]free|defect[- ]free|bug[- ]free|free\s+(from|of)\s+(all\s+)?(defects|errors|bugs|vulnerabilit)|uninterrupted|fit(ness)?\s+for\s+(a\s+)?(particular\s+)?purpose|merchantab|meet(s)?\s+(all|each|every)[^.]{0,30}(requirements|specifications|expectations)|conform[^.]{0,40}(all|every))/i,
      /guarantee[sd]?[^.]{0,60}(performance|quality|results|work|deliverables|services|workmanship)/i,
    ],
    notFound: 'No broad performance or quality guarantee found.',
  },
  outcome_guarantee: {
    include: [
      /(guarantee|warrant|ensure|promise|commit)s?[^.]{0,80}(increase|growth|improv\w+|\broi\b|return on investment|revenue|sales|profit|traffic|conversion|leads|rankings?|savings|reduction|results|outcomes?|success|approval|funding|launch\s+(on|by)|go-?live\s+(on|by)|compliance|certification|regulatory approval|customer acquisition)/i,
      /(minimum|guaranteed)\s+(roi|return|revenue|growth|increase|results|traffic|conversion|performance)/i,
    ],
    notFound: 'No guarantee of business or financial outcomes found.',
  },
  warranty_duration: {
    include: [
      /warrant\w*[^.]{0,80}\b(for|during|within)\s+(a\s+)?(period of\s+)?(\w+\s*)?(\(\d+\)\s*)?(days?|weeks?|months?|years?)\s+(after|from|following|of)\s+(the\s+)?(delivery|acceptance|completion|termination|date)/i,
      /(warranty|guarantee)\s+(period|term)/i,
      /(perpetual|lifetime|indefinite|in perpetuity)\s+(warranty|guarantee)|warrant\w*[^.]{0,60}(are|is|shall be|remain)\s+(perpetual|lifetime|indefinite|in perpetuity)|warrant\w*[^.]{0,60}(perpetual|lifetime|indefinite|forever|in perpetuity)/i,
      /(defects?|errors?|bugs?|non-?conform\w+)[^.]{0,80}(within|for|during)\s+(\w+\s*)?(\(\d+\)\s*)?(days?|months?|years?)\s+(of|after|from|following)/i,
      /(warranties|warranty)[^.]{0,40}(shall|will)\s+(remain|continue|last|be valid)[^.]{0,40}(for|during|until)[^.]{0,30}(days?|months?|years?)/i,
      /warrant\w*[^.]{0,80}reasonable (period|time)/i,
    ],
    vague: /reasonable (period|time)/i,
    specific: /\d|\b(thirty|sixty|ninety|one|two|three|six|twelve)\b/i,
    notFound: 'No warranty duration found.',
  },
  repair_replace: {
    include: [
      /(repair|correct|fix|remedy|re-?perform|replace|re-?do|rework|cure)[^.]{0,100}(at no (additional )?(charge|cost|expense)|free of charge|without (additional )?(charge|cost|compensation)|at (its|contractor'?s|own) (own )?expense|until (the )?(client|company)[^.]{0,20}(satisfied|approved|accepted))/i,
      /(unlimited|any number of)[^.]{0,30}(revisions?|corrections?|repairs?|fixes|replacements?|re-?work)/i,
      /(shall|will)\s+(promptly\s+)?(repair|correct|fix|replace|re-?perform)[^.]{0,80}(defects?|errors?|non-?conforming|bugs?)/i,
    ],
    notFound: 'No repair, replacement or re-performance obligation found.',
  },
  post_termination_warranty: {
    include: [
      /(warrant\w*|guarantee\w*|defect|support|repair)[^.]{0,120}(surviv\w+|continue|remain in effect|extend|apply)[^.]{0,60}(termination|expiration|completion|delivery)/i,
      /surviv\w+[^.]{0,80}(warrant\w*|guarantee\w*)/i,
      /after\s+(the\s+)?(termination|expiration)[^.]{0,80}(warrant\w*|repair|fix|correct|defect)/i,
    ],
    notFound: 'No warranty or defect obligations that continue after termination found.',
  },
};

function resolveGroup<K extends string>(
  sentences: Sentence[],
  specs: Record<K, FactSpec>
): Record<K, FactWithEvidence> {
  const out = {} as Record<K, FactWithEvidence>;
  for (const key of Object.keys(specs) as K[]) out[key] = resolve(sentences, specs[key]);
  return out;
}

export interface IntelligenceFacts {
  worker_classification: WorkerClassificationIndicators;
  data_protection: DataProtectionTerms;
  insurance: InsuranceTerms;
  subcontracting: SubcontractingTerms;
  tax_details: TaxTerms;
  renewal_details: RenewalTerms;
  warranty_details: WarrantyTerms;
}

export function analyzeIntelligenceFacts(elements: IntelElement[]): IntelligenceFacts {
  const sentences = toSentences(elements);
  return {
    worker_classification: resolveGroup(sentences, WORKER),
    data_protection: resolveGroup(sentences, DATA),
    insurance: resolveGroup(sentences, INSURANCE),
    subcontracting: resolveGroup(sentences, SUBCONTRACTING),
    tax_details: resolveGroup(sentences, TAX),
    renewal_details: resolveGroup(sentences, RENEWAL),
    warranty_details: resolveGroup(sentences, WARRANTY),
  };
}
