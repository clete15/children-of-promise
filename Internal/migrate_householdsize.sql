USE CofPMillstadt;

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='HouseholdSize')
    ALTER TABLE PreEnrollment ADD HouseholdSize INT;
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='rptMasterEnrollment' AND COLUMN_NAME='HouseholdSize')
    ALTER TABLE rptMasterEnrollment ADD HouseholdSize INT;

PRINT 'HouseholdSize column added.';
