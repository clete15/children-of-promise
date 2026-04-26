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
(1, 1, 'Infant',                  'Tara / Sue',          'PI',     '4',   '0 - 12 Months',  5),
(2, 1, 'Infants / Toddlers',      'Paige / Sue',         'PI',     '5',   '8 - 20 Months',  7),
(3, 1, 'Toddlers',                'Megan / New Teacher', 'INCCRA', '5',   '15 - 24 Months', 6),
(4, 2, '2 Year Olds / Toddlers',  'Renee / Raquel',      'INCCRA', '5',   '18 - 36 Months', 8),
(5, 2, '2 Year Olds',             'Janelle / Renee',     'PI',     '9',   '24 - 36 Months', 8),
(6, 1, 'Pre-School',              'Keyona / Maddie',     'PFA',    '15',  '3 to 5 yrs',     18),
(7, 1, 'Pre-School 2',            'Lindsey',             'INCCRA', '12',  '3 to 5 yrs',     12),
(8, 1, 'Before and Afterschool',  'Pam / Jeremy / Sara', 'n/a',    'n/a', '5 to 12 yrs',    20);

PRINT 'dimClassrooms loaded successfully.';
