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
  const raw = process.env[name];
  if (!raw) throw new Error(`Variável ${name} não configurada.`);
  const parsed = JSON.parse(raw);
  if (parsed.private_key) parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
  return parsed;
}

function cod(email) {
  return String(email || "").replace(/\./g, ",");
}

function safeName(value) {
  return String(value || "sem_nome")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "sem_nome";
}

function nowStamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
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

const app = express();

app.use(cors({
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
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
    googleServiceAccount: !!process.env.GOOGLE_SERVICE_ACCOUNT
  });
});

app.post("/api/backup", async (req, res) => {
  try {
    const db = initFirebase();
    const drive = initDrive();
    const user = await verificarUsuarioAdmin(req, db);

    if (!DRIVE_FOLDER_ID) {
      return res.status(500).json({ ok: false, error: "DRIVE_FOLDER_ID não configurado no Railway." });
    }

    const planilhaIds = Array.isArray(req.body.planilhaIds) ? req.body.planilhaIds.filter(Boolean) : [];
    const incluirPlanilhas = !!req.body.incluirPlanilhas;
    const incluirHistoricos = !!req.body.incluirHistoricos;

    if (!planilhaIds.length) {
      return res.status(400).json({ ok: false, error: "Nenhuma planilha selecionada." });
    }
    if (!incluirPlanilhas && !incluirHistoricos) {
      return res.status(400).json({ ok: false, error: "Selecione planilhas, históricos ou os dois." });
    }

    const metaSnap = await db.ref("planilhas_meta").once("value");
    const metas = metaSnap.val() || {};
    const validIds = planilhaIds.filter(id => metas[id]);

    if (!validIds.length) {
      return res.status(400).json({ ok: false, error: "As planilhas selecionadas não foram encontradas." });
    }

    const wb = XLSX.utils.book_new();
    const used = new Set();
    const resumo = [
      { Campo: "Destino Drive", Valor: BACKUP_EMAIL },
      { Campo: "Gerado em", Valor: new Date().toLocaleString("pt-BR") },
      { Campo: "Gerado por", Valor: user.email || user.uid },
      { Campo: "Inclui planilhas atuais", Valor: incluirPlanilhas ? "Sim" : "Não" },
      { Campo: "Inclui históricos", Valor: incluirHistoricos ? "Sim" : "Não" },
    ];

    if (incluirPlanilhas) {
      for (const id of validIds) {
        const meta = metas[id] || {};
        const dadosSnap = await db.ref(`planilhas_dados/${id}`).once("value");
        const dados = dadosSnap.val() || {};
        const linhas = linhasPlanilhaAtual(meta, dados);
        const ws = XLSX.utils.json_to_sheet(linhas);
        XLSX.utils.book_append_sheet(wb, ws, sheetName(`Plan ${meta.nome || id}`, used));
        resumo.push({ Campo: `Planilha atual: ${meta.nome || id}`, Valor: `${linhas.length} linha(s)` });
      }
    }

    if (incluirHistoricos) {
      for (const id of validIds) {
        const meta = metas[id] || {};
        const histSnap = await db.ref(`planilhas_arquivadas/${id}`).once("value");
        const historicos = histSnap.val() || {};
        const meses = Object.keys(historicos).sort();

        if (!meses.length) {
          const ws = XLSX.utils.json_to_sheet([{ aviso: "Sem histórico arquivado." }]);
          XLSX.utils.book_append_sheet(wb, ws, sheetName(`Hist ${meta.nome || id}`, used));
          resumo.push({ Campo: `Histórico: ${meta.nome || id}`, Valor: "Sem registros" });
        } else {
          for (const mes of meses) {
            const linhas = linhasHistorico(historicos[mes]);
            const ws = XLSX.utils.json_to_sheet(linhas);
            XLSX.utils.book_append_sheet(wb, ws, sheetName(`Hist ${meta.nome || id} ${mes}`, used));
            resumo.push({ Campo: `Histórico: ${meta.nome || id} / ${mes}`, Valor: `${linhas.length} registro(s)` });
          }
        }
      }
    }

    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(resumo), sheetName("Resumo", used));

    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const filename = `backup_OFICINOX_${nowStamp()}.xlsx`;
    const file = await uploadBufferDrive(drive, buffer, filename, DRIVE_FOLDER_ID);
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
