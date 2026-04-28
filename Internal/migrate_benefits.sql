USE CofPMillstadt;

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='rptMasterEnrollment' AND COLUMN_NAME='PublicBenefits')
    ALTER TABLE rptMasterEnrollment ADD PublicBenefits NVARCHAR(500);

PRINT 'PublicBenefits column added to rptMasterEnrollment.';
