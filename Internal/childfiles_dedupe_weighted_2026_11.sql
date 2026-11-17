/* One-off cleanup: ChildFiles holds ~71 WeightedEligibility/generated rows for ~17 children
   (a backfill re-indexed repeatedly). Keeps the NEWEST row per child, deletes the rest.

   Deletes INDEX rows only. No PDF on disk is touched, and the newest row is the one the
   app already points at (indexWeightedEligibilityDoc now deletes before inserting, so this
   cannot grow back).

   Run against CofPMillstadt on the VPS (160.153.187.39,1433). Run STEP 1 first and look. */

USE CofPMillstadt;
GO

-- STEP 1: what would go. "keep" = 1 is the row that stays.
SELECT StudentId, Id, FileName, UploadedAt,
       CASE WHEN ROW_NUMBER() OVER (PARTITION BY StudentId ORDER BY UploadedAt DESC, Id DESC) = 1 THEN 1 ELSE 0 END AS keep
FROM ChildFiles
WHERE FormField = 'WeightedEligibility' AND Kind = 'generated'
ORDER BY StudentId, UploadedAt DESC, Id DESC;
GO

-- STEP 2: delete the older rows.
DELETE c
FROM ChildFiles c
JOIN (
    SELECT Id, ROW_NUMBER() OVER (PARTITION BY StudentId ORDER BY UploadedAt DESC, Id DESC) AS rn
    FROM ChildFiles
    WHERE FormField = 'WeightedEligibility' AND Kind = 'generated'
) x ON x.Id = c.Id
WHERE x.rn > 1;
GO

-- STEP 3: verify. Every child should now have exactly 1 row (rows = children).
SELECT COUNT(*) AS rows_left, COUNT(DISTINCT StudentId) AS children
FROM ChildFiles
WHERE FormField = 'WeightedEligibility' AND Kind = 'generated';
GO
