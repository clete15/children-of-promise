-- Add September 2026 to the FY 2025-26 Personnel Activity sheet (scan pages 115-125).
-- Run on the VPS database (CofPMillstadt). Only touches the Sep cells; every other cell is left as saved.
-- Refuses to run if the row order on the sheet was changed (so it can never write into the wrong person).
DECLARE @j NVARCHAR(MAX) = (SELECT DataJson FROM dbo.MonthlyReporting WHERE Book=N'personnel' AND FiscalYear=N'2025');
IF @j IS NULL
    SELECT 'NOT UPDATED: no FY2025 personnel sheet found. Run personnel_activity_fy2025_load.sql first.' AS Result;
ELSE IF NOT (JSON_VALUE(@j,'$.operational[0].name')=N'Sue'
   AND JSON_VALUE(@j,'$.operational[1].name')=N'Tara'
   AND JSON_VALUE(@j,'$.operational[2].name')=N'Raquel'
   AND JSON_VALUE(@j,'$.operational[3].name')=N'Megan'
   AND JSON_VALUE(@j,'$.operational[4].name')=N'Paige'
   AND JSON_VALUE(@j,'$.operational[5].name')=N'Keyona'
   AND JSON_VALUE(@j,'$.operational[6].name')=N'Janell'
   AND JSON_VALUE(@j,'$.operational[7].name')=N'Lindsey'
   AND JSON_VALUE(@j,'$.operational[8].name')=N'Renee'
   AND JSON_VALUE(@j,'$.operational[9].name')=N'Jeremy'
   AND JSON_VALUE(@j,'$.operational[10].name')=N'Sara Holliday- Operational'
   AND JSON_VALUE(@j,'$.operational[11].name')=N'Madeline'
   AND JSON_VALUE(@j,'$.operational[12].name')=N'Velouria'
   AND JSON_VALUE(@j,'$.operational[13].name')=N'Hannah'
   AND JSON_VALUE(@j,'$.operational[14].name')=N'Molly'
   AND JSON_VALUE(@j,'$.admin[0].name')=N'Sara Holliday-Admin')
    SELECT 'NOT UPDATED: the staff rows on the sheet are not in the expected order. Nothing changed.' AS Result;
ELSE
BEGIN
    UPDATE dbo.MonthlyReporting
       SET DataJson = JSON_MODIFY(JSON_MODIFY(JSON_MODIFY(JSON_MODIFY(JSON_MODIFY(JSON_MODIFY(JSON_MODIFY(JSON_MODIFY(JSON_MODIFY(JSON_MODIFY(JSON_MODIFY(JSON_MODIFY(@j,'$.operational[0].cells."9"','360'),'$.operational[1].cells."9"','646'),'$.operational[3].cells."9"','570.15'),'$.operational[4].cells."9"','798'),'$.operational[5].cells."9"','632.21'),'$.operational[7].cells."9"','598.5'),'$.operational[8].cells."9"','567'),'$.operational[9].cells."9"','598.5'),'$.operational[10].cells."9"','750.5'),'$.operational[11].cells."9"','582.75'),'$.operational[14].cells."9"','582.75'),'$.admin[0].cells."9"','57'),
           Version = Version + 1, UpdatedAt = SYSDATETIME(), UpdatedBy = N'scan import (Sep)'
     WHERE Book=N'personnel' AND FiscalYear=N'2025';
    SELECT 'UPDATED: September added' AS Result;
END
GO
SELECT Version, UpdatedBy, JSON_VALUE(DataJson,'$.operational[1].cells."9"') AS TaraSep, JSON_VALUE(DataJson,'$.admin[0].cells."9"') AS SaraAdminSep FROM dbo.MonthlyReporting WHERE Book=N'personnel';
