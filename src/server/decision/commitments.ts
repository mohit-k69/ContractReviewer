import { Ctx, evidenceTexts, makeItem, structuredFrom } from './items';
import { Commitment, CommitmentGroup, CommitmentsSection, ExtractedItem } from './types';

type Party = 'freelancer' | 'client';
type Nature = Commitment['nature'];

interface Spec {
  party: Party;
  category: string;
  title: string;
  /** Facts that describe this commitment */
  keys: string[];
  nature: Nature;
  /** When the contract states nothing about it, list it under "not stated" (only if the whole document was analyzed) */
  expected?: boolean;
  /** Decide the nature from the verified wording instead of assuming it */
  natureFrom?: (text: string) => Nature;
}

const CATEGORY_TITLE: Record<string, string> = {
  delivery: 'Delivering the work',
  confidentiality: 'Confidentiality',
  ip: 'Intellectual property',
  restrictions: 'What you may not do',
  control: 'How the client controls the work',
  liability: 'Liability and indemnity',
  warranties: 'Warranties and guarantees',
  insurance: 'Insurance',
  data: 'Data handling',
  subcontracting: 'Subcontracting and delegation',
  tax: 'Tax',
  payment: 'Payment',
  expenses: 'Expenses',
  cooperation: 'Cooperation, materials and feedback',
  acceptance: 'Acceptance and changes',
  termination: 'Ending the contract',
  other: 'Other obligations stated in the contract',
};

const SPECS: Spec[] = [
  // ----- Freelancer
  { party: 'freelancer', category: 'delivery', title: 'Scope of the services', keys: ['scope'], nature: 'duty', expected: true },
  { party: 'freelancer', category: 'delivery', title: 'Delivery deadlines', keys: ['obl_deadlines'], nature: 'duty', expected: true },
  { party: 'freelancer', category: 'delivery', title: 'Revisions you must make', keys: ['obl_revisions'], nature: 'duty' },
  { party: 'freelancer', category: 'confidentiality', title: 'Keeping information confidential', keys: ['conf_definition', 'conf_duration', 'conf_carveouts'], nature: 'duty' },
  { party: 'freelancer', category: 'ip', title: 'Who owns the work you create', keys: ['ip_ownership'], nature: 'duty' },
  { party: 'freelancer', category: 'ip', title: 'Pre-existing materials', keys: ['ip_preexisting'], nature: 'duty', natureFrom: (t) => (RETAINS.test(t) && !ASSIGNS.test(t) ? 'allowance' : 'duty') },
  { party: 'freelancer', category: 'ip', title: 'Licence you grant', keys: ['ip_license'], nature: 'duty' },
  { party: 'freelancer', category: 'restrictions', title: 'Non-compete', keys: ['non_compete'], nature: 'restriction' },
  { party: 'freelancer', category: 'restrictions', title: 'Non-solicitation', keys: ['non_solicit'], nature: 'restriction' },
  { party: 'freelancer', category: 'restrictions', title: 'Exclusivity', keys: ['wc_exclusivity'], nature: 'restriction' },
  { party: 'freelancer', category: 'restrictions', title: 'Limits on running your own business', keys: ['wc_business'], nature: 'restriction' },
  { party: 'freelancer', category: 'control', title: 'Required working hours or availability', keys: ['wc_hours'], nature: 'duty' },
  { party: 'freelancer', category: 'control', title: 'Required work location', keys: ['wc_location'], nature: 'duty' },
  { party: 'freelancer', category: 'control', title: 'Supervision and direction', keys: ['wc_supervision', 'wc_control'], nature: 'duty' },
  { party: 'freelancer', category: 'control', title: 'Required use of client equipment or systems', keys: ['wc_equipment'], nature: 'duty' },
  { party: 'freelancer', category: 'liability', title: 'Indemnifying the client', keys: ['indemnity_contractor'], nature: 'duty' },
  { party: 'freelancer', category: 'warranties', title: 'Warranties and disclaimers', keys: ['warranties'], nature: 'duty' },
  { party: 'freelancer', category: 'warranties', title: 'Performance guarantee', keys: ['war_performance'], nature: 'duty' },
  { party: 'freelancer', category: 'warranties', title: 'Outcome guarantee', keys: ['war_outcome'], nature: 'duty' },
  { party: 'freelancer', category: 'warranties', title: 'Repair or replace obligation', keys: ['war_repair', 'war_duration', 'war_post'], nature: 'duty' },
  { party: 'freelancer', category: 'insurance', title: 'Insurance you must carry', keys: ['ins_pi', 'ins_gl', 'ins_cyber', 'ins_min', 'ins_additional', 'ins_evidence', 'ins_post'], nature: 'duty' },
  { party: 'freelancer', category: 'data', title: 'Protecting data', keys: ['dp_security', 'dp_purposes', 'dp_personal'], nature: 'duty' },
  { party: 'freelancer', category: 'data', title: 'Reporting data breaches', keys: ['dp_breach'], nature: 'duty' },
  { party: 'freelancer', category: 'data', title: 'Returning or deleting data', keys: ['dp_return'], nature: 'duty' },
  { party: 'freelancer', category: 'subcontracting', title: 'Ban on subcontracting or delegating', keys: ['sub_prohibition', 'wc_no_delegation', 'sub_delegation'], nature: 'restriction' },
  { party: 'freelancer', category: 'subcontracting', title: 'Approval needed to subcontract', keys: ['sub_approval'], nature: 'restriction' },
  { party: 'freelancer', category: 'subcontracting', title: 'Permission to use subcontractors', keys: ['sub_permission'], nature: 'allowance' },
  { party: 'freelancer', category: 'subcontracting', title: 'Responsibility for subcontractors', keys: ['sub_responsibility', 'sub_liability', 'sub_flowdown'], nature: 'duty' },
  { party: 'freelancer', category: 'tax', title: 'Your own taxes', keys: ['tax_income'], nature: 'duty' },
  { party: 'freelancer', category: 'tax', title: 'Tax indemnity', keys: ['tax_indemnity'], nature: 'duty' },
  { party: 'freelancer', category: 'termination', title: 'Notice you must give to end the contract', keys: ['deal_contractor_term'], nature: 'allowance' },

  // ----- Client
  { party: 'client', category: 'payment', title: 'Rates and amounts', keys: ['rates', 'fee_structure'], nature: 'duty', expected: true },
  { party: 'client', category: 'payment', title: 'When payment is due', keys: ['payment_terms'], nature: 'duty', expected: true },
  { party: 'client', category: 'payment', title: 'Conditions on payment', keys: ['deal_pay_conditions'], nature: 'restriction' },
  { party: 'client', category: 'payment', title: 'Consequences of late payment', keys: ['late_payment'], nature: 'duty' },
  { party: 'client', category: 'payment', title: 'Payment when the contract ends', keys: ['post_term_payment'], nature: 'duty' },
  { party: 'client', category: 'expenses', title: 'Reimbursing expenses', keys: ['expenses'], nature: 'duty' },
  { party: 'client', category: 'tax', title: 'Tax withholding', keys: ['tax_withholding'], nature: 'allowance' },
  { party: 'client', category: 'cooperation', title: 'Providing materials, access or information', keys: ['obl_client_resources'], nature: 'duty', expected: true },
  { party: 'client', category: 'cooperation', title: 'Reviewing work and giving feedback', keys: ['obl_client_review'], nature: 'duty', expected: true },
  { party: 'client', category: 'acceptance', title: 'Accepting or rejecting work', keys: ['acceptance'], nature: 'allowance' },
  { party: 'client', category: 'acceptance', title: 'Changing the scope', keys: ['change_order'], nature: 'allowance' },
  { party: 'client', category: 'liability', title: 'Indemnifying you', keys: ['indemnity_client'], nature: 'duty' },
  { party: 'client', category: 'liability', title: 'Limit on liability', keys: ['liability_cap', 'indirect_damages'], nature: 'allowance' },
  { party: 'client', category: 'termination', title: 'Ending the contract for convenience', keys: ['term_convenience'], nature: 'allowance' },
];

const GENERIC_CATEGORY: Array<[RegExp, string]> = [
  [/confiden|non-?disclos/i, 'confidentiality'],
  [/intellectual property|copyright|assign|owner/i, 'ip'],
  [/insur/i, 'insurance'],
  [/data|privacy|personal information|security/i, 'data'],
  [/subcontract|delegat/i, 'subcontracting'],
  [/pay|invoice|fee|compensat|reimburs/i, 'payment'],
  [/deliver|complete|perform|provide the services|milestone|deadline/i, 'delivery'],
  [/compete|solicit|exclusiv/i, 'restrictions'],
  [/indemnif/i, 'liability'],
  [/warrant/i, 'warranties'],
  [/tax/i, 'tax'],
];

export const RETAINS = /\b(retain|retains|reserve|reserves|excluded?|excludes|remain(s)? (the )?(sole |exclusive )?(property|owner)|owned by (the )?(contractor|consultant))\b/i;
export const ASSIGNS = /\b(assigns?|transfers?|including any pre-?existing)\b/i;

const NEGATIVE = /\b(shall not|must not|may not|cannot|can not|not permitted|prohibited|refrain from|agrees not to)\b/i;

const isPresent = (item: ExtractedItem): boolean =>
  item.status === 'explicit' || item.status === 'conflicting' || (item.status === 'unclear' && item.value !== null);

export function buildCommitments(ctx: Ctx): CommitmentsSection {
  const { a, u } = ctx;
  const groups: Record<Party, Map<string, CommitmentGroup>> = { freelancer: new Map(), client: new Map() };
  const notStated: CommitmentsSection['not_stated'] = [];
  const coveredQuotes = new Set<string>();
  const coveredElements = new Set<string>();

  const push = (party: Party, category: string, item: Commitment): void => {
    const map = groups[party];
    if (!map.has(category)) map.set(category, { category, title: CATEGORY_TITLE[category] ?? category, items: [] });
    map.get(category)!.items.push(item);
    for (const e of item.evidence) {
      coveredQuotes.add(`${e.element_id}::${e.exact_quote}`);
      coveredElements.add(e.element_id);
    }
  };

  for (const spec of SPECS) {
    const base = makeItem(ctx, { id: `commit.${spec.party}.${spec.keys[0]}`, title: spec.title, category: spec.category, keys: spec.keys });
    if (isPresent(base)) {
      const structured = structuredFrom(evidenceTexts(base));
      const nature = spec.natureFrom ? spec.natureFrom(evidenceTexts(base).join(' ')) : spec.nature;
      push(spec.party, spec.category, { ...base, ...(structured ? { structured } : {}), party: spec.party, nature });
    } else if (base.status === 'not_found' && spec.expected && a.fullCoverage) {
      notStated.push({ party: spec.party, category: spec.category, title: spec.title });
    }
  }

  // Obligations the understanding stage listed that the structured items above did not already cover
  const lists: Array<[Party, any[]]> = [
    ['freelancer', u.obligations?.contractor_obligations || []],
    ['client', u.obligations?.client_obligations || []],
  ];
  for (const [party, facts] of lists) {
    let added = 0;
    const seenSummaries = new Set<string>();
    for (const f of facts) {
      if (added >= 10) break;
      if (!a.isEstablished(f)) continue;
      const evidence = ctx.resolver.list(a.evidenceOf(f), 2);
      if (evidence.length === 0) continue;
      if (evidence.every((e) => coveredQuotes.has(`${e.element_id}::${e.exact_quote}`) || coveredElements.has(e.element_id))) continue;
      const summary = String(f.summary || '').trim();
      if (!summary || seenSummaries.has(summary.toLowerCase())) continue;
      seenSummaries.add(summary.toLowerCase());
      const category = GENERIC_CATEGORY.find(([re]) => re.test(`${summary} ${evidence[0].exact_quote}`))?.[1] ?? 'other';
      const nature: Nature = NEGATIVE.test(`${summary} ${evidence[0].exact_quote} ${a.clauses.get(evidence[0].element_id)?.text.slice(0, 400) ?? ''}`) ? 'restriction' : 'duty';
      const structured = structuredFrom([evidence[0].exact_quote]);
      push(party, category, {
        id: `commit.${party}.listed.${added + 1}`,
        title: summary.length > 90 ? `${summary.slice(0, 87).trimEnd()}…` : summary,
        value: summary.slice(0, 500),
        status: 'explicit',
        explanation: 'Listed as an obligation in the contract.',
        evidence,
        category,
        ...(structured ? { structured } : {}),
        party,
        nature,
      });
      added++;
    }
  }

  const finish = (party: Party): CommitmentGroup[] => [...groups[party].values()];
  return { freelancer: finish('freelancer'), client: finish('client'), not_stated: notStated };
}
