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
        // Ensure CCAPStartDate column exists (separate batch so metadata refreshes)
        runSQL(`IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='rptMasterEnrollment' AND COLUMN_NAME='CCAPStartDate') ALTER TABLE rptMasterEnrollment ADD CCAPStartDate NVARCHAR(20)`);
        const r = runSQL(`SELECT e.Id,e.Last_Name,e.First_Name,e.Birth_date,e.Start_Date,e.City_Town,e.Days_Old,e.RoomNumber,r.Room,r.TeacherDescription,r.Type,r.DCFSCapacity,e.Monday,e.Tuesday,e.Wednesday,e.Thursday,e.Friday,e.Active,e.Category,e.PFA_PI_na,e.F_R_P_Food,e.IEP,e.Military,ISNULL(e.HouseholdIncome,'') AS HouseholdIncome,ISNULL(e.ProofOfIncomeFile,'') AS ProofOfIncomeFile,ISNULL(CAST(e.ProofOfIncomeUploaded AS NVARCHAR),'0') AS ProofOfIncomeUploaded,ISNULL(e.PublicBenefits,'') AS PublicBenefits,ISNULL(CAST(e.HouseholdSize AS NVARCHAR),'') AS HouseholdSize,ISNULL(e.CCAPStartDate,'') AS CCAPStartDate FROM rptMasterEnrollment e LEFT JOIN dimClassrooms r ON e.RoomNumber=r.RoomNumber ORDER BY e.RoomNumber,e.Last_Name`);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const rows = r.data.trim().split('\n')
            .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()) && !l.includes('Changed database') && !l.includes('Commands completed') && l.includes('|'))
            .map(l => {
                const v = l.split('|').map(x => x.trim());
                return {
                    Id: v[0], Last_Name: v[1], First_Name: v[2], Birth_date: v[3], Start_Date: v[4],
                    City_Town: v[5], Days_Old: v[6], RoomNumber: v[7], Room: v[8],
                    TeacherDescription: v[9], Type: v[10], Room_Capacity: v[11],
                    Monday: v[12], Tuesday: v[13], Wednesday: v[14], Thursday: v[15], Friday: v[16],
                    Active: v[17], Category: v[18], PFA_PI_na: v[19], F_R_P_Food: v[20],
                    IEP: v[21], Military: v[22], HouseholdIncome: v[23],
                    ProofOfIncomeFile: v[24], ProofOfIncomeUploaded: v[25], PublicBenefits: v[26], HouseholdSize: v[27], CCAPStartDate: v[28]
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
            if (d.ccapStartDate !== undefined)    fields.push(`CCAPStartDate=${esc(d.ccapStartDate)}`);
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
            try {
                // Spawn a detached process that waits 2 seconds then starts the server
                const child = require('child_process').spawn('cmd.exe', ['/c', 'timeout /t 2 /nobreak >nul & cd /d C:\\app & Launch.bat'], {
                    detached: true,
                    stdio: 'ignore',
                    shell: false
                });
                child.unref();
            } catch(e) { console.error('[RESTART ERR]', e.message); }
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

    // GET parent interview for a student (internal - protected)
    if (req.method === 'GET' && url.startsWith('/api/parent-interview/')) {
        if (!checkAuth(req, res)) return;
        const studentId = parseInt(url.split('/')[3]);
        const sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='ParentInterviews')
            CREATE TABLE ParentInterviews (
                Id INT IDENTITY(1,1) PRIMARY KEY,
                StudentId INT NOT NULL,
                InterviewDate NVARCHAR(20),
                ParentGoals NVARCHAR(MAX),
                ParentConcerns NVARCHAR(MAX),
                ChildStrengths NVARCHAR(MAX),
                ParentSignature NVARCHAR(200),
                StaffSignature NVARCHAR(200),
                Notes NVARCHAR(MAX),
                CreatedAt DATETIME DEFAULT GETDATE(),
                UpdatedAt DATETIME DEFAULT GETDATE()
            );
            SELECT Id,StudentId,InterviewDate,ISNULL(ParentGoals,'') AS ParentGoals,ISNULL(ParentConcerns,'') AS ParentConcerns,ISNULL(ChildStrengths,'') AS ChildStrengths,ISNULL(ParentSignature,'') AS ParentSignature,ISNULL(StaffSignature,'') AS StaffSignature,ISNULL(Notes,'') AS Notes,CreatedAt,UpdatedAt FROM ParentInterviews WHERE StudentId=${studentId}`;
        const r = runSQL(sql);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const rows = r.data.trim().split('\n')
            .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()))
            .map(l => {
                const v = l.split('|').map(x => x.trim());
                return { Id:v[0], StudentId:v[1], InterviewDate:v[2], ParentGoals:v[3], ParentConcerns:v[4], ChildStrengths:v[5], ParentSignature:v[6], StaffSignature:v[7], Notes:v[8], CreatedAt:v[9], UpdatedAt:v[10] };
            });
        return sendJSON(res, 200, rows.length ? rows[0] : null);
    }

    // POST save parent interview (internal - protected)
    if (req.method === 'POST' && url.startsWith('/api/parent-interview/')) {
        if (!checkAuth(req, res)) return;
        const studentId = parseInt(url.split('/')[3]);
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='ParentInterviews')
                CREATE TABLE ParentInterviews (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    StudentId INT NOT NULL,
                    InterviewDate NVARCHAR(20),
                    ParentGoals NVARCHAR(MAX),
                    ParentConcerns NVARCHAR(MAX),
                    ChildStrengths NVARCHAR(MAX),
                    ParentSignature NVARCHAR(200),
                    StaffSignature NVARCHAR(200),
                    Notes NVARCHAR(MAX),
                    CreatedAt DATETIME DEFAULT GETDATE(),
                    UpdatedAt DATETIME DEFAULT GETDATE()
                );
                IF EXISTS (SELECT 1 FROM ParentInterviews WHERE StudentId=${studentId})
                    UPDATE ParentInterviews SET InterviewDate=${esc(d.interviewDate)},ParentGoals=${esc(d.parentGoals)},ParentConcerns=${esc(d.parentConcerns)},ChildStrengths=${esc(d.childStrengths)},ParentSignature=${esc(d.parentSignature)},StaffSignature=${esc(d.staffSignature)},Notes=${esc(d.notes)},UpdatedAt=GETDATE() WHERE StudentId=${studentId}
                ELSE
                    INSERT INTO ParentInterviews (StudentId,InterviewDate,ParentGoals,ParentConcerns,ChildStrengths,ParentSignature,StaffSignature,Notes) VALUES (${studentId},${esc(d.interviewDate)},${esc(d.parentGoals)},${esc(d.parentConcerns)},${esc(d.childStrengths)},${esc(d.parentSignature)},${esc(d.staffSignature)},${esc(d.notes)});
                IF EXISTS (SELECT 1 FROM ISBETracking WHERE StudentId=${studentId})
                    UPDATE ISBETracking SET ParentInterview=1 WHERE StudentId=${studentId}
                ELSE
                    INSERT INTO ISBETracking (StudentId,ParentInterview) VALUES (${studentId},1)`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // GET permission slip for a student (internal - protected)
    if (req.method === 'GET' && url.startsWith('/api/permission-slip/')) {
        if (!checkAuth(req, res)) return;
        const studentId = parseInt(url.split('/')[3]);
        const sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='PermissionSlips')
            CREATE TABLE PermissionSlips (
                Id INT IDENTITY(1,1) PRIMARY KEY,
                StudentId INT NOT NULL,
                ParentName NVARCHAR(200),
                SchoolYear NVARCHAR(20),
                SignedDate NVARCHAR(20),
                Teacher NVARCHAR(200),
                ParentSignature NVARCHAR(200),
                ParentSigDate NVARCHAR(20),
                TeacherSignature NVARCHAR(200),
                TeacherSigDate NVARCHAR(20),
                CreatedAt DATETIME DEFAULT GETDATE(),
                UpdatedAt DATETIME DEFAULT GETDATE()
            );
            SELECT Id,StudentId,ISNULL(ParentName,'') AS ParentName,ISNULL(SchoolYear,'') AS SchoolYear,ISNULL(SignedDate,'') AS SignedDate,ISNULL(Teacher,'') AS Teacher,ISNULL(ParentSignature,'') AS ParentSignature,ISNULL(ParentSigDate,'') AS ParentSigDate,ISNULL(TeacherSignature,'') AS TeacherSignature,ISNULL(TeacherSigDate,'') AS TeacherSigDate,CreatedAt,UpdatedAt FROM PermissionSlips WHERE StudentId=${studentId}`;
        const r = runSQL(sql);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const rows = r.data.trim().split('\n')
            .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()))
            .map(l => {
                const v = l.split('|').map(x => x.trim());
                return { Id:v[0], StudentId:v[1], ParentName:v[2], SchoolYear:v[3], SignedDate:v[4], Teacher:v[5], ParentSignature:v[6], ParentSigDate:v[7], TeacherSignature:v[8], TeacherSigDate:v[9], CreatedAt:v[10], UpdatedAt:v[11] };
            });
        return sendJSON(res, 200, rows.length ? rows[0] : null);
    }

    // POST save permission slip (internal - protected)
    if (req.method === 'POST' && url.startsWith('/api/permission-slip/')) {
        if (!checkAuth(req, res)) return;
        const studentId = parseInt(url.split('/')[3]);
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='PermissionSlips')
                CREATE TABLE PermissionSlips (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    StudentId INT NOT NULL,
                    ParentName NVARCHAR(200),
                    SchoolYear NVARCHAR(20),
                    SignedDate NVARCHAR(20),
                    Teacher NVARCHAR(200),
                    ParentSignature NVARCHAR(200),
                    ParentSigDate NVARCHAR(20),
                    TeacherSignature NVARCHAR(200),
                    TeacherSigDate NVARCHAR(20),
                    CreatedAt DATETIME DEFAULT GETDATE(),
                    UpdatedAt DATETIME DEFAULT GETDATE()
                );
                IF EXISTS (SELECT 1 FROM PermissionSlips WHERE StudentId=${studentId})
                    UPDATE PermissionSlips SET ParentName=${esc(d.parentName)},SchoolYear=${esc(d.schoolYear)},SignedDate=${esc(d.signedDate)},Teacher=${esc(d.teacher)},ParentSignature=${esc(d.parentSignature)},ParentSigDate=${esc(d.parentSigDate)},TeacherSignature=${esc(d.teacherSignature)},TeacherSigDate=${esc(d.teacherSigDate)},UpdatedAt=GETDATE() WHERE StudentId=${studentId}
                ELSE
                    INSERT INTO PermissionSlips (StudentId,ParentName,SchoolYear,SignedDate,Teacher,ParentSignature,ParentSigDate,TeacherSignature,TeacherSigDate) VALUES (${studentId},${esc(d.parentName)},${esc(d.schoolYear)},${esc(d.signedDate)},${esc(d.teacher)},${esc(d.parentSignature)},${esc(d.parentSigDate)},${esc(d.teacherSignature)},${esc(d.teacherSigDate)});
                IF EXISTS (SELECT 1 FROM ISBETracking WHERE StudentId=${studentId})
                    UPDATE ISBETracking SET PermissionSlip=1 WHERE StudentId=${studentId}
                ELSE
                    INSERT INTO ISBETracking (StudentId,PermissionSlip) VALUES (${studentId},1)`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // GET screening score for a student (internal - protected)
    if (req.method === 'GET' && url.startsWith('/api/screening/')) {
        if (!checkAuth(req, res)) return;
        const studentId = parseInt(url.split('/')[3]);
        const query = req.url.split('?')[1] || '';
        const params = new URLSearchParams(query);
        const type = params.get('type') || '';
        const period = params.get('period') || '';
        const sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='ScreeningScores')
            CREATE TABLE ScreeningScores (
                Id INT IDENTITY(1,1) PRIMARY KEY,
                StudentId INT NOT NULL,
                ScreeningType NVARCHAR(20),
                Period NVARCHAR(20),
                ScreeningDate NVARCHAR(20),
                CompletedBy NVARCHAR(20),
                Interval NVARCHAR(30),
                ReferralMade NVARCHAR(10),
                CommScore NVARCHAR(10),CommStatus NVARCHAR(20),
                GrossScore NVARCHAR(10),GrossStatus NVARCHAR(20),
                FineScore NVARCHAR(10),FineStatus NVARCHAR(20),
                ProblemScore NVARCHAR(10),ProblemStatus NVARCHAR(20),
                PersonalScore NVARCHAR(10),PersonalStatus NVARCHAR(20),
                SETotal NVARCHAR(10),SECutoff NVARCHAR(10),SEResult NVARCHAR(20),
                Notes NVARCHAR(MAX),
                CreatedAt DATETIME DEFAULT GETDATE(),
                UpdatedAt DATETIME DEFAULT GETDATE()
            );
            SELECT Id,StudentId,ScreeningType,Period,ISNULL(ScreeningDate,'') AS ScreeningDate,ISNULL(CompletedBy,'') AS CompletedBy,ISNULL([Interval],'') AS [Interval],ISNULL(ReferralMade,'') AS ReferralMade,ISNULL(CommScore,'') AS CommScore,ISNULL(CommStatus,'') AS CommStatus,ISNULL(GrossScore,'') AS GrossScore,ISNULL(GrossStatus,'') AS GrossStatus,ISNULL(FineScore,'') AS FineScore,ISNULL(FineStatus,'') AS FineStatus,ISNULL(ProblemScore,'') AS ProblemScore,ISNULL(ProblemStatus,'') AS ProblemStatus,ISNULL(PersonalScore,'') AS PersonalScore,ISNULL(PersonalStatus,'') AS PersonalStatus,ISNULL(SETotal,'') AS SETotal,ISNULL(SECutoff,'') AS SECutoff,ISNULL(SEResult,'') AS SEResult,ISNULL(Notes,'') AS Notes FROM ScreeningScores WHERE StudentId=${studentId} AND ScreeningType=${esc(type)} AND Period=${esc(period)}`;
        const r = runSQL(sql);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const rows = r.data.trim().split('\n')
            .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()))
            .map(l => {
                const v = l.split('|').map(x => x.trim());
                return { Id:v[0],StudentId:v[1],ScreeningType:v[2],Period:v[3],ScreeningDate:v[4],CompletedBy:v[5],Interval:v[6],ReferralMade:v[7],CommScore:v[8],CommStatus:v[9],GrossScore:v[10],GrossStatus:v[11],FineScore:v[12],FineStatus:v[13],ProblemScore:v[14],ProblemStatus:v[15],PersonalScore:v[16],PersonalStatus:v[17],SETotal:v[18],SECutoff:v[19],SEResult:v[20],Notes:v[21] };
            });
        return sendJSON(res, 200, rows.length ? rows[0] : null);
    }

    // POST save screening score (internal - protected)
    if (req.method === 'POST' && url.startsWith('/api/screening/')) {
        if (!checkAuth(req, res)) return;
        const studentId = parseInt(url.split('/')[3]);
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            // Map period to ISBE tracking field
            let isbeField = '';
            if (d.type === 'ASQ-3' && d.period === 'Beginning') isbeField = 'BegASQ';
            else if (d.type === 'ASQ-3' && d.period === 'End') isbeField = 'EndASQ';
            else if (d.type === 'ASQ:SE-2' && d.period === 'Beginning') isbeField = 'BegASE';
            else if (d.type === 'ASQ:SE-2' && d.period === 'End') isbeField = 'EndASE';

            const sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='ScreeningScores')
                CREATE TABLE ScreeningScores (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    StudentId INT NOT NULL,
                    ScreeningType NVARCHAR(20),
                    Period NVARCHAR(20),
                    ScreeningDate NVARCHAR(20),
                    CompletedBy NVARCHAR(20),
                    [Interval] NVARCHAR(30),
                    ReferralMade NVARCHAR(10),
                    CommScore NVARCHAR(10),CommStatus NVARCHAR(20),
                    GrossScore NVARCHAR(10),GrossStatus NVARCHAR(20),
                    FineScore NVARCHAR(10),FineStatus NVARCHAR(20),
                    ProblemScore NVARCHAR(10),ProblemStatus NVARCHAR(20),
                    PersonalScore NVARCHAR(10),PersonalStatus NVARCHAR(20),
                    SETotal NVARCHAR(10),SECutoff NVARCHAR(10),SEResult NVARCHAR(20),
                    Notes NVARCHAR(MAX),
                    CreatedAt DATETIME DEFAULT GETDATE(),
                    UpdatedAt DATETIME DEFAULT GETDATE()
                );
                IF EXISTS (SELECT 1 FROM ScreeningScores WHERE StudentId=${studentId} AND ScreeningType=${esc(d.type)} AND Period=${esc(d.period)})
                    UPDATE ScreeningScores SET ScreeningDate=${esc(d.screeningDate)},CompletedBy=${esc(d.completedBy)},[Interval]=${esc(d.interval)},ReferralMade=${esc(d.referralMade)},CommScore=${esc(d.commScore||'')},CommStatus=${esc(d.commStatus||'')},GrossScore=${esc(d.grossScore||'')},GrossStatus=${esc(d.grossStatus||'')},FineScore=${esc(d.fineScore||'')},FineStatus=${esc(d.fineStatus||'')},ProblemScore=${esc(d.problemScore||'')},ProblemStatus=${esc(d.problemStatus||'')},PersonalScore=${esc(d.personalScore||'')},PersonalStatus=${esc(d.personalStatus||'')},SETotal=${esc(d.seTotal||'')},SECutoff=${esc(d.seCutoff||'')},SEResult=${esc(d.seResult||'')},Notes=${esc(d.notes)},UpdatedAt=GETDATE() WHERE StudentId=${studentId} AND ScreeningType=${esc(d.type)} AND Period=${esc(d.period)}
                ELSE
                    INSERT INTO ScreeningScores (StudentId,ScreeningType,Period,ScreeningDate,CompletedBy,[Interval],ReferralMade,CommScore,CommStatus,GrossScore,GrossStatus,FineScore,FineStatus,ProblemScore,ProblemStatus,PersonalScore,PersonalStatus,SETotal,SECutoff,SEResult,Notes) VALUES (${studentId},${esc(d.type)},${esc(d.period)},${esc(d.screeningDate)},${esc(d.completedBy)},${esc(d.interval)},${esc(d.referralMade)},${esc(d.commScore||'')},${esc(d.commStatus||'')},${esc(d.grossScore||'')},${esc(d.grossStatus||'')},${esc(d.fineScore||'')},${esc(d.fineStatus||'')},${esc(d.problemScore||'')},${esc(d.problemStatus||'')},${esc(d.personalScore||'')},${esc(d.personalStatus||'')},${esc(d.seTotal||'')},${esc(d.seCutoff||'')},${esc(d.seResult||'')},${esc(d.notes)});
                ${isbeField ? `IF EXISTS (SELECT 1 FROM ISBETracking WHERE StudentId=${studentId})
                    UPDATE ISBETracking SET ${isbeField}=1 WHERE StudentId=${studentId}
                ELSE
                    INSERT INTO ISBETracking (StudentId,${isbeField}) VALUES (${studentId},1)` : ''}`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // ══════════════════════════════════════════
    // PARENT PORTAL (public - code-authenticated)
    // ══════════════════════════════════════════

    // POST parent portal login (public)
    if (req.method === 'POST' && url === '/api/parent-portal/login') {
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const code = (d.code || '').trim().toUpperCase();
            if (!code) return sendJSON(res, 400, { error: 'Code required' });

            // Ensure table exists and look up code
            const sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='ParentCodes')
                CREATE TABLE ParentCodes (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    StudentId INT NOT NULL,
                    Code NVARCHAR(10) NOT NULL UNIQUE,
                    CreatedAt DATETIME DEFAULT GETDATE()
                );
                SELECT pc.StudentId,e.First_Name,e.Last_Name,e.Birth_date,e.RoomNumber,r.Room,r.TeacherDescription,
                    ISNULL(e.HouseholdIncome,'') AS HouseholdIncome,ISNULL(CAST(e.HouseholdSize AS NVARCHAR),'') AS HouseholdSize,
                    ISNULL(e.PublicBenefits,'') AS PublicBenefits,ISNULL(e.IEP,'') AS IEP,ISNULL(e.Military,'') AS Military,
                    ISNULL(e.Category,'') AS Category,ISNULL(e.City_Town,'') AS City_Town,ISNULL(e.PFA_PI_na,'') AS PFA_PI_na
                FROM ParentCodes pc
                JOIN rptMasterEnrollment e ON pc.StudentId=e.Id
                LEFT JOIN dimClassrooms r ON e.RoomNumber=r.RoomNumber
                WHERE pc.Code=${esc(code)}`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            const lines = r.data.trim().split('\n')
                .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()));
            if (!lines.length) return sendJSON(res, 200, { success: false, error: 'Invalid code' });
            const v = lines[0].split('|').map(x => x.trim());
            const student = { Id:v[0], First_Name:v[1], Last_Name:v[2], Birth_date:v[3], RoomNumber:v[4], Room:v[5], TeacherDescription:v[6], HouseholdIncome:v[7], HouseholdSize:v[8], PublicBenefits:v[9], IEP:v[10], Military:v[11], Category:v[12], City_Town:v[13], PFA_PI_na:v[14] };

            // Get tracking status
            const tSql = `SELECT PermissionSlip,ParentInterview FROM ISBETracking WHERE StudentId=${parseInt(student.Id)}`;
            const tRes = runSQL(tSql);
            let tracking = {};
            if (tRes.ok) {
                const tLines = tRes.data.trim().split('\n')
                    .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()));
                if (tLines.length) {
                    const tv = tLines[0].split('|').map(x => x.trim());
                    tracking = { PermissionSlip: tv[0]==='1', ParentInterview: tv[1]==='1' };
                }
            }

            // Get pre-enrollment data if available
            let preEnroll = {};
            const peSql = `SELECT TOP 1 FirstName,LastName,Phone,Email,Address,City,Zip,
                ISNULL(Homeless,'') AS Homeless,ISNULL(FosterAdopted,'') AS FosterAdopted,
                ISNULL(NonEnglishHome,'') AS NonEnglishHome,ISNULL(ActiveMilitary,'') AS ActiveMilitary,
                ISNULL(TeenParent,'') AS TeenParent,ISNULL(LivingSituation,'') AS LivingSituation,
                ISNULL(IEP,'') AS IEP,ISNULL(EarlyIntervention,'') AS EarlyIntervention,
                ISNULL(ChildName,'') AS ChildName,ISNULL(ChildBirthDate,'') AS ChildBirthDate
                FROM PreEnrollment WHERE
                (ChildName LIKE '%'+${esc(student.First_Name)}+'%' OR FirstName=${esc(student.First_Name)})
                ORDER BY Id DESC`;
            const peRes = runSQL(peSql);
            if (peRes.ok) {
                const peLines = peRes.data.trim().split('\n')
                    .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()));
                if (peLines.length) {
                    const pv = peLines[0].split('|').map(x => x.trim());
                    preEnroll = { FirstName:pv[0],LastName:pv[1],Phone:pv[2],Email:pv[3],Address:pv[4],City:pv[5],Zip:pv[6],Homeless:pv[7],FosterAdopted:pv[8],NonEnglishHome:pv[9],ActiveMilitary:pv[10],TeenParent:pv[11],LivingSituation:pv[12],IEP:pv[13],EarlyIntervention:pv[14],ChildName:pv[15],ChildBirthDate:pv[16] };
                }
            }

            sendJSON(res, 200, { success: true, student, tracking, preEnroll });
        });
        return;
    }

    // POST parent portal sign form (public)
    if (req.method === 'POST' && url === '/api/parent-portal/sign') {
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const code = (d.code || '').trim().toUpperCase();
            const formType = d.formType;
            const data = d.data || {};

            // Verify code and get student ID
            const lookupSql = `SELECT StudentId FROM ParentCodes WHERE Code=${esc(code)}`;
            const lr = runSQL(lookupSql);
            if (!lr.ok) return sendJSON(res, 500, { error: lr.error });
            const lookupLines = lr.data.trim().split('\n')
                .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()));
            if (!lookupLines.length) return sendJSON(res, 403, { error: 'Invalid code' });
            const studentId = parseInt(lookupLines[0].trim());

            if (formType === 'PermissionSlip') {
                const sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='PermissionSlips')
                    CREATE TABLE PermissionSlips (
                        Id INT IDENTITY(1,1) PRIMARY KEY,StudentId INT NOT NULL,
                        ParentName NVARCHAR(200),SchoolYear NVARCHAR(20),SignedDate NVARCHAR(20),
                        Teacher NVARCHAR(200),ParentSignature NVARCHAR(200),ParentSigDate NVARCHAR(20),
                        TeacherSignature NVARCHAR(200),TeacherSigDate NVARCHAR(20),
                        CreatedAt DATETIME DEFAULT GETDATE(),UpdatedAt DATETIME DEFAULT GETDATE()
                    );
                    IF EXISTS (SELECT 1 FROM PermissionSlips WHERE StudentId=${studentId})
                        UPDATE PermissionSlips SET ParentName=${esc(data.parentName)},SchoolYear=${esc(data.schoolYear)},SignedDate=${esc(data.signedDate)},Teacher=${esc(data.teacher)},ParentSignature=${esc(data.parentSignature)},ParentSigDate=${esc(data.parentSigDate)},UpdatedAt=GETDATE() WHERE StudentId=${studentId}
                    ELSE
                        INSERT INTO PermissionSlips (StudentId,ParentName,SchoolYear,SignedDate,Teacher,ParentSignature,ParentSigDate) VALUES (${studentId},${esc(data.parentName)},${esc(data.schoolYear)},${esc(data.signedDate)},${esc(data.teacher)},${esc(data.parentSignature)},${esc(data.parentSigDate)});
                    IF EXISTS (SELECT 1 FROM ISBETracking WHERE StudentId=${studentId})
                        UPDATE ISBETracking SET PermissionSlip=1 WHERE StudentId=${studentId}
                    ELSE
                        INSERT INTO ISBETracking (StudentId,PermissionSlip) VALUES (${studentId},1)`;
                const r = runSQL(sql);
                if (!r.ok) return sendJSON(res, 500, { error: r.error });
                return sendJSON(res, 200, { success: true });
            }

            if (formType === 'ParentInterview') {
                // Store full interview as JSON in Notes field (comprehensive PI form)
                const jsonData = JSON.stringify(data).replace(/'/g, "''");
                const sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='ParentInterviews')
                    CREATE TABLE ParentInterviews (
                        Id INT IDENTITY(1,1) PRIMARY KEY,StudentId INT NOT NULL,
                        InterviewDate NVARCHAR(20),ParentGoals NVARCHAR(MAX),ParentConcerns NVARCHAR(MAX),
                        ChildStrengths NVARCHAR(MAX),ParentSignature NVARCHAR(200),StaffSignature NVARCHAR(200),
                        Notes NVARCHAR(MAX),CreatedAt DATETIME DEFAULT GETDATE(),UpdatedAt DATETIME DEFAULT GETDATE()
                    );
                    IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='ParentInterviews' AND COLUMN_NAME='FormData') ALTER TABLE ParentInterviews ADD FormData NVARCHAR(MAX);
                    IF EXISTS (SELECT 1 FROM ParentInterviews WHERE StudentId=${studentId})
                        UPDATE ParentInterviews SET InterviewDate=${esc(data.signDate||'')},ParentGoals=${esc(data.goals||'')},ParentConcerns=${esc(data.behaviors||'')},ChildStrengths=${esc(data.describeChild||'')},ParentSignature=${esc(data.parentSignature||'')},FormData='${jsonData}',UpdatedAt=GETDATE() WHERE StudentId=${studentId}
                    ELSE
                        INSERT INTO ParentInterviews (StudentId,InterviewDate,ParentGoals,ParentConcerns,ChildStrengths,ParentSignature,FormData) VALUES (${studentId},${esc(data.signDate||'')},${esc(data.goals||'')},${esc(data.behaviors||'')},${esc(data.describeChild||'')},${esc(data.parentSignature||'')},'${jsonData}');
                    IF EXISTS (SELECT 1 FROM ISBETracking WHERE StudentId=${studentId})
                        UPDATE ISBETracking SET ParentInterview=1 WHERE StudentId=${studentId}
                    ELSE
                        INSERT INTO ISBETracking (StudentId,ParentInterview) VALUES (${studentId},1)`;
                const r = runSQL(sql);
                if (!r.ok) return sendJSON(res, 500, { error: r.error });
                return sendJSON(res, 200, { success: true });
            }

            sendJSON(res, 400, { error: 'Unknown form type' });
        });
        return;
    }

    // GET parent codes for staff (internal - protected)
    if (req.method === 'GET' && url === '/api/parent-codes') {
        if (!checkAuth(req, res)) return;
        const sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='ParentCodes')
            CREATE TABLE ParentCodes (
                Id INT IDENTITY(1,1) PRIMARY KEY,
                StudentId INT NOT NULL,
                Code NVARCHAR(10) NOT NULL UNIQUE,
                CreatedAt DATETIME DEFAULT GETDATE()
            );
            SELECT pc.StudentId,pc.Code,e.First_Name,e.Last_Name FROM ParentCodes pc JOIN rptMasterEnrollment e ON pc.StudentId=e.Id ORDER BY e.Last_Name`;
        const r = runSQL(sql);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const rows = r.data.trim().split('\n')
            .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()))
            .map(l => { const v = l.split('|').map(x => x.trim()); return { StudentId:v[0], Code:v[1], First_Name:v[2], Last_Name:v[3] }; });
        return sendJSON(res, 200, rows);
    }

    // POST generate parent code (internal - protected)
    if (req.method === 'POST' && url === '/api/parent-codes') {
        if (!checkAuth(req, res)) return;
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const studentId = parseInt(d.studentId);
            if (!studentId) return sendJSON(res, 400, { error: 'Student ID required' });
            // Generate random 6-char code
            const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
            let code = '';
            for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];

            const sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='ParentCodes')
                CREATE TABLE ParentCodes (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    StudentId INT NOT NULL,
                    Code NVARCHAR(10) NOT NULL UNIQUE,
                    CreatedAt DATETIME DEFAULT GETDATE()
                );
                IF EXISTS (SELECT 1 FROM ParentCodes WHERE StudentId=${studentId})
                    UPDATE ParentCodes SET Code=${esc(code)} WHERE StudentId=${studentId}
                ELSE
                    INSERT INTO ParentCodes (StudentId,Code) VALUES (${studentId},${esc(code)})`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true, code: code });
        });
        return;
    }

    // POST start conference (internal - protected)
    if (req.method === 'POST' && url === '/api/conference') {
        if (!checkAuth(req, res)) return;
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const studentId = parseInt(d.studentId);
            const meetUrl = d.meetUrl || '';
            const sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='Conferences')
                CREATE TABLE Conferences (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    StudentId INT NOT NULL,
                    MeetUrl NVARCHAR(500),
                    StartedAt DATETIME DEFAULT GETDATE(),
                    Active BIT DEFAULT 1
                );
                UPDATE Conferences SET Active=0 WHERE StudentId=${studentId};
                INSERT INTO Conferences (StudentId,MeetUrl,Active) VALUES (${studentId},${esc(meetUrl)},1)`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // GET weekly menus (internal - protected)
    if (req.method === 'GET' && url.startsWith('/api/menus')) {
        if (!checkAuth(req, res)) return;
        const query = req.url.split('?')[1] || '';
        const params = new URLSearchParams(query);
        const week = params.get('week') || '';
        // Read PFA and Other data separately to avoid sqlcmd line truncation
        const r1 = runSQL(`SELECT PfaData FROM WeeklyMenus WHERE WeekKey=${esc(week)}`);
        const r2 = runSQL(`SELECT OtherData FROM WeeklyMenus WHERE WeekKey=${esc(week)}`);
        if (!r1.ok && !r2.ok) return sendJSON(res, 200, {});
        const pfaRaw = (r1.data || '').split('\n').filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim())).join('').trim();
        const otherRaw = (r2.data || '').split('\n').filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim())).join('').trim();
        try {
            const pfa = pfaRaw ? JSON.parse(pfaRaw.trim()) : {};
            const other = otherRaw ? JSON.parse(otherRaw.trim()) : {};
            return sendJSON(res, 200, { pfa, other });
        } catch(e) { return sendJSON(res, 200, {}); }
    }

    // POST save weekly menus (internal - protected)
    if (req.method === 'POST' && url === '/api/menus') {
        if (!checkAuth(req, res)) return;
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const week = d.week || '';
            const pfaJson = JSON.stringify(d.pfa || {}).replace(/'/g, "''");
            const otherJson = JSON.stringify(d.other || {}).replace(/'/g, "''");
            const sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='WeeklyMenus')
                CREATE TABLE WeeklyMenus (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    WeekKey NVARCHAR(20) NOT NULL UNIQUE,
                    PfaData NVARCHAR(MAX),
                    OtherData NVARCHAR(MAX),
                    UpdatedAt DATETIME DEFAULT GETDATE()
                );
                IF EXISTS (SELECT 1 FROM WeeklyMenus WHERE WeekKey=${esc(week)})
                    UPDATE WeeklyMenus SET PfaData='${pfaJson}',OtherData='${otherJson}',UpdatedAt=GETDATE() WHERE WeekKey=${esc(week)}
                ELSE
                    INSERT INTO WeeklyMenus (WeekKey,PfaData,OtherData) VALUES (${esc(week)},'${pfaJson}','${otherJson}')`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // GET active conference for parent portal (public - code-authenticated via query)
    if (req.method === 'GET' && url === '/api/parent-portal/conference') {
        const query = req.url.split('?')[1] || '';
        const params = new URLSearchParams(query);
        const code = (params.get('code') || '').trim().toUpperCase();
        if (!code) return sendJSON(res, 400, { error: 'Code required' });
        const sql = `SELECT c.MeetUrl FROM Conferences c
            JOIN ParentCodes pc ON c.StudentId=pc.StudentId
            WHERE pc.Code=${esc(code)} AND c.Active=1
            ORDER BY c.StartedAt DESC`;
        const r = runSQL(sql);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const lines = r.data.trim().split('\n')
            .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()));
        if (!lines.length) return sendJSON(res, 200, { active: false });
        return sendJSON(res, 200, { active: true, meetUrl: lines[0].trim() });
    }

    // GET program compliance data (internal - protected)
    if (req.method === 'GET' && url === '/api/compliance') {
        if (!checkAuth(req, res)) return;
        const query = req.url.split('?')[1] || '';
        const params = new URLSearchParams(query);
        const year = params.get('year') || '';
        const sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='ProgramCompliance')
            CREATE TABLE ProgramCompliance (
                Id INT IDENTITY(1,1) PRIMARY KEY,
                SchoolYear NVARCHAR(20) NOT NULL,
                FieldName NVARCHAR(50) NOT NULL,
                FieldValue NVARCHAR(200),
                UpdatedAt DATETIME DEFAULT GETDATE(),
                CONSTRAINT UQ_Compliance UNIQUE(SchoolYear, FieldName)
            );
            SELECT FieldName,FieldValue FROM ProgramCompliance WHERE SchoolYear=${esc(year)}`;
        const r = runSQL(sql);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const data = {};
        r.data.trim().split('\n')
            .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()))
            .forEach(l => {
                const v = l.split('|').map(x => x.trim());
                if (v[0]) data[v[0]] = v[1] === '1' ? true : v[1] === '0' ? false : v[1];
            });
        return sendJSON(res, 200, data);
    }

    // POST save program compliance field (internal - protected)
    if (req.method === 'POST' && url === '/api/compliance') {
        if (!checkAuth(req, res)) return;
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const { year, field, value } = d;
            if (!year || !field) return sendJSON(res, 400, { error: 'Year and field required' });
            const sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='ProgramCompliance')
                CREATE TABLE ProgramCompliance (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    SchoolYear NVARCHAR(20) NOT NULL,
                    FieldName NVARCHAR(50) NOT NULL,
                    FieldValue NVARCHAR(200),
                    UpdatedAt DATETIME DEFAULT GETDATE(),
                    CONSTRAINT UQ_Compliance UNIQUE(SchoolYear, FieldName)
                );
                IF EXISTS (SELECT 1 FROM ProgramCompliance WHERE SchoolYear=${esc(year)} AND FieldName=${esc(field)})
                    UPDATE ProgramCompliance SET FieldValue=${esc(String(value))},UpdatedAt=GETDATE() WHERE SchoolYear=${esc(year)} AND FieldName=${esc(field)}
                ELSE
                    INSERT INTO ProgramCompliance (SchoolYear,FieldName,FieldValue) VALUES (${esc(year)},${esc(field)},${esc(String(value))})`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // PUT ISBE tracking field (internal - protected)
    if (req.method === 'PUT' && url === '/api/isbe-tracking') {
        if (!checkAuth(req, res)) return;
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const { studentId, field, value } = d;
            const validFields = ['PermissionSlip','ParentInterview','ProofOfIncome','EnterSIS','BegASQ','BegASE','MidYearReport','EndASQ','EndASE','EndYearReport','RemoveFromSIS'];
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
            ccapEligible:  `SELECT e.First_Name,e.Last_Name,r.Room,ISNULL(e.HouseholdIncome,'') AS HouseholdIncome,ISNULL(CAST(e.HouseholdSize AS NVARCHAR),'') AS HouseholdSize,ISNULL(p.FirstName+' '+p.LastName,'') AS ParentName,ISNULL(p.Phone,'') AS ParentPhone FROM rptMasterEnrollment e LEFT JOIN dimClassrooms r ON e.RoomNumber=r.RoomNumber LEFT JOIN (SELECT ChildName,FirstName,LastName,Phone,ROW_NUMBER() OVER (PARTITION BY ChildName ORDER BY Id DESC) AS rn FROM PreEnrollment) p ON p.ChildName LIKE '%'+e.First_Name+'%' AND p.rn=1 WHERE (e.Active='Yes' OR e.Active='YES') AND e.Category<>'CCAP' AND e.Category<>'Foster' AND ISNULL(e.HouseholdIncome,0)>0 AND ISNULL(e.HouseholdSize,0)>0 AND ((e.HouseholdSize=1 AND e.HouseholdIncome<=35213) OR (e.HouseholdSize=2 AND e.HouseholdIncome<=47588) OR (e.HouseholdSize=3 AND e.HouseholdIncome<=59963) OR (e.HouseholdSize=4 AND e.HouseholdIncome<=72338) OR (e.HouseholdSize=5 AND e.HouseholdIncome<=84713) OR (e.HouseholdSize=6 AND e.HouseholdIncome<=97088) OR (e.HouseholdSize=7 AND e.HouseholdIncome<=109463) OR (e.HouseholdSize>=8 AND e.HouseholdIncome<=121838)) ORDER BY e.Last_Name`,
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
            if (d.ageGroup !== undefined) fields.push(`AgeGroup=${esc(d.ageGroup)}`);
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

    // Parent Portal (public - no auth)
    if (url === '/parent' || url === '/parent/') {
        const parentPage = path.join(__dirname, 'parent.html');
        fs.readFile(parentPage, (err, data) => {
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
        // Serve staff HTML files without Basic Auth popup - the portal has its own password gate
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
