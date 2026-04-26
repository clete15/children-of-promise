USE CofPMillstadt;

-- Update old room names to match new dimClassrooms room names
UPDATE rptMasterEnrollment SET Room = 'Toddlers'               WHERE Room IN ('Toddlers / 2s', 'Infants / Toddlers' );
UPDATE rptMasterEnrollment SET Room = 'Infants / Toddlers'     WHERE Room = 'Infant' AND Days_Old > 90;
UPDATE rptMasterEnrollment SET Room = '2 Year Olds / Toddlers' WHERE Room = '2 Year Olds - 1';
UPDATE rptMasterEnrollment SET Room = '2 Year Olds'            WHERE Room = '2 Year Olds - 2';

SELECT Room, COUNT(*) as Count FROM rptMasterEnrollment GROUP BY Room ORDER BY Room;
