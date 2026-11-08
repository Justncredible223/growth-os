-- Correct the verified product knowledge: the Edge Score blends FIVE parts, not four.
--
-- Source of truth: frontend/src/lib/calc.ts (EDGE_WEIGHTS on origin/main of the fillbook repo, verified by Site Work 2026-11-08):
-- profitability 30%, consistency 20%, risk control 20%, stop adherence 15%, rule adherence 15%. The score renormalises over the
-- parts that could be computed, so stop adherence and rule adherence count only when planned risk or a plan is logged.
-- The 2026-10-12 entry (0052) says "blends profitability, consistency, risk control and rule adherence" (four), which made the
-- review agents fail correct scripts that say five.
--
-- Additive and idempotent: only runs while the current verified 'what_fillbook_does' entry still carries the old phrase; the old
-- entry is marked 'deprecated' and points at its corrected replacement. Nothing is deleted. Growth OS migrations have no runner:
-- the owner applies this by hand in the Supabase SQL editor (project fillbook-growth-os).

with old_doc as (
  select id, content from knowledge_documents
   where topic = 'what_fillbook_does' and trust_level = 'verified' and superseded_by is null
     and content like '%Edge Score that blends profitability, consistency, risk control and rule adherence%'
), new_doc as (
  insert into knowledge_documents (topic, title, content, source_doc, trust_level, effective_at)
  select 'what_fillbook_does', 'What Fillbook does, by screen (verified 2026-11-08)',
    replace(
      content,
      'Edge Score that blends profitability, consistency, risk control and rule adherence',
      'Edge Score that blends five parts (profitability 30%, consistency 20%, risk control 20%, stop adherence 15% and rule adherence 15%; stop adherence and rule adherence count only when planned risk or a plan is logged)'
    ),
    'fillbook:frontend/src/lib/calc.ts EDGE_WEIGHTS (verified by Site Work 2026-11-08), replaces the 2026-10-12 entry', 'verified', now()
  from old_doc
  returning id
)
update knowledge_documents k
   set trust_level = 'deprecated', superseded_by = (select id from new_doc)
 where k.id in (select id from old_doc)
   and exists (select 1 from new_doc);
