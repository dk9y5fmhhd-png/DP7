-- ============================================================
-- DP7 v3.8.1 — purane remarks ki follow-up date theek karo
--
-- v3.8 ke migration ne har purane remark ko action_date + 1 diya tha —
-- chahe remark kuch bhi ho. Isliye "Will Deposit" ko bhi 1 din mila,
-- jabki uska default 2 din hai.
--
-- Yahan sirf unhi rows ko theek kiya jaata hai jo migration se bani thin
-- (follow_up_on = action_date + 1) aur jinka asli gap 1 din se zyada hai.
-- Jo remark already +1 din wale hain (No Answer, Not Reachable) unhe chheda
-- nahi jaata, aur jo caller ne khud set kiya tha (custom date) wo bhi safe hai.
--
-- Safe to run repeatedly: dusri baar chalane par kuch nahi badalta.
-- ============================================================

-- Remark-wise asli gap (schema me hi, taaki SQL aur application ek rahein)
UPDATE followups
   SET follow_up_on = action_date + 2
 WHERE follow_up_on = action_date + 1
   AND action_type IN ('Will Deposit', 'Play Later', 'Message Done');

UPDATE followups
   SET follow_up_on = action_date + 3
 WHERE follow_up_on = action_date + 1
   AND action_type IN ('Interested', 'Call Done');

UPDATE followups
   SET follow_up_on = action_date + 7
 WHERE follow_up_on = action_date + 1
   AND action_type IN ('Already Active', 'Deposited');

UPDATE followups
   SET follow_up_on = action_date + 15
 WHERE follow_up_on = action_date + 1
   AND action_type = 'Not Interested';

UPDATE followups
   SET follow_up_on = action_date + 30
 WHERE follow_up_on = action_date + 1
   AND action_type = 'Wrong Number';

-- Do Not Contact par koi follow-up nahi
UPDATE followups
   SET follow_up_on = NULL
 WHERE action_type = 'Do Not Contact';

