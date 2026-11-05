import { Ctx, makeItem } from './items';
import { holderOf } from './deal';
import { ASSIGNS, RETAINS } from './commitments';
import { OUTSIDE_CONTRACT_NOTE } from './evidence';
import {
  AttentionSection,
  ChecklistEntry,
  DealSection,
  DecisionFinding,
  ExtractedItem,
  MonitorEntry,
  Priority,
  Question,
  ReportEvidence,
  Right,
  RightsAndNextSteps,
} from './types';

const trim = (s: string, n = 300): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const RANK: Record<Priority, number> = { high: 3, medium: 2, low: 1 };

// ---------------------------------------------------------------------------
// A. Rights: what the contract gives you. Only what the verified wording supports.
// ---------------------------------------------------------------------------
const CONDITION = /\b(upon|subject to|provided that|conditional (?:up)?on|only if|if and when|contingent (?:up)?on|following|after|unless)\b[^,.;]{3,120}/gi;
const LIMITATION = /\b(only|shall not exceed|not to exceed|no more than|at most|up to a maximum of|except(?: for)?|limited to|solely)\b[^,.;]{0,100}/gi;
const NOTICE = /\b(?:\d+|[a-z]+\s*\(\d+\))\s+(?:business\s+)?(?:days?|weeks?|months?|years?)(?:['’]s)?(?:\s+(?:prior\s+)?(?:written\s+)?notice)?/i;

/** Verbatim fragments of the quotes matching a pattern (always substrings of the verified wording). */
function fragments(quotes: string[], re: RegExp): string[] {
  const out: string[] = [];
  for (const q of quotes) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(q)) !== null) {
      const f = m[0].trim();
      if (f && !out.includes(f)) out.push(f);
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return out.slice(0, 4);
}

interface RightSpec {
  id: string;
  title: string;
  keys: string[];
  holder: Right['holder'];
  /** Decides the holder from the clause itself; returning null means "do not list it as your right" */
  resolveHolder?: (quotes: string[]) => Right['holder'] | null;
  notice?: boolean;
  /** The verified wording must actually grant the right; an extracted fact alone is not enough */
  grantedBy?: (text: string) => boolean;
}

const RIGHTS: RightSpec[] = [
  { id: 'right.payment_for_work', title: 'To be paid for the work', keys: ['rates', 'fee_structure'], holder: 'client_owes_you' },
  { id: 'right.payment_deadline', title: 'To be paid within the stated time', keys: ['payment_terms'], holder: 'client_owes_you' },
  { id: 'right.payment_on_termination', title: 'To be paid when the contract ends', keys: ['post_term_payment'], holder: 'client_owes_you' },
  { id: 'right.late_payment', title: 'Consequences if the client pays late', keys: ['late_payment'], holder: 'client_owes_you' },
  { id: 'right.expenses', title: 'To be reimbursed for expenses', keys: ['expenses'], holder: 'client_owes_you' },
  { id: 'right.client_resources', title: 'To receive what you need from the client', keys: ['obl_client_resources'], holder: 'client_owes_you' },
  { id: 'right.client_review', title: 'To have your work reviewed and receive feedback', keys: ['obl_client_review'], holder: 'client_owes_you' },
  { id: 'right.client_indemnity', title: 'Indemnity from the client', keys: ['indemnity_client'], holder: 'client_owes_you' },
  {
    id: 'right.terminate_for_convenience',
    title: 'To end the contract without cause',
    keys: ['term_convenience'],
    holder: 'either_party',
    notice: true,
    resolveHolder: (q) => {
      const h = holderOf(q.join(' '));
      return h === 'freelancer' ? 'freelancer' : h === 'either_party' ? 'either_party' : null;
    },
  },
  {
    id: 'right.terminate_contractor',
    title: 'Your right to end the contract',
    keys: ['deal_contractor_term'],
    holder: 'freelancer',
    notice: true,
    resolveHolder: (q) => {
      const h = holderOf(q.join(' '));
      return h === 'client' ? null : h === 'either_party' ? 'either_party' : 'freelancer';
    },
  },
  { id: 'right.subcontract', title: 'To use subcontractors', keys: ['sub_permission'], holder: 'freelancer' },
  { id: 'right.keep_preexisting_ip', title: 'To keep your pre-existing materials', keys: ['ip_preexisting'], holder: 'freelancer', grantedBy: (t) => RETAINS.test(t) && !ASSIGNS.test(t) },
  { id: 'right.change_process', title: 'A process for changes to the scope', keys: ['change_order'], holder: 'either_party' },
];

function buildRights(ctx: Ctx): Right[] {
  const out: Right[] = [];
  for (const spec of RIGHTS) {
    const item = makeItem(ctx, { id: spec.id, title: spec.title, category: 'rights', keys: spec.keys });
    if (item.status !== 'explicit' && !(item.status === 'unclear' && item.value)) continue;
    const quotes = item.evidence.map((e) => e.exact_quote);
    if (spec.grantedBy && !spec.grantedBy(quotes.join(' '))) continue;
    let holder = spec.holder;
    if (spec.resolveHolder) {
      const h = spec.resolveHolder(quotes);
      if (h === null) continue;
      holder = h;
    }
    let notice: Right['notice_period'];
    if (spec.notice) {
      for (const q of quotes) {
        const m = NOTICE.exec(q);
        if (!m) continue;
        const text = m[0].trim();
        const n = parseFloat(m[0].match(/\d+/)?.[0] ?? '');
        const unit = /day/i.test(text) ? 'days' : /week/i.test(text) ? 'weeks' : /month/i.test(text) ? 'months' : /year/i.test(text) ? 'years' : '';
        notice = {
          text,
          ...(Number.isFinite(n) && unit === 'days' ? { days: n } : {}),
          ...(Number.isFinite(n) && unit === 'months' ? { months: n } : {}),
        };
        break;
      }
    }
    out.push({
      id: spec.id,
      title: spec.title,
      statement: trim(item.value ?? item.title),
      holder,
      status: item.status,
      conditions: fragments(quotes, CONDITION),
      limitations: fragments(quotes, LIMITATION),
      ...(notice ? { notice_period: notice } : {}),
      evidence: item.evidence,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// B. Questions to ask. Grounded in findings and unclear terms; no invented figures.
// ---------------------------------------------------------------------------
function questionFor(f: DecisionFinding, topic: string): string {
  switch (f.type) {
    case 'missing':
      return `The contract does not address ${topic}. Can it be added?`;
    case 'ambiguous':
      return `Can you clarify what the contract means here: ${f.title}?`;
    case 'contradictory':
      return `Two parts of the contract disagree (${f.title}). Which one applies?`;
    default:
      return `Would the client be open to changing this term: ${f.title}?`;
  }
}

function buildQuestions(ctx: Ctx, attention: AttentionSection, deal: DealSection): Question[] {
  const topicOf = new Map(ctx.risk.findings.map((f) => [f.id, f.topic]));
  const out: Question[] = [];
  const leads = attention.findings.filter((f) => f.is_cluster_lead || f.type === 'missing');
  for (const f of leads.slice(0, 15)) {
    out.push({
      id: `q.${f.id}`,
      question: questionFor(f, topicOf.get(f.id) ?? f.title.toLowerCase()),
      suggested_change: f.recommended_action,
      ...(f.illustrative_alternative ? { illustrative_alternative: f.illustrative_alternative } : {}),
      priority: f.priority,
      kind: f.type,
      grounded_in: { finding_id: f.id },
      contract_reference: f.evidence,
    });
  }

  // Terms that exist but are stated vaguely, and that no finding already covers
  const coveredElements = new Set(attention.findings.flatMap((f) => f.evidence.map((e) => e.element_id)));
  let extra = 0;
  for (const item of deal.items) {
    if (extra >= 5) break;
    if (item.status !== 'unclear' || !item.value || item.evidence.length === 0) continue;
    if (item.evidence.some((e) => coveredElements.has(e.element_id))) continue;
    const important = ['money', 'invoicing', 'termination', 'timeline'].includes(item.category) || item.group === 'money' || item.group === 'invoicing' || item.group === 'timeline';
    out.push({
      id: `q.item.${item.id}`,
      question: `Can you confirm exactly what the contract means by “${item.title.toLowerCase()}”?`,
      priority: important ? 'medium' : 'low',
      kind: 'unclear_term',
      grounded_in: { item_id: item.id },
      contract_reference: item.evidence,
    });
    extra++;
  }
  return out.sort((x, y) => RANK[y.priority] - RANK[x.priority]);
}

// ---------------------------------------------------------------------------
// C. Checklists
// ---------------------------------------------------------------------------
function buildBeforeSigning(attention: AttentionSection, questions: Question[]): ChecklistEntry[] {
  const out: ChecklistEntry[] = [];
  const byFinding = new Map(questions.filter((q) => q.grounded_in.finding_id).map((q) => [q.grounded_in.finding_id!, q.id]));
  for (const f of attention.findings.filter((x) => x.is_cluster_lead || x.type === 'missing').slice(0, 15)) {
    if (f.priority === 'low' && out.length >= 8) continue;
    out.push({
      id: `check.${f.id}`,
      text: `${f.title}: ${f.recommended_action}`,
      priority: f.priority,
      related_finding_id: f.id,
      ...(byFinding.has(f.id) ? { related_question_id: byFinding.get(f.id) } : {}),
      evidence: f.evidence,
    });
  }
  for (const q of questions.filter((x) => x.kind === 'unclear_term')) {
    out.push({
      id: `check.${q.id}`,
      text: q.question,
      priority: q.priority,
      related_question_id: q.id,
      ...(q.grounded_in.item_id ? { related_item_id: q.grounded_in.item_id } : {}),
      evidence: q.contract_reference,
    });
  }
  return out.sort((x, y) => RANK[y.priority] - RANK[x.priority]);
}

function buildMonitor(ctx: Ctx, deal: DealSection): MonitorEntry[] {
  const out: MonitorEntry[] = [];
  const item = (id: string): ExtractedItem | undefined => deal.items.find((i) => i.id === id);
  const established = (it: ExtractedItem | undefined): it is ExtractedItem => !!it && it.status === 'explicit' && it.evidence.length > 0 && !!it.value;
  const push = (id: string, text: string, applies_to: string, evidence: ReportEvidence[], extra: Partial<MonitorEntry> = {}): void => {
    out.push({ id, text, applies_to, evidence, ...extra });
  };

  const inv = item('invoicing.invoice_requirements');
  if (established(inv)) push('monitor.invoice', `What each invoice must contain or follow: ${trim(inv.value!)}`, 'every invoice', inv.evidence);
  const due = item('invoicing.payment_deadline');
  if (established(due)) push('monitor.payment_due', `When payment is due: ${trim(due.value!)}`, 'every invoice', due.evidence);
  const late = item('invoicing.late_payment');
  if (established(late)) push('monitor.late_payment', `If a payment is late: ${trim(late.value!)}`, 'overdue invoices', late.evidence);
  const miles = item('invoicing.milestones');
  if (established(miles)) push('monitor.milestones', `Milestones to track: ${trim(miles.value!)}`, 'each milestone', miles.evidence);
  const cond = item('invoicing.payment_conditions');
  if (established(cond)) push('monitor.payment_conditions', `Conditions that must be met before payment: ${trim(cond.value!)}`, 'each payment', cond.evidence);
  const exp = item('money.expenses');
  if (established(exp)) push('monitor.expenses', `Expenses: ${trim(exp.value!)}`, 'any expense you incur', exp.evidence);

  const notice = item('termination.notice');
  if (established(notice)) push('monitor.termination_notice', `Notice for ending the contract: ${trim(notice.value!)}`, 'ending the contract', notice.evidence);

  // Dates: only when stated in the contract or calculated from stated dates and periods
  const end = item('timeline.end_date');
  const renewal = item('renewal.terms');
  if (end && (end.structured?.date || end.structured?.calculated_date) && end.evidence.length > 0) {
    const calculated = !end.structured?.date;
    const date = (end.structured?.date ?? end.structured?.calculated_date)!;
    const renewalNote = established(renewal) ? ` Renewal terms: ${trim(renewal.value!, 200)}` : '';
    push('monitor.end_date', `Contract end date${calculated ? ' (calculated, please confirm)' : ''}.${renewalNote}`, 'the contract term', end.evidence, { date, ...(calculated ? { calculated: true } : {}) });
  } else if (established(renewal)) {
    push('monitor.renewal', `Renewal: ${trim(renewal.value!)}`, 'the contract term', renewal.evidence);
  }

  const a = ctx.a;
  const fact = (key: string, label: string, applies: string, id: string): void => {
    const f = a.facts[key];
    if (!a.isEstablished(f)) return;
    const ev = ctx.resolver.list(a.evidenceOf(f), 2);
    if (ev.length) push(id, `${label}: ${trim(f.summary.trim())}`, applies, ev);
  };
  fact('ins_evidence', 'Proof of insurance', 'insurance', 'monitor.insurance_proof');
  fact('dp_breach', 'If data is compromised', 'a data incident', 'monitor.data_breach');
  fact('war_duration', 'Warranty period', 'delivered work', 'monitor.warranty');
  fact('obl_deadlines', 'Delivery deadlines', 'each deliverable', 'monitor.deadlines');
  return out;
}

export function buildRightsAndNextSteps(ctx: Ctx, deal: DealSection, attention: AttentionSection): RightsAndNextSteps {
  const rights = buildRights(ctx);
  const questions = buildQuestions(ctx, attention, deal);
  return {
    rights,
    outside_contract_note: OUTSIDE_CONTRACT_NOTE,
    questions,
    checklist: { before_signing: buildBeforeSigning(attention, questions), during_engagement: buildMonitor(ctx, deal) },
  };
}
