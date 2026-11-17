-- Molly Ellis: record her Infant/Toddler CDA and what Gateways is waiting on.
-- Run in SSMS against CofPMillstadt on 160.153.187.39. Safe to re-run.
--
-- "Infant/Toddler CDA" goes on Credentials held, which is what the staff portal reads
-- (it then counts the CDA's ECE competencies, FCR1 and PPD1, toward ECE Level 2).
-- The note starts with "Office note:" so the Gateways Staff Attainments refresh keeps
-- it; that refresh replaces the rest of the Notes field from the report.
-- It contains "awaiting", so her page shows the "Gateways is waiting on something" box.
SET NOCOUNT ON;

UPDATE Staff
   SET EceCredentials = CASE
           WHEN ISNULL(EceCredentials,'') LIKE '%CDA%' THEN EceCredentials
           WHEN ISNULL(EceCredentials,'') = '' THEN N'Infant/Toddler CDA'
           ELSE EceCredentials + N', Infant/Toddler CDA' END,
       Notes = CASE
           WHEN ISNULL(Notes,'') LIKE '%cdaclass%' THEN Notes
           ELSE N'Office note: Gateways is awaiting Molly''s Certificate of Completed Hours from CDA Class for her 120 Infant/Toddler CDA training hours; once it arrives Gateways decides what they count toward (cdaclass.org).'
                + CASE WHEN ISNULL(Notes,'') = '' THEN N'' ELSE N' ' + Notes END END,
       UpdatedAt = GETDATE()
 WHERE Name = N'Molly Ellis';

-- Verify: one row, with the CDA and the note.
SELECT Id, Name, EceCredentials, Notes FROM Staff WHERE Name = N'Molly Ellis';
