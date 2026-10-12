-- The Elite giveaway, as a verified knowledge entry.
--
-- 2026-10-12: Inbound auto-drafted a public reply to Fillbook's OWN giveaway post saying "This is an impersonation
-- account. Fillbook does not run giveaways for 'Elite' ... does not use throwaway shorteners." The giveaway is real,
-- so the drafter was missing the fact. Source: the live giveaway page and its official rules at
-- https://fillbookhq.com/giveaway, verified 2026-10-12. Additive and idempotent: nothing is updated or deleted.
-- Not applied automatically; the Inbound prompt also carries these facts in code (inboundResponseWriter.ts).

insert into knowledge_documents (topic, title, content, source_doc, trust_level, effective_at)
select 'elite_giveaway', 'Fillbook Elite giveaway (verified 2026-10-12)',
  $$Fillbook runs a real, live giveaway: a free year of Fillbook Elite ($399.90 value). It is free to enter and no purchase is necessary. The entry period is Oct 11 2026 12:00 AM EDT to Nov 30 2026 11:59 PM EST. It does ask people to follow @FillbookHQ on X and to enter their email and X username at fillbookhq.com/giveaway; the official rules are on that page. Official links live on fillbookhq.com, including Fillbook's own short links under fillbookhq.com/go/ (for example fillbookhq.com/go/x). A post about the giveaway from the real @FillbookHQ account is not an impersonation. Only a different account posing as Fillbook, or a link that points anywhere other than fillbookhq.com, should be treated as a lookalike. Never say Fillbook does not run giveaways, does not ask anyone to follow or enter, or does not use short links. When someone asks whether the giveaway is real, say yes and point to fillbookhq.com/giveaway for the official rules. Never promise or imply that anyone will win.$$,
  'fillbookhq.com/giveaway (official rules page, verified 2026-10-12)', 'verified', now()
where not exists (select 1 from knowledge_documents where topic = 'elite_giveaway' and trust_level = 'verified');
