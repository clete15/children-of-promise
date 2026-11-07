USE CofPMillstadt;

-- Create dimClassrooms table
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'dimClassrooms')
CREATE TABLE dimClassrooms (
    RoomNumber      INT PRIMARY KEY,
    Building        INT,
    Room            NVARCHAR(100),
    TeacherDescription NVARCHAR(200),
    Type            NVARCHAR(20),
    RequiredSlots   NVARCHAR(10),
    AgeRange        NVARCHAR(50),
    DCFSCapacity    INT
);

-- Clear and reload
DELETE FROM dimClassrooms;

INSERT INTO dimClassrooms (RoomNumber, Building, Room, TeacherDescription, Type, RequiredSlots, AgeRange, DCFSCapacity)
VALUES
-- Names and types as renamed Nov 2026 (rename_rooms_2026_11.sql).
(1, 1, 'Infants / Toddlers INCCRA',       'Tara / Sue',          'INCCRA', '4',   '0 - 12 Months',  5),
(2, 1, 'Infants / Toddlers PI',           'Paige / Sue',         'PI',     '5',   '8 - 20 Months',  7),
(3, 1, 'Toddlers / 2 Year Olds PI',       'Megan / New Teacher', 'PI',     '5',   '15 - 24 Months', 6),
(4, 2, 'Toddlers / 2 Year Olds INCCRA',   'Renee / Raquel',      'INCCRA', '5',   '18 - 36 Months', 8),
(5, 2, '2 Year Olds',                     'Janelle / Renee',     'PI',     '9',   '24 - 36 Months', 8),
(6, 1, 'Pre-School PFA',                  'Keyona / Maddie',     'PFA',    '15',  '3 to 5 yrs',     18),
(7, 1, '2 & 3 Year Olds INCCRA',          'Janelle',             'INCCRA', '8',   '24 - 48 Months', 8),
(8, 1, 'Before and Afterschool',  'Pam / Jeremy / Sara', 'n/a',    'n/a', '5 to 12 yrs',    20);

PRINT 'dimClassrooms loaded successfully.';
