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

  // Aceita tanto JSON puro quanto linha ENV completa:
  // FIREBASE_SERVICE_ACCOUNT={...}
  // GOOGLE_SERVICE_ACCOUNT={...}
  if (raw.startsWith(`${name}=`)) {
    raw = raw.slice(`${name}=`.length).trim();
  }

  // Se por engano vier mais de uma linha no mesmo campo,
  // usa somente a linha que contém o JSON desta variável.
  if (raw.includes("
")) {
    const linhas = raw.split(/?
/).map(l => l.trim()).filter(Boolean);
    const linhaDaVariavel = linhas.find(l => l.startsWith(`${name}={`));
    const linhaJson = linhaDaVariavel || linhas.find(l => l.startsWith("{"));
    if (linhaJson) {
      raw = linhaJson.startsWith(`${name}=`)
        ? linhaJson.slice(`${name}=`.length).trim()
        : linhaJson;
    }
  }

  // Se ainda houver prefixo/sufixo indevido, tenta ficar só com o objeto JSON.
  if (!raw.startsWith("{")) {
    const i = raw.indexOf("{");
    if (i >= 0) raw = raw.slice(i);
  }
  if (raw.startsWith("{")) {
    const j = raw.lastIndexOf("}");
    if (j >= 0) raw = raw.slice(0, j + 1);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`A variável ${name} não está em JSON válido. Deixe somente o JSON dela, começando com { e terminando com }. Detalhe: ${err.message}`);
  }

  if (parsed.private_key) parsed.private_key = parsed.private_key.replace(/\n/g, "
");
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
  const serviceAccount = parseServiceAccount("GOOGLE_SERVICE_ACCOUNT");
  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  return google.drive({ version: "v3", auth });
}

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
}

function safeName(value) {
  return String(value || "sem_nome")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "sem_nome";
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

async function criarBackupMensal() {
  if (!DRIVE_FOLDER_ID) throw new Error("DRIVE_FOLDER_ID não configurado.");

  const db = initFirebase();
  const drive = initDrive();

  console.log("Iniciando backup mensal automático...");
  console.log(`Destino: ${BACKUP_EMAIL}`);

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
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(linhasAtuais),
      sheetName(`Plan ${nome}`, used)
    );
    resumo.push({ Campo: `Planilha atual: ${nome}`, Valor: `${linhasAtuais.length} linha(s)` });

    const histSnap = await db.ref(`planilhas_arquivadas/${id}`).once("value");
    const historicos = histSnap.val() || {};
    const meses = Object.keys(historicos).sort();

    if (!meses.length) {
      const linhas = [{ aviso: "Sem histórico arquivado." }];
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet(linhas),
        sheetName(`Hist ${nome}`, used)
      );
      resumo.push({ Campo: `Histórico: ${nome}`, Valor: "Sem registros" });
    } else {
      for (const mes of meses) {
        const linhas = linhasHistorico(historicos[mes]);
        XLSX.utils.book_append_sheet(
          wb,
          XLSX.utils.json_to_sheet(linhas),
          sheetName(`Hist ${nome} ${mes}`, used)
        );
        resumo.push({ Campo: `Histórico: ${nome} / ${mes}`, Valor: `${linhas.length} registro(s)` });
      }
    }
  }

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(resumo), sheetName("Resumo", used));

  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const fileName = `backup_mensal_OFICINOX_${stamp()}.xlsx`;
  const file = await uploadBufferDrive(drive, buffer, fileName, DRIVE_FOLDER_ID);
  await compartilharArquivo(drive, file.id);

  console.log("Backup mensal salvo com sucesso!");
  console.log(`Arquivo: ${file.name}`);
  console.log(`Link: ${file.webViewLink}`);
  return file;
}

criarBackupMensal().catch(err => {
  console.error("Erro no backup mensal:", err);
  process.exit(1);
});
