# OFICINOX - Railway Drive Backup

Este pacote tem duas funções:

1. **Backup manual pelo botão do HTML**
   - O serviço web roda com `npm start`.
   - O botão **SALVAR NO DRIVE** chama `/api/backup`.

2. **Backup mensal automático**
   - O cron roda com `npm run monthly`.
   - Ele salva todas as planilhas atuais e todos os históricos no Drive.

## E-mail/Drive de destino

`oficinoxbakup@gmail.com`

## Variáveis obrigatórias no Railway

Copie para **Variables**:

```env
FIREBASE_DATABASE_URL=https://planilhatemporeal-default-rtdb.firebaseio.com
FIREBASE_SERVICE_ACCOUNT={"type":"service_account","project_id":"..."}
GOOGLE_SERVICE_ACCOUNT={"type":"service_account","project_id":"..."}
DRIVE_FOLDER_ID=ID_DA_PASTA_DO_DRIVE
BACKUP_EMAIL=oficinoxbakup@gmail.com
ADMIN_MASTER=edkali1980@gmail.com
ALLOWED_ORIGINS=https://oficinoxx.netlify.app
```

## Permissão do Drive

1. Entre no Google Drive do `oficinoxbakup@gmail.com`.
2. Crie uma pasta, por exemplo: `Backups OFICINOX`.
3. Compartilhe essa pasta com o `client_email` da `GOOGLE_SERVICE_ACCOUNT`.
4. Dê permissão de **Editor**.
5. Copie o ID da pasta do link e coloque em `DRIVE_FOLDER_ID`.

## Serviço manual no Railway

Para o botão do HTML funcionar:

- Start Command:

```bash
npm start
```

Depois pegue a URL do Railway e coloque no HTML:

```js
const RAILWAY_BACKUP_URL = "https://seu-projeto.up.railway.app";
```

## Cron automático todo dia 1

Crie outro serviço no Railway usando o mesmo repositório/pacote.

Configuração:

- Start Command:

```bash
npm run monthly
```

- Cron Schedule:

```txt
0 11 1 * *
```

Isso roda todo dia 1 às 11:00 UTC, que equivale a aproximadamente 08:00 no Brasil.

## Testar manualmente

No Railway, você também pode rodar o comando:

```bash
npm run monthly
```

Se as variáveis estiverem certas, ele cria o arquivo no Drive.
