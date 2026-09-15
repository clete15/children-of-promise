USE CofPMillstadt;

/* ─────────────────────────────────────────────────────────────────────────────
   Room rename + staff realignment — 2026-2027

   RUN ONCE (SSMS). Safe to re-run: every statement is written to be idempotent,
   so running it a second time changes nothing.

   ── APPLIED 13 Sep 2026 (dimClassrooms only). ──────────────────────────────
   Sections 2 and 3 below were written against a schema this database does NOT
   have: there is no rptMasterEnrollment.Room column and no Staff table (staff
   data lives elsewhere). Because this file has no GO separators it is ONE batch,
   and SQL Server compiles a whole batch before running any of it — so the
   "Invalid column name 'Room'" on the rptMasterEnrollment.Room UPDATE aborted the
   entire script and the dimClassrooms renames silently never ran (which is why
   the attendance pages still showed "Pre-School 2" at capacity 12). Section 1 was
   therefore run on its own and IS applied. Sections 2 and 3 are kept below only as
   a record of intent; leave them commented out unless those objects are added.
   ───────────────────────────────────────────────────────────────────────────

   Two rooms are renamed. Room identity is the integer RoomNumber, which nothing
   here touches — so every child, report, roster, meal count and the attendance
   chart follow the new names automatically (they all join on RoomNumber, never on
   the name string).

     Room 4:  "2 Year Olds / Toddlers"  ->  "Toddlers / 2 Year Olds"
              (re-ordered to read youngest-first, matching "Infants / Toddlers")

     Room 7:  "Pre-School 2"            ->  "2 & 3 Year Olds"
              (converted from a second pre-school room into a 2s-and-3s room;
               AgeRange "3 to 5 yrs" -> "24 - 48 Months"; DCFSCapacity 12 -> 8.
               The lower capacity flows to the attendance chart and every other
               place automatically, because they all read DCFSCapacity by RoomNumber.)

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
       AgeRange = '24 - 48 Months',
       DCFSCapacity = 8,     -- was 12 as Pre-School 2; a 2s-and-3s room licenses 8
       RequiredSlots = '8'   -- kept in step with the licensed capacity
 WHERE RoomNumber = 7;

-- ── 2. Legacy rptMasterEnrollment.Room string — NOT APPLICABLE HERE ──
--    This DB's rptMasterEnrollment has no Room column (every join uses RoomNumber),
--    so these updates fail to compile and abort the batch. Left commented out.
-- UPDATE rptMasterEnrollment
--    SET Room = 'Toddlers / 2 Year Olds'
--  WHERE Room = '2 Year Olds / Toddlers';
--
-- UPDATE rptMasterEnrollment
--    SET Room = '2 & 3 Year Olds'
--  WHERE Room = 'Pre-School 2';

-- ── 3. Staff.Classroom realignment — NOT APPLICABLE HERE ──
--    This DB has no Staff table (staff data lives elsewhere), so these fail to
--    compile and abort the batch. Left commented out. If a Staff table with
--    Classroom / SecondaryClassroom is ever added, re-enable and run these.
-- UPDATE Staff SET Classroom = 'Toddlers / 2 Year Olds' WHERE Classroom = '2 Year Olds / Toddlers';
-- UPDATE Staff SET Classroom = '2 & 3 Year Olds'        WHERE Classroom = 'Pre-School 2';
-- UPDATE Staff SET SecondaryClassroom = 'Toddlers / 2 Year Olds' WHERE SecondaryClassroom = '2 Year Olds / Toddlers';
-- UPDATE Staff SET SecondaryClassroom = '2 & 3 Year Olds'        WHERE SecondaryClassroom = 'Pre-School 2';

-- ── 4. Show the result ──
SELECT RoomNumber, Room, TeacherDescription, Type, AgeRange, DCFSCapacity
  FROM dimClassrooms
 ORDER BY RoomNumber;
