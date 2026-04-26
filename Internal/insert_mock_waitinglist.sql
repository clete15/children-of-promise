USE CofPMillstadt;

INSERT INTO PreEnrollment (FirstName,LastName,Email,Phone,Address,City,Zip,Country,ChildrenInfo,AgeGroup,HouseholdIncome,PublicBenefits,Homeless,IEP,NoHSDiploma,TeenParent,BornOutsideUS,FosterAdopted,NonEnglishHome,ActiveMilitary,PriorEarlyLearning,BrightpointSubsidy,LivingSituation,EarlyIntervention,AbuseHistory,MentalIllness,DcfsInvolvement,SubstanceAbuse,CaregiverOther,FamilyDeath,LowBirthWeight,ParentIncarcerated,Score,WaitlistStatus)
VALUES
('Maria','Gonzalez','mgonzalez@email.com','618-555-0101','123 Oak St','Belleville','62220','United States','Sofia, age 2','0-2','18000','SNAP, Medicaid','Yes','No','No','No','Yes','Yes','Yes','No','No','Yes','Single Parent','No','Yes','No','Yes','No','No','No','No','No',108,'Pending'),
('James','Carter','jcarter@email.com','618-555-0102','456 Elm Ave','Cahokia','62206','United States','Liam, age 1','0-2','22000','WIC, SNAP, TANF','Yes','Yes','Yes','No','No','No','No','No','No','Yes','Single Parent','Yes','No','Yes','No','No','No','No','No','No',73,'Pending'),
('Angela','Brooks','abrooks@email.com','618-555-0103','789 Pine Rd','Dupo','62239','United States','Noah, age 2','0-2','31000','CCAP, Medicaid','No','No','No','No','No','Yes','No','No','No','No','Both Parents','No','No','No','No','No','No','No','No','No',55,'Contacted'),
('Darnell','Washington','dwash@email.com','618-555-0104','321 Maple Dr','Millstadt','62260','United States','Jaylen, age 2','2-3','27500','WIC, Medicaid','No','Yes','Yes','Yes','No','No','No','Yes','No','No','Single Parent','Yes','Yes','No','No','No','No','No','No','No',38,'Pending'),
('Sarah','Mueller','smueller@email.com','618-555-0105','654 Cedar Ln','Waterloo','62298','United States','Ava, age 2','2-3','35000','SNAP','No','No','Yes','Yes','Yes','No','Yes','No','No','No','Both Parents','No','No','Yes','No','Yes','No','No','No','No',33,'Pending'),
('Kevin','Patel','kpatel@email.com','618-555-0106','987 Birch Blvd','Freeburg','62243','United States','Priya, age 3','3-5','42000','','No','No','No','No','Yes','No','Yes','Yes','No','No','Both Parents','No','No','No','No','No','No','No','No','No',15,'Pending'),
('Tiffany','Johnson','tjohnson@email.com','618-555-0107','147 Walnut St','Swansea','62226','United States','Marcus, age 4','3-5','48000','WIC','No','No','No','No','No','No','No','No','No','No','Single Parent','No','No','Yes','No','No','No','No','No','No',13,'Pending'),
('Robert','Schneider','rschneider@email.com','618-555-0108','258 Spruce Ave','Smithton','62285','United States','Lily, age 3','3-5','55000','','No','No','No','No','No','No','No','Yes','No','No','Both Parents','No','No','No','No','No','No','No','No','No',5,'Contacted'),
('Nicole','Harris','nharris@email.com','618-555-0109','369 Ash Ct','New Athens','62264','United States','Tyler, age 2','2-3','61000','','No','No','No','Yes','No','No','No','No','No','No','Both Parents','No','No','No','No','No','No','No','No','No',5,'Pending'),
('Michael','Thompson','mthompson@email.com','618-555-0110','741 Hickory Way','Millstadt','62260','United States','Olivia, age 3','3-5','72000','','No','No','No','No','No','No','No','No','No','No','Single Parent','No','No','No','No','No','No','No','No','No',3,'Pending');

PRINT 'Mock waiting list records inserted.';
SELECT COUNT(*) AS TotalRecords FROM PreEnrollment;
