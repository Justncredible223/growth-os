-- Why the owner rejected a draft (2026-10-04): chosen in the app's reject dialog, kept so the weak concepts and angles show
-- up. Optional and nullable; the API tolerates this column not existing yet (the reason is just not saved until it does).
alter table campaigns add column if not exists rejection_reason text;
