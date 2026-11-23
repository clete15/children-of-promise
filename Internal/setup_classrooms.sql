USE CofPMillstadt;

/* ============================================================================
   CAUTION: this DELETEs every row before reloading, so running it resets room
   names, capacities and age ranges to whatever is typed below. It is a
   first-time setup script, not a repair tool.

   THERE IS NO TEACHER COLUMN HERE ANY MORE. A room's teachers are the Staff
   rows linked to it (Staff.RoomNumber = first slot, SecondaryRoomNumber =
   second) and nothing else; see roomTeacherCaptions in server.js. To set who
   teaches a room, use the Teacher 1 / Teacher 2 dropdowns in Settings >
   Classrooms, or the person's own staff card.

   dimClassrooms.TeacherDescription used to hold a hand-typed copy of those
   names. It drifted — room 3 still read "Megan / New Teacher" long after
   Lindsey took it, and that text printed on parent permission slips. Nothing
   reads or writes it now. The column may still exist on an older database,
   orphaned and harmless; do not start using it again.
   ============================================================================ */

-- Create dimClassrooms table
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'dimClassrooms')
CREATE TABLE dimClassrooms (
    RoomNumber      INT PRIMARY KEY,
    Building        INT,
    Room            NVARCHAR(100),
    Type            NVARCHAR(20),
    RequiredSlots   NVARCHAR(10),
    AgeRange        NVARCHAR(50),
    DCFSCapacity    INT
);

-- Clear and reload
DELETE FROM dimClassrooms;

INSERT INTO dimClassrooms (RoomNumber, Building, Room, Type, RequiredSlots, AgeRange, DCFSCapacity)
VALUES
-- Names and types as renamed Nov 2026 (rename_rooms_2026_11.sql). No teachers here:
-- link the staff to the room instead (see the note at the top of this file).
(1, 1, 'Infants INCCRA',                'INCCRA', '4',   '0 - 15 Months',  5),
(2, 1, 'Infants / Toddlers PI',         'PI',     '5',   '8 - 20 Months',  7),
(3, 1, 'Toddlers PI',                   'PI',     '5',   '15 - 24 Months', 6),
(4, 2, 'Toddlers / 2 Year Olds INCCRA', 'INCCRA', '5',   '16 - 36 Months', 8),
(5, 2, '2 Year Olds PI',                'PI',     '9',   '24 - 36 Months', 8),
(6, 1, 'Pre-School PFA',                'PFA',    '15',  '3 to 5 yrs',     18),
(7, 1, '2 & 3 Year Olds INCCRA',        'INCCRA', '8',   '24 - 48 Months', 8),
(8, 1, 'Before and Afterschool',        'n/a',    'n/a', '5 to 12 yrs',    20);

PRINT 'dimClassrooms loaded successfully.';
