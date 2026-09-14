USE CofPMillstadt;

/* ─────────────────────────────────────────────────────────────────────────────
   CCAP: pay type, not a public benefit — data cleanup (RUN ONCE, SSMS)

   CCAP is a childcare subsidy (how tuition is paid), not a food-program public
   benefit like WIC/Medicaid/SNAP/TANF. The UI used to record it in BOTH places —
   as a Pay type (Category) and as a public-benefit checkbox (PublicBenefits) — so
   the same fact was stored twice. The app now treats CCAP only as a Pay type.

   This migration reconciles existing rows:
     1. Any child whose PublicBenefits mentions CCAP but whose Category is blank or
        'Paid' is moved to Category = 'CCAP', so the subsidy signal is not lost.
     2. 'CCAP' is then stripped out of the PublicBenefits text, leaving only the
        real food-program benefits there.

   Idempotent: rerunning changes nothing once PublicBenefits no longer holds CCAP.
   Foster is left alone — it is its own pay type and takes precedence.
   ───────────────────────────────────────────────────────────────────────────── */

-- 1. Preserve the subsidy as a pay type where it is not already something specific.
UPDATE rptMasterEnrollment
   SET Category = 'CCAP'
 WHERE PublicBenefits LIKE '%CCAP%'
   AND (Category IS NULL OR LTRIM(RTRIM(Category)) = '' OR Category = 'Paid');

-- 2. Remove CCAP from the public-benefits text, then tidy stray separators/spaces.
UPDATE rptMasterEnrollment
   SET PublicBenefits = LTRIM(RTRIM(
        REPLACE(REPLACE(REPLACE(REPLACE(PublicBenefits,
            ', CCAP', ''),
            'CCAP, ', ''),
            ',CCAP', ''),
            'CCAP', '')
   ))
 WHERE PublicBenefits LIKE '%CCAP%';

-- A value that was only "CCAP" becomes '' above; normalise any leftover lone comma.
UPDATE rptMasterEnrollment
   SET PublicBenefits = ''
 WHERE LTRIM(RTRIM(PublicBenefits)) IN (',', '');

-- 3. Show the result.
SELECT Category, COUNT(*) AS Students
  FROM rptMasterEnrollment
 WHERE Active = 'Yes' OR Active = 'YES'
 GROUP BY Category
 ORDER BY Category;

SELECT TOP 50 Last_Name, First_Name, Category, PublicBenefits
  FROM rptMasterEnrollment
 WHERE (Active = 'Yes' OR Active = 'YES')
 ORDER BY Last_Name;
