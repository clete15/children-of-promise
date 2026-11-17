-- Megan Nooney: backup in every room serving birth to 3, so she counts in ExceleRate
-- Standard 4 (she is in classrooms more than 50% of the time, which is when ExceleRate
-- counts a Director/Teacher as teaching staff). Run in SSMS against CofPMillstadt on
-- 160.153.187.39 AFTER deploying + restarting (the server adds the column on start-up;
-- this script adds it too if it is missing). Safe to re-run.
--
-- Rooms 1 Infants INCCRA, 2 Infants / Toddlers PI, 3 Toddlers PI,
-- 4 Toddlers / 2 Year Olds INCCRA, 5 2 Year Olds PI, 7 2 & 3 Year Olds INCCRA.
-- Matched by the room's age range below rather than trusted blindly: the SELECT at the
-- end lists the rooms so you can confirm they are the 0-3 rooms.
SET NOCOUNT ON;
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Staff' AND COLUMN_NAME='BackupRoomNumbers')
    ALTER TABLE Staff ADD BackupRoomNumbers NVARCHAR(100);
GO
UPDATE Staff SET BackupRoomNumbers = N'1,2,3,4,5,7', UpdatedAt = GETDATE()
 WHERE Name = N'Megan Nooney';

-- Verify: Megan's backup rooms, and what those room numbers are.
SELECT Id, Name, Role, BackupRoomNumbers FROM Staff WHERE Name = N'Megan Nooney';
SELECT RoomNumber, Room, AgeRange FROM dimClassrooms WHERE RoomNumber IN (1,2,3,4,5,7) ORDER BY RoomNumber;
