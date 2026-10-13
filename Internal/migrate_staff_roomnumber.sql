/* =============================================================================
   Staff room-link migration — one-time, REVIEW FIRST
   =============================================================================
   Purpose: give each staff member ID-based links to their classrooms, replacing
   the fragile match on room NAME:
     Staff.RoomNumber          -> dimClassrooms.RoomNumber   (PRIMARY room,  Teacher 1)
     Staff.SecondaryRoomNumber -> dimClassrooms.RoomNumber   (SECONDARY room, Teacher 2)
   After this, a room can be renamed in ONE place (dimClassrooms.Room) and every
   page follows automatically; the Classroom / SecondaryClassroom text columns are
   kept only as readable mirrors.

   Run order on the VPS (SSMS, database CofPMillstadt):
     STEP 1  — add the columns. Safe, idempotent, touches no data.
     STEP 2  — REPORT ONLY. Shows what the backfill WOULD do for BOTH links.
               Eyeball it; note any row that resolves to NULL (hand-set in STEP 3).
     STEP 3  — the actual backfill. Run ONLY after STEP 2 looks right.
     STEP 4  — verification. Final state + anything still unmatched.

   Nothing here is destructive: STEP 1 only adds nullable columns, STEP 3 only sets
   the link columns (it never clears the Classroom/SecondaryClassroom mirrors).
   ============================================================================= */

USE CofPMillstadt;
GO

/* ---------------------------------------------------------------------------
   STEP 1 — add the columns (idempotent)
   --------------------------------------------------------------------------- */
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
               WHERE TABLE_NAME='Staff' AND COLUMN_NAME='RoomNumber')
    ALTER TABLE Staff ADD RoomNumber INT NULL;
GO
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
               WHERE TABLE_NAME='Staff' AND COLUMN_NAME='SecondaryRoomNumber')
    ALTER TABLE Staff ADD SecondaryRoomNumber INT NULL;
GO

/* ---------------------------------------------------------------------------
   Note on the normalizer used below (in STEP 2's report and STEP 3's backfill):
   it folds the differences that make exact-match fail, without being so loose
   that two genuinely different rooms collide — lower-cased, '&' -> 'and', slashes
   and dashes and spaces removed. So "Infants / Toddlers" -> "infantstoddlers".
   It is a reconciliation aid for EXISTING rows only; it is NEVER used at runtime.
   --------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
   STEP 2 — REPORT ONLY (no writes). Review this output before STEP 3.
   One row per staff member showing BOTH links. For each of primary (from the
   Classroom text) and secondary (from SecondaryClassroom text):
     exact      — text equals a dimClassrooms.Room exactly
     normalized — matches after folding case / '&' / slashes / spaces
     NONE       — no room matched; needs a hand-set line in STEP 3
     (blank)    — that text is empty on purpose; left NULL, fine
   --------------------------------------------------------------------------- */
;WITH Rn AS (
    SELECT RoomNumber, Room,
           LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
               Room,' ',''),'&','and'),'/',''),'-',''),'.','')) AS RoomKey
    FROM dimClassrooms
),
St AS (
    SELECT Id, Name, Classroom, SecondaryClassroom,
           LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
               ISNULL(Classroom,''),' ',''),'&','and'),'/',''),'-',''),'.','')) AS PriKey,
           LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
               ISNULL(SecondaryClassroom,''),' ',''),'&','and'),'/',''),'-',''),'.','')) AS SecKey
    FROM Staff
    WHERE ISNULL(Active,1)=1
)
SELECT
    St.Id,
    St.Name,
    St.Classroom                                     AS PrimaryText,
    COALESCE(pe.RoomNumber, pn.RoomNumber)           AS WouldSetRoomNumber,
    CASE
        WHEN NULLIF(St.PriKey,'') IS NULL            THEN '(blank)'
        WHEN pe.RoomNumber IS NOT NULL               THEN 'exact'
        WHEN pn.RoomNumber IS NOT NULL               THEN 'normalized'
        ELSE 'NONE - hand-set'
    END                                              AS PrimaryMatch,
    St.SecondaryClassroom                            AS SecondaryText,
    COALESCE(se.RoomNumber, sn.RoomNumber)           AS WouldSetSecondaryRoomNumber,
    CASE
        WHEN NULLIF(St.SecKey,'') IS NULL            THEN '(blank)'
        WHEN se.RoomNumber IS NOT NULL               THEN 'exact'
        WHEN sn.RoomNumber IS NOT NULL               THEN 'normalized'
        ELSE 'NONE - hand-set'
    END                                              AS SecondaryMatch
FROM St
LEFT JOIN Rn pe ON pe.Room    = St.Classroom
LEFT JOIN Rn pn ON pn.RoomKey = St.PriKey AND NULLIF(St.PriKey,'') IS NOT NULL
LEFT JOIN Rn se ON se.Room    = St.SecondaryClassroom
LEFT JOIN Rn sn ON sn.RoomKey = St.SecKey AND NULLIF(St.SecKey,'') IS NOT NULL
ORDER BY St.Name;
GO

/* =============================================================================
   STEP 3 — BACKFILL  (run ONLY after STEP 2 looks correct)
   =============================================================================
   3a. Set RoomNumber + SecondaryRoomNumber for rows the normalizer matched.
   3b. Hand-set the known oddballs the normalizer can't safely resolve.
   Both are re-runnable; 3a only fills link columns that are still NULL, so it
   never overwrites a value you set by hand.
   ----------------------------------------------------------------------------- */

/* 3a — PRIMARY: exact first, then normalized, only where RoomNumber still NULL. */
UPDATE s SET s.RoomNumber = r.RoomNumber
  FROM Staff s JOIN dimClassrooms r ON r.Room = s.Classroom
 WHERE s.RoomNumber IS NULL AND NULLIF(LTRIM(RTRIM(s.Classroom)),'') IS NOT NULL;

UPDATE s SET s.RoomNumber = r.RoomNumber
  FROM Staff s JOIN dimClassrooms r
    ON LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(r.Room,' ',''),'&','and'),'/',''),'-',''),'.','')
       ) = LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(s.Classroom,' ',''),'&','and'),'/',''),'-',''),'.',''))
 WHERE s.RoomNumber IS NULL AND NULLIF(LTRIM(RTRIM(s.Classroom)),'') IS NOT NULL;

/* 3a — SECONDARY: same, from the SecondaryClassroom text. */
UPDATE s SET s.SecondaryRoomNumber = r.RoomNumber
  FROM Staff s JOIN dimClassrooms r ON r.Room = s.SecondaryClassroom
 WHERE s.SecondaryRoomNumber IS NULL AND NULLIF(LTRIM(RTRIM(s.SecondaryClassroom)),'') IS NOT NULL;

UPDATE s SET s.SecondaryRoomNumber = r.RoomNumber
  FROM Staff s JOIN dimClassrooms r
    ON LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(r.Room,' ',''),'&','and'),'/',''),'-',''),'.','')
       ) = LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(s.SecondaryClassroom,' ',''),'&','and'),'/',''),'-',''),'.',''))
 WHERE s.SecondaryRoomNumber IS NULL AND NULLIF(LTRIM(RTRIM(s.SecondaryClassroom)),'') IS NOT NULL;
GO

/* 3b — hand-set the known oddballs STEP 2 flags as NONE. Confirmed against the
   Classrooms & Staffing chart (Teacher 1 = primary, Teacher 2 = secondary):

     - Donna Nier: primary room 4 "Toddlers / 2 Year Olds" (Teacher 1 of 4),
       secondary room 5 "2 Year Olds" (Teacher 2 of 5). Her stored text may read
       "2 Years / Toddlers" (word order + plural), which the normalizer can't fold.
     - "Infant/Toddler" (Paige, Sue Engel) -> room 2 "Infants / Toddlers" as
       primary (3a's normalized pass likely already handles this; kept as a safety
       net). The person seeded as "Paige Turner" is now on the roster as "Paige
       Holliday" after a name change, so BOTH names are listed to cover either.

   Each line is guarded by name AND by the link being NULL, so running 3b twice is
   a no-op and it never fights a value 3a already set. Adjust/extend to whatever
   STEP 2 reports as NONE.
   ----------------------------------------------------------------------------- */
UPDATE Staff SET RoomNumber = 4
 WHERE RoomNumber IS NULL AND Name = 'Donna Nier';
UPDATE Staff SET SecondaryRoomNumber = 5
 WHERE SecondaryRoomNumber IS NULL AND Name = 'Donna Nier';

UPDATE Staff SET RoomNumber = 2
 WHERE RoomNumber IS NULL AND Name IN ('Paige Turner', 'Paige Holliday', 'Sue Engel');
GO

/* =============================================================================
   STEP 4 — VERIFY
   =============================================================================
   First result: both links for every active staff member, with the room names
   they resolve to. Second result: anyone still unmatched who HAS classroom text
   in either slot (these need another 3b line). A blank-room Director showing NULL
   is expected and fine.
   ----------------------------------------------------------------------------- */
SELECT s.Id, s.Name,
       s.Classroom          AS PrimaryText,   s.RoomNumber,          rp.Room AS PrimaryRoom,
       s.SecondaryClassroom AS SecondaryText, s.SecondaryRoomNumber, rs.Room AS SecondaryRoom
  FROM Staff s
  LEFT JOIN dimClassrooms rp ON rp.RoomNumber = s.RoomNumber
  LEFT JOIN dimClassrooms rs ON rs.RoomNumber = s.SecondaryRoomNumber
 WHERE ISNULL(s.Active,1)=1
 ORDER BY s.Name;

SELECT s.Id, s.Name, s.Classroom AS UnmatchedPrimary, s.SecondaryClassroom AS UnmatchedSecondary
  FROM Staff s
 WHERE ISNULL(s.Active,1)=1
   AND ( (s.RoomNumber IS NULL          AND NULLIF(LTRIM(RTRIM(s.Classroom)),'')          IS NOT NULL)
      OR (s.SecondaryRoomNumber IS NULL AND NULLIF(LTRIM(RTRIM(s.SecondaryClassroom)),'') IS NOT NULL) )
 ORDER BY s.Name;
GO
