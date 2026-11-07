USE CofPMillstadt;

/* ─────────────────────────────────────────────────────────────────────────────
   Room rename + program types — Nov 2026

   RUN ONCE in SSMS against CofPMillstadt (160.153.187.39,1433). Safe to re-run:
   it sets fixed values by RoomNumber, so a second run changes nothing.

   Room identity is the integer RoomNumber, which nothing here touches. Children,
   staff links, attendance, projection, meal counts and every report join on the
   number, so they all follow the new names automatically. The four places that used
   to match on the NAME (vision/hearing screening, the infant/toddler credential
   alert, the ExceleRate IT count, and attendance pairing/age labels) were switched to
   RoomNumber in the same change that added this file, so a rename cannot silently
   break them. Deploy that change first.

   Type is the room's program. It drives the green/red PI/PFA counts on the Room
   Roster and Attendance, and the Room Roster's order (INCCRA, then PI, then PFA).

     Room  Was                       Now                                Type
     1     Infant                    Infants / Toddlers - INCCRA        INCCRA
     2     Infants / Toddlers        Infants / Toddlers - PI            PI
     3     Toddlers                  Toddlers / 2 Year Olds - PI        PI
     4     Toddlers / 2 Year Olds    Toddlers / 2 Year Olds - INCCRA    INCCRA
     7     2 & 3 Year Olds           2 & 3 Year Olds - INCCRA           INCCRA
     6     Pre-School                Pre-School - PFA                   PFA
     5     2 Year Olds               (unchanged)
     8     Before and Afterschool    (unchanged)

   Age ranges and capacities are NOT changed here.
   ───────────────────────────────────────────────────────────────────────────── */

SET XACT_ABORT ON;
BEGIN TRAN;

UPDATE dimClassrooms SET Room = N'Infants / Toddlers - INCCRA',     Type = N'INCCRA' WHERE RoomNumber = 1;
UPDATE dimClassrooms SET Room = N'Infants / Toddlers - PI',         Type = N'PI'     WHERE RoomNumber = 2;
UPDATE dimClassrooms SET Room = N'Toddlers / 2 Year Olds - PI',     Type = N'PI'     WHERE RoomNumber = 3;
UPDATE dimClassrooms SET Room = N'Toddlers / 2 Year Olds - INCCRA', Type = N'INCCRA' WHERE RoomNumber = 4;
UPDATE dimClassrooms SET Room = N'2 & 3 Year Olds - INCCRA',        Type = N'INCCRA' WHERE RoomNumber = 7;
UPDATE dimClassrooms SET Room = N'Pre-School - PFA',                Type = N'PFA'    WHERE RoomNumber = 6;

COMMIT;
GO

/* Staff link to rooms by RoomNumber; Classroom / SecondaryClassroom are only text
   labels mirrored from dimClassrooms. Refresh them so they show the new names (the
   Classrooms & Staffing page does this itself when it renames; a direct SQL rename
   has to do it here). Its own batch, so the renames above stand even if this fails. */
IF OBJECT_ID(N'dbo.Staff', N'U') IS NOT NULL
BEGIN
    UPDATE s SET Classroom = c.Room
      FROM dbo.Staff s JOIN dbo.dimClassrooms c ON c.RoomNumber = s.RoomNumber;
    UPDATE s SET SecondaryClassroom = c.Room
      FROM dbo.Staff s JOIN dbo.dimClassrooms c ON c.RoomNumber = s.SecondaryRoomNumber;
END
GO

-- Show the result: check the names and types read as intended.
SELECT RoomNumber, Room, Type, AgeRange, DCFSCapacity, TeacherDescription
  FROM dimClassrooms
 ORDER BY RoomNumber;
