USE CofPMillstadt;

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='rptMasterEnrollment' AND COLUMN_NAME='HouseholdIncome')
    ALTER TABLE rptMasterEnrollment ADD HouseholdIncome NVARCHAR(200);
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='rptMasterEnrollment' AND COLUMN_NAME='ProofOfIncomeFile')
    ALTER TABLE rptMasterEnrollment ADD ProofOfIncomeFile NVARCHAR(500);
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='rptMasterEnrollment' AND COLUMN_NAME='ProofOfIncomeUploaded')
    ALTER TABLE rptMasterEnrollment ADD ProofOfIncomeUploaded BIT DEFAULT 0;

PRINT 'Income columns added to rptMasterEnrollment.';
