# OFICINOX - Railway Drive Backup com OAuth do Drive

Esta versão resolve o erro:

`Service Accounts do not have storage quota`

O Firebase continua usando `FIREBASE_SERVICE_ACCOUNT`.

Para salvar no Google Drive de `oficinoxbakup@gmail.com`, o Drive agora deve usar OAuth do próprio Gmail, com estas variáveis no Railway:

```env
DRIVE_CLIENT_ID=...
DRIVE_CLIENT_SECRET=...
DRIVE_REFRESH_TOKEN=...
DRIVE_REDIRECT_URI=https://developers.google.com/oauthplayground
```

As variáveis antigas podem continuar:

```env
FIREBASE_SERVICE_ACCOUNT=...
FIREBASE_DATABASE_URL=https://planilhatemporeal-default-rtdb.firebaseio.com
DRIVE_FOLDER_ID=1pD_KHF90T237Uh_5HTCUnSkb4nWyOgO9
BACKUP_EMAIL=oficinoxbakup@gmail.com
ADMIN_MASTER=edkali1980@gmail.com
ALLOWED_ORIGINS=https://oficinoxx.netlify.app,https://oficinox1.netlify.app
```

`GOOGLE_SERVICE_ACCOUNT` deixa de ser necessário para o Drive quando o OAuth estiver configurado.

## Como pegar DRIVE_CLIENT_ID e DRIVE_CLIENT_SECRET

1. Google Cloud Console.
2. APIs e serviços.
3. Credenciais.
4. Criar credenciais.
5. ID do cliente OAuth.
6. Tipo: Aplicativo da Web.
7. Redirect URI autorizado: `https://developers.google.com/oauthplayground`.
8. Copie o Client ID e Client Secret.

## Como pegar DRIVE_REFRESH_TOKEN

1. Abra https://developers.google.com/oauthplayground
2. Clique na engrenagem no canto direito.
3. Marque `Use your own OAuth credentials`.
4. Cole o Client ID e Client Secret.
5. Em scopes, cole:
   `https://www.googleapis.com/auth/drive.file`
6. Clique `Authorize APIs`.
7. Entre com `oficinoxbakup@gmail.com`.
8. Clique `Exchange authorization code for tokens`.
9. Copie o `Refresh token`.
10. Coloque no Railway como `DRIVE_REFRESH_TOKEN`.

Depois faça Redeploy.
