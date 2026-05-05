const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = process.env.PORT || 80;
const DB_SERVER = 'localhost\\SQLEXPRESS';
const DB_NAME = 'CofPMillstadt';
const EXTERNAL_DIR = path.join(__dirname, '..', 'External');

const MIME = {
    '.html': 'text/html', '.css': 'text/css',
    '.js': 'application/javascript', '.json': 'application/json',
    '.png': 'image/png', '.ico': 'image/x-icon',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg'
};

const COLS = ['Last_Name','First_Name','Birth_date','Start_Date','City_Town','Days_Old',
              'RoomNumber','Monday','Tuesday','Wednesday','Thursday','Friday',
              'Active','Category','PFA_PI_na','F_R_P_Food','IEP','Military'];

const ROOM_COLS = ['RoomNumber','Building','Room','TeacherDescription','Type','RequiredSlots','AgeRange','DCFSCapacity'];

const INTERNAL_PASSWORD = 'cofpadmin';

function checkAuth(req, res) {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Basic ')) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Children Of Promise Staff"' });
        res.end('Unauthorized');
        return false;
    }
    const decoded = Buffer.from(auth.slice(6), 'base64').toString();
    const password = decoded.split(':')[1];
    if (password !== INTERNAL_PASSWORD) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Children Of Promise Staff"' });
        res.end('Unauthorized');
        return false;
    }
    return true;
}

function esc(v) {
    if (v === null || v === undefined || v === '') return 'NULL';
    return `'${String(v).replace(/'/g, "''")}'`;
}

function bit(v) {
    if (v === true || v === 'Yes' || v === '1' || v === 1) return 1;
    if (v === false || v === 'No' || v === '0' || v === 0) return 0;
    return 'NULL';
}

function runSQL(sql) {
    const tmp = path.join(__dirname, '_q.sql');
    fs.writeFileSync(tmp, sql, 'utf8');
    try {
        const out = execSync(`"C:\\Program Files\\Microsoft SQL Server\\Client SDK\\ODBC\\170\\Tools\\Binn\\sqlcmd.exe" -S ${DB_SERVER} -d ${DB_NAME} -E -s "|" -W -h -1 -i "${tmp}"`,
            { encoding: 'utf8', shell: 'cmd.exe' });
        console.log('[SQL]', out.trim());
        return { ok: true, data: out };
    } catch (e) {
        console.error('[SQL ERR]', e.stderr || e.message);
        return { ok: false, error: e.stderr || e.message };
    } finally {
        try { fs.unlinkSync(tmp); } catch (_) {}
    }
}

function parseRows(raw) {
    return raw.trim().split('\n')
        .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()))
        .map(l => {
            const vals = l.split('|').map(v => v.trim());
            const obj = {};
            COLS.forEach((c, i) => obj[c] = vals[i] ?? '');
            return obj;
        });
}

function sendJSON(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(body));
}

function readBody(req, cb) {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { try { cb(null, JSON.parse(b)); } catch (e) { cb(e); } });
}

const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];

    if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT', 'Access-Control-Allow-Headers': 'Content-Type' });
        return res.end();
    }

    // GET health check (public)
    if (req.method === 'GET' && url === '/api/health') {
        return sendJSON(res, 200, { ok: true });
    }

    // POST upload proof of income (internal - protected)
    if (req.method === 'POST' && url.startsWith('/api/upload/income/')) {
        if (!checkAuth(req, res)) return;
        const studentId = decodeURIComponent(url.split('/')[4] || '');
        const uploadDir = path.join(__dirname, '..', 'uploads', 'income');
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

        let body = [];
        req.on('data', chunk => body.push(chunk));
        req.on('end', () => {
            const buf = Buffer.concat(body);
            const contentType = req.headers['content-type'] || '';
            const boundary = contentType.split('boundary=')[1];
            if (!boundary) return sendJSON(res, 400, { error: 'No boundary' });

            // Parse multipart
            const parts = buf.toString('binary').split('--' + boundary);
            for (const part of parts) {
                if (!part.includes('filename=')) continue;
                const nameMatch = part.match(/filename="([^"]+)"/);
                if (!nameMatch) continue;
                const origName = nameMatch[1];
                const ext = path.extname(origName);
                const safeName = `${studentId.replace(/[^a-zA-Z0-9]/g,'_')}_${Date.now()}${ext}`;
                const filePath = path.join(uploadDir, safeName);
                const headerEnd = part.indexOf('\r\n\r\n');
                if (headerEnd < 0) continue;
                const fileData = Buffer.from(part.slice(headerEnd + 4, part.lastIndexOf('\r\n')), 'binary');
                fs.writeFileSync(filePath, fileData);

                // Update DB
                const r = runSQL(`UPDATE rptMasterEnrollment SET ProofOfIncomeFile=${esc(safeName)},ProofOfIncomeUploaded=1 WHERE First_Name=${esc(studentId.split('|')[0])} AND Last_Name=${esc(studentId.split('|')[1])}`);
                if (!r.ok) return sendJSON(res, 500, { error: r.error });
                return sendJSON(res, 200, { success: true, file: safeName });
            }
            sendJSON(res, 400, { error: 'No file found in upload' });
        });
        return;
    }

    // GET download proof of income (internal - protected)
    if (req.method === 'GET' && url.startsWith('/api/download/income/')) {
        if (!checkAuth(req, res)) return;
        const fileName = decodeURIComponent(url.split('/')[4] || '');
        const filePath = path.join(__dirname, '..', 'uploads', 'income', fileName);
        if (!fs.existsSync(filePath)) { res.writeHead(404); return res.end('Not found'); }
        const ext = path.extname(fileName).toLowerCase();
        const mime = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' }[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime, 'Content-Disposition': `inline; filename="${fileName}"` });
        fs.createReadStream(filePath).pipe(res);
        return;
    }
    // GET students (internal - protected)
    if (req.method === 'GET' && url === '/api/students') {
        if (!checkAuth(req, res)) return;
        const r = runSQL(`SELECT e.Last_Name,e.First_Name,e.Birth_date,e.Start_Date,e.City_Town,e.Days_Old,e.RoomNumber,r.Room,r.TeacherDescription,r.Type,r.DCFSCapacity,e.Monday,e.Tuesday,e.Wednesday,e.Thursday,e.Friday,e.Active,e.Category,e.PFA_PI_na,e.F_R_P_Food,e.IEP,e.Military,ISNULL(e.HouseholdIncome,'') AS HouseholdIncome,ISNULL(e.ProofOfIncomeFile,'') AS ProofOfIncomeFile,ISNULL(CAST(e.ProofOfIncomeUploaded AS NVARCHAR),'0') AS ProofOfIncomeUploaded,ISNULL(e.PublicBenefits,'') AS PublicBenefits FROM rptMasterEnrollment e LEFT JOIN dimClassrooms r ON e.RoomNumber=r.RoomNumber ORDER BY e.RoomNumber,e.Last_Name`);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const rows = r.data.trim().split('\n')
            .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()))
            .map(l => {
                const v = l.split('|').map(x => x.trim());
                return {
                    Last_Name: v[0], First_Name: v[1], Birth_date: v[2], Start_Date: v[3],
                    City_Town: v[4], Days_Old: v[5], RoomNumber: v[6], Room: v[7],
                    TeacherDescription: v[8], Type: v[9], Room_Capacity: v[10],
                    Monday: v[11], Tuesday: v[12], Wednesday: v[13], Thursday: v[14], Friday: v[15],
                    Active: v[16], Category: v[17], PFA_PI_na: v[18], F_R_P_Food: v[19],
                    IEP: v[20], Military: v[21], HouseholdIncome: v[22],
                    ProofOfIncomeFile: v[23], ProofOfIncomeUploaded: v[24], PublicBenefits: v[25]
                };
            });
        return sendJSON(res, 200, rows);
    }

    // GET classrooms (internal - protected)
    if (req.method === 'GET' && url === '/api/classrooms') {
        if (!checkAuth(req, res)) return;
        const r = runSQL(`SELECT ${ROOM_COLS.join(',')} FROM dimClassrooms ORDER BY RoomNumber`);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const rows = r.data.trim().split('\n')
            .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()))
            .map(l => {
                const v = l.split('|').map(x => x.trim());
                return { RoomNumber: v[0], Building: v[1], Room: v[2], TeacherDescription: v[3], Type: v[4], RequiredSlots: v[5], AgeRange: v[6], DCFSCapacity: v[7] };
            });
        return sendJSON(res, 200, rows);
    }

    // POST new student (internal - protected)
    if (req.method === 'POST' && url === '/api/students') {
        if (!checkAuth(req, res)) return;
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            console.log('[POST] Saving:', d.firstName, d.lastName);
            const sql = `INSERT INTO rptMasterEnrollment (Last_Name,First_Name,Birth_date,Start_Date,City_Town,Days_Old,RoomNumber,Monday,Tuesday,Wednesday,Thursday,Friday,Active,Category,PFA_PI_na,F_R_P_Food,IEP,Military,HouseholdIncome,PublicBenefits,ProofOfIncomeUploaded) VALUES (${esc(d.lastName)},${esc(d.firstName)},${esc(d.birthDate)},${esc(d.startDate)},${esc(d.cityTown)},${esc(d.daysOld)},${esc(d.roomNumber)},${d.monday?1:0},${d.tuesday?1:0},${d.wednesday?1:0},${d.thursday?1:0},${d.friday?1:0},${esc(d.active)},${esc(d.category)},${esc(d.pfaPiNa)},${esc(d.frpFood)},${esc(d.iep)},${esc(d.military)},${esc(d.householdIncome)},${esc(d.publicBenefits)},0)`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            if (!r.data.includes('rows affected')) return sendJSON(res, 500, { error: 'No rows written: ' + r.data });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // PUT update student (internal - protected)
    if (req.method === 'PUT' && url.startsWith('/api/students/')) {
        if (!checkAuth(req, res)) return;
        const parts = url.split('/');
        const origFirst = decodeURIComponent(parts[3] || '');
        const origLast  = decodeURIComponent(parts[4] || '');
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const sql = `UPDATE rptMasterEnrollment SET Last_Name=${esc(d.lastName)},First_Name=${esc(d.firstName)},Birth_date=${esc(d.birthDate)},Start_Date=${esc(d.startDate)},City_Town=${esc(d.cityTown)},Days_Old=${esc(d.daysOld)},RoomNumber=${esc(d.roomNumber)},Monday=${d.monday?1:0},Tuesday=${d.tuesday?1:0},Wednesday=${d.wednesday?1:0},Thursday=${d.thursday?1:0},Friday=${d.friday?1:0},Active=${esc(d.active)},Category=${esc(d.category)},PFA_PI_na=${esc(d.pfaPiNa)},F_R_P_Food=${esc(d.frpFood)},IEP=${esc(d.iep)},Military=${esc(d.military)},HouseholdIncome=${esc(d.householdIncome)},PublicBenefits=${esc(d.publicBenefits)} WHERE First_Name=${esc(origFirst)} AND Last_Name=${esc(origLast)}`;
            console.log('[PUT SQL]', sql);
            const r = runSQL(sql);
            console.log('[PUT RESULT]', JSON.stringify(r));
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            if (!r.data.includes('rows affected')) return sendJSON(res, 500, { error: 'No rows updated: ' + r.data });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // POST deploy (internal - protected)
    if (req.method === 'POST' && url === '/api/deploy') {
        if (!checkAuth(req, res)) return;
        try {
            const out = execSync('"C:\\Program Files\\Git\\mingw64\\bin\\git.exe" fetch origin && "C:\\Program Files\\Git\\mingw64\\bin\\git.exe" reset --hard origin/master', { encoding: 'utf8', shell: 'cmd.exe', cwd: 'C:\\app' });
            console.log('[DEPLOY]', out);
            sendJSON(res, 200, { success: true, output: out });
            // Schedule restart via task scheduler after response is sent
            setTimeout(() => {
                try {
                    execSync('schtasks /run /tn "CofPServer"', { shell: 'cmd.exe' });
                } catch(e) {}
                process.exit(0);
            }, 500);
        } catch (e) {
            return sendJSON(res, 500, { error: e.message });
        }
    }

    // POST pre-enrollment form (public)
    if (req.method === 'POST' && url === '/api/preenrollment') {
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const sql = `
                IF NOT EXISTS (
                    SELECT 1 FROM INFORMATION_SCHEMA.TABLES
                    WHERE TABLE_NAME = 'PreEnrollment'
                )
                CREATE TABLE PreEnrollment (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    SubmittedAt DATETIME DEFAULT GETDATE(),
                    FirstName NVARCHAR(100),
                    LastName NVARCHAR(100),
                    Email NVARCHAR(200),
                    Address NVARCHAR(500),
                    City NVARCHAR(100),
                    Zip NVARCHAR(20),
                    Country NVARCHAR(100),
                    Phone NVARCHAR(30),
                    ChildrenInfo NVARCHAR(1000),
                    HouseholdIncome NVARCHAR(200),
                    PublicBenefits NVARCHAR(500),
                    Homeless NVARCHAR(10),
                    IEP NVARCHAR(10),
                    NoHSDiploma NVARCHAR(10),
                    TeenParent NVARCHAR(10),
                    BornOutsideUS NVARCHAR(10),
                    FosterAdopted NVARCHAR(10),
                    NonEnglishHome NVARCHAR(10),
                    ActiveMilitary NVARCHAR(10),
                    PriorEarlyLearning NVARCHAR(10),
                    BrightpointSubsidy NVARCHAR(10),
                    LivingSituation NVARCHAR(20),
                    EarlyIntervention NVARCHAR(10),
                    AbuseHistory NVARCHAR(10),
                    MentalIllness NVARCHAR(10)
                );
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='ChildName') ALTER TABLE PreEnrollment ADD ChildName NVARCHAR(200);
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='ChildBirthDate') ALTER TABLE PreEnrollment ADD ChildBirthDate NVARCHAR(20);
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='DcfsInvolvement') ALTER TABLE PreEnrollment ADD DcfsInvolvement NVARCHAR(10);
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='SubstanceAbuse') ALTER TABLE PreEnrollment ADD SubstanceAbuse NVARCHAR(10);
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='CaregiverOther') ALTER TABLE PreEnrollment ADD CaregiverOther NVARCHAR(10);
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='FamilyDeath') ALTER TABLE PreEnrollment ADD FamilyDeath NVARCHAR(10);
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='LowBirthWeight') ALTER TABLE PreEnrollment ADD LowBirthWeight NVARCHAR(10);
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='ParentIncarcerated') ALTER TABLE PreEnrollment ADD ParentIncarcerated NVARCHAR(10);
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='Score') ALTER TABLE PreEnrollment ADD Score INT DEFAULT 0;
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='WaitlistStatus') ALTER TABLE PreEnrollment ADD WaitlistStatus NVARCHAR(20) DEFAULT 'Pending';
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='AgeGroup') ALTER TABLE PreEnrollment ADD AgeGroup NVARCHAR(10);
                INSERT INTO PreEnrollment (
                    FirstName,LastName,Email,Address,City,Zip,Country,Phone,
                    ChildrenInfo,ChildName,ChildBirthDate,AgeGroup,HouseholdIncome,PublicBenefits,Homeless,IEP,
                    NoHSDiploma,TeenParent,BornOutsideUS,FosterAdopted,
                    NonEnglishHome,ActiveMilitary,PriorEarlyLearning,
                    BrightpointSubsidy,LivingSituation,EarlyIntervention,
                    AbuseHistory,MentalIllness,DcfsInvolvement,SubstanceAbuse,
                    CaregiverOther,FamilyDeath,LowBirthWeight,ParentIncarcerated,Score
                ) VALUES (
                    ${esc(d.firstName)},${esc(d.lastName)},${esc(d.email)},
                    ${esc(d.address)},${esc(d.city)},${esc(d.zip)},${esc(d.country)},
                    ${esc(d.phone)},${esc(d.childrenInfo)},${esc(d.childName)},${esc(d.childBirthDate)},${esc(d.ageGroup)},
                    ${esc(d.householdIncome)},${esc(d.publicBenefits)},${esc(d.homeless)},${esc(d.iep)},
                    ${esc(d.noHSDiploma)},${esc(d.teenParent)},${esc(d.bornOutsideUS)},
                    ${esc(d.fosterAdopted)},${esc(d.nonEnglishHome)},${esc(d.activeMilitary)},
                    ${esc(d.priorEarlyLearning)},${esc(d.brightpointSubsidy)},
                    ${esc(d.livingSituation)},${esc(d.earlyIntervention)},
                    ${esc(d.abuseHistory)},${esc(d.mentalIllness)},
                    ${esc(d.dcfsInvolvement)},${esc(d.substanceAbuse)},
                    ${esc(d.caregiverOther)},${esc(d.familyDeath)},
                    ${esc(d.lowBirthWeight)},${esc(d.parentIncarcerated)},
                    ${parseInt(d.score)||0}
                );`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // GET management reports (internal - protected)
    if (req.method === 'GET' && url === '/api/reports') {
        if (!checkAuth(req, res)) return;
        const queries = {
            byRoom:        `SELECT r.Room, COUNT(*) AS Total, SUM(CASE WHEN e.Active='Yes' OR e.Active='YES' THEN 1 ELSE 0 END) AS Active FROM rptMasterEnrollment e LEFT JOIN dimClassrooms r ON e.RoomNumber=r.RoomNumber GROUP BY r.Room ORDER BY r.Room`,
            byRoomDaily:   `SELECT r.Room, r.DCFSCapacity, SUM(CASE WHEN e.Monday=1 AND (e.Active='Yes' OR e.Active='YES') THEN 1 ELSE 0 END) AS Mon, SUM(CASE WHEN e.Tuesday=1 AND (e.Active='Yes' OR e.Active='YES') THEN 1 ELSE 0 END) AS Tue, SUM(CASE WHEN e.Wednesday=1 AND (e.Active='Yes' OR e.Active='YES') THEN 1 ELSE 0 END) AS Wed, SUM(CASE WHEN e.Thursday=1 AND (e.Active='Yes' OR e.Active='YES') THEN 1 ELSE 0 END) AS Thu, SUM(CASE WHEN e.Friday=1 AND (e.Active='Yes' OR e.Active='YES') THEN 1 ELSE 0 END) AS Fri FROM rptMasterEnrollment e LEFT JOIN dimClassrooms r ON e.RoomNumber=r.RoomNumber WHERE e.Active='Yes' OR e.Active='YES' GROUP BY r.Room, r.DCFSCapacity, r.RoomNumber ORDER BY r.RoomNumber`,
            byProgram:     `SELECT ISNULL(PFA_PI_na,'Unknown') AS ProgramType, COUNT(*) AS Total FROM rptMasterEnrollment WHERE Active='Yes' OR Active='YES' GROUP BY PFA_PI_na`,
            byFood:        `SELECT ISNULL(F_R_P_Food,'Unknown') AS FoodProgram, COUNT(*) AS Total FROM rptMasterEnrollment WHERE Active='Yes' OR Active='YES' GROUP BY F_R_P_Food`,
            byPayType:     `SELECT ISNULL(Category,'Unknown') AS PayType, COUNT(*) AS Total FROM rptMasterEnrollment WHERE Active='Yes' OR Active='YES' GROUP BY Category`,
            benefits:      `SELECT SUM(CASE WHEN PublicBenefits LIKE '%WIC%' THEN 1 ELSE 0 END) AS WIC, SUM(CASE WHEN PublicBenefits LIKE '%Medicaid%' THEN 1 ELSE 0 END) AS Medicaid, SUM(CASE WHEN PublicBenefits LIKE '%SNAP%' THEN 1 ELSE 0 END) AS SNAP, SUM(CASE WHEN PublicBenefits LIKE '%TANF%' THEN 1 ELSE 0 END) AS TANF, SUM(CASE WHEN PublicBenefits LIKE '%CCAP%' THEN 1 ELSE 0 END) AS CCAP FROM rptMasterEnrollment WHERE Active='Yes' OR Active='YES'`,
            incomeProof:   `SELECT SUM(CASE WHEN ISNULL(ProofOfIncomeUploaded,0)=1 THEN 1 ELSE 0 END) AS Uploaded, SUM(CASE WHEN ISNULL(ProofOfIncomeUploaded,0)=0 THEN 1 ELSE 0 END) AS Missing FROM rptMasterEnrollment WHERE Active='Yes' OR Active='YES'`,
            flags:         `SELECT SUM(CASE WHEN IEP='Yes' OR IEP='YES' THEN 1 ELSE 0 END) AS IEP, SUM(CASE WHEN Military='Yes' OR Military='YES' THEN 1 ELSE 0 END) AS Military FROM rptMasterEnrollment WHERE Active='Yes' OR Active='YES'`,
            waitlistSummary: `SELECT AgeGroup, COUNT(*) AS Total, AVG(CAST(Score AS FLOAT)) AS AvgScore FROM PreEnrollment WHERE WaitlistStatus NOT IN ('Enrolled','Declined') GROUP BY AgeGroup`,
        };
        const results = {};
        for (const [key, sql] of Object.entries(queries)) {
            const r = runSQL(sql);
            if (!r.ok) { results[key] = { error: r.error }; continue; }
            results[key] = r.data.trim().split('\n')
                .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()))
                .map(l => l.split('|').map(x => x.trim()));
        }
        return sendJSON(res, 200, results);
    }

    // GET waiting list (internal - protected)
    if (req.method === 'GET' && url === '/api/waitinglist') {
        if (!checkAuth(req, res)) return;
        const r = runSQL(`SELECT Id,SubmittedAt,FirstName,LastName,Phone,Email,ChildrenInfo,ChildName,ChildBirthDate,AgeGroup,Homeless,FosterAdopted,IEP,EarlyIntervention,AbuseHistory,MentalIllness,DcfsInvolvement,SubstanceAbuse,CaregiverOther,FamilyDeath,LowBirthWeight,ParentIncarcerated,TeenParent,NoHSDiploma,BornOutsideUS,NonEnglishHome,ActiveMilitary,PublicBenefits,LivingSituation,City,HouseholdIncome,Score,WaitlistStatus,Notes FROM PreEnrollment ORDER BY Score DESC,SubmittedAt ASC`);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const rows = r.data.trim().split('\n')
            .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()))
            .map(l => {
                const v = l.split('|').map(x => x.trim());
                return { Id:v[0],SubmittedAt:v[1],FirstName:v[2],LastName:v[3],Phone:v[4],Email:v[5],ChildrenInfo:v[6],ChildName:v[7],ChildBirthDate:v[8],AgeGroup:v[9],Homeless:v[10],FosterAdopted:v[11],IEP:v[12],EarlyIntervention:v[13],AbuseHistory:v[14],MentalIllness:v[15],DcfsInvolvement:v[16],SubstanceAbuse:v[17],CaregiverOther:v[18],FamilyDeath:v[19],LowBirthWeight:v[20],ParentIncarcerated:v[21],TeenParent:v[22],NoHSDiploma:v[23],BornOutsideUS:v[24],NonEnglishHome:v[25],ActiveMilitary:v[26],PublicBenefits:v[27],LivingSituation:v[28],City:v[29],HouseholdIncome:v[30],Score:v[31],WaitlistStatus:v[32],Notes:v[33] };
            });
        return sendJSON(res, 200, rows);
    }

    // PUT update waitlist status (internal - protected)
    if (req.method === 'PUT' && url.startsWith('/api/waitinglist/')) {
        if (!checkAuth(req, res)) return;
        const id = parseInt(url.split('/')[3]);
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const fields = [];
            if (d.status !== undefined) fields.push(`WaitlistStatus=${esc(d.status)}`);
            if (d.notes !== undefined) fields.push(`Notes=${esc(d.notes)}`);
            if (!fields.length) return sendJSON(res, 400, { error: 'Nothing to update' });
            const r = runSQL(`UPDATE PreEnrollment SET ${fields.join(',')} WHERE Id=${id}`);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // External public site static files
    if (url.startsWith('/public')) {
        let subPath = url.slice('/public'.length) || '/';
        if (subPath === '' || subPath === '/') subPath = '/index.html';
        const filePath = path.join(EXTERNAL_DIR, subPath);
        console.log('[PUBLIC]', url, '->', filePath);
        fs.readFile(filePath, (err, data) => {
            if (err) { console.error('[PUBLIC 404]', filePath); res.writeHead(404); return res.end('Not found'); }
            res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
            res.end(data);
        });
        return;
    }

    // Root landing page
    if (url === '/') {
        const rootIndex = path.join(__dirname, '..', 'index.html');
        fs.readFile(rootIndex, (err, data) => {
            if (err) { res.writeHead(404); return res.end('Not found'); }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
        return;
    }

    // Internal static files (protected) - served under /staff/
    if (url.startsWith('/staff')) {
        if (!checkAuth(req, res)) return;
        const subPath = url === '/staff' || url === '/staff/' ? '/index.html' : url.replace('/staff', '');
        const filePath = path.join(__dirname, subPath);
        fs.readFile(filePath, (err, data) => {
            if (err) { res.writeHead(404); return res.end('Not found'); }
            res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
            res.end(data);
        });
        return;
    }
});

server.listen(PORT, () => {
    console.log(`Server: http://localhost:${PORT}`);
    console.log(`DB: ${DB_SERVER} / ${DB_NAME}`);
});
