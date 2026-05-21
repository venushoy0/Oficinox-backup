const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const { google } = require("googleapis");
const XLSX = require("xlsx");
const { Readable } = require("stream");

const PORT = process.env.PORT || 3000;
const FIREBASE_DATABASE_URL = process.env.FIREBASE_DATABASE_URL || "https://planilhatemporeal-default-rtdb.firebaseio.com";
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || "1pD_KHF90T237Uh_5HTCUnSkb4nWyOgO9";
const BACKUP_EMAIL = process.env.BACKUP_EMAIL || "oficinoxbakup@gmail.com";
const ADMIN_MASTER = process.env.ADMIN_MASTER || "edkali1980@gmail.com";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "https://oficinoxx.netlify.app,https://oficinox1.netlify.app")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

function parseServiceAccount(name) {
  const rawOriginal = process.env[name];
  if (!rawOriginal) throw new Error(`Variável ${name} não configurada.`);

  let raw = String(rawOriginal).trim();

  // Aceita valor no formato ENV também: NOME_DA_VARIAVEL={...}
  if (raw.startsWith(`${name}=`)) {
    raw = raw.slice(`${name}=`.length).trim();
  }

  // Se colaram várias linhas por engano, tenta achar a linha correta.
  if (raw.indexOf("\n") !== -1 || raw.indexOf("\r") !== -1) {
    const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const exactLine = lines.find(l => l.startsWith(`${name}={`));
    const jsonLine = lines.find(l => l.startsWith("{"));
    raw = exactLine ? exactLine.slice(`${name}=`.length).trim() : (jsonLine || raw);
  }

  // Tenta recortar o primeiro objeto JSON caso tenha texto extra antes/depois.
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) {
    raw = raw.slice(first, last + 1);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`A variável ${name} não está em JSON válido. Deixe somente o JSON dela, começando com { e terminando com }. Detalhe: ${err.message}`);
  }

  if (parsed.private_key) {
    parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
  }
  return parsed;
}

function cod(email) {
  return String(email || "").replace(/\./g, ",");
}

function sheetName(name, used) {
  let base = String(name || "Aba")
    .replace(/[\\\/\?\*\[\]\:]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 31) || "Aba";

  let final = base;
  let n = 2;
  while (used.has(final)) {
    const suffix = ` ${n}`;
    final = base.slice(0, 31 - suffix.length) + suffix;
    n++;
  }
  used.add(final);
  return final;
}

function nowStamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
}

function initFirebase() {
  if (!admin.apps.length) {
    const serviceAccount = parseServiceAccount("FIREBASE_SERVICE_ACCOUNT");
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: FIREBASE_DATABASE_URL,
    });
  }
  return admin.database();
}

function initDrive() {
  // Preferência: OAuth do usuário dono do Drive (ex.: oficinoxbakup@gmail.com).
  // Isso evita o erro "Service Accounts do not have storage quota".
  if (process.env.DRIVE_CLIENT_ID && process.env.DRIVE_CLIENT_SECRET && process.env.DRIVE_REFRESH_TOKEN) {
    const oauth2 = new google.auth.OAuth2(
      process.env.DRIVE_CLIENT_ID,
      process.env.DRIVE_CLIENT_SECRET,
      process.env.DRIVE_REDIRECT_URI || "https://developers.google.com/oauthplayground"
    );
    oauth2.setCredentials({ refresh_token: process.env.DRIVE_REFRESH_TOKEN });
    return google.drive({ version: "v3", auth: oauth2 });
  }

  // Fallback: service account. Funciona apenas em Shared Drive/Workspace ou cenários compatíveis.
  const serviceAccount = parseServiceAccount("GOOGLE_SERVICE_ACCOUNT");
  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  return google.drive({ version: "v3", auth });
}

function linhaTemDados(row) {
  return Object.values(row).some(v => v !== undefined && v !== null && String(v).trim() !== "");
}

function linhasPlanilhaAtual(meta, dados) {
  const colunas = Array.isArray(meta.colunas) ? meta.colunas : [];
  const maxLinhaDados = Math.max(0, ...Object.keys(dados || {}).map(k => {
    const m = k.match(/^l(\d+)c\d+$/);
    return m ? parseInt(m[1], 10) : 0;
  }));
  const totalLinhas = Math.max(Number(meta.linhas || 0), maxLinhaDados);
  const linhas = [];

  for (let i = 1; i <= totalLinhas; i++) {
    const row = { "#": i };
    colunas.forEach((col, idx) => row[col] = dados[`l${i}c${idx}`] || "");
    if (linhaTemDados(row)) linhas.push(row);
  }

  return linhas.length ? linhas : [{ aviso: "Sem dados preenchidos nesta planilha." }];
}

function linhasHistorico(registros) {
  const linhas = [];
  Object.entries(registros || {}).forEach(([pushId, registro]) => {
    const row = { "_ID": pushId };
    Object.entries(registro || {}).forEach(([k, v]) => {
      row[k] = (v && typeof v === "object") ? JSON.stringify(v) : (v || "");
    });
    linhas.push(row);
  });
  return linhas.length ? linhas : [{ aviso: "Sem registros neste histórico." }];
}

async function usuarioEhAdmin(db, decoded) {
  const email = String(decoded.email || "").toLowerCase();
  if (!email) return false;
  if (email === String(ADMIN_MASTER).toLowerCase()) return true;

  const snap = await db.ref(`equipe/${cod(email)}`).once("value");
  const perfil = snap.val() || {};
  return perfil.cargo === "admin";
}

async function verificarUsuarioAdmin(req, db) {
  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    const err = new Error("Token de login ausente.");
    err.status = 401;
    throw err;
  }

  const decoded = await admin.auth().verifyIdToken(match[1]);
  const ok = await usuarioEhAdmin(db, decoded);
  if (!ok) {
    const err = new Error("Usuário não autorizado para gerar backup.");
    err.status = 403;
    throw err;
  }

  return decoded;
}

async function uploadBufferDrive(drive, buffer, name, parentId) {
  const res = await drive.files.create({
    requestBody: {
      name,
      parents: parentId ? [parentId] : undefined,
    },
    media: {
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      body: Readable.from(buffer),
    },
    fields: "id,name,webViewLink",
  });
  return res.data;
}

async function compartilharArquivo(drive, fileId) {
  if (!BACKUP_EMAIL || !fileId) return;
  try {
    await drive.permissions.create({
      fileId,
      requestBody: {
        type: "user",
        role: "writer",
        emailAddress: BACKUP_EMAIL,
      },
      sendNotificationEmail: false,
    });
  } catch (e) {
    console.warn("Não consegui compartilhar arquivo:", e.message);
  }
}

async function criarWorkbookBackup(planilhaIds, incluirPlanilhas, incluirHistoricos, userLabel) {
  const db = initFirebase();
  const metaSnap = await db.ref("planilhas_meta").once("value");
  const metas = metaSnap.val() || {};
  const ids = (Array.isArray(planilhaIds) && planilhaIds.length)
    ? planilhaIds.filter(id => metas[id])
    : Object.keys(metas);

  if (!ids.length) throw new Error("Nenhuma planilha encontrada para backup.");

  const wb = XLSX.utils.book_new();
  const used = new Set();

  const resumo = [
    { Campo: "Destino Drive", Valor: BACKUP_EMAIL },
    { Campo: "Gerado em", Valor: new Date().toLocaleString("pt-BR") },
    { Campo: "Gerado por", Valor: userLabel || "automático" },
    { Campo: "Inclui planilhas atuais", Valor: incluirPlanilhas ? "Sim" : "Não" },
    { Campo: "Inclui históricos", Valor: incluirHistoricos ? "Sim" : "Não" },
  ];

  if (incluirPlanilhas) {
    for (const id of ids) {
      const meta = metas[id] || {};
      const dadosSnap = await db.ref(`planilhas_dados/${id}`).once("value");
      const dados = dadosSnap.val() || {};
      const linhas = linhasPlanilhaAtual(meta, dados);
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(linhas), sheetName(`Plan ${meta.nome || id}`, used));
      resumo.push({ Campo: `Planilha atual: ${meta.nome || id}`, Valor: `${linhas.length} linha(s)` });
    }
  }

  if (incluirHistoricos) {
    for (const id of ids) {
      const meta = metas[id] || {};
      const histSnap = await db.ref(`planilhas_arquivadas/${id}`).once("value");
      const historicos = histSnap.val() || {};
      const meses = Object.keys(historicos).sort();

      if (!meses.length) {
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ aviso: "Sem histórico arquivado." }]), sheetName(`Hist ${meta.nome || id}`, used));
        resumo.push({ Campo: `Histórico: ${meta.nome || id}`, Valor: "Sem registros" });
      } else {
        for (const mes of meses) {
          const linhas = linhasHistorico(historicos[mes]);
          XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(linhas), sheetName(`Hist ${meta.nome || id} ${mes}`, used));
          resumo.push({ Campo: `Histórico: ${meta.nome || id} / ${mes}`, Valor: `${linhas.length} registro(s)` });
        }
      }
    }
  }

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(resumo), sheetName("Resumo", used));
  return wb;
}

const app = express();

app.use(cors({
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error("Origem não permitida pelo CORS."));
  }
}));

app.use(express.json({ limit: "1mb" }));

app.get("/", (_, res) => {
  res.json({ ok: true, service: "OFICINOX Railway Drive Backup" });
});

app.get("/health", (_, res) => {
  res.json({ ok: true });
});

app.get("/env-check", (_, res) => {
  res.json({
    ok: true,
    firebaseDatabaseUrl: !!FIREBASE_DATABASE_URL,
    driveFolderId: !!DRIVE_FOLDER_ID,
    backupEmail: BACKUP_EMAIL,
    adminMaster: ADMIN_MASTER,
    allowedOrigins: ALLOWED_ORIGINS,
    firebaseServiceAccount: !!process.env.FIREBASE_SERVICE_ACCOUNT,
    googleServiceAccount: !!process.env.GOOGLE_SERVICE_ACCOUNT,
    driveOAuthClientId: !!process.env.DRIVE_CLIENT_ID,
    driveOAuthClientSecret: !!process.env.DRIVE_CLIENT_SECRET,
    driveOAuthRefreshToken: !!process.env.DRIVE_REFRESH_TOKEN
  });
});

app.post("/api/backup", async (req, res) => {
  try {
    const db = initFirebase();
    const user = await verificarUsuarioAdmin(req, db);

    const planilhaIds = Array.isArray(req.body.planilhaIds) ? req.body.planilhaIds.filter(Boolean) : [];
    const incluirPlanilhas = !!req.body.incluirPlanilhas;
    const incluirHistoricos = !!req.body.incluirHistoricos;

    if (!planilhaIds.length) return res.status(400).json({ ok: false, error: "Nenhuma planilha selecionada." });
    if (!incluirPlanilhas && !incluirHistoricos) return res.status(400).json({ ok: false, error: "Selecione planilhas, históricos ou os dois." });

    const wb = await criarWorkbookBackup(planilhaIds, incluirPlanilhas, incluirHistoricos, user.email || user.uid);
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const fileName = `backup_OFICINOX_${nowStamp()}.xlsx`;

    const drive = initDrive();
    const file = await uploadBufferDrive(drive, buffer, fileName, DRIVE_FOLDER_ID);
    await compartilharArquivo(drive, file.id);

    res.json({
      ok: true,
      fileId: file.id,
      fileName: file.name,
      fileLink: file.webViewLink,
      backupEmail: BACKUP_EMAIL,
    });
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ ok: false, error: e.message || "Erro interno ao gerar backup." });
  }
});

app.listen(PORT, () => {
  console.log(`OFICINOX backup server rodando na porta ${PORT}`);
});
