USE CofPMillstadt;

IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_NAME = 'PreEnrollment'
)
BEGIN
    CREATE TABLE PreEnrollment (
        Id                  INT IDENTITY(1,1) PRIMARY KEY,
        SubmittedAt         DATETIME DEFAULT GETDATE(),
        FirstName           NVARCHAR(100),
        LastName            NVARCHAR(100),
        Email               NVARCHAR(200),
        Address             NVARCHAR(500),
        City                NVARCHAR(100),
        Zip                 NVARCHAR(20),
        Country             NVARCHAR(100),
        Phone               NVARCHAR(30),
        ChildrenInfo        NVARCHAR(1000),
        HouseholdIncome     NVARCHAR(200),
        PublicBenefits      NVARCHAR(500),
        Homeless            NVARCHAR(10),
        IEP                 NVARCHAR(10),
        NoHSDiploma         NVARCHAR(10),
        TeenParent          NVARCHAR(10),
        BornOutsideUS       NVARCHAR(10),
        FosterAdopted       NVARCHAR(10),
        NonEnglishHome      NVARCHAR(10),
        ActiveMilitary      NVARCHAR(10),
        PriorEarlyLearning  NVARCHAR(10),
        BrightpointSubsidy  NVARCHAR(10),
        LivingSituation     NVARCHAR(20),
        EarlyIntervention   NVARCHAR(10),
        AbuseHistory        NVARCHAR(10),
        MentalIllness       NVARCHAR(10)
    );
    PRINT 'PreEnrollment table created successfully.';
END
ELSE
BEGIN
    PRINT 'PreEnrollment table already exists.';
END
