-- Fleet table. serial_group: LOW (0001-0172 without SB750-71-10), LOW_SB (0001-0172 with SB750-71-10), HIGH (0173-0500).
-- N702FL: SB750-71-10 status NOT yet confirmed. Change LOW to LOW_SB once records confirm the SB is incorporated.
INSERT OR REPLACE INTO aircraft (tail, serial, serial_group, notes) VALUES
  ('N702FL', '750-0076', 'LOW', 'SB750-71-10 status to be confirmed from aircraft records');
