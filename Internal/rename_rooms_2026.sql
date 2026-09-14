USE CofPMillstadt;

/* ─────────────────────────────────────────────────────────────────────────────
   Room rename + staff realignment — 2026-2027

   RUN ONCE (SSMS). Safe to re-run: every statement is written to be idempotent,
   so running it a second time changes nothing.

   Two rooms are renamed. Room identity is the integer RoomNumber, which nothing
   here touches — so every child, report, roster, meal count and the attendance
   chart follow the new names automatically (they all join on RoomNumber, never on
   the name string).

     Room 4:  "2 Year Olds / Toddlers"  ->  "Toddlers / 2 Year Olds"
              (re-ordered to read youngest-first, matching "Infants / Toddlers")

     Room 7:  "Pre-School 2"            ->  "2 & 3 Year Olds"
              (converted from a second pre-school room into a 2s-and-3s room;
               AgeRange updated from "3 to 5 yrs" to "24 - 48 Months")

   The ONE place that matches a room by NAME rather than by number is the PAS
   cross-check, which compares each staff member's free-text Classroom against the
   classroom names. So the staff Classroom values that pointed at the old names are
   realigned below, to keep that panel consistent.
   ───────────────────────────────────────────────────────────────────────────── */

-- ── 1. dimClassrooms: the display names (keyed on the stable RoomNumber) ──
UPDATE dimClassrooms
   SET Room = 'Toddlers / 2 Year Olds'
 WHERE RoomNumber = 4;

UPDATE dimClassrooms
   SET Room = '2 & 3 Year Olds',
       AgeRange = '24 - 48 Months'
 WHERE RoomNumber = 7;

-- ── 2. Legacy rptMasterEnrollment.Room string ──
--    This column is not read at runtime (every join uses RoomNumber), but it is
--    kept truthful so a future ad-hoc query on it does not see a stale name.
UPDATE rptMasterEnrollment
   SET Room = 'Toddlers / 2 Year Olds'
 WHERE Room = '2 Year Olds / Toddlers';

UPDATE rptMasterEnrollment
   SET Room = '2 & 3 Year Olds'
 WHERE Room = 'Pre-School 2';

-- ── 3. Staff.Classroom realignment (only the free-text room name the PAS
--    cross-check compares against; RoomNumber is not stored on staff) ──
--    Guarded on the OLD value so re-running or a manual later edit is not clobbered.

-- Renee Nier — sole staff in room 4.
UPDATE Staff
   SET Classroom = 'Toddlers / 2 Year Olds'
 WHERE Classroom = '2 Year Olds / Toddlers';

-- Whoever is still recorded in the old "Pre-School 2" (room 7) follows the rename.
UPDATE Staff
   SET Classroom = '2 & 3 Year Olds'
 WHERE Classroom = 'Pre-School 2';

UPDATE Staff
   SET SecondaryClassroom = 'Toddlers / 2 Year Olds'
 WHERE SecondaryClassroom = '2 Year Olds / Toddlers';

UPDATE Staff
   SET SecondaryClassroom = '2 & 3 Year Olds'
 WHERE SecondaryClassroom = 'Pre-School 2';

-- ── 4. Show the result ──
SELECT RoomNumber, Room, TeacherDescription, Type, AgeRange, DCFSCapacity
  FROM dimClassrooms
 ORDER BY RoomNumber;

SELECT Name, Role, Classroom, SecondaryClassroom
  FROM Staff
 WHERE ISNULL(Active, 1) = 1
 ORDER BY Classroom, Name;
