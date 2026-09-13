import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { sha256, stableJson, uniq } from '../util.js';

// The criterion definitions as one prompt graph (PRD 7.4), in the directory layout the PRD names
// for Clera's uberprompt: prompts/*.json, fragments/*.json, edges.json. uberprompt itself ships
// without a license, so Exhibit never runs or copies it; this module is Exhibit's own dependents
// check over the same files, which is the fallback 7.4 specifies.

export interface Fragment {
  name: string;
  version: number;
  rules: string[];
  text: string[];
  /** Structured values code reads directly (the source allowlists), so a change is one edit in one place. */
  data?: Record<string, unknown>;
}

export interface PromptDef {
  name: string;
  purpose: string;
  uses: string[];
  template: string[];
}

export interface Edge {
  from: string;
  to: string;
  kind: 'uses';
}

export interface ScenarioMap {
  prompts: Record<string, string[]>;
  /** Narrows a prompt's scenarios when a specific fragment changes. */
  fragments: Record<string, string[]>;
}

export interface PromptGraph {
  root: string;
  fragments: Map<string, Fragment>;
  prompts: Map<string, PromptDef>;
  edges: Edge[];
  scenarioMap: ScenarioMap;
}

export const DEFAULT_PROMPTS_DIR = join(import.meta.dirname, '..', '..', 'prompts');

function readJsonDir<T>(dir: string): T[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as T);
}

export function loadGraph(root = DEFAULT_PROMPTS_DIR): PromptGraph {
  const fragments = new Map(readJsonDir<Fragment>(join(root, 'fragments')).map((f) => [f.name, f]));
  const prompts = new Map(readJsonDir<PromptDef>(join(root, 'prompts')).map((p) => [p.name, p]));
  const edges = JSON.parse(readFileSync(join(root, 'edges.json'), 'utf8')) as Edge[];
  const scenarioMap = JSON.parse(readFileSync(join(root, 'scenario-map.json'), 'utf8')) as ScenarioMap;
  return { root, fragments, prompts, edges, scenarioMap };
}

/** Problems with the graph itself: undeclared fragments, edges that disagree with `uses`. */
export function validateGraph(g: PromptGraph): string[] {
  const problems: string[] = [];
  const declared = new Set(g.edges.map((e) => `${e.from}->${e.to}`));
  for (const p of g.prompts.values()) {
    for (const u of p.uses) {
      if (!g.fragments.has(u)) problems.push(`${p.name} uses missing fragment ${u}`);
      if (!declared.has(`${p.name}->${u}`)) problems.push(`edges.json lacks ${p.name} -> ${u}`);
    }
    for (const m of p.template.join('\n').matchAll(/\{\{([\w-]+)\}\}/g)) {
      if (!p.uses.includes(m[1]!)) problems.push(`${p.name} template references ${m[1]} without declaring it in uses`);
    }
    if (!g.scenarioMap.prompts[p.name]) problems.push(`scenario-map.json has no scenarios for ${p.name}`);
  }
  for (const e of g.edges) {
    const p = g.prompts.get(e.from);
    if (!p || !p.uses.includes(e.to)) problems.push(`edges.json declares ${e.from} -> ${e.to}, which no prompt uses`);
  }
  return problems;
}

export function renderPrompt(g: PromptGraph, name: string): string {
  const p = g.prompts.get(name);
  if (!p) throw new Error(`unknown prompt ${name}`);
  return p.template.join('\n').replace(/\{\{([\w-]+)\}\}/g, (_m, frag: string) => {
    const f = g.fragments.get(frag);
    if (!f) throw new Error(`unknown fragment ${frag}`);
    return f.text.join('\n');
  });
}

export function fragmentHash(f: Fragment): string {
  return sha256(stableJson(f));
}

export interface Affected {
  fragments: string[];
  prompts: string[];
  scenarios: string[];
  byPrompt: Record<string, string[]>;
}

/** Every prompt a fragment change touches, and the Arga scenarios that exercise those prompts. */
export function affected(g: PromptGraph, changedFragments: string[]): Affected {
  const prompts = uniq(g.edges.filter((e) => changedFragments.includes(e.to)).map((e) => e.from)).sort();
  const byPrompt: Record<string, string[]> = {};
  for (const p of prompts) {
    const base = g.scenarioMap.prompts[p] ?? [];
    const narrowed = changedFragments.flatMap((f) => g.scenarioMap.fragments[f] ?? []);
    byPrompt[p] = narrowed.length ? base.filter((s) => narrowed.includes(s)) : base;
    if (byPrompt[p]!.length === 0) byPrompt[p] = base;
  }
  const scenarios = uniq(Object.values(byPrompt).flat()).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  return { fragments: changedFragments, prompts, scenarios, byPrompt };
}

/** Fragment files changed relative to a git ref (git-diff mode). */
export function changedFragmentsSince(g: PromptGraph, ref: string): string[] {
  const out = execFileSync('git', ['diff', '--name-only', ref, '--', join(g.root, 'fragments')], { cwd: g.root, encoding: 'utf8' });
  return out
    .split('\n')
    .filter(Boolean)
    .map((f) => basename(f, '.json'))
    .filter((n) => g.fragments.has(n));
}

export interface RuleProofs {
  release: string;
  at: string;
  fragments: Record<string, string>;
  scenarios: Record<string, { attempts: number; passed: number }>;
}

export function proofsPath(g: PromptGraph): string {
  return join(g.root, 'proofs.json');
}

export function readProofs(g: PromptGraph): RuleProofs | null {
  const path = proofsPath(g);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as RuleProofs) : null;
}

export function writeProofs(g: PromptGraph, proofs: RuleProofs): void {
  writeFileSync(proofsPath(g), `${JSON.stringify(proofs, null, 2)}\n`);
}

/** Fragments whose content differs from the last proven version (CI refuses these, 7.4). */
export function unprovenFragments(g: PromptGraph): string[] {
  const proofs = readProofs(g);
  return [...g.fragments.values()].filter((f) => proofs?.fragments[f.name] !== fragmentHash(f)).map((f) => f.name);
}

export function allRuleIds(g: PromptGraph): string[] {
  return uniq([...g.fragments.values()].flatMap((f) => f.rules)).sort();
}
