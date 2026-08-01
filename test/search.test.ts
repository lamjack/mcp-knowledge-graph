// Tests for Tier 1 retrieval improvements: relevance ranking, top-k (limit),
// 1-hop ego-graph expansion (relation recall fix), and the token-efficient
// concise serialization format.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync } from 'node:fs';

import { KnowledgeGraphManager, formatGraphConcise, type KnowledgeGraph } from '../storage.js';

function tmpRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'kg-search-'));
}

async function seed(mgr: KnowledgeGraphManager, root: string): Promise<void> {
  await mgr.createEntities(
    [
      { name: 'TripLog', entityType: 'note', observations: ['visited Seattle in spring'] },
      { name: 'Bob', entityType: 'person', observations: ['organizer'] },
    ],
    undefined,
    undefined,
    root,
  );
  await mgr.createRelations(
    [{ from: 'TripLog', to: 'Bob', relationType: 'organized_by' }],
    undefined,
    undefined,
    root,
  );
}

test('search keeps relations to 1-hop neighbours even when the neighbour does not match (recall fix)', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await seed(mgr, root);

  // "seattle" only matches TripLog (via observation), not Bob.
  const graph = await mgr.searchNodes('seattle', undefined, undefined, root);

  const names = new Set(graph.entities.map(e => e.name));
  assert.ok(names.has('TripLog'), 'matched entity must be present');
  assert.ok(names.has('Bob'), '1-hop neighbour must be pulled in for context');
  assert.equal(graph.relations.length, 1, 'the relation to the neighbour must survive');
  assert.equal(graph.relations[0]!.relationType, 'organized_by');
});

test('search with depth 0 returns only matched entities and drops dangling relations', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await seed(mgr, root);

  const graph = await mgr.searchNodes('seattle', undefined, undefined, root, { depth: 0 });

  const names = graph.entities.map(e => e.name);
  assert.deepEqual(names, ['TripLog']);
  assert.equal(graph.relations.length, 0);
});

test('search ranks name matches above type matches above observation matches', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  // Insert in the OPPOSITE order to the expected ranking so that a result which
  // merely preserves insertion order (the old behaviour) cannot pass this test.
  await mgr.createEntities(
    [
      { name: 'note_x', entityType: 'note', observations: ['a project idea'] }, // observation -> lowest
      { name: 'gizmo', entityType: 'project', observations: [] },        // type substring
      { name: 'project_alpha', entityType: 'task', observations: [] },   // name substring
      { name: 'Project', entityType: 't', observations: [] },            // exact name  -> highest
    ],
    undefined,
    undefined,
    root,
  );

  const graph = await mgr.searchNodes('project', undefined, undefined, root);
  const order = graph.entities.map(e => e.name);
  assert.deepEqual(order, ['Project', 'project_alpha', 'gizmo', 'note_x']);
});

test('search limit caps the number of seed matches', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [
      { name: 'Project', entityType: 't', observations: [] },
      { name: 'project_alpha', entityType: 'task', observations: [] },
      { name: 'gizmo', entityType: 'project', observations: [] },
    ],
    undefined,
    undefined,
    root,
  );

  const graph = await mgr.searchNodes('project', undefined, undefined, root, { limit: 1 });
  assert.equal(graph.entities.length, 1, 'only the single highest-ranked seed is returned');
  assert.equal(graph.entities[0]!.name, 'Project');
});

test('search depth 2 expands exactly two hops of neighbours', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [
      { name: 'A_seed', entityType: 't', observations: ['contains needle'] },
      { name: 'B', entityType: 't', observations: [] },
      { name: 'C', entityType: 't', observations: [] },
      { name: 'D', entityType: 't', observations: [] },
    ],
    undefined,
    undefined,
    root,
  );
  await mgr.createRelations(
    [
      { from: 'A_seed', to: 'B', relationType: 'r' },
      { from: 'B', to: 'C', relationType: 'r' },
      { from: 'C', to: 'D', relationType: 'r' },
    ],
    undefined,
    undefined,
    root,
  );

  const d1 = await mgr.searchNodes('needle', undefined, undefined, root, { depth: 1 });
  assert.deepEqual(new Set(d1.entities.map(e => e.name)), new Set(['A_seed', 'B']));

  const d2 = await mgr.searchNodes('needle', undefined, undefined, root, { depth: 2 });
  assert.deepEqual(new Set(d2.entities.map(e => e.name)), new Set(['A_seed', 'B', 'C']));
  assert.ok(!d2.entities.some(e => e.name === 'D'), 'D is three hops away and must be excluded');
});

test('search limit caps seeds but still pulls in their neighbours', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [
      { name: 'match_hi', entityType: 'project', observations: [] }, // type match -> score 5
      { name: 'project_lo', entityType: 't', observations: [] },     // name substring -> score 10 (higher)
      { name: 'neighbour', entityType: 't', observations: [] },
    ],
    undefined,
    undefined,
    root,
  );
  await mgr.createRelations(
    [{ from: 'project_lo', to: 'neighbour', relationType: 'r' }],
    undefined,
    undefined,
    root,
  );

  const g = await mgr.searchNodes('project', undefined, undefined, root, { limit: 1 });
  const names = g.entities.map(e => e.name);
  assert.ok(names.includes('project_lo'), 'the single highest-ranked seed is kept');
  assert.ok(names.includes('neighbour'), "a seed's neighbour is included and does not count against limit");
  assert.ok(!names.includes('match_hi'), 'the lower-ranked match is dropped by limit');
});

test('search treats a negative limit as zero results rather than returning everything', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [
      { name: 'Project', entityType: 't', observations: [] },
      { name: 'project_alpha', entityType: 't', observations: [] },
    ],
    undefined,
    undefined,
    root,
  );

  const g = await mgr.searchNodes('project', undefined, undefined, root, { limit: -5 });
  assert.equal(g.entities.length, 0, 'a negative limit must not silently return all matches');
});

// Tier A search enhancements: multi-term tokenization, term-coverage ranking,
// and whole-word (boundary) weighting. Single-term behaviour is unchanged.

test('search matches multiple query terms across different fields (multi-term recall)', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [{ name: 'TripLog', entityType: 'note', observations: ['visited Seattle in spring'] }],
    undefined,
    undefined,
    root,
  );
  // "trip" matches the name, "seattle" matches an observation; the full phrase
  // "seattle trip" appears nowhere, so the old single-substring search found nothing.
  const graph = await mgr.searchNodes('seattle trip', undefined, undefined, root, { depth: 0 });
  assert.deepEqual(graph.entities.map(e => e.name), ['TripLog']);
});

test('search ranks an entity matching more query terms above one matching fewer (coverage)', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [
      { name: 'seattle_note', entityType: 't', observations: [] },           // matches only "seattle"
      { name: 'trip', entityType: 't', observations: ['went to seattle'] },  // matches "trip" AND "seattle"
    ],
    undefined,
    undefined,
    root,
  );
  const graph = await mgr.searchNodes('seattle trip', undefined, undefined, root, { depth: 0 });
  assert.equal(graph.entities[0]!.name, 'trip', 'entity matching both terms ranks first');
  assert.ok(graph.entities.some(e => e.name === 'seattle_note'), 'partial match is still included');
});

test('search weights whole-word matches above mid-word substring matches (multi-term)', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [
      { name: 'category', entityType: 't', observations: ['dogma'] }, // "cat"/"dog" only as substrings
      { name: 'cat', entityType: 't', observations: ['dog'] },         // "cat"/"dog" as whole words
    ],
    undefined,
    undefined,
    root,
  );
  const graph = await mgr.searchNodes('cat dog', undefined, undefined, root, { depth: 0 });
  assert.equal(graph.entities[0]!.name, 'cat', 'whole-word matches outrank mid-word substring matches');
});

// Tier B search enhancements: IDF (down-weight common query terms, up-weight rare
// ones) and observation-length normalization (suppress long-observation hubs).

test('search down-weights a common query term via IDF so a rare-term match ranks first', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [
      // "common" appears in many entity names -> high document frequency -> low IDF.
      { name: 'common_a', entityType: 't', observations: [] },
      { name: 'common_b', entityType: 't', observations: [] },
      { name: 'common_c', entityType: 't', observations: [] },
      { name: 'common_d', entityType: 't', observations: [] },
      { name: 'common_x', entityType: 't', observations: [] }, // matches only "common"
      { name: 'rare_x', entityType: 't', observations: [] },   // matches only the rare term "rare"
    ],
    undefined,
    undefined,
    root,
  );
  // Both matches are equally strong (whole-word name hits); only IDF differs.
  const graph = await mgr.searchNodes('common rare', undefined, undefined, root, { depth: 0 });
  assert.equal(graph.entities[0]!.name, 'rare_x', 'the rarer, more distinctive term wins ranking');
});

test('search length-normalizes observations so a focused entity outranks a long hub', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [
      // Hub matches "signal" in 2 of 8 observations (higher raw count).
      { name: 'hub_note', entityType: 't', observations: ['signal one', 'signal two', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6'] },
      // Focused entity matches "signal" in its single observation.
      { name: 'focused_note', entityType: 't', observations: ['a signal here'] },
    ],
    undefined,
    undefined,
    root,
  );
  const graph = await mgr.searchNodes('signal', undefined, undefined, root, { depth: 0 });
  assert.equal(graph.entities[0]!.name, 'focused_note', 'match density beats raw observation-hit count');
});

// Tier C search enhancement: typo tolerance via a bounded edit-distance fallback,
// applied only when a query term has no exact substring match anywhere.

test('search tolerates a typo via fuzzy fallback when no exact match exists', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [{ name: 'Kubernetes Cluster', entityType: 'infra', observations: ['runs the production workload'] }],
    undefined,
    undefined,
    root,
  );
  // "kubernets" is a typo for "kubernetes" (edit distance 1) and is a substring of nothing.
  const graph = await mgr.searchNodes('kubernets', undefined, undefined, root, { depth: 0 });
  assert.deepEqual(graph.entities.map(e => e.name), ['Kubernetes Cluster']);
});

test('fuzzy fallback does not match unrelated words beyond the edit-distance threshold', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [{ name: 'database', entityType: 't', observations: [] }],
    undefined,
    undefined,
    root,
  );
  // "elephant" is far from "database" (edit distance >> threshold) -> no spurious match.
  const graph = await mgr.searchNodes('elephant', undefined, undefined, root, { depth: 0 });
  assert.equal(graph.entities.length, 0);
});

test('formatGraphConcise labels the database and handles an empty graph', () => {
  const out = formatGraphConcise({ entities: [], relations: [] }, 'work');
  assert.ok(out.includes('=== work database (concise) ==='), 'named context appears in the header');
  assert.ok(out.includes('ENTITIES (0):'));
  assert.ok(out.includes('RELATIONS (0):'));
});

test('formatGraphConcise renders one compact line per entity and is smaller than pretty JSON', () => {
  const graph: KnowledgeGraph = {
    entities: [
      { name: 'Alice', entityType: 'person', observations: ['likes tea', 'lives in Macau'] },
      { name: 'Acme', entityType: 'org', observations: [] },
    ],
    relations: [{ from: 'Alice', to: 'Acme', relationType: 'works_at' }],
  };

  const out = formatGraphConcise(graph);

  assert.ok(out.includes('Alice (person): likes tea | lives in Macau'), 'entity observations joined on one line');
  assert.ok(out.includes('Acme (org)'), 'entity with no observations rendered without trailing colon content');
  assert.ok(out.includes('Alice -[works_at]-> Acme'), 'relation rendered compactly');
  assert.ok(out.length < JSON.stringify(graph, null, 2).length, 'concise output must be smaller than indented JSON');
});
