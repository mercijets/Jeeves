-- Chief Pilot notes. Add one INSERT per note; run:
--   npx wrangler d1 execute jeeves --remote --file=../seed/notes.sql
-- To retire a note: UPDATE notes SET active=0 WHERE id=N;
INSERT INTO notes (title, text, keywords, applies_to, author, created_at) VALUES (
  'Max tire ground speed: 182 knots (210 is mph, not knots)',
  'The maximum tire ground speed is 182 knots ground speed (AFM 75FMA TC-R02-61, replacing page 2-310-2). 182 knots is about 210 mph. Some study aids print "210 Knots" (CAE SimuFlite Cockpit Reference Handbook) or "210 KIAS" (CX flashcards): that is the mph value mislabeled as knots, and the limit is a ground speed, not an indicated airspeed. Use 182 knots ground speed.',
  'tire tyre ground speed maximum 182 210 knots kts mph KIAS limitation',
  'All serial numbers',
  'Chief Pilot (verified 2026-11-04)',
  '2026-11-04'
);
