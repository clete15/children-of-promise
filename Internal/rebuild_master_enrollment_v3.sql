USE CofPMillstadt;

DELETE FROM rptMasterEnrollment;

INSERT INTO rptMasterEnrollment (RoomNumber,Last_Name,First_Name,HouseholdIncome,Birth_date,Start_Date,City_Town,Days_Old,Monday,Tuesday,Wednesday,Thursday,Friday,Active,Category,PFA_PI_na,F_R_P_Food,IEP,Military)
VALUES
-- ROOM 1 - Infant (PI-4, Tara/Sue)
(1,'Staley','Bodie','164000','2025-12-19','2026-03-02','Millstadt',136,1,1,1,1,1,'YES','Paid','INCCRA','Paid','no','no'),
(1,'Stickles','Lei''Lani','26000','2026-01-12','2026-03-02','Belleville',112,1,1,1,1,1,'YES','CHASI','PI','Free','no','no'),
(1,'Childerson','Scarlett','136436','2025-11-11','2026-02-02','Columbia',174,1,1,1,1,1,'YES','Paid','INCCRA','Paid','no','no'),
(1,'Beyer','Daniel','120000','2025-10-22','2026-01-19','Belleville',194,1,1,1,1,1,'YES','Paid','PI','Paid','no','no'),
-- ROOM 2 - Infants / Toddlers (PI-5, Paige/Sue)
(2,'Mooney','Brayden','0','2025-09-19','2025-11-04','Belleville',227,1,1,1,1,1,'YES','CHASI','PI','Free','no','no'),
(2,'McClanahan','Kaidyn','41600','2025-05-31','2025-08-25','Smithton',338,1,1,1,1,0,'Yes','CHASi','PI','Free','no','no'),
(2,'Overmann','Tilly','275000','2025-05-20','2025-08-26','Millstadt',349,1,1,1,1,1,'Yes','Paid','INCCRA','Paid','no','no'),
-- ROOM 3 - Toddlers (INCCRA-5, Megan/New Teacher)
(3,'Whitehead','Kohan','36000','2025-02-28','2025-05-07','Freeburg',430,1,1,1,1,1,'YES','Chasi','PI','Reduced','no','no'),
(3,'Thouvenot','Hailey','145600','2025-02-27','2025-06-23','Belleville',431,1,1,1,1,1,'YES','Paid','PI','Paid','no','no'),
(3,'Kolb','Mallie','51480','2025-01-08','2025-04-07','Belleville',481,1,1,1,1,1,'YES','Paid','PI','Paid','no','no'),
(3,'Pollard','Ronan','162000','2024-10-05','2025-01-09','Swansea',576,1,1,0,1,0,'YES','Paid','INCCRA','Paid','no','no'),
-- ROOM 4 - 2 Year Olds / Toddlers (INCCRA-5, Renee/Raquel)
(4,'Smith','Serena','60000','2024-06-07','2025-10-03','Millstadt',696,0,1,0,0,1,'YES','Paid','INCCRA','Paid','no','no'),
(4,'Wallace','Julian','97595','2024-02-20','2024-05-07','St. Louis',804,1,1,1,1,1,'YES','1/2 price','INCCRA','Paid','no','no'),
(4,'Pollard','Winona','162000','2023-06-20','2024-04-02','Swansea',1049,1,1,0,1,0,'YES','Paid','INCCRA','Paid','no','no'),
-- ROOM 5 - 2 Year Olds (PI-9, Janelle/Renee)
(5,'McClure','Greyson','88140','2024-05-17','2024-07-15','Belleville',717,1,1,1,1,1,'YES','Chasi','PI','Paid','no','no'),
(5,'Gardner','Cambri','14400','2024-01-26','2024-03-11','Cahokia',829,1,1,1,1,1,'YES','Chasi','PI','Free','no','no'),
(5,'Mooney','Kaiden','0','2023-12-30','2024-12-09','Belleville',856,1,1,1,1,1,'YES','Chasi','PI','Free','no','no'),
(5,'Schneider','Nolan','59800','2023-10-19','2025-03-17','Millstadt',928,1,1,1,1,1,'YES','Chasi','PI','Paid','no','no'),
(5,'Stickels','Amoura','26000','2023-08-04','2024-08-26','Belleville',1004,1,1,1,1,1,'YES','Chasi','PI','Free','no','no'),
(5,'Brown','Benjamin','192010','2023-06-02','2025-08-06','Millstadt',1067,0,0,1,1,1,'YES','Paid','PI','Paid','no','no'),
(5,'Brock','Ausar','24076','2023-05-10','2025-06-09','Cahokia',1090,1,1,1,1,1,'YES','Chasi','PI','Free','no','no'),
-- ROOM 6 - Pre-School (PFA-15, Keyona/Maddie)
(6,'Gardner','Leilani','14400','2022-10-02','2024-01-23','Cahokia',1310,1,1,1,1,1,'YES','Chasi','PFA','Free','no','no'),
(6,'Gagliardi','Elaina','26000','2022-09-17','2025-03-17','Smithon',1325,1,1,1,1,1,'YES','CHASI','PFA','Free','no','no'),
(6,'Schlegel','Royal','32640','2022-02-05','2025-05-26','Caseyville',1549,1,1,1,1,1,'YES','Chasi','PFA','Reduced','no','no'),
(6,'Grissom','Ace','36000','2021-11-04','2023-02-01','Cahokia',1642,1,1,1,1,1,'YES','Chasi','PFA','Paid','no','no'),
(6,'McClanahan','Kolson','41600','2021-10-02','2021-11-15','Freeburg',1675,1,1,1,1,0,'YES','Chasi','PFA','Free','no','no'),
(6,'Click','Kolton','33800','2021-08-26','2021-10-11','Dupo',1712,1,1,1,1,1,'YES','Chasi','PFA','Reduced','no','no'),
(6,'Smith','Nellie','67200','2021-08-17','2023-08-01','Fairview Heights',1721,1,1,1,1,1,'YES','Paid','PFA','Paid','no','no'),
(6,'Nichols','Max','325000','2021-07-01','2023-10-02','Belleville',1768,1,1,1,1,1,'YES','Paid','PFA','Paid','no','no'),
(6,'Gardner','Phoenix','14400','2021-05-26','2024-01-23','Cahokia',1804,1,1,1,1,1,'YES','Chasi','PFA','Free','no','no'),
(6,'Weaver','Sullivan','82212','2021-04-06','2023-11-20','Millstadt',1854,1,1,1,0,0,'YES','Paid','PFA','Paid','no','no'),
(6,'Lovett','Caden','54600','2021-03-23','2021-06-02','Millstadt',1868,1,1,1,1,1,'YES','Paid','PFA','Paid','no','no'),
(6,'Shearer','Abigail','112736','2020-11-04','2022-02-23','East Carondelet',2007,1,1,1,1,1,'YES','Paid','PFA','Paid','no','no'),
(6,'Tokarski','Livie','104000','2020-09-25','2021-03-01','Belleville',2047,1,1,1,1,1,'YES','Paid','PFA','Paid','no','no'),
-- ROOM 7 - Pre-School 2 (INCCRA-12, Lindsey)
(7,'Overmann','Mckenna','275000','2022-09-15','2023-01-16','Millstadt',1327,0,1,0,1,0,'YES','Paid','INCCRA','Paid','no','no'),
(7,'Cramm','Liam','184990','2022-04-05','2022-08-10','Millstadt',1490,1,1,1,1,1,'YES','Paid','INCCRA','Paid','no','no'),
(7,'Murray','George','93600','2022-02-20','2022-06-06','Belleville',1534,1,0,1,0,1,'YES','Paid','INCCRA','Paid','no','no'),
(7,'Hayes','Rylee','129600','2021-10-12','2021-11-29','Millstadt',1665,1,1,1,1,1,'YES','Paid','INCCRA','Paid','no','no'),
(7,'Wallace','Genevieve','97595','2021-09-09','2022-05-23','St. Louis',1698,1,1,1,1,1,'YES','1/2 price','INCCRA','Paid','no','no'),
(7,'Berg','Jackson','59520','2019-10-28','2021-09-07','Belleville',2380,1,0,0,1,1,'YES','1/2 price','INCCRA','Paid','Yes','no'),
(7,'Horrights','Rowan','36000','2020-08-22','2020-10-05','Belleville',2081,1,1,1,1,1,'NO','Chasi','INCCRA','Free','no','no'),
(7,'Hill','Alec','46800','2020-07-30','2020-02-15','Belleville',2104,1,1,1,1,1,'NO','Chasi','INCCRA','Paid','Yes','no'),
-- ROOM 8 - Before and Afterschool (N/A-20, Pam/Jeremy/Sara)
(8,'Ehinger','Case','104000','2020-02-04','2021-07-12','Belleville',2281,1,1,1,1,1,'YES','Paid','INCCRA','Paid','no','no'),
(8,'Murdock','Novella','133000','2019-12-23','2021-10-26','Belleville',2324,1,1,1,1,1,'NO','Paid','INCCRA','Paid','no','no'),
(8,'McHugh','Julia','47840','2019-10-12','2023-05-30','Millstadt',2396,1,1,1,1,1,'YES','Chasi','INCCRA','Paid','no','no'),
(8,'Johnson','Chase','36826','2019-03-29','2019-10-21','Dupo',2593,1,1,1,1,1,'YES','Chasi','INCCRA','Free','no','no'),
(8,'Meng','Piper','20800','2019-01-26','2021-03-09','Dupo',2655,1,1,1,1,1,'NO','Chasi','INCCRA','Reduced','no','no'),
(8,'Sinclair','Vivan','36000','2019-01-18','2019-03-11','Belleville',2663,1,1,1,1,1,'NO','Chasi','INCCRA','Free','no','no'),
(8,'Phelps','Jolee','124800','2018-07-06','2021-10-25','Millstadt',2859,0,0,1,0,1,'YES','Paid','INCCRA','Paid','no','no'),
(8,'Peterson','Madisyn','77844','2018-07-05','2018-06-18','New Athens',2860,1,1,1,1,1,'NO','Staff','INCCRA','Paid','Yes','no'),
(8,'Duby','Sloan','400000','2018-02-12','2018-10-03','Millstadt',3003,1,1,1,1,1,'YES','Paid','INCCRA','Paid','no','no'),
(8,'Cronin','Aubree','20800','2017-02-18','2017-05-01','Belleville',3362,0,1,0,0,0,'NO','Paid','INCCRA','Free','no','no'),
(8,'Weaver','Lucy','82212','2017-02-02','2022-09-01','Millstadt',3378,1,1,1,0,0,'YES','Paid','INCCRA','Paid','no','no'),
(8,'Peterson','Ellie','77844','2017-01-16','2017-03-06','New Athens',3395,1,1,1,1,1,'NO','Staff','INCCRA','Paid','no','no'),
(8,'Phelps','Jax','124800','2016-10-04','2021-10-25','Millstadt',3499,0,0,1,0,1,'YES','Paid','INCCRA','Paid','no','no'),
(8,'Thomas','Sadie','52000','2016-01-09','2023-04-06','Millstadt',3768,1,1,1,1,1,'NO','Paid','INCCRA','Reduced','no','no'),
(8,'Johnson','Reilly','36826','2015-11-04','2018-01-22','Dupo',3834,1,1,1,1,1,'YES','Chasi','INCCRA','Free','no','no'),
(8,'Bequette','Makenzie','32760','2014-02-10','2015-07-01','Millstadt',4466,1,1,1,1,1,'YES','Chasi','INCCRA','Free','no','no');

PRINT 'Master enrollment rebuilt with updated data.';
SELECT COUNT(*) AS TotalStudents FROM rptMasterEnrollment;
