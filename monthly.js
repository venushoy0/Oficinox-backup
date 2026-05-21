const admin = require("firebase-admin");
const { google } = require("googleapis");
const XLSX = require("xlsx");
const { Readable } = require("stream");

const FIREBASE_DATABASE_URL = process.env.FIREBASE_DATABASE_URL || "https://planilhatemporeal-default-rtdb.firebaseio.com";
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || "1pD_KHF90T237Uh_5HTCUnSkb4nWyOgO9";
const BACKUP_EMAIL = process.env.BACKUP_EMAIL || "oficinoxbakup@gmail.com";

function parseServiceAccount(name) {
  const rawOriginal = process.env[name];
  if (!rawOriginal) throw new Error(`Variável ${name} não configurada.`);

  let raw = String(rawOriginal).trim();

  if (raw.startsWith(`${name}=`)) {
    raw = raw.slice(`${name}=`.length).trim();
  }

  if (raw.indexOf("\n") !== -1 || raw.indexOf("\r") !== -1) {
    const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const exactLine = lines.find(l => l.startsWith(`${name}={`));
    const jsonLine = lines.find(l => l.startsWith("{"));
    raw = exactLine ? exactLine.slice(`${name}=`.length).trim() : (jsonLine || raw);
  }

  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) {
    raw = raw.slice(first, last + 1);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`A variável ${name} não está em JSON válido. Detalhe: ${err.message}`);
  }

  if (parsed.private_key) {
    parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
  }
  return parsed;
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

function sheetName(name, used) {
  let base = String(name || "Aba").replace(/[\\\/\?\*\[\]\:]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31) || "Aba";
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

async function uploadBufferDrive(drive, buffer, name, parentId) {
  const res = await drive.files.create({
    requestBody: { name, parents: parentId ? [parentId] : undefined },
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
      requestBody: { type: "user", role: "writer", emailAddress: BACKUP_EMAIL },
      sendNotificationEmail: false,
    });
  } catch (e) {
    console.warn("Não consegui compartilhar arquivo:", e.message);
  }
}

async function criarBackupMensal() {
  const db = initFirebase();
  const drive = initDrive();

  const metaSnap = await db.ref("planilhas_meta").once("value");
  const metas = metaSnap.val() || {};
  const ids = Object.keys(metas);

  const wb = XLSX.utils.book_new();
  const used = new Set();
  const resumo = [
    { Campo: "Tipo", Valor: "Backup mensal automático" },
    { Campo: "Destino Drive", Valor: BACKUP_EMAIL },
    { Campo: "Gerado em", Valor: new Date().toLocaleString("pt-BR") },
    { Campo: "Total de planilhas", Valor: ids.length },
  ];

  for (const id of ids) {
    const meta = metas[id] || {};
    const nome = meta.nome || id;

    const dadosSnap = await db.ref(`planilhas_dados/${id}`).once("value");
    const dados = dadosSnap.val() || {};
    const linhasAtuais = linhasPlanilhaAtual(meta, dados);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(linhasAtuais), sheetName(`Plan ${nome}`, used));
    resumo.push({ Campo: `Planilha atual: ${nome}`, Valor: `${linhasAtuais.length} linha(s)` });

    const histSnap = await db.ref(`planilhas_arquivadas/${id}`).once("value");
    const historicos = histSnap.val() || {};
    const meses = Object.keys(historicos).sort();

    if (!meses.length) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ aviso: "Sem histórico arquivado." }]), sheetName(`Hist ${nome}`, used));
      resumo.push({ Campo: `Histórico: ${nome}`, Valor: "Sem registros" });
    } else {
      for (const mes of meses) {
        const linhas = linhasHistorico(historicos[mes]);
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(linhas), sheetName(`Hist ${nome} ${mes}`, used));
        resumo.push({ Campo: `Histórico: ${nome} / ${mes}`, Valor: `${linhas.length} registro(s)` });
      }
    }
  }

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(resumo), sheetName("Resumo", used));

  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const fileName = `backup_mensal_OFICINOX_${nowStamp()}.xlsx`;
  const file = await uploadBufferDrive(drive, buffer, fileName, DRIVE_FOLDER_ID);
  await compartilharArquivo(drive, file.id);

  console.log("Backup mensal salvo com sucesso!");
  console.log(`Arquivo: ${file.name}`);
  console.log(`Link: ${file.webViewLink}`);
}

criarBackupMensal().catch(err => {
  console.error("Erro no backup mensal:", err);
  process.exit(1);
});
