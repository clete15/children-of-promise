-- ESTIMATES for months with no scanned form (Sue, Tara, Paige, Keyona, Lindsey worked every month).
-- Each value = typical hours for that person x their wage that month. These are NOT from a signed form.
--   Nov 1.5/day staff: 28.5 h (19 days, as Renee's Nov form). Dec: 30 h.  Sue: her usual 18 h x $20.
--   Tara/Paige: their usual hours (Tara 34 h, Paige 34-36 h) x wage.
-- Only fills cells that are EMPTY. Never overwrites a scanned or typed value. Run AFTER personnel_activity_fy2025_load.sql.
--   Sue Nov 360, Dec 360 | Tara Nov 629, Aug 637.50 | Raquel left blank (no estimate)
--   Paige Nov 629, Dec 629, Aug 684 | Keyona Nov 565.16, Jan 624.65, Aug 624.65
--   Lindsey Nov 527.25, Feb 555, Mar 610.50
DECLARE @j NVARCHAR(MAX) = (SELECT DataJson FROM dbo.MonthlyReporting WHERE Book=N'personnel' AND FiscalYear=N'2025');
IF @j IS NULL
    SELECT 'NOT UPDATED: no FY2025 personnel sheet found.' AS Result;
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
   AND JSON_VALUE(@j,'$.operational[14].name')=N'Molly')
    SELECT 'NOT UPDATED: staff rows are not in the expected order. Nothing changed.' AS Result;
ELSE
BEGIN
    UPDATE dbo.MonthlyReporting
       SET DataJson = JSON_MODIFY(JSON_MODIFY(JSON_MODIFY(JSON_MODIFY(JSON_MODIFY(JSON_MODIFY(JSON_MODIFY(JSON_MODIFY(JSON_MODIFY(JJJSON_MODIFY(JSON_MODIFY(JSON_MODIFY(JSON_MODIFY(@j,'$.operational[0].cells."11"',ISNULL(NULLIF(JSON_VALUE(@j,'$.operational[0].cells."11"'),''),'360')),'$.operational[0].cells."12"',ISNULL(NULLIF(JSON_VALUE(@j,'$.operational[0].cells."12"'),''),'360')),'$.operational[1].cells."11"',ISNULL(NULLIF(JSON_VALUE(@j,'$.operational[1].cells."11"'),''),'629')),'$.operational[1].cells."8"',ISNULL(NULLIF(JSON_VALUE(@j,'$.operational[1].cells."8"'),''),'637.5')),'$.operational[4].cells."11"',ISNULL(NULLIF(JSON_VALUE(@j,'$.operational[4].cells."11"'),''),'629')),'$.operational[4].cells."12"',ISNULL(NULLIF(JSON_VALUE(@j,'$.operational[4].cells."12"'),''),'629')),'$.operational[4].cells."8"',ISNULL(NULLIF(JSON_VALUE(@j,'$.operational[4].cells."8"'),''),'684')),'$.operational[5].cells."11"',ISNULL(NULLIF(JSON_VALUE(@j,'$.operational[5].cells."11"'),''),'565.16')),'$.operational[5].cells."1"',ISNULL(NULLIF(JSON_VALUE(@j,'$.operational[5].cells."1"'),''),'624.65')),'$.operational[5].cells."8"',ISNULL(NULLIF(JSON_VALUE(@j,'$.operational[5].cells."8"'),''),'624.65')),'$.operational[7].cells."11"',ISNULL(NULLIF(JSON_VALUE(@j,'$.operational[7].cells."11"'),''),'527.25')),'$.operational[7].cells."2"',ISNULL(NULLIF(JSON_VALUE(@j,'$.operational[7].cells."2"'),''),'555')),'$.operational[7].cells."3"',ISNULL(NULLIF(JSON_VALUE(@j,'$.operational[7].cells."3"'),''),'610.5')),
           Version = Version + 1, UpdatedAt = SYSDATETIME(), UpdatedBy = N'scan import (estimates)'
     WHERE Book=N'personnel' AND FiscalYear=N'2025';
    SELECT 'UPDATED: estimates filled into empty cells' AS Result;
END
