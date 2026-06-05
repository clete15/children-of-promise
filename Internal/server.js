const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Prevent crashes from unhandled errors
process.on('uncaughtException', (err) => {
    console.error('[CRASH PREVENTED]', err.message);
});
process.on('unhandledRejection', (err) => {
    console.error('[UNHANDLED REJECTION]', err);
});

const PORT = process.env.PORT || 80;
const HTTPS_PORT = 443;
const DB_SERVER = 'localhost\\SQLEXPRESS';
const DB_NAME = 'CofPMillstadt';
const EXTERNAL_DIR = path.join(__dirname, '..', 'External');

// SSL Certificate paths (from win-acme / Let's Encrypt)
const CERT_DIR = 'C:\\certs';
let sslOptions = null;
try {
    const certFiles = fs.readdirSync(CERT_DIR);
    const keyFile = certFiles.find(f => f.endsWith('-key.pem'));
    const chainFile = certFiles.find(f => f.endsWith('-chain.pem'));
    if (keyFile && chainFile) {
        sslOptions = {
            key: fs.readFileSync(path.join(CERT_DIR, keyFile)),
            cert: fs.readFileSync(path.join(CERT_DIR, chainFile)),
        };
        console.log('[SSL] Certificates loaded from', CERT_DIR);
    }
} catch (e) {
    console.log('[SSL] No certificates found, HTTPS disabled');
}

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
    // If HTTPS is available, redirect HTTP to HTTPS (except for ACME challenges)
    if (sslOptions && !req.url.startsWith('/.well-known/acme-challenge')) {
        const host = (req.headers.host || '').split(':')[0];
        res.writeHead(301, { 'Location': `https://${host}${req.url}` });
        return res.end();
    }
    handleRequest(req, res);
});

// HTTPS server
let httpsServer = null;
if (sslOptions) {
    httpsServer = https.createServer(sslOptions, (req, res) => {
        handleRequest(req, res);
    });
}

function handleRequest(req, res) {
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
        const r = runSQL(`SELECT e.Id,e.Last_Name,e.First_Name,e.Birth_date,e.Start_Date,e.City_Town,e.Days_Old,e.RoomNumber,r.Room,r.TeacherDescription,r.Type,r.DCFSCapacity,e.Monday,e.Tuesday,e.Wednesday,e.Thursday,e.Friday,e.Active,e.Category,e.PFA_PI_na,e.F_R_P_Food,e.IEP,e.Military,ISNULL(e.HouseholdIncome,'') AS HouseholdIncome,ISNULL(e.ProofOfIncomeFile,'') AS ProofOfIncomeFile,ISNULL(CAST(e.ProofOfIncomeUploaded AS NVARCHAR),'0') AS ProofOfIncomeUploaded,ISNULL(e.PublicBenefits,'') AS PublicBenefits,ISNULL(CAST(e.HouseholdSize AS NVARCHAR),'') AS HouseholdSize FROM rptMasterEnrollment e LEFT JOIN dimClassrooms r ON e.RoomNumber=r.RoomNumber ORDER BY e.RoomNumber,e.Last_Name`);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const rows = r.data.trim().split('\n')
            .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()))
            .map(l => {
                const v = l.split('|').map(x => x.trim());
                return {
                    Id: v[0], Last_Name: v[1], First_Name: v[2], Birth_date: v[3], Start_Date: v[4],
                    City_Town: v[5], Days_Old: v[6], RoomNumber: v[7], Room: v[8],
                    TeacherDescription: v[9], Type: v[10], Room_Capacity: v[11],
                    Monday: v[12], Tuesday: v[13], Wednesday: v[14], Thursday: v[15], Friday: v[16],
                    Active: v[17], Category: v[18], PFA_PI_na: v[19], F_R_P_Food: v[20],
                    IEP: v[21], Military: v[22], HouseholdIncome: v[23],
                    ProofOfIncomeFile: v[24], ProofOfIncomeUploaded: v[25], PublicBenefits: v[26], HouseholdSize: v[27]
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

    // POST new classroom (internal - protected)
    if (req.method === 'POST' && url === '/api/classrooms') {
        if (!checkAuth(req, res)) return;
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const sql = `INSERT INTO dimClassrooms (RoomNumber,Room,TeacherDescription,DCFSCapacity,AgeRange) VALUES (${parseInt(d.roomNumber)},${esc(d.room)},${esc(d.teacher)},${parseInt(d.capacity)||10},${esc(d.ageRange)})`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // PUT update classroom (internal - protected)
    if (req.method === 'PUT' && url.startsWith('/api/classrooms/')) {
        if (!checkAuth(req, res)) return;
        const roomNumber = decodeURIComponent(url.split('/')[3] || '');
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const fields = [];
            if (d.room !== undefined)     fields.push(`Room=${esc(d.room)}`);
            if (d.teacher !== undefined)  fields.push(`TeacherDescription=${esc(d.teacher)}`);
            if (d.capacity !== undefined) fields.push(`DCFSCapacity=${parseInt(d.capacity) || 0}`);
            if (d.ageRange !== undefined) fields.push(`AgeRange=${esc(d.ageRange)}`);
            if (!fields.length) return sendJSON(res, 400, { error: 'Nothing to update' });
            const rn = parseInt(roomNumber);
            const whereClause = isNaN(rn) ? `RoomNumber=${esc(roomNumber)}` : `RoomNumber=${rn}`;
            const sql = `UPDATE dimClassrooms SET ${fields.join(',')} WHERE ${whereClause}`;
            console.log('[PUT CLASSROOM]', sql);
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // POST new student (internal - protected)
    if (req.method === 'POST' && url === '/api/students') {
        if (!checkAuth(req, res)) return;
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            console.log('[POST] Saving:', d.firstName, d.lastName);
            // Auto-calculate F/R/P based on USDA income guidelines (2026-2027)
            const freeThresholds  = [20748,28132,35516,42900,50284,57668,65052,72436];
            const reducedThresholds = [29526,40034,50542,61050,71558,82066,92574,103082];
            const hhSize = Math.max(1, Math.min(parseInt(d.householdSize)||1, 8)) - 1;
            const income = parseInt(d.householdIncome) || 100000;
            const benefits = d.publicBenefits || '';
            const isFoster = d.category === 'Foster';
            const isMilitary = d.military === true || d.military === 'Yes';
            const isPFA = d.pfaPiNa === 'PFA';
            let frpFood = 'Paid';
            if (benefits || isFoster || isMilitary || isPFA || income <= freeThresholds[hhSize]) frpFood = 'Free';
            else if (income <= reducedThresholds[hhSize]) frpFood = 'Reduced';
            const sql = `INSERT INTO rptMasterEnrollment (Last_Name,First_Name,Birth_date,Start_Date,City_Town,Days_Old,RoomNumber,Monday,Tuesday,Wednesday,Thursday,Friday,Active,Category,PFA_PI_na,F_R_P_Food,IEP,Military,HouseholdIncome,HouseholdSize,PublicBenefits,ProofOfIncomeUploaded) VALUES (${esc(d.lastName)},${esc(d.firstName)},${esc(d.birthDate)},${esc(d.startDate)},${esc(d.cityTown)},${esc(d.daysOld)},${esc(d.roomNumber)},${d.monday?1:0},${d.tuesday?1:0},${d.wednesday?1:0},${d.thursday?1:0},${d.friday?1:0},${esc(d.active)},${esc(d.category)},${esc(d.pfaPiNa)},${esc(frpFood)},${esc(d.iep)},${esc(d.military)},${esc(d.householdIncome)},${parseInt(d.householdSize)||0},${esc(d.publicBenefits)},0)`;
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

            // Auto-calculate F_R_P_Food from income/size/benefits (USDA 2026-2027)
            const freeThresholds  = [20748,28132,35516,42900,50284,57668,65052,72436];
            const reducedThresholds = [29526,40034,50542,61050,71558,82066,92574,103082];
            const hasIncome = d.householdIncome !== undefined && d.householdIncome !== '';
            const hasSize   = d.householdSize !== undefined && d.householdSize !== '';
            if (hasIncome && hasSize) {
                const hhSize = Math.max(1, Math.min(parseInt(d.householdSize)||1, 8)) - 1;
                const income = parseInt(d.householdIncome) || 100000;
                const benefits = d.publicBenefits || '';
                const isFoster = d.category === 'Foster';
                const isMilitary = d.military === true || d.military === 'Yes';
                const isPFA = d.pfaPiNa === 'PFA';
                let frpFood = 'Paid';
                if (benefits || isFoster || isMilitary || isPFA || income <= freeThresholds[hhSize]) frpFood = 'Free';
                else if (income <= reducedThresholds[hhSize]) frpFood = 'Reduced';
                d.frpFood = frpFood;
            }

            const fields = [];
            if (d.lastName !== undefined)        fields.push(`Last_Name=${esc(d.lastName)}`);
            if (d.firstName !== undefined)       fields.push(`First_Name=${esc(d.firstName)}`);
            if (d.birthDate !== undefined)       fields.push(`Birth_date=${esc(d.birthDate)}`);
            if (d.startDate !== undefined)       fields.push(`Start_Date=${esc(d.startDate)}`);
            if (d.cityTown !== undefined)        fields.push(`City_Town=${esc(d.cityTown)}`);
            if (d.daysOld !== undefined)         fields.push(`Days_Old=${esc(d.daysOld)}`);
            if (d.roomNumber !== undefined)      fields.push(`RoomNumber=${esc(d.roomNumber)}`);
            if (d.monday !== undefined)          fields.push(`Monday=${d.monday?1:0}`);
            if (d.tuesday !== undefined)         fields.push(`Tuesday=${d.tuesday?1:0}`);
            if (d.wednesday !== undefined)       fields.push(`Wednesday=${d.wednesday?1:0}`);
            if (d.thursday !== undefined)        fields.push(`Thursday=${d.thursday?1:0}`);
            if (d.friday !== undefined)          fields.push(`Friday=${d.friday?1:0}`);
            if (d.active !== undefined)          fields.push(`Active=${esc(d.active)}`);
            if (d.category !== undefined)        fields.push(`Category=${esc(d.category)}`);
            if (d.pfaPiNa !== undefined)         fields.push(`PFA_PI_na=${esc(d.pfaPiNa)}`);
            if (d.frpFood !== undefined)         fields.push(`F_R_P_Food=${esc(d.frpFood)}`);
            if (d.iep !== undefined)             fields.push(`IEP=${esc(d.iep)}`);
            if (d.military !== undefined)        fields.push(`Military=${esc(d.military)}`);
            if (d.householdIncome !== undefined)  fields.push(`HouseholdIncome=${esc(d.householdIncome)}`);
            if (d.householdSize !== undefined)    fields.push(`HouseholdSize=${d.householdSize?parseInt(d.householdSize):'NULL'}`);
            if (d.publicBenefits !== undefined)   fields.push(`PublicBenefits=${esc(d.publicBenefits)}`);
            if (d.proofOfIncome !== undefined)    fields.push(`ProofOfIncomeUploaded=${d.proofOfIncome?1:0}`);
            if (!fields.length) return sendJSON(res, 400, { error: 'Nothing to update' });
            const sql = `UPDATE rptMasterEnrollment SET ${fields.join(',')} WHERE First_Name=${esc(origFirst)} AND Last_Name=${esc(origLast)}`;
            console.log('[PUT SQL]', sql);
            const r = runSQL(sql);
            console.log('[PUT RESULT]', JSON.stringify(r));
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            if (!r.data.includes('rows affected')) return sendJSON(res, 500, { error: 'No rows updated: ' + r.data });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // POST run SQL (internal - protected)
    if (req.method === 'POST' && url === '/api/sql') {
        if (!checkAuth(req, res)) return;
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            if (!d.query) return sendJSON(res, 400, { error: 'No query provided' });
            const r = runSQL(d.query);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true, output: r.data });
        });
        return;
    }

    // POST deploy (internal - protected) — pulls code only, no restart
    if (req.method === 'POST' && url === '/api/deploy') {
        if (!checkAuth(req, res)) return;
        try {
            const out = execSync('"C:\\Program Files\\Git\\mingw64\\bin\\git.exe" fetch origin && "C:\\Program Files\\Git\\mingw64\\bin\\git.exe" reset --hard origin/master', { encoding: 'utf8', shell: 'cmd.exe', cwd: 'C:\\app' });
            console.log('[DEPLOY]', out);
            return sendJSON(res, 200, { success: true, output: out, message: 'Code updated. Static files active immediately. Restart server if server.js changed.' });
        } catch (e) {
            return sendJSON(res, 500, { error: e.message });
        }
    }

    // POST restart server (internal - protected)
    if (req.method === 'POST' && url === '/api/restart') {
        if (!checkAuth(req, res)) return;
        sendJSON(res, 200, { success: true, message: 'Server restarting...' });
        setTimeout(() => {
            try { execSync('schtasks /run /tn "CofPServer"', { shell: 'cmd.exe' }); } catch(e) {}
            process.exit(0);
        }, 1000);
        return;
    }

    // POST summer program sign-up (public)
    if (req.method === 'POST' && url === '/api/summer') {
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const sql = `
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'SummerProgram')
                CREATE TABLE SummerProgram (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    SubmittedAt DATETIME DEFAULT GETDATE(),
                    ParentFirstName NVARCHAR(100),
                    ParentLastName NVARCHAR(100),
                    ParentPhone NVARCHAR(30),
                    ChildFirstName NVARCHAR(100),
                    ChildLastName NVARCHAR(100),
                    ChildAge INT,
                    Days NVARCHAR(200)
                );
                INSERT INTO SummerProgram (ParentFirstName,ParentLastName,ParentPhone,ChildFirstName,ChildLastName,ChildAge,Days)
                VALUES (${esc(d.parentFirstName)},${esc(d.parentLastName)},${esc(d.parentPhone)},${esc(d.childFirstName)},${esc(d.childLastName)},${parseInt(d.childAge)||0},${esc(d.days)});`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
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
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='ChildStartDate') ALTER TABLE PreEnrollment ADD ChildStartDate NVARCHAR(20);
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='HouseholdSize') ALTER TABLE PreEnrollment ADD HouseholdSize INT;
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
                    ChildrenInfo,ChildName,ChildBirthDate,ChildStartDate,AgeGroup,HouseholdIncome,HouseholdSize,PublicBenefits,Homeless,IEP,
                    NoHSDiploma,TeenParent,BornOutsideUS,FosterAdopted,
                    NonEnglishHome,ActiveMilitary,PriorEarlyLearning,
                    BrightpointSubsidy,LivingSituation,EarlyIntervention,
                    AbuseHistory,MentalIllness,DcfsInvolvement,SubstanceAbuse,
                    CaregiverOther,FamilyDeath,LowBirthWeight,ParentIncarcerated,Score
                ) VALUES (
                    ${esc(d.firstName)},${esc(d.lastName)},${esc(d.email)},
                    ${esc(d.address)},${esc(d.city)},${esc(d.zip)},${esc(d.country)},
                    ${esc(d.phone)},${esc(d.childrenInfo)},${esc(d.childName)},${esc(d.childBirthDate)},${esc(d.childStartDate)},${esc(d.ageGroup)},
                    ${esc(d.householdIncome)},${parseInt(d.householdSize)||0},${esc(d.publicBenefits)},${esc(d.homeless)},${esc(d.iep)},
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

    // GET ISBE tracking data (internal - protected)
    if (req.method === 'GET' && url === '/api/isbe-tracking') {
        if (!checkAuth(req, res)) return;
        const sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='ISBETracking')
            CREATE TABLE ISBETracking (
                Id INT IDENTITY(1,1) PRIMARY KEY,
                StudentId INT NOT NULL,
                PermissionSlip BIT DEFAULT 0,
                ParentInterview BIT DEFAULT 0,
                ProofOfIncome BIT DEFAULT 0,
                BegASQ BIT DEFAULT 0,
                BegASE BIT DEFAULT 0,
                MidYearReport BIT DEFAULT 0,
                EndASQ BIT DEFAULT 0,
                EndASE BIT DEFAULT 0,
                EndYearReport BIT DEFAULT 0
            );
            SELECT StudentId,PermissionSlip,ParentInterview,ProofOfIncome,BegASQ,BegASE,MidYearReport,EndASQ,EndASE,EndYearReport FROM ISBETracking`;
        const r = runSQL(sql);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const rows = r.data.trim().split('\n')
            .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()))
            .map(l => {
                const v = l.split('|').map(x => x.trim());
                return { StudentId: v[0], PermissionSlip: v[1]==='1', ParentInterview: v[2]==='1', ProofOfIncome: v[3]==='1', BegASQ: v[4]==='1', BegASE: v[5]==='1', MidYearReport: v[6]==='1', EndASQ: v[7]==='1', EndASE: v[8]==='1', EndYearReport: v[9]==='1' };
            });
        return sendJSON(res, 200, rows);
    }

    // PUT ISBE tracking field (internal - protected)
    if (req.method === 'PUT' && url === '/api/isbe-tracking') {
        if (!checkAuth(req, res)) return;
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const { studentId, field, value } = d;
            const validFields = ['PermissionSlip','ParentInterview','ProofOfIncome','BegASQ','BegASE','MidYearReport','EndASQ','EndASE','EndYearReport'];
            if (!validFields.includes(field)) return sendJSON(res, 400, { error: 'Invalid field' });
            const sql = `IF EXISTS (SELECT 1 FROM ISBETracking WHERE StudentId=${parseInt(studentId)})
                UPDATE ISBETracking SET ${field}=${value?1:0} WHERE StudentId=${parseInt(studentId)}
            ELSE
                INSERT INTO ISBETracking (StudentId,${field}) VALUES (${parseInt(studentId)},${value?1:0})`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // POST recalculate all F/R/P values (internal - protected)
    if (req.method === 'POST' && url === '/api/recalculate-frp') {
        if (!checkAuth(req, res)) return;
        // Auto-select thresholds based on current date (effective July 1 each year)
        const now = new Date();
        const usdaYear = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
        const guidelines = {
            2025: { free: [20163,27339,34515,41691,48867,56043,63219,70395], reduced: [28694,38907,49120,59333,69546,79759,89972,100185] },
            2026: { free: [20748,28132,35516,42900,50284,57668,65052,72436], reduced: [29526,40034,50542,61050,71558,82066,92574,103082] },
        };
        const g = guidelines[usdaYear] || guidelines[2026];
        const f = g.free;
        const r2 = g.reduced;
        console.log(`[FRP] Using ${usdaYear}-${usdaYear+1} thresholds`);
        const sql = `UPDATE rptMasterEnrollment SET F_R_P_Food = 
            CASE 
                WHEN ISNULL(PublicBenefits,'') <> '' THEN 'Free'
                WHEN Category = 'Foster' THEN 'Free'
                WHEN Military = 'Yes' OR Military = 'YES' THEN 'Free'
                WHEN PFA_PI_na = 'PFA' THEN 'Free'
                WHEN ISNULL(HouseholdIncome,100000) <= CASE ISNULL(HouseholdSize,1) WHEN 1 THEN ${f[0]} WHEN 2 THEN ${f[1]} WHEN 3 THEN ${f[2]} WHEN 4 THEN ${f[3]} WHEN 5 THEN ${f[4]} WHEN 6 THEN ${f[5]} WHEN 7 THEN ${f[6]} ELSE ${f[7]} END THEN 'Free'
                WHEN ISNULL(HouseholdIncome,100000) <= CASE ISNULL(HouseholdSize,1) WHEN 1 THEN ${r2[0]} WHEN 2 THEN ${r2[1]} WHEN 3 THEN ${r2[2]} WHEN 4 THEN ${r2[3]} WHEN 5 THEN ${r2[4]} WHEN 6 THEN ${r2[5]} WHEN 7 THEN ${r2[6]} ELSE ${r2[7]} END THEN 'Reduced'
                ELSE 'Paid'
            END
            WHERE Active = 'Yes' OR Active = 'YES'`;
        const r = runSQL(sql);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        sendJSON(res, 200, { success: true, message: `All F/R/P values recalculated using ${usdaYear}-${usdaYear+1} thresholds` });
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
            incomeProof:   `SELECT SUM(CASE WHEN ISNULL(ProofOfIncomeUploaded,0)=1 THEN 1 ELSE 0 END) AS Uploaded, SUM(CASE WHEN ISNULL(ProofOfIncomeUploaded,0)=0 THEN 1 ELSE 0 END) AS Missing FROM rptMasterEnrollment WHERE (Active='Yes' OR Active='YES') AND (PFA_PI_na='PFA' OR PFA_PI_na='PI')`,
            flags:         `SELECT SUM(CASE WHEN IEP='Yes' OR IEP='YES' THEN 1 ELSE 0 END) AS IEP, SUM(CASE WHEN Military='Yes' OR Military='YES' THEN 1 ELSE 0 END) AS Military FROM rptMasterEnrollment WHERE Active='Yes' OR Active='YES'`,
            waitlistSummary: `SELECT AgeGroup, COUNT(*) AS Total, AVG(CAST(Score AS FLOAT)) AS AvgScore FROM PreEnrollment WHERE WaitlistStatus NOT IN ('Enrolled','Declined') GROUP BY AgeGroup`,
            ccapEligible:  `SELECT First_Name,Last_Name,r.Room,ISNULL(e.HouseholdIncome,'') AS HouseholdIncome,ISNULL(CAST(e.HouseholdSize AS NVARCHAR),'') AS HouseholdSize FROM rptMasterEnrollment e LEFT JOIN dimClassrooms r ON e.RoomNumber=r.RoomNumber WHERE (e.Active='Yes' OR e.Active='YES') AND e.Category<>'CCAP' AND e.Category<>'Foster' AND ISNULL(e.HouseholdIncome,0)>0 AND ISNULL(e.HouseholdSize,0)>0 AND ((e.HouseholdSize=1 AND e.HouseholdIncome<=35888) OR (e.HouseholdSize=2 AND e.HouseholdIncome<=48668) OR (e.HouseholdSize=3 AND e.HouseholdIncome<=61448) OR (e.HouseholdSize=4 AND e.HouseholdIncome<=74228) OR (e.HouseholdSize=5 AND e.HouseholdIncome<=87008) OR (e.HouseholdSize=6 AND e.HouseholdIncome<=99788) OR (e.HouseholdSize=7 AND e.HouseholdIncome<=112568) OR (e.HouseholdSize>=8 AND e.HouseholdIncome<=125348)) ORDER BY e.Last_Name`,
            foodDetail:    `SELECT r.Room,e.Last_Name,e.First_Name,ISNULL(e.HouseholdIncome,'') AS HouseholdIncome,ISNULL(CAST(e.HouseholdSize AS NVARCHAR),'') AS HouseholdSize,ISNULL(e.F_R_P_Food,'') AS FRP,ISNULL(e.PublicBenefits,'') AS Benefits FROM rptMasterEnrollment e LEFT JOIN dimClassrooms r ON e.RoomNumber=r.RoomNumber WHERE e.Active='Yes' OR e.Active='YES' ORDER BY r.Room,e.Last_Name`,
            summerProgram: `IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='SummerProgram') SELECT s.ChildLastName,s.ChildFirstName,s.ChildAge,ISNULL(e.F_R_P_Food,'Unknown') AS FRP,s.Days,s.ParentLastName,s.ParentFirstName,s.ParentPhone FROM SummerProgram s LEFT JOIN rptMasterEnrollment e ON s.ChildFirstName=e.First_Name AND s.ChildLastName=e.Last_Name ORDER BY s.ChildLastName`,
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

    // GET waiting list count (lightweight - for badge)
    if (req.method === 'GET' && url === '/api/waitinglist/count') {
        if (!checkAuth(req, res)) return;
        const r = runSQL(`SELECT COUNT(*) AS Total FROM PreEnrollment WHERE ISNULL(WaitlistStatus,'Pending') NOT IN ('Enrolled','Declined')`);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const line = r.data.trim().split('\n').find(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()));
        const count = parseInt(line) || 0;
        return sendJSON(res, 200, { count });
    }

    // GET waiting list (internal - protected)
    if (req.method === 'GET' && url === '/api/waitinglist') {
        if (!checkAuth(req, res)) return;
        const r = runSQL(`SELECT Id,SubmittedAt,FirstName,LastName,Phone,Email,ChildrenInfo,ChildName,ChildBirthDate,ISNULL(ChildStartDate,'') AS ChildStartDate,AgeGroup,Homeless,FosterAdopted,IEP,EarlyIntervention,AbuseHistory,MentalIllness,DcfsInvolvement,SubstanceAbuse,CaregiverOther,FamilyDeath,LowBirthWeight,ParentIncarcerated,TeenParent,NoHSDiploma,BornOutsideUS,NonEnglishHome,ActiveMilitary,PublicBenefits,LivingSituation,City,HouseholdIncome,ISNULL(CAST(HouseholdSize AS NVARCHAR),'') AS HouseholdSize,Score,ISNULL(WaitlistStatus,'Pending') AS WaitlistStatus,ISNULL(Notes,'') AS Notes FROM PreEnrollment ORDER BY Score DESC,SubmittedAt ASC`);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const rows = r.data.trim().split('\n')
            .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()))
            .map(l => {
                const v = l.split('|').map(x => x.trim());
                return { Id:v[0],SubmittedAt:v[1],FirstName:v[2],LastName:v[3],Phone:v[4],Email:v[5],ChildrenInfo:v[6],ChildName:v[7],ChildBirthDate:v[8],ChildStartDate:v[9],AgeGroup:v[10],Homeless:v[11],FosterAdopted:v[12],IEP:v[13],EarlyIntervention:v[14],AbuseHistory:v[15],MentalIllness:v[16],DcfsInvolvement:v[17],SubstanceAbuse:v[18],CaregiverOther:v[19],FamilyDeath:v[20],LowBirthWeight:v[21],ParentIncarcerated:v[22],TeenParent:v[23],NoHSDiploma:v[24],BornOutsideUS:v[25],NonEnglishHome:v[26],ActiveMilitary:v[27],PublicBenefits:v[28],LivingSituation:v[29],City:v[30],HouseholdIncome:v[31],HouseholdSize:v[32],Score:v[33],WaitlistStatus:v[34],Notes:v[35] };
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
        let subPath = decodeURIComponent(url.slice('/public'.length) || '/');
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

    // Portal page (admin splash)
    if (url === '/portal' || url === '/portal/') {
        const rootIndex = path.join(__dirname, '..', 'index.html');
        fs.readFile(rootIndex, (err, data) => {
            if (err) { res.writeHead(404); return res.end('Not found'); }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
        return;
    }

    // Root landing page — serve public site
    if (url === '/' || url === '/index.html') {
        const pubIndex = path.join(EXTERNAL_DIR, 'index.html');
        fs.readFile(pubIndex, (err, data) => {
            if (err) { res.writeHead(404); return res.end('Not found'); }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
        return;
    }

    // Internal static files (protected) - served under /staff/
    // Allow images/css without auth (needed for login page logo)
    if (url.startsWith('/staff') && (url.endsWith('.png') || url.endsWith('.jpg') || url.endsWith('.css'))) {
        const subPath = url.replace('/staff', '');
        const filePath = path.join(__dirname, subPath);
        fs.readFile(filePath, (err, data) => {
            if (err) { res.writeHead(404); return res.end('Not found'); }
            res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
            res.end(data);
        });
        return;
    }
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

    // Fallback: try serving from External directory (public site assets at root level)
    const extPath = decodeURIComponent(url);
    const extFile = path.join(EXTERNAL_DIR, extPath);
    fs.readFile(extFile, (err, data) => {
        if (err) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(extFile)] || 'text/plain' });
        res.end(data);
    });
}

server.listen(PORT, () => {
    console.log(`HTTP Server: http://localhost:${PORT}`);
    console.log(`DB: ${DB_SERVER} / ${DB_NAME}`);
});

if (httpsServer) {
    httpsServer.listen(HTTPS_PORT, () => {
        console.log(`HTTPS Server: https://localhost:${HTTPS_PORT}`);
    });
}
