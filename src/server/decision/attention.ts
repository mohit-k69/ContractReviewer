import { KIND_RANK, SEVERITY_RANK } from '../risk/analysis';
import { FindingKind, RISK_CATEGORIES, RiskCategory, RiskFinding } from '../risk/types';
import { Ctx } from './items';
import { stmt } from './evidence';
import {
  AttentionSection,
  DecisionFinding,
  FindingGroup,
  FindingType,
  ImpactArea,
  Observation,
  Priority,
  RelatedClause,
  ReportEvidence,
  ReportStatus,
  Statement,
} from './types';

const TYPE: Record<FindingKind, FindingType> = {
  RISK: 'risk',
  MISSING_PROVISION: 'missing',
  AMBIGUOUS_TERM: 'ambiguous',
  CONTRADICTORY_PROVISIONS: 'contradictory',
};

const STATUS: Record<FindingKind, ReportStatus> = {
  RISK: 'explicit',
  MISSING_PROVISION: 'not_found',
  AMBIGUOUS_TERM: 'unclear',
  CONTRADICTORY_PROVISIONS: 'conflicting',
};

const IMPACT: Record<RiskCategory, ImpactArea[]> = {
  Payment: ['money'],
  'Scope of Work': ['responsibilities', 'money'],
  Termination: ['rights', 'money'],
  'Intellectual Property': ['rights', 'other_clients'],
  'Liability & Indemnification': ['liability', 'money'],
  Confidentiality: ['responsibilities', 'other_clients'],
  'Non-Compete, Exclusivity & Non-Solicitation': ['other_clients', 'rights'],
  'Dispute Resolution & Governing Law': ['rights', 'money'],
  'Worker Classification': ['rights', 'other_clients'],
  'Data Protection & Security': ['responsibilities', 'liability'],
  Insurance: ['money', 'liability'],
  'Subcontracting & Delegation': ['responsibilities'],
  Tax: ['money'],
  Renewal: ['rights', 'money'],
  Warranties: ['liability', 'responsibilities'],
};

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const priorityOf = (s: RiskFinding['severity']): Priority => s.toLowerCase() as Priority;

/** Union-find over findings that cite the same clause. */
function cluster(findings: RiskFinding[]): Map<string, string> {
  const parent = new Map<string, string>(findings.map((f) => [f.id, f.id]));
  const find = (x: string): string => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!);
      x = parent.get(x)!;
    }
    return x;
  };
  const owner = new Map<string, string>();
  for (const f of findings) {
    for (const e of f.evidence) {
      const seen = owner.get(e.element_id);
      if (seen) parent.set(find(f.id), find(seen));
      else owner.set(e.element_id, f.id);
    }
  }
  return new Map(findings.map((f) => [f.id, find(f.id)]));
}

const order = (x: RiskFinding, y: RiskFinding): number =>
  SEVERITY_RANK[y.severity] - SEVERITY_RANK[x.severity] ||
  KIND_RANK[y.kind] - KIND_RANK[x.kind] ||
  RISK_CATEGORIES.indexOf(x.category) - RISK_CATEGORIES.indexOf(y.category) ||
  x.id.localeCompare(y.id);

function firstSentence(text: string): string {
  const m = text.match(/^.*?[.!?](?=\s|$)/);
  return (m ? m[0] : text).trim();
}

export function buildAttention(ctx: Ctx): AttentionSection {
  const { risk, resolver } = ctx;
  const sorted = [...risk.findings].sort(order);
  const clusterOf = cluster(sorted);

  // Lead of each cluster = first in priority order
  const members = new Map<string, RiskFinding[]>();
  for (const f of sorted) {
    const root = clusterOf.get(f.id)!;
    (members.get(root) ?? members.set(root, []).get(root)!).push(f);
  }
  const clusterId = new Map<string, string>();
  const leadOf = new Map<string, string>();
  for (const [root, list] of members) {
    const cid = `cluster.${list[0].id}`;
    for (const f of list) clusterId.set(f.id, cid);
    leadOf.set(cid, list[0].id);
    void root;
  }

  const findings: DecisionFinding[] = sorted.map((f) => {
    const type = TYPE[f.kind];
    const evidence = resolver.list(f.evidence, 4);
    const cid = clusterId.get(f.id)!;
    const peers = (members.get(clusterOf.get(f.id)!) || []).filter((o) => o.id !== f.id);

    let position: Statement;
    const text = firstSentence(f.explanation);
    if (type === 'missing') position = stmt.notStated(text);
    else if (type === 'contradictory') position = stmt.conflicting(text, evidence);
    else if (type === 'ambiguous') position = stmt.unclear(text, evidence);
    else position = stmt.explicit(text, evidence);

    const related: RelatedClause[] = [];
    if (type === 'contradictory') {
      for (const e of evidence.slice(1)) related.push({ element_id: e.element_id, reference: e.reference, relationship: 'conflicts_with' });
    }
    for (const p of peers) {
      for (const e of resolver.list(p.evidence, 1)) {
        if (related.some((r) => r.element_id === e.element_id)) continue;
        if (evidence.some((x) => x.element_id === e.element_id) || f.evidence.some((x) => x.element_id === e.element_id)) {
          related.push({ element_id: e.element_id, reference: e.reference, relationship: 'also_cited_by_related_finding', finding_id: p.id });
        }
      }
    }

    return {
      id: f.id,
      title: f.title,
      priority: priorityOf(f.severity),
      category: f.category,
      type,
      status: STATUS[f.kind],
      group_id: slug(f.category),
      cluster_id: cid,
      is_cluster_lead: leadOf.get(cid) === f.id,
      contract_position: position,
      contract_language: evidence.map((e) => e.exact_quote),
      evidence,
      explanation: f.explanation,
      impact: f.why_it_matters,
      recommended_action: f.suggestion,
      ...(f.illustrative_alternative ? { illustrative_alternative: f.illustrative_alternative } : {}),
      related_clauses: related,
      related_finding_ids: peers.map((p) => p.id),
      impact_areas: IMPACT[f.category] ?? [],
      confidence: f.confidence,
      ...(f.uncertainty ? { uncertainty: f.uncertainty } : {}),
      ...(type === 'missing' && f.relevance?.material
        ? { relevance: { material: true as const, reason: f.relevance.reason, evidence: resolver.list(f.relevance.trigger_evidence, 2) as ReportEvidence[] } }
        : {}),
    };
  });

  // Groups: one per category, ordered by the most serious finding inside them
  const byCategory = new Map<string, DecisionFinding[]>();
  for (const f of findings) (byCategory.get(f.group_id) ?? byCategory.set(f.group_id, []).get(f.group_id)!).push(f);
  const groups: FindingGroup[] = [...byCategory.entries()].map(([group_id, list]) => {
    const clusters = new Map<string, string[]>();
    for (const f of list) (clusters.get(f.cluster_id) ?? clusters.set(f.cluster_id, []).get(f.cluster_id)!).push(f.id);
    return {
      group_id,
      title: list[0].category,
      finding_ids: list.map((f) => f.id),
      clusters: [...clusters.entries()].map(([cluster_id, finding_ids]) => ({ cluster_id, lead_id: leadOf.get(cluster_id) ?? finding_ids[0], finding_ids })),
    };
  });

  const observations: Observation[] = (risk.observations || []).map((o) => ({
    id: o.id,
    title: o.title,
    category: o.category,
    explanation: o.explanation,
    topic: o.topic ?? o.title,
    relevance_reason: o.relevance?.reason ?? '',
  }));

  const by_priority: Record<Priority, number> = { high: 0, medium: 0, low: 0 };
  const by_type: Record<FindingType, number> = { risk: 0, ambiguous: 0, contradictory: 0, missing: 0 };
  for (const f of findings) {
    by_priority[f.priority]++;
    by_type[f.type]++;
  }

  return { groups, findings, observations, counts: { by_priority, by_type } };
}
