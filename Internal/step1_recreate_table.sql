USE CofPMillstadt;

IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'rptMasterEnrollment')
    DROP TABLE rptMasterEnrollment;

CREATE TABLE rptMasterEnrollment (
    Id          INT IDENTITY(1,1) PRIMARY KEY,
    Last_Name   NVARCHAR(100),
    First_Name  NVARCHAR(100),
    Birth_date  NVARCHAR(20),
    Start_Date  NVARCHAR(20),
    City_Town   NVARCHAR(100),
    Days_Old    INT,
    RoomNumber  INT REFERENCES dimClassrooms(RoomNumber),
    Monday      INT,
    Tuesday     INT,
    Wednesday   INT,
    Thursday    INT,
    Friday      INT,
    Active      NVARCHAR(10),
    Category    NVARCHAR(50),
    PFA_PI_na   NVARCHAR(20),
    F_R_P_Food  NVARCHAR(20),
    IEP         NVARCHAR(10),
    Military    NVARCHAR(10)
);

PRINT 'Table recreated successfully.';
