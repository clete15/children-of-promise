USE CofPMillstadt;

/* Repair dimClassrooms.TeacherDescription from the Staff room links.
   -----------------------------------------------------------------
   Safe to run any time. Touches ONE column and nothing else: no DELETE, no
   change to room names, capacities or age ranges. (Do NOT use
   setup_classrooms.sql for this -- it deletes and reseeds every room.)

   Why this exists: the captions had drifted from reality. Room 3 still read
   "Megan / New Teacher" long after Lindsey took the room, and room 5 read
   "Janelle / Renee" when Molly has it. That text is what parent permission
   slips and the PFA/PI forms print, so a stale caption is a wrong name on a
   document we hand a family.

   /api/classrooms now derives the caption from the Staff links on every read,
   so the app is already correct without this. This fixes the STORED column,
   which is both the fallback if that read ever fails and what the two queries
   that join dimClassrooms directly (/api/students and the parent portal child
   lookup) still show.

   The rule, identical to roomCaptionRebuildSQL() in server.js:
     - a person is in a room if either link points at it, RoomNumber (first
       slot) or SecondaryRoomNumber (second slot)
     - active staff only, first names, joined with ' / ', first-slot holders
       listed first then by staff Id
     - a room with NO linked staff is left alone, not blanked. A blank teacher
       line on a parent document is worse than an old one, and an unstaffed
       room is a gap to fix on the staff card.

   So if a room still looks wrong after this, the staff links are wrong: fix
   the person's room on their staff card, or the Teacher 1 / Teacher 2
   dropdowns in Settings > Classrooms, which writes the same links. */

-- Before
SELECT 'BEFORE' AS Stage, RoomNumber, Room, TeacherDescription
FROM dimClassrooms ORDER BY RoomNumber;

UPDATE c SET TeacherDescription = x.Names
FROM dimClassrooms c
CROSS APPLY (
    SELECT STUFF((
        SELECT ' / ' + LEFT(LTRIM(s.Name), CASE WHEN CHARINDEX(' ', LTRIM(s.Name)) > 0
                                                THEN CHARINDEX(' ', LTRIM(s.Name)) - 1
                                                ELSE LEN(LTRIM(s.Name)) END)
        FROM Staff s
        WHERE (s.RoomNumber = c.RoomNumber OR s.SecondaryRoomNumber = c.RoomNumber)
          AND ISNULL(s.Active,1)=1
          AND LTRIM(RTRIM(ISNULL(s.Name,''))) <> ''
        ORDER BY CASE WHEN s.RoomNumber = c.RoomNumber THEN 0 ELSE 1 END, s.Id
        FOR XML PATH(''), TYPE
    ).value('.', 'NVARCHAR(MAX)'), 1, 3, '') AS Names
) x
WHERE x.Names IS NOT NULL AND x.Names <> '';

/* After, with the staff actually linked to each room beside the caption, so a
   room that did not change can be told apart from one with nobody linked.
   Always read this output: a POST /api/sql batch reports success even when a
   statement inside it failed, so the SELECT is the proof. */
SELECT 'AFTER' AS Stage, c.RoomNumber, c.Room, c.TeacherDescription,
       ISNULL(STUFF((
           SELECT ', ' + s.Name
                  + CASE WHEN s.RoomNumber = c.RoomNumber THEN ' (1st)' ELSE ' (2nd)' END
           FROM Staff s
           WHERE (s.RoomNumber = c.RoomNumber OR s.SecondaryRoomNumber = c.RoomNumber)
             AND ISNULL(s.Active,1)=1
           ORDER BY CASE WHEN s.RoomNumber = c.RoomNumber THEN 0 ELSE 1 END, s.Id
           FOR XML PATH(''), TYPE
       ).value('.', 'NVARCHAR(MAX)'), 1, 2, ''), '(nobody linked - caption left as-is)')
           AS LinkedStaff
FROM dimClassrooms c
ORDER BY c.RoomNumber;
