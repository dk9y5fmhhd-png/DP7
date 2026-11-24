-- ============================================================
-- DP7 v3.8 — follow-up scheduling
--
-- Problem: remark save hone ke baad koi "next follow-up date" nahi hoti thi.
-- Caller ko yaad rakhna padta tha (note me "after 2days" likh ke). List kabhi
-- chhoti nahi hoti thi — kal wahi 168 naam phir se.
--
-- Solution: har remark ke saath follow_up_on (date). Jis customer ka follow-up
-- aaj ya pehle due hai wahi caller ki list me aata hai; jiska aage hai wo
-- tab tak chhupa rehta hai.
--
-- Safe to run repeatedly.
-- ============================================================

ALTER TABLE followups ADD COLUMN IF NOT EXISTS follow_up_on DATE;
ALTER TABLE followups ADD COLUMN IF NOT EXISTS outcome TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS followups_fu_idx
  ON followups (LOWER(username), follow_up_on);

CREATE INDEX IF NOT EXISTS followups_caller_fu_idx
  ON followups (caller_id, follow_up_on);

-- Purane remarks ke liye follow_up_on bhar do (action_date + default gap),
-- taaki upgrade ke baad koi customer "gum" na ho.
UPDATE followups
   SET follow_up_on = action_date + 1
 WHERE follow_up_on IS NULL;

-- Kisi bhi customer ka latest follow-up (caller list ka filter isi par)
CREATE OR REPLACE VIEW latest_followup AS
SELECT DISTINCT ON (LOWER(username))
       LOWER(username) AS uname,
       id            AS followup_id,
       action_type,
       action_date,
       follow_up_on,
       outcome,
       caller_id,
       created_by
  FROM followups
 ORDER BY LOWER(username), action_date DESC, id DESC;

