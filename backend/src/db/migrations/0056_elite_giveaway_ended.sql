-- The Elite giveaway has ended (Site Work's public wording, team decision 2026-11-08).
-- The verified knowledge entry from 0051 said it was live and pointed at fillbookhq.com/giveaway, which now redirects home.
-- Not applied automatically; the owner applies it by hand in the Supabase SQL editor (project fillbook-growth-os).
-- Idempotent: it only rewrites the one verified elite_giveaway row.

update knowledge_documents
set title = 'Fillbook Elite giveaway (ended 2026-11-08)',
    content = $$The Fillbook Elite giveaway has ended. Thank you to everyone who entered. There are no new entries and no further giveaways are promised. Say only that it has ended and thank them for entering. Never say a winner was drawn, how it was drawn, who won, the prize or its value, or any number of entries, and never say another giveaway is coming. Never link fillbookhq.com/giveaway (it redirects to the home page). A post about the giveaway from the real @FillbookHQ account is not an impersonation and not a scam. If someone says they entered and asks about their entry, thank them and tell them to email developer@fillbookhq.com, with no promises.$$,
    source_doc = 'Site Work public status wording, 2026-11-08',
    effective_at = now()
where topic = 'elite_giveaway' and trust_level = 'verified';
