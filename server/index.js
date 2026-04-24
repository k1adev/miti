const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const FormData = require('form-data');
const cheerio = require('cheerio');
const multer = require('multer');
const xlsx = require('xlsx');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const os = require('os');
const fs = require('fs');
const qs = require('qs');
const archiver = require('archiver');
// sharp é opcional — carregamento lazy para não quebrar se o módulo nativo
// falhar em alguma plataforma. Usado para normalizar imagens antes do upload
// para Shopee (converter WEBP/GIF → JPG, redimensionar para evitar rejeições).
let sharpLib = null;
try { sharpLib = require('sharp'); }
catch (e) { console.warn('[startup] sharp não disponível — imagens Shopee não serão normalizadas:', e.message); }
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';

// Dependências para autenticação
const SECRET = process.env.JWT_SECRET || 'apoli-secret-' + require('crypto').randomBytes(8).toString('hex');

// Token compartilhado em memória para chamadas internas (o próprio servidor
// chamando endpoints REST via 127.0.0.1). Gerado uma vez por boot e NUNCA
// exposto em respostas. Permite que crons e handlers reutilizem endpoints
// HTTP sem precisar forjar um JWT de usuário. O middleware de auth abaixo
// reconhece este token via header "x-internal-service".
const INTERNAL_SERVICE_TOKEN = require('crypto').randomBytes(32).toString('hex');
const internalServiceHeaders = () => ({ 'x-internal-service': INTERNAL_SERVICE_TOKEN });

// Configuração Bling
const BLING_CLIENT_ID = process.env.BLING_CLIENT_ID;
const BLING_CLIENT_SECRET = process.env.BLING_CLIENT_SECRET;
const BLING_REDIRECT_URI = process.env.BLING_REDIRECT_URI || 'http://localhost:3001/api/bling/callback';
const BLING_AUTH_URL = 'https://www.bling.com.br/Api/v3/oauth/authorize';
const BLING_TOKEN_URL = 'https://www.bling.com.br/Api/v3/oauth/token';
const BLING_API_BASE = 'https://www.bling.com.br/Api/v3';
const TOKEN_FILE = path.join(__dirname, 'bling_token.json');
const LOG_FILE = path.join(__dirname, 'bling_api.log');

let defaultBlingAccountId = 1;

// ─── Active sessions & user action tracking ───
const activeSessions = new Map();
const revokedTokens = new Set();
const userActionBuffer = [];
const MAX_USER_ACTIONS = 500;

function addUserAction(userId, userName, action, details) {
  userActionBuffer.push({
    timestamp: new Date().toISOString(),
    userId, userName, action, details
  });
  if (userActionBuffer.length > MAX_USER_ACTIONS) userActionBuffer.shift();
}

function normalizeAccountId(value) {
  const parsed = parseInt(value, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return defaultBlingAccountId;
}

function getAccountIdFromReq(req) {
  return normalizeAccountId((req && req.query && req.query.accountId) || (req && req.body && req.body.accountId));
}

function getOptionalAccountIdFromReq(req) {
  const raw = (req && req.query && req.query.accountId) || (req && req.body && req.body.accountId);
  if (raw === undefined || raw === null || raw === '' || String(raw).toLowerCase() === 'all') return null;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

/** Query do autocomplete (#): NBSP e espaços unicode viram espaço, evitando 1 token “colado” (ordem fixa no LIKE). */
function normalizeMlAutocompleteQuery(q) {
  return String(q || '')
    .replace(/\u00A0/g, ' ')
    .replace(/[\u2000-\u200B\uFEFF]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function stripAccentsForMatch(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function normForMlMatch(s) {
  return stripAccentsForMatch(s).toLowerCase();
}

/** Uma palavra: título, SKU ou ID. Várias: todas as palavras devem aparecer no título (ordem livre). */
function mlItemMatchesSearchTokens(row, tokens) {
  if (!tokens.length) return false;
  const titleN = normForMlMatch(row.title);
  if (tokens.length === 1) {
    const t = normForMlMatch(tokens[0]);
    return titleN.includes(t)
      || normForMlMatch(row.sku || '').includes(t)
      || normForMlMatch(String(row.ml_item_id || '')).includes(t);
  }
  return tokens.every((tok) => titleN.includes(normForMlMatch(tok)));
}

function buildAccountFilter(accountId, column = 'account_id') {
  if (!accountId) return { sql: '', params: [] };
  const parsed = parseInt(accountId, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return { sql: '', params: [] };
  if (parsed === defaultBlingAccountId) {
    return { sql: ` AND (${column} = ? OR ${column} IS NULL)`, params: [parsed] };
  }
  return { sql: ` AND ${column} = ?`, params: [parsed] };
}

// Controle de concorrência, cache e progresso por conta Bling
const isNotasFiscaisFetchingByAccount = new Map();
const notasFiscaisCacheByAccount = new Map();
const importacaoProgressoByAccount = new Map();

function getNotasFiscaisCache(accountId) {
  if (!notasFiscaisCacheByAccount.has(accountId)) {
    notasFiscaisCacheByAccount.set(accountId, { key: null, data: null, timestamp: 0 });
  }
  return notasFiscaisCacheByAccount.get(accountId);
}

function getImportacaoProgresso(accountId) {
  if (!importacaoProgressoByAccount.has(accountId)) {
    importacaoProgressoByAccount.set(accountId, { importados: 0, total: 0, status: 'idle' });
  }
  return importacaoProgressoByAccount.get(accountId);
}

function isNotasFiscaisFetching(accountId) {
  return Boolean(isNotasFiscaisFetchingByAccount.get(accountId));
}

function setNotasFiscaisFetching(accountId, value) {
  isNotasFiscaisFetchingByAccount.set(accountId, Boolean(value));
}

// Cache simples em memória
const CACHE_DURATION_MS = 2 * 60 * 1000; // 2 minutos

// Estado simples: último erro de refresh
let ultimoErroRefresh = null;

// Sistema de logs reais em memória (ring buffer)
const LOG_BUFFER_MAX = 500;
const logBuffer = [];
const serverStartTime = new Date();

function addLog(level, category, message, data) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    category,
    message,
    data: data || null
  };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_MAX) {
    logBuffer.splice(0, logBuffer.length - LOG_BUFFER_MAX);
  }
}

const _origLog = console.log.bind(console);
const _origError = console.error.bind(console);
const _origWarn = console.warn.bind(console);

console.log = (...args) => {
  _origLog(...args);
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  if (msg.includes('[POST') || msg.includes('[GET') || msg.includes('[DELETE') || msg.includes('[PUT')) {
    addLog('DEBUG', 'API', msg);
  } else if (msg.includes('Bling') || msg.includes('bling')) {
    addLog('INFO', 'BLING', msg);
  } else if (msg.includes('✅')) {
    addLog('INFO', 'SYSTEM', msg.replace(/✅\s*/g, ''));
  } else if (msg.includes('Conectado ao banco') || msg.includes('SQLite')) {
    addLog('INFO', 'DB', msg);
  } else if (msg.includes('admin') || msg.includes('Usuário')) {
    addLog('INFO', 'AUTH', msg);
  } else {
    addLog('INFO', 'SYSTEM', msg);
  }
};

console.error = (...args) => {
  _origError(...args);
  const msg = args.map(a => typeof a === 'string' ? a : (a instanceof Error ? a.message : JSON.stringify(a))).join(' ');
  if (msg.includes('❌')) {
    addLog('ERROR', 'SYSTEM', msg.replace(/❌\s*/g, ''));
  } else {
    addLog('ERROR', 'SYSTEM', msg);
  }
};

console.warn = (...args) => {
  _origWarn(...args);
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  addLog('WARN', 'SYSTEM', msg);
};

addLog('INFO', 'SYSTEM', 'Servidor iniciando...');

// Função para obter data atual no timezone de São Paulo
function getCurrentDateTimeSP() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).replace(' ', 'T');
}

// Variáveis de progresso agora são por conta (ver helpers acima)

// ============================================================================
// app_settings — store de configuração key/value com cache em memória.
// Usado para valores editáveis em runtime pela tela de Configurações (ex:
// horário do backup noturno, pacing, etc.). Fallback explícito para ENV e
// depois para o default fornecido pelo chamador.
// ============================================================================
const settingsCache = new Map();
let settingsCacheReady = false;

function primeSettingsCache() {
  return new Promise((resolve) => {
    db.all('SELECT key, value FROM app_settings', (err, rows) => {
      if (!err && Array.isArray(rows)) {
        for (const r of rows) settingsCache.set(r.key, r.value);
      }
      settingsCacheReady = true;
      resolve();
    });
  });
}

function getSetting(key, fallback = null) {
  if (settingsCache.has(key)) {
    const v = settingsCache.get(key);
    return v === null || v === undefined ? fallback : v;
  }
  return fallback;
}

function setSetting(key, value) {
  const v = value === null || value === undefined ? null : String(value);
  settingsCache.set(key, v);
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`,
      [key, v], (err) => err ? reject(err) : resolve()
    );
  });
}

// Máscara usada antes de serializar objetos com tokens para log ou para a
// resposta do console — evita que access_token/refresh_token vazem pela UI.
function maskTokenFields(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  try {
    return JSON.parse(JSON.stringify(obj, (k, v) => {
      if (typeof v !== 'string') return v;
      if (k === 'access_token' || k === 'refresh_token' || k === 'client_secret') {
        return v.length > 8 ? `${v.slice(0, 8)}…(${v.length})` : '***';
      }
      return v;
    }));
  } catch (_) { return obj; }
}

function logBling(msg, data) {
  const safe = data ? maskTokenFields(data) : null;
  const logMsg = `[${new Date().toISOString()}] ${msg} ${safe ? JSON.stringify(safe) : ''}`;
  fs.appendFileSync(LOG_FILE, logMsg + '\n');
  console.log(logMsg);
}

function saveToken(tokenObj, accountId) {
  return new Promise((resolve, reject) => {
    const normalizedAccountId = normalizeAccountId(accountId);
    // Primeiro, tentar migrar token do arquivo se existir
    if (fs.existsSync(TOKEN_FILE)) {
      try {
        const fileToken = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
        logBling('Migrando token do arquivo para banco de dados', fileToken);
        // Deletar arquivo após migração
        fs.unlinkSync(TOKEN_FILE);
      } catch (e) {
        logBling('Erro ao migrar token do arquivo', e.message);
      }
    }

    // Salvar no banco de dados
    const now = new Date().toISOString();
    db.run(
      `INSERT OR REPLACE INTO api_tokens 
       (provider, account_id, access_token, refresh_token, expires_in, token_type, created_at, updated_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'bling',
        normalizedAccountId,
        tokenObj.access_token,
        tokenObj.refresh_token || null,
        tokenObj.expires_in || null,
        tokenObj.token_type || 'Bearer',
        tokenObj.created_at || now,
        now
      ],
      function(err) {
        if (err) {
          logBling('Erro ao salvar token no banco', err.message);
          reject(err);
                 } else {
          logBling('Token salvo no banco de dados', { id: this.lastID, accountId: normalizedAccountId, ...tokenObj });
           // Limpar tokens antigos após salvar o novo
          cleanOldTokens(normalizedAccountId).then(() => {
             resolve(tokenObj);
           });
         }
      }
    );
  });
}

// Helpers de consulta assíncrona
function dbAllAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

function dbGetAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

function dbRunAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

function normalizeBlingDateParam(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.includes('T')) return s;
  if (s.includes(' ')) return s;
  return s;
}

function shiftDateStr(dateStr, days) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  const base = new Date(`${dateStr}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  const yyyy = base.getUTCFullYear();
  const mm = String(base.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(base.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

async function getBlingCredentials(accountId) {
  const row = await dbGetAsync(
    'SELECT client_id, client_secret, redirect_uri FROM bling_accounts WHERE id = ? LIMIT 1',
    [accountId]
  );
  const clientId = row?.client_id || BLING_CLIENT_ID;
  const clientSecret = row?.client_secret || BLING_CLIENT_SECRET;
  const redirectUri = row?.redirect_uri || BLING_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

function limparSkuFinal(sku) {
  if (typeof sku !== 'string') return sku;
  // Remove letras no final (inclui variantes como sufixo 'B')
  return sku.replace(/[a-zA-Z]+$/, '');
}

function loadToken(accountId) {
  const normalizedAccountId = normalizeAccountId(accountId);
  return new Promise((resolve) => {
    db.get(
      'SELECT * FROM api_tokens WHERE provider = ? AND account_id = ? ORDER BY updated_at DESC LIMIT 1',
      ['bling', normalizedAccountId],
      (err, row) => {
        if (err) {
          logBling('Erro ao carregar token do banco', err.message);
          resolve(null);
        } else if (row) {
          const tokenObj = {
            access_token: row.access_token,
            refresh_token: row.refresh_token,
            expires_in: row.expires_in,
            token_type: row.token_type,
            created_at: row.created_at
          };
          logBling('Token carregado do banco de dados', { accountId: normalizedAccountId, ...tokenObj });
          resolve(tokenObj);
        } else {
          logBling('Nenhum token encontrado no banco de dados', { accountId: normalizedAccountId });
          resolve(null);
        }
      }
    );
  });
}

function isTokenValid(tokenObj) {
  if (!tokenObj || !tokenObj.access_token || !tokenObj.expires_in || !tokenObj.created_at) return false;
  // Margem aumentada para 10 minutos para reduzir risco de expiração durante operações
  const expiresAt = new Date(tokenObj.created_at).getTime() + (tokenObj.expires_in * 1000) - 600000; // 10 min de margem
  return Date.now() < expiresAt;
}

async function refreshTokenIfNeeded(accountId) {
  const normalizedAccountId = normalizeAccountId(accountId);
  let tokenObj = await loadToken(normalizedAccountId);
  if (tokenObj && isTokenValid(tokenObj)) {
    return tokenObj;
  }
  if (!tokenObj) {
    logMarketplaceConnection('bling', 'no_token_in_db', 'WARN', normalizedAccountId, {});
    return null;
  }
  if (!tokenObj.refresh_token) {
    logMarketplaceConnection('bling', 'expired_or_invalid_no_refresh_token', 'WARN', normalizedAccountId, { hadAccessToken: Boolean(tokenObj.access_token) });
    return null;
  }
  logBling('Renovando token com refresh_token', { accountId: normalizedAccountId });
  try {
    const creds = await getBlingCredentials(normalizedAccountId);
    if (!creds) {
      logBling('Credenciais do Bling não configuradas para a conta', { accountId: normalizedAccountId });
      logMarketplaceConnection('bling', 'no_oauth_credentials', 'WARN', normalizedAccountId, {});
      return null;
    }
    const data = qs.stringify({
      grant_type: 'refresh_token',
      refresh_token: tokenObj.refresh_token,
      // Apesar de muitos provedores aceitarem client_id/secret no corpo,
      // mantemos para compatibilidade e enviamos também via Basic Auth.
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      redirect_uri: creds.redirectUri
    });
    const basicAuth = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
    const response = await axios.post(
      BLING_TOKEN_URL,
      data,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${basicAuth}`
        }
      }
    );
    const newToken = {
      ...response.data,
      // Se a resposta não trouxer um refresh_token novo, preserva o atual
      refresh_token: response.data?.refresh_token || tokenObj.refresh_token,
      created_at: new Date().toISOString()
    };
    await saveToken(newToken, normalizedAccountId);
    ultimoErroRefresh = null;
    return newToken;
  } catch (err) {
    const details = err.response?.data || err.message;
    ultimoErroRefresh = details;
    logBling('Erro ao renovar token', { accountId: normalizedAccountId, details });
    logMarketplaceConnection('bling', 'refresh_failed', 'ERROR', normalizedAccountId, {
      status: err.response?.status,
      details: typeof details === 'object' ? details : String(details)
    });
    if (err.response?.data?.error?.type === 'invalid_grant' || err.response?.data?.error === 'invalid_grant') {
      logBling('Refresh token inválido - conta precisa ser reconectada', { accountId: normalizedAccountId });
      logMarketplaceConnection('bling', 'invalid_grant_reconnect_required', 'ERROR', normalizedAccountId, { hint: 'Reconectar Bling no painel de APIs' });
      db.run('UPDATE bling_accounts SET connection_status = ? WHERE id = ?', ['disconnected', normalizedAccountId]);
    }
    return null;
  }
}

// Helper: GET na API do Bling com retry automático em 401 (tenta renovar token e refaz 1x)
async function blingGet(urlOrPath, tokenObj, config = {}, accountId) {
  const isFullUrl = /^https?:\/\//i.test(urlOrPath);
  const url = isFullUrl ? urlOrPath : `${BLING_API_BASE}${urlOrPath}`;
  const buildHeaders = (accessToken) => ({
    'Authorization': `Bearer ${accessToken}`,
    'Accept': 'application/json',
    ...(config.headers || {})
  });
  try {
    return await axios.get(url, { ...config, headers: buildHeaders(tokenObj.access_token) });
  } catch (err) {
    const status = err.response?.status;
    if (status === 401) {
      // tenta renovar e refazer
      const newToken = await refreshTokenIfNeeded(accountId);
      if (newToken && newToken.access_token) {
        return await axios.get(url, { ...config, headers: buildHeaders(newToken.access_token) });
      }
      logMarketplaceConnection('bling', 'api_401_refresh_failed', 'ERROR', normalizeAccountId(accountId), {
        url,
        lastRefreshError: ultimoErroRefresh
      });
    }
    throw err;
  }
}

// Helper: POST na API do Bling com retry automático em 401
async function blingPost(urlOrPath, data, tokenObj, accountId) {
  const isFullUrl = /^https?:\/\//i.test(urlOrPath);
  const url = isFullUrl ? urlOrPath : `${BLING_API_BASE}${urlOrPath}`;
  const buildHeaders = (accessToken) => ({
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  });
  try {
    return await axios.post(url, data, { headers: buildHeaders(tokenObj.access_token) });
  } catch (err) {
    if (err.response?.status === 401) {
      const newToken = await refreshTokenIfNeeded(accountId);
      if (newToken && newToken.access_token) {
        return await axios.post(url, data, { headers: buildHeaders(newToken.access_token) });
      }
      logMarketplaceConnection('bling', 'api_401_refresh_failed', 'ERROR', normalizeAccountId(accountId), {
        url,
        method: 'POST',
        lastRefreshError: ultimoErroRefresh
      });
    }
    throw err;
  }
}

// Helper: PUT na API do Bling com retry automático em 401
async function blingPut(urlOrPath, data, tokenObj, accountId) {
  const isFullUrl = /^https?:\/\//i.test(urlOrPath);
  const url = isFullUrl ? urlOrPath : `${BLING_API_BASE}${urlOrPath}`;
  const buildHeaders = (accessToken) => ({
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  });
  try {
    return await axios.put(url, data, { headers: buildHeaders(tokenObj.access_token) });
  } catch (err) {
    if (err.response?.status === 401) {
      const newToken = await refreshTokenIfNeeded(accountId);
      if (newToken && newToken.access_token) {
        return await axios.put(url, data, { headers: buildHeaders(newToken.access_token) });
      }
      logMarketplaceConnection('bling', 'api_401_refresh_failed', 'ERROR', normalizeAccountId(accountId), {
        url,
        method: 'PUT',
        lastRefreshError: ultimoErroRefresh
      });
    }
    throw err;
  }
}

// Função para limpar tokens antigos (manter apenas o mais recente)
function cleanOldTokens(accountId) {
  const normalizedAccountId = normalizeAccountId(accountId);
  return new Promise((resolve) => {
    db.run(
      `DELETE FROM api_tokens WHERE provider = ? AND account_id = ? AND id NOT IN (
        SELECT id FROM api_tokens WHERE provider = ? AND account_id = ? ORDER BY updated_at DESC LIMIT 1
      )`,
      ['bling', normalizedAccountId, 'bling', normalizedAccountId],
      function(err) {
        if (err) {
          logBling('Erro ao limpar tokens antigos', err.message);
        } else {
          logBling('Tokens antigos removidos', { accountId: normalizedAccountId, deletedRows: this.changes });
        }
        resolve();
      }
    );
  });
}

// Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https://*.mlstatic.com", "http2.mlstatic.com", "https://*.susercontent.com", "https://down-br.img.susercontent.com", "https://cf.shopee.com.br"],
      connectSrc: ["'self'", "https://api.mercadolibre.com"],
      fontSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      frameSrc: ["'self'"],
    }
  }
}));
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || 'https://miti.fly.dev,https://apoli-miti.fly.dev,http://localhost:3000,http://localhost:3001').split(',').map(s => s.trim());
app.use(cors({
  origin: function(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes('*')) {
      callback(null, true);
    } else {
      callback(null, false);
    }
  },
  credentials: true
}));
app.use(morgan('combined'));
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const status = res.statusCode;
    if (req.path === '/health' || req.path.startsWith('/static')) return;
    const level = status >= 500 ? 'ERROR' : status >= 400 ? 'WARN' : 'INFO';
    addLog(level, 'HTTP', `${req.method} ${req.path} ${status} ${duration}ms`);
  });
  next();
});
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Estratégia de cache para evitar que navegadores sirvam uma versão antiga
// do frontend ao usuário (problema clássico de PWA sem service worker):
//   • Arquivos em /static/* (CRA) têm hash no nome → cache forever (1 ano).
//     Se o conteúdo muda, o hash muda, o browser busca o novo arquivo.
//   • index.html e demais assets sem hash → no-store. Obriga o browser a
//     validar a cada abertura, garantindo que clientes peguem sempre o
//     build mais recente depois de um deploy.
//   • API (/api/*) → no-store, porque retornos dependem de dados dinâmicos.
app.use('/static', express.static(path.join(__dirname, '../client/build/static'), {
  maxAge: '1y',
  immutable: true,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  },
}));
const noStoreHtml = (res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
};
app.use(express.static(path.join(__dirname, '../client/public'), { setHeaders: noStoreHtml }));
app.use(express.static(path.join(__dirname, '../client/build'), { setHeaders: noStoreHtml }));
// Respostas de API não podem ser cacheadas por browsers ou proxies.
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true });
});

// Configuração do banco de dados SQLite
const dbPath = process.env.DB_PATH || '/data/database.sqlite';
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    addLog('ERROR', 'DB', 'Erro ao conectar ao banco de dados: ' + err.message);
    console.error('Erro ao conectar ao banco de dados:', err);
  } else {
    addLog('INFO', 'DB', `Conectado ao SQLite em ${dbPath}`);
    console.log('Conectado ao banco de dados SQLite em', dbPath);
    initDatabase();
  }
});
// Sem um listener para 'error', falhas em db.run() sem callback viram
// uncaughtException e derrubam o processo. Logamos e seguimos.
db.on('error', (e) => {
  console.error('[DB] erro não tratado:', e && e.message ? e.message : e);
});

// Proteções de runtime — evitam que rejeições ou exceções pontuais (ex.
// falhas transientes de API do ML/Shopee, eventos emitidos sem listener)
// derrubem o processo todo no Fly. Em produção, manter o servidor vivo é
// melhor do que crashar e depender do restart do orquestrador.
process.on('unhandledRejection', (reason) => {
  console.error('[Runtime] unhandledRejection:', reason && (reason.stack || reason.message || reason));
});
process.on('uncaughtException', (err) => {
  console.error('[Runtime] uncaughtException:', err && (err.stack || err.message || err));
});

/**
 * Converte timestamps do SQLite (`CURRENT_TIMESTAMP`) em objetos Date com fuso correto.
 * O SQLite grava em UTC no formato "YYYY-MM-DD HH:MM:SS" (sem `Z`); sem esse tratamento,
 * `new Date()` do Node interpreta como horário local e o cálculo de expiração de token
 * fica deslocado pelo offset do fuso (ex.: 3h no Brasil), causando refresh tardio.
 */
function parseSqliteUtcDate(value) {
  if (value == null) return new Date(NaN);
  if (value instanceof Date) return value;
  const s = String(value).trim();
  if (!s) return new Date(NaN);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(s)) {
    return new Date(s.replace(' ', 'T') + 'Z');
  }
  return new Date(s);
}

/** Log estruturado para diagnóstico de desconexão / falha de token (Bling, ML, Shopee). Persistido no SQLite. */
function logMarketplaceConnection(provider, event, level, accountId, detailObj) {
  const safeProvider = String(provider || 'unknown');
  const safeEvent = String(event || 'event');
  const lev = ['ERROR', 'WARN', 'INFO', 'DEBUG'].includes(level) ? level : 'INFO';
  const acct = accountId === undefined || accountId === null ? '' : ` conta=${accountId}`;
  const message = `[${safeProvider}] ${safeEvent}${acct}`;
  const data = { provider: safeProvider, accountId: accountId != null ? accountId : null, event: safeEvent, ...(detailObj && typeof detailObj === 'object' ? detailObj : {}) };
  addLog(lev, 'MARKETPLACE', message, data);
  let detailJson = null;
  try {
    detailJson = JSON.stringify(data).slice(0, 8000);
  } catch {
    detailJson = String(detailObj);
  }
  db.run(
    'INSERT INTO marketplace_connection_log (provider, account_id, event, level, detail) VALUES (?, ?, ?, ?, ?)',
    [safeProvider, accountId != null && Number.isFinite(Number(accountId)) ? Number(accountId) : null, safeEvent, lev, detailJson],
    () => {}
  );
}

const REPORT_TZ_OFFSET_HOURS = parseInt(process.env.REPORT_TZ_OFFSET_HOURS || '-3', 10);
const REPORT_TZ_MODIFIER = `${REPORT_TZ_OFFSET_HOURS} hours`;
const reportDateExpr = (alias = 'n') =>
  `date(datetime(${alias}.dataExpedicao, '${REPORT_TZ_MODIFIER}'))`;

const REPORT_TZ_OFFSET = `${REPORT_TZ_OFFSET_HOURS <= 0 ? '-' : '+'}${String(Math.abs(REPORT_TZ_OFFSET_HOURS)).padStart(2, '0')}:00`;

function normalizeDateWithOffset(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  if (!s) return '';
  if (s.includes('T')) {
    const parts = s.split('T');
    const datePart = parts[0];
    const timePart = parts[1] || '';
    s = timePart ? `${datePart}T${timePart}` : datePart;
  } else if (s.includes(' ')) {
    const parts = s.split(' ');
    const datePart = parts[0];
    const timePart = parts[1] || '';
    s = timePart ? `${datePart}T${timePart}` : datePart;
  }
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
    const [d, m, y] = s.split('/');
    s = `${y}-${m}-${d}`;
  }
  if (/([zZ]|[+-]\d{2}:?\d{2})$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00${REPORT_TZ_OFFSET}`;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return `${s}${REPORT_TZ_OFFSET}`;
  return s;
}

/** Início/fim do dia no fuso de relatório (padrão America/Sao_Paulo via REPORT_TZ_OFFSET), alinhado às datas do ML. Apenas YYYY-MM-DD. */
function marketplaceOrdersDateRangeBounds(dateFrom, dateTo) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const out = { from: null, to: null };
  if (dateFrom && re.test(String(dateFrom).trim())) {
    const d = String(dateFrom).trim();
    out.from = `${d}T00:00:00.000${REPORT_TZ_OFFSET}`;
  }
  if (dateTo && re.test(String(dateTo).trim())) {
    const d = String(dateTo).trim();
    out.to = `${d}T23:59:59.999${REPORT_TZ_OFFSET}`;
  }
  return out;
}

/**
 * Normaliza instante vindo da API (ML etc.) para ISO 8601 único: data/hora civil em America/Sao_Paulo
 * com sufixo REPORT_TZ_OFFSET. Melhora ordenação no SQLite e filtros por intervalo.
 * Pedidos antigos no banco podem ser regravados com nova sincronização.
 */
function normalizeMarketplaceOrderDate(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    const fallback = normalizeDateWithOffset(s);
    return fallback || null;
  }
  const sign = REPORT_TZ_OFFSET_HOURS <= 0 ? '-' : '+';
  const absH = Math.abs(REPORT_TZ_OFFSET_HOURS);
  const offStr = `${sign}${String(absH).padStart(2, '0')}:00`;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value || '00';
  const ms = d.getMilliseconds();
  const frac = `.${String(ms).padStart(3, '0')}`;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${frac}${offStr}`;
}

// Inicialização do banco de dados
function initDatabase() {
  db.serialize(() => {
    // Tabela de usuários
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // MIGRAÇÃO: Adicionar campo settings se não existir
    db.all("PRAGMA table_info(users)", (err, columns) => {
      if (!err && Array.isArray(columns) && !columns.some(col => col.name === 'settings')) {
        db.run("ALTER TABLE users ADD COLUMN settings TEXT", (err) => {
          if (!err) console.log('Campo settings adicionado à tabela users');
        });
      }
    });

    // Tabela de produtos
    db.run(`CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      price REAL NOT NULL,
      quantity INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Tabela de configurações da API externa
    db.run(`CREATE TABLE IF NOT EXISTS api_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      api_key TEXT,
      enabled BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Configurações globais key/value editáveis em runtime pela UI de
    // Configurações (backup schedule, pacing, etc.).
    db.run(`CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Tabela de vendas
    db.run(`CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      product_id INTEGER,
      quantity INTEGER NOT NULL,
      total_price REAL NOT NULL,
      sale_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id),
      FOREIGN KEY (product_id) REFERENCES products (id)
    )`);

    // Tabela de estoque
    db.run(`CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku TEXT UNIQUE NOT NULL,
      ean TEXT,
      title TEXT NOT NULL,
      quantity INTEGER DEFAULT 0,
      location TEXT,
      min_quantity INTEGER DEFAULT 0,
      max_quantity INTEGER,
      category TEXT,
      supplier TEXT,
      cost_price REAL,
      selling_price REAL,
      cubic_weight REAL,
      height_cm REAL,
      width_cm REAL,
      length_cm REAL,
      weight_kg REAL,
      notes TEXT,
      is_composite BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Tabela de fotos dos SKUs (armazenamento base64 leve)
    db.run(`CREATE TABLE IF NOT EXISTS inventory_images (
      sku TEXT PRIMARY KEY,
      mime TEXT,
      image_base64 TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Migrar coluna cubic_weight se não existir
    db.all("PRAGMA table_info(inventory)", (err, cols) => {
      if (!err && Array.isArray(cols) && !cols.some(c => c.name === 'cubic_weight')) {
        db.run("ALTER TABLE inventory ADD COLUMN cubic_weight REAL", () => {});
      }
      if (!err && Array.isArray(cols) && !cols.some(c => c.name === 'height_cm')) {
        db.run("ALTER TABLE inventory ADD COLUMN height_cm REAL", () => {});
      }
      if (!err && Array.isArray(cols) && !cols.some(c => c.name === 'width_cm')) {
        db.run("ALTER TABLE inventory ADD COLUMN width_cm REAL", () => {});
      }
      if (!err && Array.isArray(cols) && !cols.some(c => c.name === 'length_cm')) {
        db.run("ALTER TABLE inventory ADD COLUMN length_cm REAL", () => {});
      }
      if (!err && Array.isArray(cols) && !cols.some(c => c.name === 'weight_kg')) {
        db.run("ALTER TABLE inventory ADD COLUMN weight_kg REAL", () => {});
      }
      // Imposto por SKU foi descontinuado — agora a alíquota vive em
      // ml_accounts.tax_pct / shopee_accounts.tax_pct (por conta de
      // marketplace). Tentamos dropar a coluna se existir, mas não falhamos
      // se o SQLite for antigo (<3.35) e não suportar DROP COLUMN: nesses
      // casos a coluna fica como legado silencioso, ignorada pelo backend.
      if (!err && Array.isArray(cols) && cols.some(c => c.name === 'tax_pct')) {
        db.run("ALTER TABLE inventory DROP COLUMN tax_pct", () => {});
      }
    });

    // Tabela de movimentações de estoque
    db.run(`CREATE TABLE IF NOT EXISTS inventory_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inventory_id INTEGER NOT NULL,
      movement_type TEXT NOT NULL, -- 'in', 'out', 'adjustment'
      quantity INTEGER NOT NULL,
      previous_quantity INTEGER NOT NULL,
      new_quantity INTEGER NOT NULL,
      reason TEXT,
      user_id INTEGER,
      account_id INTEGER,
      movement_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (inventory_id) REFERENCES inventory (id),
      FOREIGN KEY (user_id) REFERENCES users (id)
    )`);

    // Adicionar coluna account_id em inventory_movements se não existir
    db.all(`PRAGMA table_info(inventory_movements)`, (err, columns) => {
      if (!err && Array.isArray(columns) && !columns.some(col => col.name === 'account_id')) {
        db.run("ALTER TABLE inventory_movements ADD COLUMN account_id INTEGER", (alterErr) => {
          if (alterErr) {
            console.error('❌ Erro ao adicionar coluna account_id em inventory_movements:', alterErr.message);
          } else {
            console.log('✅ Coluna account_id adicionada à tabela inventory_movements');
          }
        });
      }
    });

    // Configuração de custos por marketplace
    db.run(`CREATE TABLE IF NOT EXISTS marketplace_cost_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      marketplace TEXT NOT NULL,
      commission_percent REAL DEFAULT 0,
      commission_fixed_per_order REAL DEFAULT 0,
      commission_fixed_per_item REAL DEFAULT 0,
      freight_mode TEXT DEFAULT 'fixed_per_order',
      freight_fixed_per_order REAL DEFAULT 0,
      freight_fixed_per_item REAL DEFAULT 0,
      default_shipping_table_id INTEGER,
      commission_base TEXT DEFAULT 'gross',
      extra_fixed_per_order REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Tabelas de frete
    db.run(`CREATE TABLE IF NOT EXISTS shipping_tables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      marketplace TEXT NOT NULL,
      name TEXT NOT NULL,
      rule_type TEXT NOT NULL,
      rules_json TEXT NOT NULL,
      effective_from DATETIME,
      effective_to DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Overrides por item
    db.run(`CREATE TABLE IF NOT EXISTS item_cost_overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku_id INTEGER NOT NULL,
      commission_percent_override REAL,
      commission_fixed_override REAL,
      extra_fixed_per_item REAL,
      shipping_table_id_override INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sku_id) REFERENCES inventory(id)
    )`);

    // Cache de custos por pedido
    db.run(`CREATE TABLE IF NOT EXISTS order_costs (
      nota_id INTEGER PRIMARY KEY,
      marketplace TEXT,
      total_itens INTEGER,
      faturamento REAL,
      commission REAL,
      freight REAL,
      extra_fixed REAL,
      cogs REAL,
      gross_margin REAL,
      gross_margin_percent REAL,
      computed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Detalhe por item
    db.run(`CREATE TABLE IF NOT EXISTS order_item_costs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nota_id INTEGER NOT NULL,
      sku TEXT,
      quantidade INTEGER,
      receita_item REAL,
      commission_item REAL,
      freight_item REAL,
      extra_fixed_item REAL,
      cogs_item REAL,
      gross_margin_item REAL,
      gross_margin_item_percent REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Migrações leves
    db.all("PRAGMA table_info(marketplace_cost_config)", (err, cols) => {
      if (!err && Array.isArray(cols) && !cols.some(c => c.name === 'commission_base')) {
        db.run("ALTER TABLE marketplace_cost_config ADD COLUMN commission_base TEXT DEFAULT 'gross'", () => {});
      }
    });
    // Tabela: comissão por categoria (sincronizada de fontes externas)
    db.run(`CREATE TABLE IF NOT EXISTS marketplace_category_fees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      marketplace TEXT NOT NULL,
      category TEXT NOT NULL,
      commission_percent REAL DEFAULT 0,
      commission_fixed_per_order REAL DEFAULT 0,
      commission_fixed_per_item REAL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    // Fonte remota para fees
    db.run(`CREATE TABLE IF NOT EXISTS fee_remote_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      marketplace TEXT NOT NULL,
      url TEXT NOT NULL,
      format TEXT DEFAULT 'csv', -- 'csv' | 'json'
      active INTEGER DEFAULT 1,
      last_synced DATETIME,
      notes TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.all("PRAGMA table_info(notas_expedidas)", (err, cols) => {
      if (!err && Array.isArray(cols) && !cols.some(c => c.name === 'desconto')) {
        db.run("ALTER TABLE notas_expedidas ADD COLUMN desconto REAL DEFAULT 0", () => {});
      }
    });

    // Seed: Tabela estática de frete por peso do Mercado Livre (< R$79/usados)
    db.get(`SELECT id FROM shipping_tables WHERE marketplace = 'Mercado Livre' AND name = 'ML Frete Peso (estático - <R$79/usados)' LIMIT 1`, (e, row) => {
      if (e) return; if (row) return;
      const bands = [
        { min: 0, max: 0.3, price: 39.90 },
        { min: 0.3, max: 0.5, price: 42.90 },
        { min: 0.5, max: 1, price: 44.90 },
        { min: 1, max: 2, price: 46.90 },
        { min: 2, max: 3, price: 49.90 },
        { min: 3, max: 4, price: 53.90 },
        { min: 4, max: 5, price: 56.90 },
        { min: 5, max: 9, price: 88.90 },
        { min: 9, max: 13, price: 131.90 },
        { min: 13, max: 17, price: 146.90 },
        { min: 17, max: 23, price: 171.90 },
        { min: 23, max: 30, price: 197.90 },
        { min: 30, max: 40, price: 203.90 },
        { min: 40, max: 50, price: 210.90 },
        { min: 50, max: 60, price: 224.90 },
        { min: 60, max: 70, price: 240.90 },
        { min: 70, max: 80, price: 251.90 },
        { min: 80, max: 90, price: 279.90 },
        { min: 90, max: 100, price: 319.90 },
        { min: 100, max: 125, price: 357.90 },
        { min: 125, max: 150, price: 379.90 },
        { min: 150, max: 9999, price: 498.90 }
      ];
      db.run(`INSERT INTO shipping_tables (marketplace, name, rule_type, rules_json) VALUES ('Mercado Livre', 'ML Frete Peso (estático - <R$79/usados)', 'weight_band', ?)`, [JSON.stringify(bands)]);
    });

    // Seeds: tabelas por faixa de preço (ex.: R$79–99, 100–119, 120–149, 150–199, >200) - valores aproximados da página oficial
    function seedMltable(name, rows) {
      db.get(`SELECT id FROM shipping_tables WHERE marketplace = 'Mercado Livre' AND name = ? LIMIT 1`, [name], (e, r) => {
        if (e || r) return;
        db.run(`INSERT INTO shipping_tables (marketplace, name, rule_type, rules_json) VALUES ('Mercado Livre', ?, 'weight_band', ?)`, [name, JSON.stringify(rows)]);
      });
    }
    seedMltable('ML Frete Peso (R$79-99,99)', [
      { min:0, max:0.3, price:11.97 },{ min:0.3, max:0.5, price:12.87 },{ min:0.5, max:1, price:13.47 },{ min:1, max:2, price:14.07 },{ min:2, max:3, price:14.97 },{ min:3, max:4, price:16.17 },{ min:4, max:5, price:17.07 },{ min:5, max:9, price:26.67 },{ min:9, max:13, price:39.57 },{ min:13, max:17, price:44.07 },{ min:17, max:23, price:51.57 },{ min:23, max:30, price:59.37 },{ min:30, max:40, price:61.17 },{ min:40, max:50, price:63.27 },{ min:50, max:60, price:67.47 },{ min:60, max:70, price:72.27 },{ min:70, max:80, price:75.57 },{ min:80, max:90, price:83.97 },{ min:90, max:100, price:95.97 },{ min:100, max:125, price:107.37 },{ min:125, max:150, price:113.97 },{ min:150, max:9999, price:149.67 }
    ]);
    seedMltable('ML Frete Peso (R$100-119,99)', [
      { min:0, max:0.3, price:13.97 },{ min:0.3, max:0.5, price:15.02 },{ min:0.5, max:1, price:15.72 },{ min:1, max:2, price:16.42 },{ min:2, max:3, price:17.47 },{ min:3, max:4, price:18.87 },{ min:4, max:5, price:19.92 },{ min:5, max:9, price:31.12 },{ min:9, max:13, price:46.17 },{ min:13, max:17, price:51.42 },{ min:17, max:23, price:60.17 },{ min:23, max:30, price:69.27 },{ min:30, max:40, price:71.37 },{ min:40, max:50, price:73.82 },{ min:50, max:60, price:78.72 },{ min:60, max:70, price:84.32 },{ min:70, max:80, price:88.17 },{ min:80, max:90, price:97.97 },{ min:90, max:100, price:111.97 },{ min:100, max:125, price:125.27 },{ min:125, max:150, price:132.97 },{ min:150, max:9999, price:174.62 }
    ]);
    seedMltable('ML Frete Peso (R$120-149,99)', [
      { min:0, max:0.3, price:15.96 },{ min:0.3, max:0.5, price:17.16 },{ min:0.5, max:1, price:17.96 },{ min:1, max:2, price:18.76 },{ min:2, max:3, price:19.96 },{ min:3, max:4, price:21.56 },{ min:4, max:5, price:22.76 },{ min:5, max:9, price:35.56 },{ min:9, max:13, price:52.76 },{ min:13, max:17, price:58.76 },{ min:17, max:23, price:68.76 },{ min:23, max:30, price:79.16 },{ min:30, max:40, price:81.56 },{ min:40, max:50, price:84.36 },{ min:50, max:60, price:89.96 },{ min:60, max:70, price:96.36 },{ min:70, max:80, price:100.76 },{ min:80, max:90, price:111.96 },{ min:90, max:100, price:127.96 },{ min:100, max:125, price:143.16 },{ min:125, max:150, price:151.96 },{ min:150, max:9999, price:199.56 }
    ]);
    seedMltable('ML Frete Peso (R$150-199,99)', [
      { min:0, max:0.3, price:17.96 },{ min:0.3, max:0.5, price:19.31 },{ min:0.5, max:1, price:20.21 },{ min:1, max:2, price:21.11 },{ min:2, max:3, price:22.46 },{ min:3, max:4, price:24.26 },{ min:4, max:5, price:25.61 },{ min:5, max:9, price:40.01 },{ min:9, max:13, price:59.36 },{ min:13, max:17, price:66.11 },{ min:17, max:23, price:77.36 },{ min:23, max:30, price:89.06 },{ min:30, max:40, price:91.76 },{ min:40, max:50, price:94.91 },{ min:50, max:60, price:101.21 },{ min:60, max:70, price:108.41 },{ min:70, max:80, price:113.36 },{ min:80, max:90, price:125.96 },{ min:90, max:100, price:143.96 },{ min:100, max:125, price:161.06 },{ min:125, max:150, price:170.96 },{ min:150, max:9999, price:224.51 }
    ]);
    seedMltable('ML Frete Peso (>R$200)', [
      { min:0, max:0.3, price:19.95 },{ min:0.3, max:0.5, price:21.45 },{ min:0.5, max:1, price:22.45 },{ min:1, max:2, price:23.45 },{ min:2, max:3, price:24.95 },{ min:3, max:4, price:26.95 },{ min:4, max:5, price:28.45 },{ min:5, max:9, price:44.45 },{ min:9, max:13, price:65.95 },{ min:13, max:17, price:73.45 },{ min:17, max:23, price:85.95 },{ min:23, max:30, price:98.95 },{ min:30, max:40, price:101.95 },{ min:40, max:50, price:105.45 },{ min:50, max:60, price:112.45 },{ min:60, max:70, price:120.45 },{ min:70, max:80, price:125.95 },{ min:80, max:90, price:139.95 },{ min:90, max:100, price:159.95 },{ min:100, max:125, price:178.95 },{ min:125, max:150, price:189.95 },{ min:150, max:9999, price:249.45 }
    ]);

    // Seed: Configuração básica da Shopee (sem frete por pedido, com possível taxa por item a definir)
    db.get(`SELECT id FROM marketplace_cost_config WHERE marketplace = 'Shopee' LIMIT 1`, (e, row) => {
      if (e) return; if (row) return;
      db.run(`INSERT INTO marketplace_cost_config (marketplace, commission_percent, commission_fixed_per_order, commission_fixed_per_item, freight_mode, freight_fixed_per_order, freight_fixed_per_item, default_shipping_table_id, extra_fixed_per_order, commission_base) VALUES ('Shopee', 0, 0, 0, 'fixed_per_order', 0, 0, NULL, 0, 'gross')`);
    });

    // NOVA TABELA: SKUs Compostos
    db.run(`CREATE TABLE IF NOT EXISTS composite_skus (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      main_sku_id INTEGER NOT NULL,
      component_sku_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (main_sku_id) REFERENCES inventory (id),
      FOREIGN KEY (component_sku_id) REFERENCES inventory (id)
    )`);

    // Tabela de aglutinados
    db.run(`CREATE TABLE IF NOT EXISTS aglutinados (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data_criacao DATETIME DEFAULT CURRENT_TIMESTAMP,
      marketplaces TEXT,
      conteudo_html TEXT NOT NULL,
      conteudo_json TEXT
    )`);

    // Criar usuário admin padrão se não existir
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@apoli.com';
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
    db.get('SELECT * FROM users WHERE email = ?', [adminEmail], (err, row) => {
      if (!row) {
        const hash = bcrypt.hashSync(adminPassword, 10);
        db.run('INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
          ['Administrador', adminEmail, hash, 4],
          (err) => {
            if (err) console.error('Erro ao criar admin:', err);
            else console.log('Usuário admin criado com sucesso');
          }
        );
      }
    });

    // Criar tabela de notas expedidas
    db.run(`CREATE TABLE IF NOT EXISTS notas_expedidas (
      id INTEGER PRIMARY KEY,
      account_id INTEGER,
      numero TEXT,
      codigo TEXT,
      numeroLoja TEXT,
      cliente TEXT,
      valorNota REAL,
      dataExpedicao DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Adicionar coluna account_id em notas_expedidas se não existir
    db.all("PRAGMA table_info(notas_expedidas)", (err, columns) => {
      if (!err && Array.isArray(columns) && !columns.some(col => col.name === 'account_id')) {
        db.run("ALTER TABLE notas_expedidas ADD COLUMN account_id INTEGER", (alterErr) => {
          if (alterErr) {
            console.error('❌ Erro ao adicionar coluna account_id em notas_expedidas:', alterErr.message);
          } else {
            db.run("UPDATE notas_expedidas SET account_id = ? WHERE account_id IS NULL", [defaultBlingAccountId], () => {});
            console.log('✅ Coluna account_id adicionada à tabela notas_expedidas');
          }
        });
      }
    });

    // Tabela de notas fiscais importadas (relatórios)
    db.run(`CREATE TABLE IF NOT EXISTS notas_fiscais (
      id TEXT PRIMARY KEY,
      account_id INTEGER,
      numero TEXT,
      numeroLoja TEXT,
      cliente TEXT,
      valorNota REAL,
      marketplace TEXT,
      dataEmissao DATETIME
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_notas_fiscais_account ON notas_fiscais(account_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_notas_fiscais_data ON notas_fiscais(dataEmissao)`);

    db.run(`CREATE TABLE IF NOT EXISTS nota_itens_fiscais (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nota_id TEXT,
      account_id INTEGER,
      sku TEXT,
      quantidade INTEGER,
      title TEXT
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_nota_itens_fiscais_nota ON nota_itens_fiscais(nota_id)`);

    // Adicionar coluna marketplace em notas_expedidas se não existir
    db.all("PRAGMA table_info(notas_expedidas)", (err, columns) => {
      if (!err && Array.isArray(columns) && !columns.some(col => col.name === 'marketplace')) {
        db.run("ALTER TABLE notas_expedidas ADD COLUMN marketplace TEXT", (alterErr) => {
          if (alterErr) {
            console.error('❌ Erro ao adicionar coluna marketplace em notas_expedidas:', alterErr.message);
          } else {
            console.log('✅ Coluna marketplace adicionada à tabela notas_expedidas');
          }
        });
      }
    });

    // Tabela de itens das notas expedidas (para consolidar SKUs e quantidades)
    db.run(`CREATE TABLE IF NOT EXISTS nota_itens_expedidos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nota_id INTEGER NOT NULL,
      account_id INTEGER,
      sku TEXT NOT NULL,
      quantidade INTEGER NOT NULL DEFAULT 0,
      title TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(nota_id) REFERENCES notas_expedidas(id)
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_nota_itens_expedidos_nota ON nota_itens_expedidos(nota_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_nota_itens_expedidos_sku ON nota_itens_expedidos(sku)`);

    // Adicionar coluna account_id em nota_itens_expedidos se não existir
    db.all("PRAGMA table_info(nota_itens_expedidos)", (err, columns) => {
      if (!err && Array.isArray(columns) && !columns.some(col => col.name === 'account_id')) {
        db.run("ALTER TABLE nota_itens_expedidos ADD COLUMN account_id INTEGER", (alterErr) => {
          if (alterErr) {
            console.error('❌ Erro ao adicionar coluna account_id em nota_itens_expedidos:', alterErr.message);
          } else {
            db.run("UPDATE nota_itens_expedidos SET account_id = ? WHERE account_id IS NULL", [defaultBlingAccountId], () => {});
            console.log('✅ Coluna account_id adicionada à tabela nota_itens_expedidos');
          }
        });
      }
    });

    // Backfill de account_id em itens expedidos (legado)
    db.run(
      `UPDATE nota_itens_expedidos
       SET account_id = (
         SELECT n.account_id FROM notas_expedidas n WHERE n.id = nota_itens_expedidos.nota_id
       )
       WHERE account_id IS NULL`,
      () => {}
    );

    // Pedidos de reposição ao fornecedor (em aberto / em trânsito)
    db.run(`CREATE TABLE IF NOT EXISTS supplier_order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inventory_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 0,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (inventory_id) REFERENCES inventory(id)
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_supplier_order_items_inv ON supplier_order_items(inventory_id)`);

    // Lotes pedidos à fábrica (multi-SKU, entregas parciais). Substitui supplier_order_items no fluxo novo.
    db.run(`CREATE TABLE IF NOT EXISTS factory_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE,
      supplier_name TEXT,
      expected_date DATE,
      status TEXT NOT NULL DEFAULT 'open',
      notes TEXT,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      closed_at DATETIME
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS factory_order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      factory_order_id INTEGER NOT NULL,
      inventory_id INTEGER NOT NULL,
      sku TEXT,
      title TEXT,
      quantity_ordered INTEGER NOT NULL,
      quantity_received INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      FOREIGN KEY (factory_order_id) REFERENCES factory_orders(id) ON DELETE CASCADE,
      FOREIGN KEY (inventory_id) REFERENCES inventory(id)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS factory_order_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      factory_order_item_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      received_by INTEGER,
      received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'pending', -- pending | confirmed | rejected
      quantity_confirmed INTEGER,
      confirmed_by INTEGER,
      confirmed_at DATETIME,
      divergence_notes TEXT,
      FOREIGN KEY (factory_order_item_id) REFERENCES factory_order_items(id) ON DELETE CASCADE
    )`);
    // Migrações aditivas para instalações antigas (executam em ordem dentro do serialize).
    // Se a coluna já existir, o SQLite retorna erro "duplicate column name" — que ignoramos.
    const addColumnSafe = (sql) => db.run(sql, (err) => {
      if (err && !/duplicate column name/i.test(err.message)) {
        console.error('[migration] erro ao adicionar coluna:', err.message);
      }
    });
    addColumnSafe("ALTER TABLE factory_order_receipts ADD COLUMN status TEXT NOT NULL DEFAULT 'confirmed'");
    addColumnSafe('ALTER TABLE factory_order_receipts ADD COLUMN quantity_confirmed INTEGER');
    addColumnSafe('ALTER TABLE factory_order_receipts ADD COLUMN confirmed_by INTEGER');
    addColumnSafe('ALTER TABLE factory_order_receipts ADD COLUMN confirmed_at DATETIME');
    addColumnSafe('ALTER TABLE factory_order_receipts ADD COLUMN divergence_notes TEXT');

    // A6 — controle de sync incremental/agendado.
    addColumnSafe('ALTER TABLE ml_accounts ADD COLUMN last_items_sync_at DATETIME');
    addColumnSafe('ALTER TABLE ml_accounts ADD COLUMN auto_sync_enabled INTEGER DEFAULT 0');
    addColumnSafe('ALTER TABLE shopee_accounts ADD COLUMN last_items_sync_at DATETIME');
    addColumnSafe('ALTER TABLE shopee_accounts ADD COLUMN auto_sync_enabled INTEGER DEFAULT 0');
    // Integrador de pedidos (M1) — vincula conta ML/Shopee à conta Bling usada
    // para faturar e habilita o worker de auto-fatura por conta.
    addColumnSafe('ALTER TABLE ml_accounts ADD COLUMN bling_account_id INTEGER');
    addColumnSafe('ALTER TABLE ml_accounts ADD COLUMN auto_invoice_enabled INTEGER DEFAULT 0');
    addColumnSafe('ALTER TABLE shopee_accounts ADD COLUMN bling_account_id INTEGER');
    addColumnSafe('ALTER TABLE shopee_accounts ADD COLUMN auto_invoice_enabled INTEGER DEFAULT 0');
    // A7 — telemetria de erro por config de estoque (último erro + data).
    // (ml_*_stock_config já foram criados antes desse bloco. As tabelas da
    //  Shopee, porém, são criadas mais abaixo; migrations de coluna para elas
    //  vivem após os CREATE TABLE correspondentes.)
    addColumnSafe('ALTER TABLE ml_stock_config ADD COLUMN last_error_message TEXT');
    addColumnSafe('ALTER TABLE ml_stock_config ADD COLUMN last_error_at DATETIME');
    addColumnSafe('ALTER TABLE ml_variation_stock_config ADD COLUMN last_error_message TEXT');
    addColumnSafe('ALTER TABLE ml_variation_stock_config ADD COLUMN last_error_at DATETIME');
    // Overrides manuais de atributos Shopee (quando a API oficial está bloqueada
    // por permissão). O seller cola o JSON do DevTools do Seller Center e fica
    // persistido aqui, funcionando como fonte oficial pra categoria.
    db.run(`CREATE TABLE IF NOT EXISTS shopee_category_attrs_override (
      category_id INTEGER PRIMARY KEY,
      attributes_json TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
      if (err) { console.error('[Shopee] failed to create shopee_category_attrs_override:', err.message); return; }
      // Load após CREATE TABLE completar, garantindo ordem correta.
      try { loadShopeeAttrsOverridesFromDb(); } catch (_) {}
    });
    // Valores "default" por (categoria, atributo) — alimenta o pré-preenchimento
    // da ficha técnica Shopee em novos modelos. Atualizado a cada import/merge
    // com o último valor escolhido pelo seller naquela categoria.
    db.run(`CREATE TABLE IF NOT EXISTS shopee_category_default_values (
      category_id INTEGER NOT NULL,
      attribute_id INTEGER NOT NULL,
      value_id INTEGER,
      original_value_name TEXT,
      display_value_name TEXT,
      value_unit TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (category_id, attribute_id)
    )`, (err) => {
      if (err) { console.error('[Shopee] failed to create shopee_category_default_values:', err.message); return; }
      try { loadShopeeCategoryDefaultsFromDb(); } catch (_) {}
    });
    db.run('UPDATE factory_order_receipts SET quantity_confirmed = quantity WHERE quantity_confirmed IS NULL');
    db.run(`CREATE INDEX IF NOT EXISTS idx_fo_status ON factory_orders(status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_foi_order ON factory_order_items(factory_order_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_foi_inv ON factory_order_items(inventory_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_for_item ON factory_order_receipts(factory_order_item_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_for_status ON factory_order_receipts(status)`);

    // Migração: normaliza movement_date antigo em UTC ("… Z" ou "YYYY-MM-DD HH:MM:SS") para o
    // padrão do projeto "YYYY-MM-DDTHH:MM:SS" em horário de São Paulo. É idempotente: após a
    // conversão, os registros não batem mais no filtro (ficam com 'T' e sem 'Z').
    db.run(
      `UPDATE inventory_movements
       SET movement_date = strftime('%Y-%m-%dT%H:%M:%S', datetime(movement_date, '-3 hours'))
       WHERE movement_date LIKE '%Z'
          OR movement_date LIKE '____-__-__ __:__:__'
          OR movement_date LIKE '____-__-__ __:__:__.%'`,
      function(err) {
        if (err) {
          console.error('[migration] movement_date:', err.message);
        } else if (this && this.changes) {
          console.log(`[migration] movement_date normalizado em ${this.changes} registro(s) para America/Sao_Paulo.`);
        }
      }
    );

    // Pedidos manuais (não movimentam estoque, não contam no faturamento)
    db.run(`CREATE TABLE IF NOT EXISTS manual_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      marketplace TEXT,
      order_number TEXT,
      customer_name TEXT,
      contact TEXT,
      discount REAL DEFAULT 0,
      total_value REAL DEFAULT 0,
      invoice_number TEXT,
      order_date DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_manual_orders_created ON manual_orders(created_at)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_manual_orders_order_number ON manual_orders(order_number)`);

    // Migrar coluna invoice_number se não existir
    db.all("PRAGMA table_info(manual_orders)", (err, cols) => {
      if (!err && Array.isArray(cols) && !cols.some(c => c.name === 'invoice_number')) {
        db.run("ALTER TABLE manual_orders ADD COLUMN invoice_number TEXT", () => {});
      }
      if (!err && Array.isArray(cols) && !cols.some(c => c.name === 'order_date')) {
        db.run("ALTER TABLE manual_orders ADD COLUMN order_date DATETIME", () => {});
      }
    });

    db.run(`CREATE TABLE IF NOT EXISTS manual_order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      sku TEXT,
      title TEXT,
      quantity INTEGER NOT NULL,
      unit_price REAL DEFAULT 0,
      FOREIGN KEY(order_id) REFERENCES manual_orders(id)
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_manual_order_items_order ON manual_order_items(order_id)`);

    // NOVA TABELA: Tokens da API Bling
    db.run(`CREATE TABLE IF NOT EXISTS api_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL DEFAULT 'bling',
      account_id INTEGER,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expires_in INTEGER,
      token_type TEXT DEFAULT 'Bearer',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Adicionar coluna account_id em api_tokens se não existir
    db.all("PRAGMA table_info(api_tokens)", (err, columns) => {
      if (!err && Array.isArray(columns) && !columns.some(col => col.name === 'account_id')) {
        db.run("ALTER TABLE api_tokens ADD COLUMN account_id INTEGER", (alterErr) => {
          if (alterErr) {
            console.error('❌ Erro ao adicionar coluna account_id em api_tokens:', alterErr.message);
          } else {
            db.run("UPDATE api_tokens SET account_id = ? WHERE account_id IS NULL", [defaultBlingAccountId], () => {});
            console.log('✅ Coluna account_id adicionada à tabela api_tokens');
          }
        });
      }
    });

    // Tabela de contas Bling
    db.run(`CREATE TABLE IF NOT EXISTS bling_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      client_id TEXT,
      client_secret TEXT,
      redirect_uri TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, () => {
      db.get('SELECT id FROM bling_accounts ORDER BY id LIMIT 1', (err, row) => {
        if (!err && row && row.id) {
          defaultBlingAccountId = row.id;
          return;
        }
        db.run('INSERT INTO bling_accounts (name) VALUES (?)', ['Conta 1'], function(insertErr) {
          if (insertErr) {
            console.error('❌ Erro ao criar conta Bling padrão:', insertErr.message);
          } else if (this && this.lastID) {
            defaultBlingAccountId = this.lastID;
          }
        });
      });
    });
    db.all('PRAGMA table_info(bling_accounts)', (err, columns) => {
      if (err || !Array.isArray(columns)) return;
      const names = columns.map(col => col.name);
      if (!names.includes('client_id')) {
        db.run('ALTER TABLE bling_accounts ADD COLUMN client_id TEXT');
      }
      if (!names.includes('client_secret')) {
        db.run('ALTER TABLE bling_accounts ADD COLUMN client_secret TEXT');
      }
      if (!names.includes('redirect_uri')) {
        db.run('ALTER TABLE bling_accounts ADD COLUMN redirect_uri TEXT');
      }
      if (!names.includes('connection_status')) {
        db.run("ALTER TABLE bling_accounts ADD COLUMN connection_status TEXT DEFAULT 'active'");
      }
    });

    // ─── Mercado Livre tables ───
    db.run(`CREATE TABLE IF NOT EXISTS ml_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      client_id TEXT,
      client_secret TEXT,
      redirect_uri TEXT,
      ml_user_id TEXT,
      tax_pct REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.all("PRAGMA table_info(ml_accounts)", (err, cols) => {
      if (err || !Array.isArray(cols)) return;
      if (!cols.some(c => c.name === 'tax_pct')) {
        db.run("ALTER TABLE ml_accounts ADD COLUMN tax_pct REAL", () => {});
      }
    });

    db.run(`CREATE TABLE IF NOT EXISTS ml_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ml_item_id TEXT NOT NULL,
      ml_account_id INTEGER NOT NULL,
      title TEXT,
      sku TEXT,
      price REAL,
      original_price REAL,
      permalink TEXT,
      status TEXT,
      ml_available_quantity INTEGER DEFAULT 0,
      thumbnail TEXT,
      last_synced_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(ml_item_id, ml_account_id)
    )`);
    db.all('PRAGMA table_info(ml_items)', (err, cols) => {
      if (err || !Array.isArray(cols)) return;
      const names = cols.map(c => c.name);
      if (!names.includes('original_price')) db.run('ALTER TABLE ml_items ADD COLUMN original_price REAL');
      if (!names.includes('catalog_product_id')) db.run('ALTER TABLE ml_items ADD COLUMN catalog_product_id TEXT');
      if (!names.includes('listing_type_id')) db.run('ALTER TABLE ml_items ADD COLUMN listing_type_id TEXT');
      if (!names.includes('is_catalog_listing')) db.run('ALTER TABLE ml_items ADD COLUMN is_catalog_listing INTEGER DEFAULT 0');
      if (!names.includes('variation_count')) db.run('ALTER TABLE ml_items ADD COLUMN variation_count INTEGER DEFAULT 0');
      if (!names.includes('variation_types')) db.run("ALTER TABLE ml_items ADD COLUMN variation_types TEXT DEFAULT ''");
    });

    db.run(`CREATE TABLE IF NOT EXISTS ml_item_variations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ml_item_id TEXT NOT NULL,
      ml_account_id INTEGER NOT NULL,
      variation_id TEXT,
      sku TEXT,
      price REAL,
      available_quantity INTEGER DEFAULT 0,
      sold_quantity INTEGER DEFAULT 0,
      attribute_combinations TEXT,
      picture_ids TEXT,
      thumbnail TEXT,
      catalog_product_id TEXT,
      UNIQUE(ml_item_id, ml_account_id, variation_id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS ml_stock_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inventory_id INTEGER NOT NULL,
      ml_account_id INTEGER NOT NULL,
      ml_item_id TEXT NOT NULL,
      use_real_stock INTEGER DEFAULT 0,
      fictitious_min INTEGER DEFAULT 450,
      fictitious_max INTEGER DEFAULT 499,
      fictitious_value INTEGER,
      enabled INTEGER DEFAULT 1,
      last_pushed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (inventory_id) REFERENCES inventory(id),
      UNIQUE(inventory_id, ml_item_id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS ml_variation_stock_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inventory_id INTEGER NOT NULL,
      ml_account_id INTEGER NOT NULL,
      ml_item_id TEXT NOT NULL,
      variation_id TEXT NOT NULL,
      use_real_stock INTEGER DEFAULT 0,
      fictitious_min INTEGER DEFAULT 450,
      fictitious_max INTEGER DEFAULT 499,
      fictitious_value INTEGER,
      enabled INTEGER DEFAULT 1,
      last_pushed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (inventory_id) REFERENCES inventory(id),
      UNIQUE(inventory_id, ml_item_id, variation_id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS ml_item_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_ml_item_id TEXT,
      source_account_id INTEGER,
      title TEXT NOT NULL,
      category_id TEXT,
      price REAL,
      currency_id TEXT DEFAULT 'BRL',
      condition TEXT DEFAULT 'new',
      buying_mode TEXT DEFAULT 'buy_it_now',
      listing_type_id TEXT DEFAULT 'gold_special',
      available_quantity INTEGER DEFAULT 1,
      pictures TEXT,
      attributes TEXT,
      variations TEXT,
      description TEXT,
      shipping TEXT,
      sale_terms TEXT,
      video_id TEXT,
      status TEXT DEFAULT 'draft',
      error_message TEXT,
      published_ml_item_id TEXT,
      published_account_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS ad_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inventory_id INTEGER,
      sku TEXT,
      ean TEXT,
      title TEXT NOT NULL,
      category_id TEXT,
      category_name TEXT,
      price REAL,
      currency_id TEXT DEFAULT 'BRL',
      condition TEXT DEFAULT 'new',
      buying_mode TEXT DEFAULT 'buy_it_now',
      listing_type_id TEXT DEFAULT 'gold_special',
      available_quantity INTEGER DEFAULT 1,
      pictures TEXT,
      attributes TEXT,
      variations TEXT,
      description TEXT,
      shipping TEXT,
      sale_terms TEXT,
      video_id TEXT,
      source_ml_item_id TEXT,
      source_account_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(sku)
    )`);

    db.all("PRAGMA table_info(ad_models)", (err, cols) => {
      if (cols && !cols.find(c => c.name === 'category_name')) {
        db.run("ALTER TABLE ad_models ADD COLUMN category_name TEXT");
      }
      if (cols && !cols.find(c => c.name === 'package_measures')) {
        db.run('ALTER TABLE ad_models ADD COLUMN package_measures TEXT');
      }
      if (cols && !cols.find(c => c.name === 'marketplace_mappings')) {
        db.run('ALTER TABLE ad_models ADD COLUMN marketplace_mappings TEXT');
      }
      if (cols && !cols.find(c => c.name === 'source_marketplace')) {
        db.run("ALTER TABLE ad_models ADD COLUMN source_marketplace TEXT DEFAULT 'ml'");
      }
      if (cols && !cols.find(c => c.name === 'source_shopee_item_id')) {
        db.run("ALTER TABLE ad_models ADD COLUMN source_shopee_item_id TEXT");
      }
    });

    db.run(`CREATE TABLE IF NOT EXISTS package_presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      width_cm REAL NOT NULL,
      height_cm REAL NOT NULL,
      depth_cm REAL NOT NULL,
      weight_kg REAL NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS ad_model_publications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ad_model_id INTEGER NOT NULL,
      marketplace TEXT NOT NULL,
      account_id INTEGER NOT NULL,
      published_item_id TEXT,
      status TEXT DEFAULT 'pending',
      error_message TEXT,
      published_at DATETIME,
      published_price REAL,
      published_listing_type TEXT,
      FOREIGN KEY (ad_model_id) REFERENCES ad_models(id),
      UNIQUE(ad_model_id, marketplace, account_id)
    )`);

    db.all("PRAGMA table_info(ad_model_publications)", (err, columns) => {
      if (!err && Array.isArray(columns)) {
        if (!columns.some(c => c.name === 'published_price')) {
          db.run('ALTER TABLE ad_model_publications ADD COLUMN published_price REAL');
        }
        if (!columns.some(c => c.name === 'published_listing_type')) {
          db.run('ALTER TABLE ad_model_publications ADD COLUMN published_listing_type TEXT');
        }
      }
    });

    // Lista plana de todos os SKUs que cada modelo representa (modelo simples + variações).
    // Permite queries como "quais modelos usam o SKU X" e "um SKU pode aparecer em N modelos".
    db.run(`CREATE TABLE IF NOT EXISTS ad_model_skus (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ad_model_id INTEGER NOT NULL,
      inventory_id INTEGER,
      sku TEXT,
      role TEXT NOT NULL DEFAULT 'main',
      variation_key TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (ad_model_id) REFERENCES ad_models(id) ON DELETE CASCADE
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_ad_model_skus_model ON ad_model_skus(ad_model_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_ad_model_skus_sku ON ad_model_skus(sku)');
    db.run('CREATE INDEX IF NOT EXISTS idx_ad_model_skus_inventory ON ad_model_skus(inventory_id)');

    // Rastreio granular dos itens criados em cada publicação — cobre o caso User Products ML
    // onde uma publicação gera múltiplos itens (um por variação).
    db.run(`CREATE TABLE IF NOT EXISTS ad_model_publication_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      publication_id INTEGER NOT NULL,
      published_item_id TEXT,
      external_sku TEXT,
      variation_key TEXT,
      permalink TEXT,
      status TEXT DEFAULT 'published',
      error_message TEXT,
      last_sync_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (publication_id) REFERENCES ad_model_publications(id) ON DELETE CASCADE
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_ad_model_pub_items_pub ON ad_model_publication_items(publication_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_ad_model_pub_items_item ON ad_model_publication_items(published_item_id)');

    // Migração idempotente: relaxar UNIQUE(sku) em ad_models. No SQLite não dá para dropar a
    // constraint via ALTER TABLE, então recriamos a tabela preservando os dados. Verificamos
    // pelo sqlite_master.sql para rodar só quando necessário.
    db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='ad_models'", (err, row) => {
      if (err || !row || !row.sql) return;
      const sql = String(row.sql);
      const hasInlineUnique = /\bsku\s+TEXT\s+UNIQUE\b/i.test(sql) || /UNIQUE\s*\(\s*sku\s*\)/i.test(sql);
      if (!hasInlineUnique) return;
      console.log('[migration] ad_models: removendo UNIQUE(sku) para suportar modelos multi-SKU.');
      db.serialize(() => {
        db.run('PRAGMA foreign_keys = OFF');
        db.run('BEGIN TRANSACTION');
        db.run(`CREATE TABLE IF NOT EXISTS ad_models_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          inventory_id INTEGER,
          sku TEXT,
          ean TEXT,
          title TEXT NOT NULL,
          category_id TEXT,
          category_name TEXT,
          price REAL,
          currency_id TEXT DEFAULT 'BRL',
          condition TEXT DEFAULT 'new',
          buying_mode TEXT DEFAULT 'buy_it_now',
          listing_type_id TEXT DEFAULT 'gold_special',
          available_quantity INTEGER DEFAULT 1,
          pictures TEXT,
          attributes TEXT,
          variations TEXT,
          description TEXT,
          shipping TEXT,
          sale_terms TEXT,
          video_id TEXT,
          source_ml_item_id TEXT,
          source_account_id INTEGER,
          package_measures TEXT,
          marketplace_mappings TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        db.run(`INSERT INTO ad_models_new
          (id, inventory_id, sku, ean, title, category_id, category_name, price, currency_id,
           condition, buying_mode, listing_type_id, available_quantity, pictures, attributes,
           variations, description, shipping, sale_terms, video_id, source_ml_item_id,
           source_account_id, package_measures, marketplace_mappings, created_at, updated_at)
          SELECT id, inventory_id, sku, ean, title, category_id, category_name, price, currency_id,
            condition, buying_mode, listing_type_id, available_quantity, pictures, attributes,
            variations, description, shipping, sale_terms, video_id, source_ml_item_id,
            source_account_id, package_measures, marketplace_mappings, created_at, updated_at
          FROM ad_models`);
        db.run('DROP TABLE ad_models');
        db.run('ALTER TABLE ad_models_new RENAME TO ad_models');
        db.run('COMMIT', (cErr) => {
          if (cErr) console.error('[migration] ad_models UNIQUE(sku) relax falhou:', cErr.message);
          else console.log('[migration] ad_models UNIQUE(sku) removido com sucesso.');
        });
        db.run('PRAGMA foreign_keys = ON');
      });
    });

    // Migração one-shot: consolidar ml_item_templates → ad_models. Copia templates que ainda
    // não estão em ad_models (match por source_ml_item_id). Idempotente; pode rodar sempre.
    db.run(`INSERT INTO ad_models (
      inventory_id, sku, ean, title, category_id, category_name, price, currency_id,
      condition, buying_mode, listing_type_id, available_quantity, pictures, attributes,
      variations, description, shipping, sale_terms, video_id, source_ml_item_id,
      source_account_id, created_at, updated_at
    )
    SELECT
      NULL, NULL, NULL, t.title, t.category_id, NULL, t.price, COALESCE(t.currency_id, 'BRL'),
      COALESCE(t.condition, 'new'), COALESCE(t.buying_mode, 'buy_it_now'),
      COALESCE(t.listing_type_id, 'gold_special'), COALESCE(t.available_quantity, 1),
      t.pictures, t.attributes, t.variations, t.description, t.shipping, t.sale_terms,
      t.video_id, t.source_ml_item_id, t.source_account_id, t.created_at, t.updated_at
    FROM ml_item_templates t
    WHERE t.source_ml_item_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM ad_models m WHERE m.source_ml_item_id = t.source_ml_item_id
      )`, function(err) {
      if (err) {
        // ml_item_templates pode não existir em instalações novas — silenciar "no such table".
        if (!/no such table/i.test(err.message)) {
          console.error('[migration] ml_item_templates → ad_models:', err.message);
        }
      } else if (this && this.changes) {
        console.log(`[migration] ${this.changes} template(s) legados migrados para ad_models.`);
      }
    });

    // Backfill de ad_model_skus a partir dos dados atuais em ad_models. Idempotente: só insere
    // linhas que ainda não existem (comparando ad_model_id + sku + role + variation_key).
    db.all('SELECT id, inventory_id, sku, variations FROM ad_models', (err, rows) => {
      if (err || !Array.isArray(rows)) return;
      for (const m of rows) {
        const stmts = [];
        if (m.sku) {
          stmts.push({ sku: String(m.sku).trim(), role: 'main', variation_key: null, inventory_id: m.inventory_id || null });
        }
        let vars = [];
        try { vars = JSON.parse(m.variations || '[]'); } catch {}
        if (Array.isArray(vars)) {
          for (const v of vars) {
            const vSku = v?.seller_custom_field || null;
            if (!vSku) continue;
            let varKey = null;
            if (Array.isArray(v.attribute_combinations)) {
              varKey = v.attribute_combinations.map((c) => `${c.id || ''}:${c.value_name || c.value_id || ''}`).join('|');
            }
            stmts.push({ sku: String(vSku).trim(), role: 'variation', variation_key: varKey, inventory_id: null });
          }
        }
        for (const s of stmts) {
          db.run(
            `INSERT INTO ad_model_skus (ad_model_id, inventory_id, sku, role, variation_key)
             SELECT ?, ?, ?, ?, ?
             WHERE NOT EXISTS (
               SELECT 1 FROM ad_model_skus
               WHERE ad_model_id = ? AND COALESCE(sku,'') = COALESCE(?, '')
                 AND role = ? AND COALESCE(variation_key,'') = COALESCE(?, '')
             )`,
            [m.id, s.inventory_id, s.sku, s.role, s.variation_key, m.id, s.sku, s.role, s.variation_key]
          );
        }
      }
    });

    db.run(`CREATE TABLE IF NOT EXISTS shopee_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      partner_id TEXT,
      partner_key TEXT,
      shop_id TEXT,
      redirect_uri TEXT,
      tax_pct REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.all("PRAGMA table_info(shopee_accounts)", (err, cols) => {
      if (err || !Array.isArray(cols)) return;
      if (!cols.some(c => c.name === 'tax_pct')) {
        db.run("ALTER TABLE shopee_accounts ADD COLUMN tax_pct REAL", () => {});
      }
    });

    db.run(`CREATE TABLE IF NOT EXISTS shopee_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shopee_item_id TEXT NOT NULL,
      shopee_account_id INTEGER NOT NULL,
      title TEXT,
      sku TEXT,
      price REAL,
      original_price REAL,
      permalink TEXT,
      status TEXT,
      shopee_stock INTEGER DEFAULT 0,
      thumbnail TEXT,
      has_model INTEGER DEFAULT 0,
      last_synced_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(shopee_item_id, shopee_account_id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS shopee_stock_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inventory_id INTEGER NOT NULL,
      shopee_account_id INTEGER NOT NULL,
      shopee_item_id TEXT NOT NULL,
      use_real_stock INTEGER DEFAULT 0,
      fictitious_min INTEGER DEFAULT 450,
      fictitious_max INTEGER DEFAULT 499,
      fictitious_value INTEGER,
      enabled INTEGER DEFAULT 1,
      last_pushed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (inventory_id) REFERENCES inventory(id),
      UNIQUE(inventory_id, shopee_item_id)
    )`);

    // Modelos (variações) Shopee — espelha o conceito de ml_item_variations.
    // Um shopee_item com has_model = 1 tem 1..N modelos, cada um com seu próprio
    // SKU, preço, estoque e imagem. Ver Shopee API: product/get_model_list.
    db.run(`CREATE TABLE IF NOT EXISTS shopee_item_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shopee_item_id TEXT NOT NULL,
      shopee_account_id INTEGER NOT NULL,
      model_id TEXT NOT NULL,
      model_sku TEXT,
      tier_index TEXT,
      name TEXT,
      price REAL,
      stock INTEGER DEFAULT 0,
      thumbnail TEXT,
      status TEXT,
      last_synced_at DATETIME,
      UNIQUE(shopee_item_id, shopee_account_id, model_id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS shopee_variation_stock_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inventory_id INTEGER NOT NULL,
      shopee_account_id INTEGER NOT NULL,
      shopee_item_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      use_real_stock INTEGER DEFAULT 0,
      fictitious_min INTEGER DEFAULT 450,
      fictitious_max INTEGER DEFAULT 499,
      fictitious_value INTEGER,
      enabled INTEGER DEFAULT 1,
      last_pushed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (inventory_id) REFERENCES inventory(id),
      UNIQUE(inventory_id, shopee_item_id, model_id)
    )`);

    // A7 — telemetria de erro por config de estoque (Shopee).
    // Importante: aqui as tabelas já existem (criadas logo acima), então
    // as ALTER TABLE são seguras em primeira execução.
    addColumnSafe('ALTER TABLE shopee_stock_config ADD COLUMN last_error_message TEXT');
    addColumnSafe('ALTER TABLE shopee_stock_config ADD COLUMN last_error_at DATETIME');
    addColumnSafe('ALTER TABLE shopee_variation_stock_config ADD COLUMN last_error_message TEXT');
    addColumnSafe('ALTER TABLE shopee_variation_stock_config ADD COLUMN last_error_at DATETIME');

    // Tabelas de pedidos dos marketplaces
    db.run(`CREATE TABLE IF NOT EXISTS marketplace_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      marketplace TEXT NOT NULL,
      marketplace_order_id TEXT NOT NULL,
      account_id INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      buyer_name TEXT,
      buyer_doc TEXT,
      buyer_phone TEXT,
      buyer_email TEXT,
      buyer_nickname TEXT,
      shipping_address_json TEXT,
      total_amount REAL,
      shipping_cost REAL DEFAULT 0,
      order_date DATETIME,
      payment_method TEXT,
      payment_status TEXT,
      bling_pedido_id TEXT,
      bling_nfe_id TEXT,
      bling_nfe_status TEXT,
      bling_account_id INTEGER,
      synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(marketplace, marketplace_order_id, account_id)
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_mkt_orders_marketplace ON marketplace_orders(marketplace)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_mkt_orders_account ON marketplace_orders(account_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_mkt_orders_date ON marketplace_orders(order_date)`);
    db.all('PRAGMA table_info(marketplace_orders)', (err, cols) => {
      if (err || !Array.isArray(cols)) return;
      const names = cols.map(c => c.name);
      if (!names.includes('payment_id')) db.run("ALTER TABLE marketplace_orders ADD COLUMN payment_id TEXT");
      if (!names.includes('pack_id')) db.run("ALTER TABLE marketplace_orders ADD COLUMN pack_id TEXT");
      if (!names.includes('shipping_id')) db.run("ALTER TABLE marketplace_orders ADD COLUMN shipping_id TEXT");
      if (!names.includes('shipping_tracking')) db.run("ALTER TABLE marketplace_orders ADD COLUMN shipping_tracking TEXT");
      if (!names.includes('shipping_status')) db.run("ALTER TABLE marketplace_orders ADD COLUMN shipping_status TEXT");
      if (!names.includes('shipping_method')) db.run("ALTER TABLE marketplace_orders ADD COLUMN shipping_method TEXT");
      if (!names.includes('shipping_type')) db.run("ALTER TABLE marketplace_orders ADD COLUMN shipping_type TEXT");
      if (!names.includes('nf_manual_number')) db.run("ALTER TABLE marketplace_orders ADD COLUMN nf_manual_number TEXT");
      if (!names.includes('nf_manual_key')) db.run("ALTER TABLE marketplace_orders ADD COLUMN nf_manual_key TEXT");
      if (!names.includes('nf_manual_serie')) db.run("ALTER TABLE marketplace_orders ADD COLUMN nf_manual_serie TEXT");
      if (!names.includes('nf_manual_date')) db.run("ALTER TABLE marketplace_orders ADD COLUMN nf_manual_date TEXT");
      if (!names.includes('payment_installments')) db.run("ALTER TABLE marketplace_orders ADD COLUMN payment_installments INTEGER");
      if (!names.includes('payment_date')) db.run("ALTER TABLE marketplace_orders ADD COLUMN payment_date TEXT");
      if (!names.includes('payment_total')) db.run("ALTER TABLE marketplace_orders ADD COLUMN payment_total REAL");
      if (!names.includes('ml_pack_order_number')) db.run("ALTER TABLE marketplace_orders ADD COLUMN ml_pack_order_number TEXT");
      if (!names.includes('bling_nfe_numero')) db.run("ALTER TABLE marketplace_orders ADD COLUMN bling_nfe_numero TEXT");
      if (!names.includes('bling_nfe_chave')) db.run("ALTER TABLE marketplace_orders ADD COLUMN bling_nfe_chave TEXT");
      // Integrador (M3): pipeline unificado e telemetria de erro.
      if (!names.includes('pipeline_stage')) db.run("ALTER TABLE marketplace_orders ADD COLUMN pipeline_stage TEXT DEFAULT 'pending'");
      if (!names.includes('pipeline_last_error')) db.run("ALTER TABLE marketplace_orders ADD COLUMN pipeline_last_error TEXT");
      if (!names.includes('pipeline_last_error_at')) db.run("ALTER TABLE marketplace_orders ADD COLUMN pipeline_last_error_at DATETIME");
      // Integrador (M4) — NFe emitida dentro do próprio Mercado Livre.
      if (!names.includes('ml_invoice_number')) db.run("ALTER TABLE marketplace_orders ADD COLUMN ml_invoice_number TEXT");
      if (!names.includes('ml_invoice_key')) db.run("ALTER TABLE marketplace_orders ADD COLUMN ml_invoice_key TEXT");
      if (!names.includes('ml_invoice_serie')) db.run("ALTER TABLE marketplace_orders ADD COLUMN ml_invoice_serie TEXT");
      if (!names.includes('ml_invoice_xml_url')) db.run("ALTER TABLE marketplace_orders ADD COLUMN ml_invoice_xml_url TEXT");
      if (!names.includes('ml_invoice_pdf_url')) db.run("ALTER TABLE marketplace_orders ADD COLUMN ml_invoice_pdf_url TEXT");
      if (!names.includes('ml_invoice_status')) db.run("ALTER TABLE marketplace_orders ADD COLUMN ml_invoice_status TEXT");
      if (!names.includes('ml_invoice_issued_at')) db.run("ALTER TABLE marketplace_orders ADD COLUMN ml_invoice_issued_at DATETIME");
      if (!names.includes('ml_invoice_fetched_at')) db.run("ALTER TABLE marketplace_orders ADD COLUMN ml_invoice_fetched_at DATETIME");
      // Integrador (M5) — NFe Bling materializada + upload na Shopee.
      if (!names.includes('bling_nfe_serie')) db.run("ALTER TABLE marketplace_orders ADD COLUMN bling_nfe_serie TEXT");
      if (!names.includes('bling_nfe_xml')) db.run("ALTER TABLE marketplace_orders ADD COLUMN bling_nfe_xml TEXT");
      if (!names.includes('bling_nfe_pdf_url')) db.run("ALTER TABLE marketplace_orders ADD COLUMN bling_nfe_pdf_url TEXT");
      if (!names.includes('nf_uploaded_at')) db.run("ALTER TABLE marketplace_orders ADD COLUMN nf_uploaded_at DATETIME");
      if (!names.includes('nf_uploaded_response')) db.run("ALTER TABLE marketplace_orders ADD COLUMN nf_uploaded_response TEXT");
      if (!names.includes('invoice_public_token')) db.run("ALTER TABLE marketplace_orders ADD COLUMN invoice_public_token TEXT");
      // Cache negativo para evitar reconsultar Bling a cada F5
      if (!names.includes('bling_nfe_checked_at')) db.run("ALTER TABLE marketplace_orders ADD COLUMN bling_nfe_checked_at DATETIME");
      if (!names.includes('last_updated_at')) db.run("ALTER TABLE marketplace_orders ADD COLUMN last_updated_at DATETIME");
      // Nightly backup / histórico de versões — re-hidratação noturna que
      // captura a última versão antes do marketplace apagar os dados.
      if (!names.includes('last_hydrated_at')) db.run("ALTER TABLE marketplace_orders ADD COLUMN last_hydrated_at DATETIME");
      if (!names.includes('hydrate_source')) db.run("ALTER TABLE marketplace_orders ADD COLUMN hydrate_source TEXT");
      if (!names.includes('hydrate_attempts')) db.run("ALTER TABLE marketplace_orders ADD COLUMN hydrate_attempts INTEGER DEFAULT 0");
      if (!names.includes('hydrate_last_error')) db.run("ALTER TABLE marketplace_orders ADD COLUMN hydrate_last_error TEXT");
      if (!names.includes('marketplace_deleted_at')) db.run("ALTER TABLE marketplace_orders ADD COLUMN marketplace_deleted_at DATETIME");
      if (!names.includes('frozen')) db.run("ALTER TABLE marketplace_orders ADD COLUMN frozen INTEGER DEFAULT 0");
      if (!names.includes('snapshot_hash')) db.run("ALTER TABLE marketplace_orders ADD COLUMN snapshot_hash TEXT");
      // Status de impressão da etiqueta de envio — permite separar pedidos
      // pendentes de impressão dos já impressos (por ML, Shopee ou Miti).
      if (!names.includes('shipping_substatus')) db.run("ALTER TABLE marketplace_orders ADD COLUMN shipping_substatus TEXT");
      if (!names.includes('label_printed_at')) db.run("ALTER TABLE marketplace_orders ADD COLUMN label_printed_at DATETIME");
      if (!names.includes('label_printed_by')) db.run("ALTER TABLE marketplace_orders ADD COLUMN label_printed_by TEXT");
      // Backfill: pedidos já em trânsito/entregues entram com a etiqueta
      // marcada como impressa (evita lista cheia de "pendente" antigos).
      // Usa synced_at como timestamp de fallback (coluna existente no schema).
      db.run(`UPDATE marketplace_orders
              SET label_printed_at = COALESCE(label_printed_at, synced_at, CURRENT_TIMESTAMP),
                  label_printed_by = COALESCE(label_printed_by, 'backfill')
              WHERE label_printed_at IS NULL
                AND shipping_status IN ('shipped','delivered','in_transit','not_delivered')`,
        (bfErr) => {
          if (bfErr) console.warn('[Backup] backfill label_printed_at:', bfErr.message);
        });
      // O índice depende de colunas recém-adicionadas acima. Precisa ficar
      // DENTRO deste callback para que o sqlite3 driver o enfileire depois
      // dos ALTER TABLE — caso contrário é enfileirado antes do PRAGMA
      // retornar e falha com "no such column: frozen".
      db.run(`CREATE INDEX IF NOT EXISTS idx_mkt_orders_hydrated ON marketplace_orders(frozen, last_hydrated_at)`, (idxErr) => {
        if (idxErr) console.warn('[Backup] idx_mkt_orders_hydrated:', idxErr.message);
      });
      db.run(`CREATE INDEX IF NOT EXISTS idx_mkt_orders_label_printed ON marketplace_orders(label_printed_at)`, (idxErr) => {
        if (idxErr) console.warn('[Backup] idx_mkt_orders_label_printed:', idxErr.message);
      });
    });
    // Histórico versionado: uma linha por snapshot sempre que algo mudar.
    db.run(`CREATE TABLE IF NOT EXISTS marketplace_orders_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      marketplace TEXT NOT NULL,
      marketplace_order_id TEXT NOT NULL,
      account_id INTEGER NOT NULL,
      snapshot_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      source TEXT,
      changed_fields_json TEXT,
      snapshot_json TEXT NOT NULL,
      snapshot_hash TEXT,
      FOREIGN KEY (order_id) REFERENCES marketplace_orders(id)
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_mkt_history_order ON marketplace_orders_history(order_id, snapshot_at DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_mkt_history_hash ON marketplace_orders_history(snapshot_hash)`);
    // Marker de sync incremental por conta do marketplace
    addColumnSafe('ALTER TABLE ml_accounts ADD COLUMN last_orders_sync_at DATETIME');
    addColumnSafe('ALTER TABLE shopee_accounts ADD COLUMN last_orders_sync_at DATETIME');

    db.run(`CREATE TABLE IF NOT EXISTS marketplace_order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      marketplace_item_id TEXT,
      variation_id TEXT,
      sku TEXT,
      title TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_price REAL,
      thumbnail TEXT,
      variation_attributes_json TEXT,
      FOREIGN KEY (order_id) REFERENCES marketplace_orders(id)
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_mkt_order_items_order ON marketplace_order_items(order_id)`);

    // D4 — Auditoria de estoque: toggles, alterações de faixa, pushes (manual,
    // automático e em massa) e edições de inventário. Essencial para suporte
    // investigar "por que o canal ficou com valor X".
    db.run(`CREATE TABLE IF NOT EXISTS stock_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      user_id INTEGER,
      inventory_id INTEGER,
      target_marketplace TEXT,
      target_account INTEGER,
      before_value TEXT,
      after_value TEXT,
      meta TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_stock_audit_inventory ON stock_audit_log(inventory_id, created_at DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_stock_audit_action_created ON stock_audit_log(action, created_at DESC)`);

    // Decomposição de custos por pedido de marketplace. Uma linha por
    // (order_id, source), permitindo guardar em paralelo a versão reconstruída
    // (a partir de /orders + /shipments/costs + escrow) e a versão oficial
    // vinda do Billing Reports do ML (quando o endpoint voltar ao ar). Isso
    // alimenta o relatório "Análise de Custos de Pedido" sem poluir
    // marketplace_orders com dezenas de colunas financeiras.
    db.run(`CREATE TABLE IF NOT EXISTS marketplace_order_costs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      source TEXT NOT NULL,
      gross_revenue REAL,
      discounts_seller REAL,
      discounts_marketplace REAL,
      marketplace_commission REAL,
      marketplace_service_fee REAL,
      payment_fee REAL,
      shipping_paid_by_buyer REAL,
      shipping_cost_seller REAL,
      shipping_subsidy REAL,
      reverse_shipping_fee REAL,
      taxes_withheld REAL,
      taxes_seller REAL,
      other_adjustments REAL,
      net_received REAL,
      cogs_estimated REAL,
      gross_margin REAL,
      currency TEXT DEFAULT 'BRL',
      escrow_status TEXT,
      cogs_status TEXT,
      warnings TEXT,
      raw_json TEXT,
      computed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(order_id, source),
      FOREIGN KEY (order_id) REFERENCES marketplace_orders(id)
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_moc_order_source ON marketplace_order_costs(order_id, source)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_moc_computed_at ON marketplace_order_costs(computed_at DESC)`);
    // Migração idempotente: taxes_seller (imposto estimado do vendedor com
    // base em ml_accounts.tax_pct / shopee_accounts.tax_pct). Diferente de
    // taxes_withheld (retido pelo marketplace).
    db.all("PRAGMA table_info(marketplace_order_costs)", (err, cols) => {
      if (!err && Array.isArray(cols) && !cols.some(c => c.name === 'taxes_seller')) {
        db.run("ALTER TABLE marketplace_order_costs ADD COLUMN taxes_seller REAL", () => {});
      }
    });

    db.run(`CREATE TABLE IF NOT EXISTS password_reset_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      user_email TEXT NOT NULL,
      user_name TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      resolved_by INTEGER,
      resolved_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS marketplace_connection_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      provider TEXT NOT NULL,
      account_id INTEGER,
      event TEXT NOT NULL,
      level TEXT NOT NULL,
      detail TEXT
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_mkt_conn_log_created ON marketplace_connection_log(created_at DESC)`);

    // CORREÇÃO AUTOMÁTICA: Corrigir settings corrompidos
    console.log('🔧 Verificando e corrigindo settings corrompidos...');
    
    // Corrigir settings que contêm HTML
    db.run("UPDATE users SET settings = '{\"pinnedSkus\":[]}' WHERE settings LIKE '%<!doctype html>%'", function(err) {
      if (err) {
        console.error('❌ Erro ao corrigir settings com HTML:', err.message);
      } else {
        console.log('✅ Corrigidos', this.changes, 'usuários com settings HTML');
      }
    });
    
    // Corrigir settings NULL
    db.run("UPDATE users SET settings = '{\"pinnedSkus\":[]}' WHERE settings IS NULL", function(err) {
      if (err) {
        console.error('❌ Erro ao corrigir settings NULL:', err.message);
      } else {
        console.log('✅ Corrigidos', this.changes, 'usuários com settings NULL');
      }
    });
    
    // Corrigir settings JSON inválidos
    db.run("UPDATE users SET settings = '{\"pinnedSkus\":[]}' WHERE settings NOT LIKE '%pinnedSkus%'", function(err) {
      if (err) {
        console.error('❌ Erro ao corrigir settings inválidos:', err.message);
      } else {
        console.log('✅ Corrigidos', this.changes, 'usuários com settings inválidos');
      }
    });
  });
}

// Middleware para autenticação
function authenticateToken(req, res, next) {
  if (req.user) return next();
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token não fornecido' });
  if (revokedTokens.has(token)) return res.status(401).json({ error: 'Sessão encerrada pelo administrador' });
  jwt.verify(token, SECRET, (err, user) => {
    if (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Token expirado', code: 'TOKEN_EXPIRED' });
      }
      return res.status(403).json({ error: 'Token inválido' });
    }
    req.user = user;
    next();
  });
}

const PUBLIC_ROUTES = [
  '/api/login',
  '/api/auth/refresh',
  '/api/logout',
  '/api/status',
  '/api/bling/callback',
  '/api/ml/callback',
  '/api/shopee/callback',
  '/api/shopee/test-sign',
  '/api/shopee/live-test',
  '/api/password-reset-request',
  '/health'
];

// Alguns endpoints precisam de URL pública (ex.: XML da NFe consumido pelo
// Shopee em upload_invoice_doc). Esses usam token de uso único em query.
const PUBLIC_ROUTE_PATTERNS = [
  /^\/api\/marketplace-orders\/\d+\/invoice\.xml$/,
];

app.use('/api', (req, res, next) => {
  const fullPath = '/api' + req.path;
  // Chamada interna (servidor → servidor via loopback com token de boot).
  // Verificamos também o IP de origem para evitar que um proxy mal configurado
  // repasse o header de fora. Aceita IPv4 e IPv6 de loopback.
  const internalHeader = req.headers['x-internal-service'];
  if (internalHeader && internalHeader === INTERNAL_SERVICE_TOKEN) {
    const ip = req.ip || req.connection?.remoteAddress || '';
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
      return next();
    }
  }
  if (PUBLIC_ROUTES.some(r => fullPath === r || fullPath.startsWith(r + '/'))) {
    return next();
  }
  if (PUBLIC_ROUTE_PATTERNS.some(re => re.test(fullPath))) {
    return next();
  }
  // EventSource não envia Authorization header; aceitar token na query para GET em notas-expedidas
  if (req.method === 'GET' && fullPath.startsWith('/api/notas-expedidas')) {
    const token = (req.query.token || '').trim() || (req.headers['authorization'] || '').split(' ')[1];
    if (token) {
      return jwt.verify(token, SECRET, (err, user) => {
        if (!err && user) { req.user = user; return next(); }
        authenticateToken(req, res, next);
      });
    }
  }
  authenticateToken(req, res, next);
});

app.use('/api', (req, res, next) => {
  if (req.user && req.method !== 'OPTIONS') {
    const token = (req.headers['authorization'] || '').split(' ')[1];
    if (token) {
      if (activeSessions.has(token)) {
        activeSessions.get(token).lastActivity = new Date().toISOString();
      } else {
        activeSessions.set(token, {
          userId: req.user.id, userName: req.user.name, userEmail: req.user.email, role: req.user.role,
          loginTime: new Date().toISOString(), lastActivity: new Date().toISOString(),
          ip: req.ip || req.connection?.remoteAddress || 'unknown'
        });
      }
    }
    const actionMap = { GET: 'Consultou', POST: 'Criou/Executou', PUT: 'Atualizou', DELETE: 'Removeu' };
    const action = actionMap[req.method] || req.method;
    const path = '/api' + req.path;
    if (!path.includes('/admin/') && !path.includes('/logs')) {
      addUserAction(req.user.id, req.user.name, action, path);
    }
  }
  next();
});

// Rotas da API
// Reiniciar servidor (somente admin)
app.post('/api/admin/restart', authenticateToken, requireAdmin, async (req, res) => {
  try {
    res.json({ message: 'Reiniciando servidor...' });
    // Aguardar resposta sair antes de encerrar
    setTimeout(() => {
      try {
        logBling('Reinício solicitado via API');
      } finally {
        process.exit(0); // No Fly.io, o processo será reiniciado pelo supervisor
      }
    }, 250);
  } catch (e) {
    res.status(500).json({ error: 'Falha ao reiniciar servidor' });
  }
});

// Rota para verificar status do servidor
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    database: 'connected',
    uptime: Math.floor(process.uptime())
  });
});

// Rota para informações do sistema
app.get('/api/system-info', (req, res) => {
  try {
    const platform = os.platform();
    const nodeVersion = process.version;
    const totalMem = (os.totalmem() / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    const freeMem = (os.freemem() / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    const cpus = os.cpus();
    const cpu = cpus && cpus.length > 0 ? cpus[0].model : 'Desconhecido';
    res.json({
      platform,
      nodeVersion,
      totalMem,
      freeMem,
      cpu
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao obter informações do sistema' });
  }
});

// Rota para logs do sistema (logs reais em memória)
app.get('/api/logs', (req, res) => {
  const { limit, level, category } = req.query;
  let filtered = [...logBuffer];
  if (level) {
    const levels = level.toUpperCase().split(',');
    filtered = filtered.filter(l => levels.includes(l.level));
  }
  if (category) {
    const cats = category.toUpperCase().split(',');
    filtered = filtered.filter(l => cats.includes(l.category));
  }
  const count = parseInt(limit) || 150;
  const recent = filtered.slice(-count);
  res.json({
    logs: recent,
    total: logBuffer.length,
    serverUptime: Math.floor((Date.now() - serverStartTime.getTime()) / 1000),
    serverStartedAt: serverStartTime.toISOString()
  });
});

// Rotas de usuários
app.get('/api/users', (req, res) => {
  const { limit, offset } = req.query;
  let query = 'SELECT id, name, email, role, created_at FROM users ORDER BY created_at DESC';
  const params = [];
  if (limit) {
    query += ' LIMIT ? OFFSET ?';
    params.push(parseInt(limit) || 50, parseInt(offset) || 0);
  }
  db.all(query, params, (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

app.post('/api/users', (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password) {
    res.status(400).json({ error: 'Nome, email e senha são obrigatórios' });
    return;
  }
  const userRole = Number(role || 1);
  if (![1, 2, 3, 4, 5].includes(userRole)) {
    return res.status(400).json({ error: 'Nível de usuário inválido (use 1, 2, 3, 4 ou 5).' });
  }
  const hash = bcrypt.hashSync(password, 10);
  db.run('INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)', [name, email, hash, userRole], function(err) {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json({ id: this.lastID, name, email, role: userRole });
  });
});

// NOVA ROTA: Editar usuário
app.put('/api/users/:id', (req, res) => {
  const { id } = req.params;
  const { name, email, password, role } = req.body;
  if (!name || !email || !role) {
    return res.status(400).json({ error: 'Nome, email e nível são obrigatórios' });
  }
  const roleNum = Number(role);
  if (![1, 2, 3, 4, 5].includes(roleNum)) {
    return res.status(400).json({ error: 'Nível de usuário inválido (use 1, 2, 3, 4 ou 5).' });
  }
  // Buscar usuário atual para manter senha se não for enviada
  db.get('SELECT * FROM users WHERE id = ?', [id], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'Usuário não encontrado' });
    let newPassword = user.password;
    if (password && password.length > 0) {
      newPassword = bcrypt.hashSync(password, 10);
    }
    db.run('UPDATE users SET name = ?, email = ?, password = ?, role = ? WHERE id = ?',
      [name, email, newPassword, roleNum, id],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
      }
    );
  });
});

// Rota para excluir usuário
app.delete('/api/users/:id', (req, res) => {
  const { id } = req.params;
  // Não permitir excluir o admin padrão
  db.get('SELECT * FROM users WHERE id = ?', [id], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'Usuário não encontrado' });
    if (user.email === 'admin@apoli.com') {
      return res.status(403).json({ error: 'Não é permitido excluir o usuário admin padrão.' });
    }
    db.run('DELETE FROM users WHERE id = ?', [id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
  });
});

// Rotas de produtos
app.get('/api/products', (req, res) => {
  const { limit, offset } = req.query;
  let query = 'SELECT * FROM products ORDER BY created_at DESC';
  const params = [];
  if (limit) {
    query += ' LIMIT ? OFFSET ?';
    params.push(parseInt(limit) || 50, parseInt(offset) || 0);
  }
  db.all(query, params, (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

app.post('/api/products', (req, res) => {
  const { name, description, price, quantity } = req.body;
  if (!name || !price) {
    res.status(400).json({ error: 'Nome e preço são obrigatórios' });
    return;
  }

  db.run(
    'INSERT INTO products (name, description, price, quantity) VALUES (?, ?, ?, ?)',
    [name, description, price, quantity || 0],
    function(err) {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }
      res.json({ id: this.lastID, name, description, price, quantity });
    }
  );
});

// Rotas de configuração da API externa
app.get('/api/external-apis', (req, res) => {
  const { limit, offset } = req.query;
  let query = 'SELECT * FROM api_config ORDER BY created_at DESC';
  const params = [];
  if (limit) {
    query += ' LIMIT ? OFFSET ?';
    params.push(parseInt(limit) || 50, parseInt(offset) || 0);
  }
  db.all(query, params, (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

app.post('/api/external-apis', (req, res) => {
  const { name, url, api_key } = req.body;
  if (!name || !url) {
    res.status(400).json({ error: 'Nome e URL são obrigatórios' });
    return;
  }

  db.run(
    'INSERT INTO api_config (name, url, api_key) VALUES (?, ?, ?)',
    [name, url, api_key || null],
    function(err) {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }
      res.json({ id: this.lastID, name, url, api_key });
    }
  );
});

// Rota para testar conexão com API externa
app.post('/api/test-external-api', async (req, res) => {
  const { url, api_key } = req.body;
  
  try {
    const config = {
      headers: api_key ? { 'Authorization': `Bearer ${api_key}` } : {}
    };
    
    const response = await axios.get(url, config);
    res.json({
      success: true,
      status: response.status,
      data: response.data
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      status: error.response?.status
    });
  }
});

// NOVAS ROTAS: Vendas (exemplo de atualização)
app.get('/api/sales', (req, res) => {
  const { limit, offset } = req.query;
  let query = `
    SELECT s.*, u.name as user_name, p.name as product_name 
    FROM sales s 
    LEFT JOIN users u ON s.user_id = u.id 
    LEFT JOIN products p ON s.product_id = p.id 
    ORDER BY s.sale_date DESC
  `;
  const params = [];
  if (limit) {
    query += ' LIMIT ? OFFSET ?';
    params.push(parseInt(limit) || 50, parseInt(offset) || 0);
  }
  db.all(query, params, (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

app.post('/api/sales', (req, res) => {
  const { user_id, product_id, quantity, total_price } = req.body;
  if (!product_id || !quantity || !total_price) {
    res.status(400).json({ error: 'Dados obrigatórios: product_id, quantity, total_price' });
    return;
  }

  db.run(
    'INSERT INTO sales (user_id, product_id, quantity, total_price) VALUES (?, ?, ?, ?)',
    [user_id || null, product_id, quantity, total_price],
    function(err) {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }
      res.json({ id: this.lastID, user_id, product_id, quantity, total_price });
    }
  );
});

// ROTAS DO ESTOQUE
app.get('/api/inventory', (req, res) => {
  const { search, category, low_stock, noStock, withStock, limit, offset } = req.query;
  let query = 'SELECT * FROM inventory WHERE 1=1';
  let params = [];

  if (search) {
    query += ' AND (sku LIKE ? OR title LIKE ? OR ean LIKE ?)';
    const searchTerm = `%${search}%`;
    params.push(searchTerm, searchTerm, searchTerm);
  }

  if (category) {
    query += ' AND category = ?';
    params.push(category);
  }

  if (low_stock === 'true') {
    query += ' AND quantity <= min_quantity';
  }
  if (noStock === 'true') {
    query += ' AND quantity = 0';
  }
  if (withStock === 'true') {
    query += ' AND quantity > 0';
  }

  // Ordenação: quando houver busca, priorizar correspondência exata de SKU para evitar
  // que o item exato fique fora do LIMIT padrão (ex.: muitos resultados parciais).
  if (search) {
    query += ' ORDER BY (CASE WHEN sku = ? THEN 0 ELSE 1 END), title ASC';
    params.push(search);
  } else {
    query += ' ORDER BY title ASC';
  }

  // Paginação
  let limitNum = parseInt(limit) || 20;
  let offsetNum = parseInt(offset) || 0;
  query += ' LIMIT ? OFFSET ?';
  params.push(limitNum, offsetNum);

  // Buscar total de itens (sem filtro)
  db.get('SELECT COUNT(*) as total FROM inventory', (err, totalRow) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    // Buscar total filtrado
    let countQuery = 'SELECT COUNT(*) as totalFiltrado FROM inventory WHERE 1=1';
    let countParams = [];
    if (search) {
      countQuery += ' AND (sku LIKE ? OR title LIKE ? OR ean LIKE ?)';
      const searchTerm = `%${search}%`;
      countParams.push(searchTerm, searchTerm, searchTerm);
    }
    if (category) {
      countQuery += ' AND category = ?';
      countParams.push(category);
    }
    if (low_stock === 'true') {
      countQuery += ' AND quantity <= min_quantity';
    }
    if (noStock === 'true') {
      countQuery += ' AND quantity = 0';
    }
    if (withStock === 'true') {
      countQuery += ' AND quantity > 0';
    }
    db.get(countQuery, countParams, (err, countRow) => {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }
      // Buscar itens paginados
      db.all(query, params, (err, rows) => {
        if (err) {
          res.status(500).json({ error: err.message });
          return;
        }
        // Custo de fabricação: somente role=4 pode ver `cost_price`.
        const isRole4 = Number(req.user?.role) === 4;
        const items = isRole4
          ? rows
          : rows.map(r => { const { cost_price, ...rest } = r; return rest; });
        res.json({
          items,
          total: totalRow.total,
          totalFiltrado: countRow.totalFiltrado
        });
      });
    });
  });
});

app.get('/api/inventory/:id', (req, res) => {
  const { id } = req.params;
  
  db.get('SELECT * FROM inventory WHERE id = ?', [id], (err, row) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    if (!row) {
      res.status(404).json({ error: 'Item não encontrado' });
      return;
    }
    // Custo de fabricação: somente role=4 pode ver `cost_price`.
    const isRole4 = Number(req.user?.role) === 4;
    if (!isRole4) { const { cost_price, ...rest } = row; return res.json(rest); }
    res.json(row);
  });
});

app.post('/api/inventory', (req, res) => {
  const {
    sku, ean, title, quantity, location, min_quantity, max_quantity,
    category, supplier, selling_price, cubic_weight, notes
  } = req.body;
  // Custo de fabricação: somente role=4 pode gravar. Usuários sem permissão
  // têm o campo ignorado silenciosamente.
  const isRole4 = Number(req.user?.role) === 4;
  const cost_price = isRole4 ? req.body.cost_price : null;

  if (!sku || !title) {
    res.status(400).json({ error: 'SKU e título são obrigatórios' });
    return;
  }

  db.run(`
    INSERT INTO inventory (
      sku, ean, title, quantity, location, min_quantity, max_quantity,
      category, supplier, cost_price, selling_price, cubic_weight, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [sku, ean, title, quantity || 0, location, min_quantity || 0, max_quantity, 
      category, supplier, cost_price, selling_price, cubic_weight || null, notes], function(err) {
    if (err) {
      console.error('Erro ao inserir no inventário:', err);
      res.status(500).json({ error: err.message });
      return;
    }
    const payload = {
      id: this.lastID,
      sku, ean, title, quantity, location, min_quantity, max_quantity,
      category, supplier, selling_price, cubic_weight, notes,
    };
    if (isRole4) { payload.cost_price = cost_price; }
    res.json(payload);
  });
});

app.put('/api/inventory/:id', (req, res) => {
  const { id } = req.params;
  const {
    sku, ean, title, quantity, location, min_quantity, max_quantity,
    category, supplier, selling_price, cubic_weight, notes, is_composite
  } = req.body;
  const isRole4 = Number(req.user?.role) === 4;
  // A3: capturar quantidade anterior para detectar mudança real e disparar
  // push apenas quando `quantity` mudou (evita push desnecessário em edições
  // que só alteram título/preço/localização). Também preserva cost_price
  // atual quando o usuário não tem permissão (role<4) para editá-lo.
  db.get('SELECT quantity, cost_price FROM inventory WHERE id = ?', [id], (gerr, prev) => {
    const prevQty = prev ? Number(prev.quantity) : null;
    const cost_price = isRole4 ? req.body.cost_price : (prev ? prev.cost_price : null);
    db.run(`
      UPDATE inventory SET 
        sku = ?, ean = ?, title = ?, quantity = ?, location = ?, 
        min_quantity = ?, max_quantity = ?, category = ?, supplier = ?, 
        cost_price = ?, selling_price = ?, cubic_weight = ?, notes = ?, is_composite = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [sku, ean, title, quantity, location, min_quantity, max_quantity, 
        category, supplier, cost_price, selling_price, cubic_weight || null, notes, is_composite, id], function(err) {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }
      if (this.changes === 0) {
        res.status(404).json({ error: 'Item não encontrado' });
        return;
      }
      const newQty = Number(quantity);
      if (Number.isFinite(newQty) && prevQty !== newQty) {
        pushStockForInventoryId(id).catch(() => {});
      }
      res.json({ success: true, changes: this.changes });
    });
  });
});

app.delete('/api/inventory/:id', (req, res) => {
  const { id } = req.params;
  
  db.run('DELETE FROM inventory WHERE id = ?', [id], function(err) {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    if (this.changes === 0) {
      res.status(404).json({ error: 'Item não encontrado' });
      return;
    }
    res.json({ success: true, changes: this.changes });
  });
});

// Função auxiliar para movimentar componentes de um SKU composto
function movimentarComponentesCompostos({ db, mainSkuId, movementType, quantidade, reason, userId, accountId, callback }) {
  db.all(
    'SELECT component_sku_id, quantity FROM composite_skus WHERE main_sku_id = ?',
    [mainSkuId],
    (err, componentes) => {
      if (err) {
        console.error('[movimentarComponentesCompostos] Erro ao buscar componentes:', err);
        if (callback) callback(err);
        return;
      }
      if (!componentes || componentes.length === 0) {
        // Não há componentes, seguir normalmente
        if (callback) callback(null);
        return;
      }
      let completed = 0;
      let errors = [];
      let finalCalled = false;
      componentes.forEach(componente => {
        const quantidadeMovimentar = componente.quantity * quantidade;
        // Buscar se o componente é composto
        db.get('SELECT is_composite, quantity FROM inventory WHERE id = ?', [componente.component_sku_id], (err, row) => {
          if (err || !row) {
            errors.push(`Componente ID ${componente.component_sku_id} não encontrado no estoque. Vínculo órfão em composite_skus. Nenhuma movimentação realizada para este componente.`);
            completed++;
            if (completed === componentes.length && !finalCalled) { finalCalled = true; callback(errors.length ? errors : null); }
            return;
          }
          if (row.is_composite) {
            // Recursivo: movimentar componentes do composto
            movimentarComponentesCompostos({
              db,
              mainSkuId: componente.component_sku_id,
              movementType,
              quantidade: quantidadeMovimentar,
              reason,
              userId,
              accountId,
              callback: (errRec) => {
                if (errRec) errors = errors.concat(errRec);
                completed++;
                if (completed === componentes.length && !finalCalled) { finalCalled = true; callback(errors.length ? errors : null); }
              }
            });
          } else {
            // Componente simples: movimentar normalmente
            let previous_quantity = row.quantity;
            let new_quantity = previous_quantity;
            if (movementType === 'in') {
              new_quantity += quantidadeMovimentar;
            } else if (movementType === 'out') {
              new_quantity -= quantidadeMovimentar;
              if (new_quantity < 0) {
                errors.push(`Estoque insuficiente do componente ID ${componente.component_sku_id}`);
                completed++;
                if (completed === componentes.length && !finalCalled) { finalCalled = true; callback(errors.length ? errors : null); }
                return;
              }
            }
            db.run('UPDATE inventory SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [new_quantity, componente.component_sku_id], function(err) {
              if (err) {
                errors.push(`Erro ao atualizar componente ID ${componente.component_sku_id}`);
              } else {
                // A3: componente teve estoque alterado → atualiza marketplaces
                // que eventualmente vendam o componente direto.
                pushStockForInventoryId(componente.component_sku_id).catch(() => {});
              }
              db.run(`INSERT INTO inventory_movements (inventory_id, movement_type, quantity, previous_quantity, new_quantity, reason, user_id, account_id, movement_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [componente.component_sku_id, movementType, quantidadeMovimentar, previous_quantity, new_quantity, `Movimentação automática por SKU composto: ${reason || ''}`, userId || null, accountId || null, getCurrentDateTimeSP()], function(err) {
                if (err) {
                  errors.push(`Erro ao registrar movimentação do componente ID ${componente.component_sku_id}`);
                }
                completed++;
                if (completed === componentes.length && !finalCalled) { finalCalled = true; callback(errors.length ? errors : null); }
              });
            });
          }
        });
      });
    }
  );
}

// Movimentação de estoque
app.post('/api/inventory/:id/movement', (req, res) => {
  const { id } = req.params;
  const { movement_type, quantity, reason, user_id, accountId } = req.body;
  addLog('INFO', 'ESTOQUE', `Movimentação: tipo=${movement_type} qty=${quantity} item=${id} motivo="${reason || 'N/A'}"`);
  
  if (!movement_type || !quantity) {
    console.error('ERRO DETALHADO: Tipo e quantidade são obrigatórios', { movement_type, quantity });
    res.status(400).json({ error: 'Tipo e quantidade são obrigatórios' });
    return;
  }
  
  // Validar quantidade
  if (quantity <= 0) {
    console.error('ERRO DETALHADO: Quantidade deve ser maior que zero', { quantity });
    res.status(400).json({ error: 'Quantidade deve ser maior que zero' });
    return;
  }

  db.serialize(() => {
    db.get('SELECT quantity, is_composite FROM inventory WHERE id = ?', [id], (err, row) => {
      if (err) {
        console.error('ERRO DETALHADO: Falha ao buscar item no inventário', err);
        res.status(500).json({ error: err.message });
        return;
      }
      if (!row) {
        console.error('ERRO DETALHADO: Item não encontrado no inventário', { id });
        res.status(404).json({ error: 'Item não encontrado' });
        return;
      }
      
      console.log('[MOVIMENTAÇÃO] Item encontrado:', { id, current_quantity: row.quantity, is_composite: row.is_composite });
      
      const previous_quantity = row.quantity;
      let new_quantity = previous_quantity;
      if (row.is_composite) {
        // Para SKUs compostos, não exigir saldo do próprio SKU composto ao dar saída
        if (movement_type === 'in') {
          new_quantity += quantity;
        } else if (movement_type === 'adjustment') {
          new_quantity = quantity;
        }
        movimentarComponentesCompostos({
          db,
          mainSkuId: id,
          movementType: movement_type,
          quantidade: quantity,
          reason,
          userId: user_id,
          accountId,
          callback: (componentError) => {
            if (componentError) {
              console.error('ERRO DETALHADO: Erro ao movimentar componentes do SKU composto', componentError);
              res.status(400).json({ error: 'Erro ao movimentar componentes do SKU composto', details: componentError });
              return;
            }
            // Registrar movimentação do SKU composto para histórico, mas não exigir saldo
            db.run('UPDATE inventory SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [new_quantity, id], function(err) {
              if (err) {
                console.error('ERRO DETALHADO: Falha ao atualizar estoque do SKU composto', err);
                res.status(500).json({ error: err.message });
                return;
              }
              db.run(`INSERT INTO inventory_movements (inventory_id, movement_type, quantity, previous_quantity, new_quantity, reason, user_id, account_id, movement_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, movement_type, quantity, previous_quantity, new_quantity, reason || null, user_id || null, accountId || null, getCurrentDateTimeSP()], function(err) {
                if (err) {
                  console.error('ERRO DETALHADO: Falha ao registrar movimentação do SKU composto', err);
                  res.status(500).json({ error: err.message });
                  return;
                }
                pushStockForInventoryId(id).catch(() => {});
                res.json({ success: true, previous_quantity, new_quantity, movement_id: this.lastID });
              });
            });
          }
        });
      } else {
        // SKU simples: manter lógica atual
        if (movement_type === 'in') {
          new_quantity += quantity;
        } else if (movement_type === 'out') {
          new_quantity -= quantity;
          if (new_quantity < 0) {
            console.error('ERRO DETALHADO: Quantidade insuficiente em estoque', { id, previous_quantity, quantity });
            res.status(400).json({ error: 'Quantidade insuficiente em estoque' });
            return;
          }
        } else if (movement_type === 'adjustment') {
          new_quantity = quantity;
        }
        console.log('[MOVIMENTAÇÃO] Atualizando SKU simples:', { id, previous_quantity, new_quantity, movement_type, quantity });
        
        db.run('UPDATE inventory SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [new_quantity, id], function(err) {
          if (err) {
            console.error('ERRO DETALHADO: Falha ao atualizar estoque do SKU simples', err);
            res.status(500).json({ error: err.message });
            return;
          }
          console.log('[MOVIMENTAÇÃO] Estoque do SKU simples atualizado com sucesso:', { id, new_quantity });
          
          db.run(`INSERT INTO inventory_movements (inventory_id, movement_type, quantity, previous_quantity, new_quantity, reason, user_id, account_id, movement_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, movement_type, quantity, previous_quantity, new_quantity, reason || null, user_id || null, accountId || null, getCurrentDateTimeSP()], function(err) {
            if (err) {
              console.error('ERRO DETALHADO: Falha ao registrar movimentação do SKU simples', err);
              res.status(500).json({ error: err.message });
              return;
            }
            console.log('[MOVIMENTAÇÃO] Movimentação do SKU simples registrada com sucesso:', { id, movement_id: this.lastID });
            pushStockForInventoryId(id).catch(() => {});
            res.json({ success: true, previous_quantity, new_quantity, movement_id: this.lastID });
          });
        });
      }
    });
  });
});

// Histórico de movimentações
app.get('/api/inventory/:id/movements', (req, res) => {
  const { id } = req.params;
  
  db.all(`
    SELECT m.*, u.name as user_name, i.title as item_title
    FROM inventory_movements m
    LEFT JOIN users u ON m.user_id = u.id
    LEFT JOIN inventory i ON m.inventory_id = i.id
    WHERE m.inventory_id = ?
    ORDER BY m.movement_date DESC
  `, [id], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

// D5 — timeline combinando movimentações (inventory_movements) e ações de
// estoque (stock_audit_log: toggles, faixa, pushes). Ordenado por data desc.
// Limit configurável (default 50).
app.get('/api/inventory/:id/stock-history', (req, res) => {
  const { id } = req.params;
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const sql = `
    SELECT 'movement' AS kind, m.id AS id, m.movement_type AS action,
           CAST(m.quantity AS TEXT) AS after_value, CAST(m.previous_quantity AS TEXT) AS before_value,
           m.reason AS meta, m.movement_date AS created_at,
           u.name AS user_name, NULL AS target_marketplace, NULL AS target_account
    FROM inventory_movements m
    LEFT JOIN users u ON u.id = m.user_id
    WHERE m.inventory_id = ?
    UNION ALL
    SELECT 'audit' AS kind, a.id AS id, a.action AS action,
           a.after_value AS after_value, a.before_value AS before_value,
           a.meta AS meta, a.created_at AS created_at,
           u.name AS user_name, a.target_marketplace, a.target_account
    FROM stock_audit_log a
    LEFT JOIN users u ON u.id = a.user_id
    WHERE a.inventory_id = ?
    ORDER BY created_at DESC
    LIMIT ?`;
  db.all(sql, [id, id, limit], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

// Middleware para verificar nível de usuário (nível 4 = admin)
function requireAdmin(req, res, next) {
  if (req.user.role < 4) {
    return res.status(403).json({ error: 'Acesso negado. Nível de usuário insuficiente.' });
  }
  next();
}

/** Exige role numérico >= n. role=5 (Fábrica) é um papel restrito e é excluído de checagens por nível — validar via requireFactoryOrStaff quando aplicável. */
function requireRoleAtLeast(n) {
  return (req, res, next) => {
    const r = Number(req.user?.role || 0);
    if (r === 5) return res.status(403).json({ error: 'Acesso negado. Conta de Fábrica.' });
    if (r >= n) return next();
    return res.status(403).json({ error: 'Acesso negado. Nível de usuário insuficiente.' });
  };
}

/** Permite role=5 (Fábrica) ou staff interno (role >= 3). Usado em rotas de lotes/recebimentos. */
function requireFactoryOrStaff(req, res, next) {
  const r = Number(req.user?.role || 0);
  if (r === 5 || r >= 3) return next();
  return res.status(403).json({ error: 'Acesso negado' });
}

// Exportar estoque para CSV (apenas nível 4)
app.get('/api/inventory/export/csv', authenticateToken, requireAdmin, (req, res) => {
  db.all('SELECT * FROM inventory ORDER BY title ASC', (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }

    const csvHeader = 'SKU,EAN,Título,Quantidade,Localização,Quantidade Mínima,Quantidade Máxima,Categoria,Fornecedor,Preço de Custo,Preço de Venda,Observações,Data de Criação\n';
    
    const csvData = rows.map(row => {
      return [
        `"${row.sku || ''}"`,
        `"${row.ean || ''}"`,
        `"${row.title || ''}"`,
        row.quantity || 0,
        `"${row.location || ''}"`,
        row.min_quantity || 0,
        row.max_quantity || '',
        `"${row.category || ''}"`,
        `"${row.supplier || ''}"`,
        row.cost_price || '',
        row.selling_price || '',
        `"${(row.notes || '').replace(/"/g, '""')}"`,
        row.created_at
      ].join(',');
    }).join('\n');

    const csvContent = csvHeader + csvData;
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=estoque.csv');
    res.send(csvContent);
  });
});

// Relatório de Estoque Baixo (apenas nível 4)
app.get('/api/inventory/report/low-stock', authenticateToken, requireAdmin, (req, res) => {
  db.all(`
    SELECT * FROM inventory 
    WHERE quantity > 0 
    AND quantity <= COALESCE(min_quantity, 0)
    AND is_composite = 0
    ORDER BY title ASC
  `, (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }

    const csvHeader = 'SKU,EAN,Título,Quantidade Atual,Quantidade Mínima,Localização,Categoria,Fornecedor,Preço de Custo,Preço de Venda,Observações\n';
    
    const csvData = rows.map(row => {
      return [
        `"${row.sku || ''}"`,
        `"${row.ean || ''}"`,
        `"${row.title || ''}"`,
        row.quantity || 0,
        row.min_quantity || 0,
        `"${row.location || ''}"`,
        `"${row.category || ''}"`,
        `"${row.supplier || ''}"`,
        row.cost_price || '',
        row.selling_price || '',
        `"${(row.notes || '').replace(/"/g, '""')}"`
      ].join(',');
    }).join('\n');

    const csvContent = csvHeader + csvData;
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=relatorio-estoque-baixo.csv');
    res.send(csvContent);
  });
});

// Relatório de Sem Estoque (apenas nível 4)
app.get('/api/inventory/report/out-of-stock', authenticateToken, requireAdmin, (req, res) => {
  db.all(`
    SELECT * FROM inventory 
    WHERE quantity = 0
    AND is_composite = 0
    AND (category IS NULL OR LOWER(category) != 'ventilador')
    ORDER BY title ASC
  `, (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }

    const csvHeader = 'SKU,EAN,Título,Localização,Categoria,Fornecedor,Preço de Custo,Preço de Venda,Observações,Data de Criação\n';
    
    const csvData = rows.map(row => {
      return [
        `"${row.sku || ''}"`,
        `"${row.ean || ''}"`,
        `"${row.title || ''}"`,
        `"${row.location || ''}"`,
        `"${row.category || ''}"`,
        `"${row.supplier || ''}"`,
        row.cost_price || '',
        row.selling_price || '',
        `"${(row.notes || '').replace(/"/g, '""')}"`,
        row.created_at
      ].join(',');
    }).join('\n');

    const csvContent = csvHeader + csvData;
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=relatorio-sem-estoque.csv');
    res.send(csvContent);
  });
});

function parseCsvLine(line, separator) {
  const values = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === separator && !inQuotes) {
      values.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  values.push(current.trim());
  return values.map(v => v.replace(/\r/g, '').trim());
}

function normalizeImportedCsvLine(line) {
  const raw = String(line || '').replace(/\r/g, '');
  if (!raw) return raw;
  // Compatibilidade com o CSV exportado pela própria tela, que pode vir
  // com a linha inteira entre aspas e com aspas duplicadas em excesso.
  if (raw.startsWith('"') && raw.endsWith('"') && raw.includes(',"""')) {
    const inner = raw.slice(1, -1);
    return inner.replace(/""/g, '"');
  }
  return raw;
}

// Importar estoque de CSV
// Regra:
// - SKU existente: atualiza TODAS as colunas presentes no CSV (quantidade,
//   título, EAN, localização, min/max, categoria, fornecedor, preço de venda,
//   observações). Preço de custo só é atualizado quando role=4.
//   Colunas ausentes no cabeçalho preservam o valor atual (UPDATE dinâmico).
// - SKU novo: insere cadastro básico (sem impactar outros SKUs).
app.post('/api/inventory/import/csv', authenticateToken, async (req, res) => {
  const csvData = req.body.csvData;

  if (!csvData) {
    res.status(400).json({ error: 'Dados CSV são obrigatórios' });
    return;
  }

  const isRole4 = Number(req.user?.role) === 4;

  // Parsers tolerantes ao formato BR ("1.234,56") e internacional ("1234.56").
  const parseIntBr = (s) => {
    const raw = String(s ?? '').trim();
    if (!raw) return null;
    const n = parseInt(raw.replace(/\./g, '').replace(',', '.'), 10);
    return Number.isFinite(n) ? n : null;
  };
  const parseDecBr = (s) => {
    const raw = String(s ?? '').trim();
    if (!raw) return null;
    const n = parseFloat(raw.replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  };
  const strOrNull = (s) => {
    const v = String(s ?? '').trim();
    return v === '' ? null : v;
  };

  // Detectar separador: vírgula ou ponto e vírgula
  let separator = ',';
  const firstLine = csvData.split('\n')[0];
  if (firstLine.split(';').length > firstLine.split(',').length) {
    separator = ';';
  }

  const lines = csvData.split('\n');
  const headers = parseCsvLine(lines[0], separator).map(h => h.replace(/"/g, ''));
  const headerSet = new Set(headers);
  const has = (...keys) => keys.some(k => headerSet.has(k));
  const dataLines = lines.slice(1).filter(line => line.trim());

  let successCount = 0;
  let errorCount = 0;
  const errors = [];

  try {
    for (let index = 0; index < dataLines.length; index++) {
      const line = normalizeImportedCsvLine(dataLines[index]);
      const values = parseCsvLine(line, separator).map(v => v.replace(/"/g, ''));
      const item = {};
      headers.forEach((header, i) => {
        item[header] = values[i] || '';
      });

      const sku = String(item.SKU || '').trim();
      if (!sku) {
        errorCount++;
        errors.push(`Linha ${index + 2}: SKU é obrigatório`);
        continue;
      }

      // Quantidade: se a coluna existir, usa o valor do CSV (aceita 0);
      // se não existir, manteremos o valor atual no UPDATE.
      const qtdParsed = has('Quantidade') ? parseIntBr(item.Quantidade) : null;
      const qtd = Number.isFinite(qtdParsed) ? qtdParsed : 0;

      const existing = await dbGetAsync(`SELECT id, quantity FROM inventory WHERE sku = ? LIMIT 1`, [sku]);
      if (existing) {
        // SKU existente: atualiza dinamicamente apenas as colunas presentes no
        // CSV. Assim o usuário pode exportar, editar qualquer campo (título,
        // fornecedor, preço, localização, mínimo, observações etc.), reimportar
        // e ver as alterações aplicadas.
        const fields = [];
        const params = [];

        if (has('Quantidade')) { fields.push('quantity = ?'); params.push(qtd); }
        if (has('EAN')) { fields.push('ean = ?'); params.push(strOrNull(item.EAN)); }
        if (has('Título')) {
          const t = strOrNull(item.Título);
          if (t) { fields.push('title = ?'); params.push(t); }
        }
        if (has('Localização')) { fields.push('location = ?'); params.push(strOrNull(item.Localização)); }
        if (has('Quantidade Mínima')) {
          const v = parseIntBr(item['Quantidade Mínima']);
          fields.push('min_quantity = ?'); params.push(Number.isFinite(v) ? v : 0);
        }
        if (has('Quantidade Máxima')) {
          const v = parseIntBr(item['Quantidade Máxima']);
          fields.push('max_quantity = ?'); params.push(Number.isFinite(v) ? v : null);
        }
        if (has('Categoria')) { fields.push('category = ?'); params.push(strOrNull(item.Categoria)); }
        if (has('Fornecedor')) { fields.push('supplier = ?'); params.push(strOrNull(item.Fornecedor)); }
        if (has('Preço de Custo', 'Custo de Fabricação')) {
          // Preserva o valor atual se o usuário não é role=4 (não pode editar custo).
          if (isRole4) {
            const v = parseDecBr(item['Preço de Custo'] || item['Custo de Fabricação']);
            fields.push('cost_price = ?'); params.push(Number.isFinite(v) ? v : null);
          }
        }
        if (has('Preço de Venda')) {
          const v = parseDecBr(item['Preço de Venda']);
          fields.push('selling_price = ?'); params.push(Number.isFinite(v) ? v : null);
        }
        if (has('Observações')) { fields.push('notes = ?'); params.push(strOrNull(item.Observações)); }

        if (fields.length === 0) {
          // Nada a atualizar nessa linha (cabeçalho não trouxe colunas mapeadas).
          successCount++;
          continue;
        }

        fields.push('updated_at = CURRENT_TIMESTAMP');
        params.push(existing.id);
        await dbRunAsync(`UPDATE inventory SET ${fields.join(', ')} WHERE id = ?`, params);

        // Dispara sync para marketplaces apenas quando o saldo mudou de fato.
        if (has('Quantidade') && Number(existing.quantity) !== qtd) {
          pushStockForInventoryId(existing.id).catch(() => {});
        }
        successCount++;
        continue;
      }

      // SKU novo: cria cadastro básico (sem impactar outros SKUs)
      const title = strOrNull(item.Título);
      if (!title) {
        errorCount++;
        errors.push(`Linha ${index + 2}: Título é obrigatório para SKU novo`);
        continue;
      }

      const maxQtyRaw = parseIntBr(item['Quantidade Máxima']);
      const costRaw = parseDecBr(item['Preço de Custo'] || item['Custo de Fabricação']);
      const sellingRaw = parseDecBr(item['Preço de Venda']);
      const costToSave = isRole4 && Number.isFinite(costRaw) ? costRaw : null;
      await dbRunAsync(
        `INSERT INTO inventory (
          sku, ean, title, quantity, location, min_quantity, max_quantity,
          category, supplier, cost_price, selling_price, notes, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [
          sku,
          strOrNull(item.EAN),
          title,
          qtd,
          strOrNull(item.Localização),
          parseIntBr(item['Quantidade Mínima']) || 0,
          Number.isFinite(maxQtyRaw) ? maxQtyRaw : null,
          strOrNull(item.Categoria),
          strOrNull(item.Fornecedor),
          costToSave,
          Number.isFinite(sellingRaw) ? sellingRaw : null,
          strOrNull(item.Observações)
        ]
      );
      successCount++;
    }

    const row = await dbGetAsync('SELECT COUNT(*) as count FROM inventory');
    res.json({
      success: true,
      imported: successCount,
      errors: errorCount,
      errorDetails: errors,
      totalItems: row?.count || 0
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: 'Erro ao importar CSV',
      details: err.message
    });
  }
});

// Estatísticas do estoque
app.get('/api/inventory/stats', (req, res) => {
  db.get(`
    SELECT 
      COUNT(*) as total_items,
      SUM(quantity) as total_quantity,
      SUM(CASE WHEN quantity <= min_quantity THEN 1 ELSE 0 END) as low_stock_items,
      SUM(CASE WHEN quantity = 0 THEN 1 ELSE 0 END) as out_of_stock_items,
      AVG(quantity) as avg_quantity
    FROM inventory
  `, (err, stats) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(stats);
  });
});

// ROTAS PARA SKUs COMPOSTOS
app.get('/api/composite-skus/:mainSkuId', (req, res) => {
  const { mainSkuId } = req.params;
  
  db.all(`
    SELECT cs.*, i.sku as component_sku, i.title as component_title, i.quantity as component_quantity
    FROM composite_skus cs
    JOIN inventory i ON cs.component_sku_id = i.id
    WHERE cs.main_sku_id = ?
    ORDER BY cs.created_at DESC
  `, [mainSkuId], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

app.post('/api/composite-skus', (req, res) => {
  const { main_sku_id, component_sku_id, quantity } = req.body;

  // Garantir que os IDs são números
  const mainId = Number(main_sku_id);
  const compId = Number(component_sku_id);
  const qty = Number(quantity);

  if (!mainId || !compId || !qty) {
    console.log('[POST /api/composite-skus] Falha: Campos obrigatórios ausentes ou inválidos');
    res.status(400).json({ error: 'Todos os campos são obrigatórios e devem ser números válidos' });
    return;
  }

  if (mainId === compId) {
    console.log('[POST /api/composite-skus] Falha: SKU principal igual ao componente');
    res.status(400).json({ error: 'Um SKU não pode ser componente de si mesmo' });
    return;
  }

  // Verificar existência dos SKUs
  db.get('SELECT id FROM inventory WHERE id = ?', [mainId], (err, mainRow) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    if (!mainRow) {
      res.status(400).json({ error: 'SKU principal não encontrado no estoque' });
      return;
    }
    db.get('SELECT id FROM inventory WHERE id = ?', [compId], (err, compRow) => {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }
      if (!compRow) {
        res.status(400).json({ error: 'SKU componente não encontrado no estoque' });
        return;
      }
      // Inserir vínculo
      db.run(`
        INSERT INTO composite_skus (main_sku_id, component_sku_id, quantity)
        VALUES (?, ?, ?)
      `, [mainId, compId, qty], function(err) {
        if (err) {
          console.log('[POST /api/composite-skus] Erro ao inserir:', err.message);
          res.status(500).json({ error: err.message });
          return;
        }
        // Marcar o SKU principal como composto
        db.run('UPDATE inventory SET is_composite = 1 WHERE id = ?', [mainId], (err2) => {
          if (err2) {
            console.log('[POST /api/composite-skus] Erro ao marcar is_composite:', err2.message);
            // Não impede o sucesso do vínculo, apenas loga
          }
          res.json({ 
            id: this.lastID, 
            main_sku_id: mainId, 
            component_sku_id: compId, 
            quantity: qty 
          });
        });
      });
    });
  });
});

app.delete('/api/composite-skus/:id', (req, res) => {
  const { id } = req.params;
  
  db.run('DELETE FROM composite_skus WHERE id = ?', [id], function(err) {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    if (this.changes === 0) {
      res.status(404).json({ error: 'Componente não encontrado' });
      return;
    }
    res.json({ success: true, changes: this.changes });
  });
});

// Função recursiva para calcular saldo máximo possível de um SKU (simples, composto, kit, kit de composto)
async function calcularSaldoRecursivo(skuId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT quantity, is_composite FROM inventory WHERE id = ?', [skuId], (err, item) => {
      if (err || !item) return resolve(0);
      if (!item.is_composite) {
        // SKU simples
        return resolve(item.quantity);
      }
      // SKU composto: buscar componentes
      db.all('SELECT component_sku_id, quantity as required_quantity FROM composite_skus WHERE main_sku_id = ?', [skuId], async (err, componentes) => {
        if (err || !componentes || componentes.length === 0) return resolve(0);
        let min = Infinity;
        for (const comp of componentes) {
          // Recursivo: saldo do componente dividido pela quantidade necessária
          const saldoComp = await calcularSaldoRecursivo(comp.component_sku_id);
          const possivel = Math.floor(saldoComp / comp.required_quantity);
          if (possivel < min) min = possivel;
        }
        resolve(min === Infinity ? 0 : min);
      });
    });
  });
}

// Rota para calcular estoque de SKU composto
app.get('/api/inventory/:id/composite-stock', async (req, res) => {
  const { id } = req.params;
  db.get('SELECT is_composite FROM inventory WHERE id = ?', [id], async (err, item) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    if (!item) {
      res.status(404).json({ error: 'Item não encontrado' });
      return;
    }
    if (!item.is_composite) {
      res.json({ is_composite: false, max_possible: null });
      return;
    }
    // Novo: cálculo recursivo
    const maxPossible = await calcularSaldoRecursivo(id);
    // Para manter compatibilidade, também retorna os componentes diretos
    db.all(`
      SELECT cs.component_sku_id, cs.quantity as required_quantity, i.quantity as available_quantity
      FROM composite_skus cs
      JOIN inventory i ON cs.component_sku_id = i.id
      WHERE cs.main_sku_id = ?
    `, [id], (err, components) => {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }
      res.json({
        is_composite: true,
        max_possible: maxPossible,
        components: components
      });
    });
  });
});

// Função auxiliar para buscar título do SKU no estoque
async function buscarTituloESku(sku) {
  // Remove qualquer letra do final do SKU (ex: 50583b -> 50583)
  const skuLimpo = typeof sku === 'string' ? sku.replace(/[a-zA-Z]+$/, '') : sku;
  return new Promise((resolve) => {
    console.log('Buscando título para SKU:', sku, '| SKU limpo:', skuLimpo);
    db.get('SELECT title FROM inventory WHERE sku = ?', [skuLimpo], (err, row) => {
      if (err) return resolve('');
      if (row) return resolve(row.title || '');
      // Se não encontrar, tenta buscar por aproximação (LIKE)
      db.get('SELECT title FROM inventory WHERE sku LIKE ?', [skuLimpo + '%'], (err2, row2) => {
        if (err2 || !row2) return resolve('');
        resolve(row2.title || '');
      });
    });
  });
}

// Atualizar função montarNotaFiscalDetalhada para garantir que o campo numeroLoja sempre seja string, mesmo que venha como número do Bling.
async function montarNotaFiscalDetalhada(nota, tokenObj, accountId) {
  const notaData = nota && nota.data ? nota.data : nota;
  let valorNota = notaData.valorNota;
  let numeroLoja = null;
  let dataEmissao = notaData.dataEmissao;
  let horaEmissao = notaData.horaEmissao || null;
  // Buscar numeroLoja em diferentes locais possíveis
  if (notaData.numeroPedidoLoja !== undefined && notaData.numeroPedidoLoja !== null) {
    numeroLoja = String(notaData.numeroPedidoLoja).trim();
  } else if (notaData.pedido && notaData.pedido.numero) {
    numeroLoja = String(notaData.pedido.numero).trim();
  } else if (notaData.numeroPedido && notaData.numeroPedido !== null) {
    numeroLoja = String(notaData.numeroPedido).trim();
  }
  let detalhe = null;
  try {
    const detalheRes = await blingGet(`/nfe/${notaData.id}`, tokenObj, {}, accountId);
    detalhe = detalheRes.data?.data;
    if (detalhe) {
      if (detalhe.dataEmissao) dataEmissao = detalhe.dataEmissao;
      if (detalhe.horaEmissao) horaEmissao = detalhe.horaEmissao;
      if (detalhe.valorNota !== undefined) {
        valorNota = detalhe.valorNota;
      } else if (Array.isArray(detalhe?.itens) && detalhe.itens.length > 0 && detalhe.itens[0].valorTotal !== undefined) {
        valorNota = detalhe.itens[0].valorTotal;
      }
      // Buscar numeroLoja em diferentes locais possíveis no detalhe
      if (detalhe.numeroPedidoLoja !== undefined && detalhe.numeroPedidoLoja !== null) {
        numeroLoja = String(detalhe.numeroPedidoLoja).trim();
      } else if (detalhe.pedido && detalhe.pedido.numero) {
        numeroLoja = String(detalhe.pedido.numero).trim();
      } else if (detalhe.numeroPedido && detalhe.numeroPedido !== null) {
        numeroLoja = String(detalhe.numeroPedido).trim();
      }
    }
  } catch (e) {
    // Se falhar, mantém os valores da listagem
  }
  let itensNota = [];
  if (Array.isArray(detalhe?.itens) && detalhe.itens.length > 0) {
    itensNota = detalhe.itens;
  } else if (Array.isArray(notaData.itens) && notaData.itens.length > 0) {
    itensNota = notaData.itens;
  }
  const itensComLocalizacao = Array.isArray(itensNota) ? await Promise.all(itensNota.map(async item => {
    const sku = item.codigo || '';
    // Buscar título, localização e saldo do estoque usando a função buscarTituloESku e lógica de limpeza
    const title = await buscarTituloESku(sku);
    // Buscar quantidade e localização com limpeza e aproximação
    const skuLimpo = typeof sku === 'string' ? sku.replace(/[a-zA-Z]+$/, '') : sku;
    const estoque = await new Promise((resolve) => {
      db.get('SELECT location, quantity FROM inventory WHERE sku = ? OR sku LIKE ?', [skuLimpo, skuLimpo + '%'], (err, row) => {
        if (err || !row) return resolve({ location: '', quantity: '' });
        resolve(row);
      });
    });
    return {
      codigo: sku,
      descricao: title || item.descricao || '',
      quantidade: item.quantidade || 0,
      localizacao: estoque.location || '',
      cfop: item.cfop || null, // Incluir CFOP para identificação do Mercado Livre Full
    };
  })) : [];

  // LOG DIAGNÓSTICO
  const mkLog = identificarMarketplace(numeroLoja, itensNota) || 'Desconhecido';
  console.log(`[LOG DIAGNÓSTICO] numeroLoja: '${numeroLoja}' | identificarMarketplace: '${mkLog}'`);

  let dataEmissaoFinal = dataEmissao;
  if (dataEmissao && horaEmissao) {
    const dataStr = String(dataEmissao);
    if (!dataStr.includes('T') && !dataStr.includes(' ')) {
      dataEmissaoFinal = `${dataStr} ${horaEmissao}`;
    }
  }

  return {
    accountId,
    id: notaData.id,
    numero: notaData.numero,
    dataEmissao: dataEmissaoFinal,
    valorNota: valorNota,
    cliente: notaData.contato?.nome || 'Cliente não informado',
    serie: notaData.serie,
    situacao: notaData.situacao, // número conforme API
    numeroLoja: numeroLoja,
    marketplace: mkLog, // sempre preenchido
    idMovimentacaoInterna: notaData.idMovimentacaoInterna || notaData.idMovimentacao || null,
    itens: itensComLocalizacao
  };
}

// Rota para montar SKU composto (consumir componentes)
app.post('/api/inventory/:id/build-composite', (req, res) => {
  const { id } = req.params;
  const { quantity, reason } = req.body;
  const accountId = getAccountIdFromReq(req);
  
  if (!quantity || quantity <= 0) {
    res.status(400).json({ error: 'Quantidade deve ser maior que zero' });
    return;
  }

  refreshTokenIfNeeded(accountId).then(tokenObj => {
    if (!tokenObj || !tokenObj.access_token) {
      res.status(401).json({ error: 'Não autenticado no Bling.' });
      return;
    }
  db.serialize(() => {
    // Verificar se é um SKU composto
    db.get('SELECT is_composite FROM inventory WHERE id = ?', [id], (err, item) => {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }
      if (!item || !item.is_composite) {
        res.status(400).json({ error: 'Item não é um SKU composto' });
        return;
      }

      // Verificar se há componentes suficientes
      db.all(`
          SELECT cs.component_sku_id, cs.quantity as required_quantity, i.quantity as available_quantity
        FROM composite_skus cs
        JOIN inventory i ON cs.component_sku_id = i.id
        WHERE cs.main_sku_id = ?
      `, [id], (err, components) => {
        if (err) {
          res.status(500).json({ error: err.message });
          return;
        }

        // Verificar se há estoque suficiente
        const insufficient = components.filter(comp => 
          comp.available_quantity < (comp.required_quantity * quantity)
        );

        if (insufficient.length > 0) {
          res.status(400).json({ 
            error: 'Estoque insuficiente dos componentes',
            insufficient: insufficient
          });
          return;
        }

        // Consumir componentes e adicionar SKU composto
        const notasFormatadas = [];
        for (let i = 0; i < components.length; i++) {
          const comp = components[i];
          const consumedQuantity = comp.required_quantity * quantity;
          const newQuantity = comp.available_quantity - consumedQuantity;

          db.run('UPDATE inventory SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', 
            [newQuantity, comp.component_sku_id], function(err) {
            if (err) {
                console.error(`Erro ao atualizar ${comp.sku}: ${err.message}`);
            } else {
              // A3: componente consumido pela montagem — propaga para canais.
              pushStockForInventoryId(comp.component_sku_id).catch(() => {});
            }

            // Registrar movimentação do componente
            db.run(`
              INSERT INTO inventory_movements (
                inventory_id, movement_type, quantity, previous_quantity, 
                new_quantity, reason, user_id, account_id, movement_date
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [comp.component_sku_id, 'out', consumedQuantity, comp.available_quantity, newQuantity, 
                `Montagem de SKU composto: ${reason || 'Montagem automática'}`, null, accountId || null, getCurrentDateTimeSP()]);

              const notaData = comp && comp.data ? comp.data : comp;
              montarNotaFiscalDetalhada(notaData, tokenObj, accountId).then(nota => {
                notasFormatadas.push(nota);
                // Se for o último componente, responder
                if (notasFormatadas.length === components.length) {
                  if (notasFormatadas.length === 0) {
                    logBling('Erro ao buscar notas fiscais (lista)', insufficient);
                    res.status(404).json({ error: 'Nenhuma nota fiscal encontrada.', details: insufficient });
                  } else {
                    logBling('Importação de notas fiscais concluída', { total: notasFormatadas.length });
                    console.log("DEBUG - Enviando numeroLoja:", notasFormatadas.map(n => n.numeroLoja));
                    if (Array.isArray(notasFormatadas) && notasFormatadas.length > 0) {
                      console.log("DEBUG - Estrutura completa da primeira nota:", JSON.stringify(notasFormatadas[0], null, 2));
                    }
                    res.json({ data: notasFormatadas });
                    }
                }
                });
              });
            }
          });
      });
    });
  });
});

// Rota para listar todos os SKUs compostos e seus componentes
app.get('/api/composite-skus', (req, res) => {
  db.all(`
    SELECT cs.id, cs.main_sku_id, msku.sku as main_sku, msku.title as main_title,
           cs.component_sku_id, csku.sku as component_sku, csku.title as component_title,
           cs.quantity as component_quantity
    FROM composite_skus cs
    JOIN inventory msku ON cs.main_sku_id = msku.id
    JOIN inventory csku ON cs.component_sku_id = csku.id
    ORDER BY cs.main_sku_id, cs.id
  `, (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    // Agrupar por main_sku_id
    const result = {};
    rows.forEach(row => {
      if (!result[row.main_sku_id]) {
        result[row.main_sku_id] = {
          main_sku_id: row.main_sku_id,
          main_sku: row.main_sku,
          main_title: row.main_title,
          components: []
        };
      }
      result[row.main_sku_id].components.push({
        id: row.id,
        component_sku_id: row.component_sku_id,
        component_sku: row.component_sku,
        component_title: row.component_title,
        quantity: row.component_quantity
      });
    });
    res.json(Object.values(result));
  });
});

// Listar todas as movimentações de estoque
app.get('/api/stock-movements', (req, res) => {
  const { search, limit, offset } = req.query;
  const accountId = getOptionalAccountIdFromReq(req);
  
  let query = `
    SELECT m.*, u.name as user_name, i.title as item_title, i.sku as item_sku, a.name as account_name
    FROM inventory_movements m
    LEFT JOIN users u ON m.user_id = u.id
    LEFT JOIN inventory i ON m.inventory_id = i.id
    LEFT JOIN bling_accounts a ON m.account_id = a.id
    WHERE 1=1
  `;
  let params = [];
  
  if (accountId) {
    query += ' AND m.account_id = ?';
    params.push(accountId);
  }

  // Filtro de pesquisa
  if (search) {
    query += ' AND (i.sku LIKE ? OR i.title LIKE ?)';
    const searchTerm = `%${search}%`;
    params.push(searchTerm, searchTerm);
  }
  
  query += ' ORDER BY m.movement_date DESC';
  
  // Paginação
  let limitNum = parseInt(limit) || 20;
  let offsetNum = parseInt(offset) || 0;
  query += ' LIMIT ? OFFSET ?';
  params.push(limitNum, offsetNum);
  
  // Buscar total de movimentações (sem filtro)
  const totalQuery = accountId
    ? 'SELECT COUNT(*) as total FROM inventory_movements WHERE account_id = ?'
    : 'SELECT COUNT(*) as total FROM inventory_movements';
  db.get(totalQuery, accountId ? [accountId] : [], (err, totalRow) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    
    // Buscar total filtrado
    let countQuery = `
      SELECT COUNT(*) as totalFiltrado 
      FROM inventory_movements m
      LEFT JOIN inventory i ON m.inventory_id = i.id
      WHERE 1=1
    `;
    let countParams = [];
    
    if (accountId) {
      countQuery += ' AND m.account_id = ?';
      countParams.push(accountId);
    }

    if (search) {
      countQuery += ' AND (i.sku LIKE ? OR i.title LIKE ?)';
      const searchTerm = `%${search}%`;
      countParams.push(searchTerm, searchTerm);
    }
    
    db.get(countQuery, countParams, (err, countRow) => {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }
      
      // Buscar movimentações paginadas
      db.all(query, params, (err, rows) => {
        if (err) {
          res.status(500).json({ error: err.message });
          return;
        }
        res.json({
          movements: rows,
          total: totalRow.total,
          totalFiltrado: countRow.totalFiltrado
        });
      });
    });
  });
});

// Contas Bling
app.get('/api/bling/accounts', (req, res) => {
  db.all(`SELECT id, name, client_id, redirect_uri,
                 CASE WHEN client_secret IS NOT NULL AND client_secret != '' THEN 1 ELSE 0 END AS has_client_secret,
                 created_at, updated_at
          FROM bling_accounts ORDER BY id ASC`, (err, rows) => {
    if (err) return res.status(500).json({ error: 'Erro ao listar contas', details: err.message });
    res.json({ accounts: rows || [] });
  });
});

app.post('/api/bling/accounts', (req, res) => {
  const name = (req.body && req.body.name) ? String(req.body.name).trim() : '';
  if (!name) return res.status(400).json({ error: 'Nome da conta é obrigatório' });
  const clientId = (req.body && req.body.client_id) ? String(req.body.client_id).trim() : null;
  const clientSecret = (req.body && req.body.client_secret) ? String(req.body.client_secret).trim() : null;
  const redirectUri = (req.body && req.body.redirect_uri) ? String(req.body.redirect_uri).trim() : (BLING_REDIRECT_URI || null);
  db.run(
    'INSERT INTO bling_accounts (name, client_id, client_secret, redirect_uri, created_at, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
    [name, clientId, clientSecret, redirectUri],
    function(err) {
    if (err) return res.status(500).json({ error: 'Erro ao criar conta', details: err.message });
    res.json({ id: this.lastID, name });
    }
  );
});

app.put('/api/bling/accounts/:id', (req, res) => {
  const accountId = parseInt(req.params.id, 10);
  if (!Number.isFinite(accountId) || accountId <= 0) {
    return res.status(400).json({ error: 'Conta inválida' });
  }
  const name = (req.body && req.body.name) ? String(req.body.name).trim() : '';
  if (!name) return res.status(400).json({ error: 'Nome da conta é obrigatório' });
  db.run(
    'UPDATE bling_accounts SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [name, accountId],
    function(err) {
      if (err) return res.status(500).json({ error: 'Erro ao atualizar conta', details: err.message });
      if (!this.changes) return res.status(404).json({ error: 'Conta Bling não encontrada' });
      res.json({ success: true, id: accountId, name });
    }
  );
});

app.put('/api/bling/accounts/:id/credentials', (req, res) => {
  const accountId = parseInt(req.params.id, 10);
  if (!Number.isFinite(accountId) || accountId <= 0) {
    return res.status(400).json({ error: 'Conta inválida' });
  }
  const clientId = (req.body && req.body.client_id) ? String(req.body.client_id).trim() : '';
  const clientSecret = (req.body && req.body.client_secret) ? String(req.body.client_secret).trim() : '';
  const redirectUri = (req.body && req.body.redirect_uri) ? String(req.body.redirect_uri).trim() : '';
  if (!clientId || !redirectUri) {
    return res.status(400).json({ error: 'client_id e redirect_uri são obrigatórios' });
  }
  db.get('SELECT id, client_secret FROM bling_accounts WHERE id = ? LIMIT 1', [accountId], (err, row) => {
    if (err) return res.status(500).json({ error: 'Erro ao buscar conta', details: err.message });
    if (!row) return res.status(404).json({ error: 'Conta Bling não encontrada' });
    const nextSecret = clientSecret ? clientSecret : row.client_secret;
    db.run(
      'UPDATE bling_accounts SET client_id = ?, client_secret = ?, redirect_uri = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [clientId, nextSecret, redirectUri, accountId],
      function(updateErr) {
        if (updateErr) return res.status(500).json({ error: 'Erro ao atualizar credenciais', details: updateErr.message });
        res.json({ success: true, accountId });
      }
    );
  });
});

// Endpoint para gerar URL de autorização
app.get('/api/bling/auth', async (req, res) => {
  const accountId = getAccountIdFromReq(req);
  db.get('SELECT id FROM bling_accounts WHERE id = ? LIMIT 1', [accountId], async (err, row) => {
    if (err) return res.status(500).json({ error: 'Erro ao validar conta', details: err.message });
    if (!row) return res.status(404).json({ error: 'Conta Bling não encontrada' });
    const creds = await getBlingCredentials(accountId);
    if (!creds) return res.status(400).json({ error: 'Credenciais do Bling não configuradas para esta conta' });
    const state = `${accountId}:${Math.random().toString(36).substring(7)}`;
    const url = `${BLING_AUTH_URL}?response_type=code&client_id=${creds.clientId}&redirect_uri=${encodeURIComponent(creds.redirectUri)}&scope=produtos%20notasfiscais%20pedidos%20contatos&state=${encodeURIComponent(state)}`;
    logBling('URL de autorização gerada', { accountId, url });
    res.json({ url, state, accountId });
  });
});

// Endpoint de callback para receber o code e trocar pelo token
app.get('/api/bling/callback', async (req, res) => {
  const { code, error, state } = req.query;
  if (error) {
    logBling('Erro no callback', error);
    return res.status(400).send('Erro na autorização: ' + error);
  }
  if (!code) {
    logBling('Callback sem code');
    return res.status(400).send('Código de autorização não recebido.');
  }
  let accountIdFromState = null;
  if (state && typeof state === 'string' && state.includes(':')) {
    const [idPart] = state.split(':');
    accountIdFromState = normalizeAccountId(idPart);
  }
  const accountId = accountIdFromState || getAccountIdFromReq(req);
  try {
    const creds = await getBlingCredentials(accountId);
    if (!creds) {
      return res.status(400).send('Credenciais do Bling não configuradas para esta conta.');
    }
    const data = qs.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: creds.redirectUri
    });
    // Montar o header Authorization: Basic base64(client_id:client_secret)
    const basicAuth = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
    const response = await axios.post(BLING_TOKEN_URL, data, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${basicAuth}`
      }
    });
    const tokenObj = {
      ...response.data,
      created_at: new Date().toISOString()
    };
    await saveToken(tokenObj, accountId);
    res.send('<h2>Autorização concluída com sucesso! Você já pode fechar esta janela.</h2>');
  } catch (err) {
    logBling('Erro ao trocar code por token', err.response?.data || err.message);
    res.status(500).send('Erro ao autorizar com o Bling. Tente novamente.');
  }
});

// Endpoint para status da conexão
app.get('/api/bling/status', async (req, res) => {
  const accountId = getAccountIdFromReq(req);
  let tokenObj = null;
  try {
    tokenObj = await refreshTokenIfNeeded(accountId);
  } catch (err) {
    setNotasFiscaisFetching(accountId, false);
    importacaoProgresso.status = 'erro';
    logBling('Erro ao obter token do Bling', { accountId, details: err?.message || err });
    return res.status(500).json({ error: 'Erro ao obter token do Bling.', details: err?.message || err });
  }
  if (!tokenObj || !tokenObj.access_token) {
    return res.json({ accountId, connected: false, last_error: ultimoErroRefresh || null });
  }
  // Se existe token válido, considera conectado
  return res.json({ accountId, connected: true, expires_in: tokenObj.expires_in, created_at: tokenObj.created_at, last_error: ultimoErroRefresh || null });
});

// Endpoint para logs detalhados
app.get('/api/bling/logs', (req, res) => {
  try {
    if (!fs.existsSync(LOG_FILE)) return res.type('text/plain').send('Sem logs ainda.');
    const requested = parseInt(req.query.lines, 10);
    const max = Math.min(1000, Math.max(20, Number.isFinite(requested) ? requested : 200));
    // Tail simples — lê o arquivo inteiro e fatia. Como LOG_FILE é local e os
    // scripts de rotação externa (fly volume) mantêm em tamanho razoável, é
    // aceitável. Se crescer demais, considerar um tail baseado em fs.stat.
    const raw = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const tail = lines.slice(-max);
    res.type('text/plain').send(tail.join('\n'));
  } catch (e) {
    res.status(500).type('text/plain').send('Erro ao ler logs: ' + (e.message || e));
  }
});

// Limpa completamente o console do Bling. Usado pelo botão "Limpar console" na
// aba Avançado de Configurações.
app.delete('/api/bling/logs', (req, res) => {
  try {
    if (fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Erro ao limpar logs' });
  }
});

// Endpoint para verificar tokens no banco de dados
app.get('/api/bling/tokens', (req, res) => {
  const accountId = (req.query && req.query.accountId) ? normalizeAccountId(req.query.accountId) : null;
  const where = accountId ? 'WHERE t.provider = ? AND t.account_id = ?' : 'WHERE t.provider = ?';
  const params = accountId ? ['bling', accountId] : ['bling'];
  const sql = `SELECT t.id, t.provider, t.account_id, a.name as account_name, t.created_at, t.updated_at
               FROM api_tokens t
               LEFT JOIN bling_accounts a ON a.id = t.account_id
               ${where}
               ORDER BY t.updated_at DESC`;
  db.all(sql, params, (err, rows) => {
    if (err) {
      res.status(500).json({ error: 'Erro ao consultar tokens', details: err.message });
    } else {
      res.json({ tokens: rows, count: rows.length });
    }
  });
});

// Endpoint para limpar tokens antigos
app.delete('/api/bling/tokens', async (req, res) => {
  try {
    const accountId = getAccountIdFromReq(req);
    await cleanOldTokens(accountId);
    res.json({ message: 'Tokens antigos removidos com sucesso' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao limpar tokens', details: err.message });
  }
});

// Endpoint para desconectar (remover todos os tokens) de uma conta
app.delete('/api/bling/tokens/revoke', (req, res) => {
  const accountId = getAccountIdFromReq(req);
  db.run('DELETE FROM api_tokens WHERE provider = ? AND account_id = ?', ['bling', accountId], function(err) {
    if (err) return res.status(500).json({ error: 'Erro ao revogar tokens', details: err.message });
    res.json({ success: true, removed: this.changes || 0, accountId });
  });
});

// ═══════════════════════════════════════════════════════════════
// ═══  MERCADO LIVRE INTEGRATION  ═════════════════════════════
// ═══════════════════════════════════════════════════════════════

const ML_AUTH_URL = 'https://auth.mercadolivre.com.br/authorization';
const ML_TOKEN_URL = 'https://api.mercadolibre.com/oauth/token';
const ML_API_BASE = 'https://api.mercadolibre.com';

function getMLCredentials(accountId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT client_id, client_secret, redirect_uri, ml_user_id FROM ml_accounts WHERE id = ?', [accountId], (err, row) => {
      if (err || !row || !row.client_id) return resolve(null);
      resolve({ clientId: row.client_id, clientSecret: row.client_secret, redirectUri: row.redirect_uri, mlUserId: row.ml_user_id });
    });
  });
}

function loadMLToken(accountId) {
  return new Promise((resolve) => {
    db.get('SELECT * FROM api_tokens WHERE provider = ? AND account_id = ? ORDER BY updated_at DESC LIMIT 1',
      ['mercado_livre', accountId], (err, row) => resolve(err ? null : row));
  });
}

function saveMLToken(tokenData, accountId, existingRefreshToken) {
  return new Promise((resolve, reject) => {
    const refreshToken = tokenData.refresh_token || existingRefreshToken || null;
    db.run(`INSERT OR REPLACE INTO api_tokens (id, provider, account_id, access_token, refresh_token, expires_in, token_type, created_at, updated_at)
            VALUES ((SELECT id FROM api_tokens WHERE provider = 'mercado_livre' AND account_id = ?), 'mercado_livre', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [accountId, accountId, tokenData.access_token, refreshToken, tokenData.expires_in || 21600, tokenData.token_type || 'Bearer', tokenData.created_at || new Date().toISOString()],
      function(err) { err ? reject(err) : resolve(); });
  });
}

const mlRefreshFailures = {};
async function refreshMLTokenIfNeeded(accountId, forceRefresh = false) {
  const token = await loadMLToken(accountId);
  if (!token) {
    logMarketplaceConnection('mercado_livre', 'no_token_row', 'WARN', accountId, {});
    return null;
  }
  const elapsed = (Date.now() - new Date(token.updated_at || token.created_at).getTime()) / 1000;
  const expiresIn = token.expires_in || 21600;
  if (!forceRefresh && elapsed < expiresIn - 600) return token;

  // On forceRefresh (401 retry), skip the cooldown to allow immediate retry
  if (!forceRefresh && mlRefreshFailures[accountId] && Date.now() - mlRefreshFailures[accountId] < 3 * 60 * 1000) {
    console.log(`[ML] Refresh cooldown active for account ${accountId}, using existing token`);
    logMarketplaceConnection('mercado_livre', 'refresh_skipped_cooldown', 'WARN', accountId, {
      cooldownRemainingSec: Math.ceil((3 * 60 * 1000 - (Date.now() - mlRefreshFailures[accountId])) / 1000)
    });
    return token.access_token ? token : null;
  }

  const creds = await getMLCredentials(accountId);
  if (!creds) {
    logMarketplaceConnection('mercado_livre', 'no_oauth_credentials', 'WARN', accountId, {});
    console.error(`[ML] No credentials for account ${accountId}`);
    return null;
  }
  if (!token.refresh_token) {
    logMarketplaceConnection('mercado_livre', 'no_refresh_token', 'WARN', accountId, {});
    console.error(`[ML] No refresh_token for account ${accountId} - user must re-authorize`);
    return null;
  }

  try {
    console.log(`[ML] Refreshing token for account ${accountId} (elapsed: ${Math.round(elapsed)}s / expires: ${expiresIn}s)`);
    const resp = await axios.post(ML_TOKEN_URL, qs.stringify({
      grant_type: 'refresh_token',
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: token.refresh_token
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const newToken = { ...resp.data, created_at: new Date().toISOString() };
    await saveMLToken(newToken, accountId, token.refresh_token);
    delete mlRefreshFailures[accountId];
    console.log(`[ML] Token refreshed OK for account ${accountId} (new refresh_token: ${resp.data.refresh_token ? 'yes' : 'preserved old'})`);
    return { ...token, ...newToken, refresh_token: resp.data.refresh_token || token.refresh_token };
  } catch (err) {
    const errData = err.response?.data || {};
    console.error(`[ML] Token refresh failed for account ${accountId}:`, errData.error || err.message, errData.message || '');
    mlRefreshFailures[accountId] = Date.now();
    logMarketplaceConnection('mercado_livre', 'refresh_failed', 'ERROR', accountId, {
      status: err.response?.status,
      error: errData.error || err.message,
      description: errData.error_description || errData.message
    });
    if (errData.error === 'invalid_grant') {
      console.error(`[ML] Refresh token is invalid/expired for account ${accountId}. User must re-authorize.`);
      logMarketplaceConnection('mercado_livre', 'invalid_grant_reconnect_required', 'ERROR', accountId, { hint: 'Reautorizar Mercado Livre' });
    }
    return token.access_token ? token : null;
  }
}

// Retry exponencial para 429 (rate limit) e 5xx transientes.
// Respeita Retry-After quando presente. Usado em todas as chamadas ML/Shopee.
const MAX_API_RETRIES = 3;
async function withRetryBackoff(fn, label = 'api') {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      const isRetriable = status === 429 || (status >= 500 && status < 600);
      if (!isRetriable || attempt === MAX_API_RETRIES) { lastErr = err; break; }
      const retryAfterHeader = Number(err.response?.headers?.['retry-after']);
      const base = 500 * Math.pow(2, attempt); // 500, 1000, 2000 ms
      const jitter = Math.floor(Math.random() * 250);
      const waitMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
        ? Math.min(retryAfterHeader * 1000, 15000)
        : base + jitter;
      console.warn(`[${label}] status ${status} — aguardando ${waitMs}ms antes do retry ${attempt + 1}/${MAX_API_RETRIES}`);
      await new Promise((r) => setTimeout(r, waitMs));
      lastErr = err;
    }
  }
  throw lastErr;
}

async function mlApiRequest(method, path, body, accountId) {
  let token = await refreshMLTokenIfNeeded(accountId);
  if (!token) throw new Error('Token ML indisponível');
  const makeRequest = async (accessToken) => {
    const config = { headers: { Authorization: `Bearer ${accessToken}` } };
    if (body) config.headers['Content-Type'] = 'application/json';
    switch (method) {
      case 'GET': return axios.get(`${ML_API_BASE}${path}`, config);
      case 'PUT': return axios.put(`${ML_API_BASE}${path}`, body, config);
      case 'POST': return axios.post(`${ML_API_BASE}${path}`, body, config);
      case 'DELETE': return axios.delete(`${ML_API_BASE}${path}`, config);
      default: throw new Error(`Método HTTP inválido: ${method}`);
    }
  };
  try {
    const resp = await withRetryBackoff(() => makeRequest(token.access_token), `ML ${method} ${path}`);
    return resp.data;
  } catch (err) {
    if (err.response?.status === 401) {
      logMarketplaceConnection('mercado_livre', 'api_401', 'WARN', accountId, { method, path });
      console.log(`[ML] 401 em ${method} ${path}, forçando refresh e retry...`);
      token = await refreshMLTokenIfNeeded(accountId, true);
      if (!token) {
        logMarketplaceConnection('mercado_livre', 'api_401_no_token_after_refresh', 'ERROR', accountId, { method, path });
        throw new Error('Token ML indisponível após retry');
      }
      // Recarrega do SQLite para garantir o mesmo access_token persistido (evita inconsistência no objeto mesclado após refresh).
      const freshRow = await loadMLToken(accountId);
      const accessAfterRefresh = freshRow?.access_token || token.access_token;
      if (!accessAfterRefresh) {
        logMarketplaceConnection('mercado_livre', 'api_401_empty_token_after_refresh', 'ERROR', accountId, { method, path });
        throw new Error('Token ML vazio após refresh');
      }
      try {
        const resp = await withRetryBackoff(() => makeRequest(accessAfterRefresh), `ML ${method} ${path} retry401`);
        return resp.data;
      } catch (err2) {
        console.error(`[ML] Retry após refresh falhou ${method} ${path}:`, err2.response?.status, err2.response?.data || err2.message);
        logMarketplaceConnection('mercado_livre', 'api_401_retry_failed', 'ERROR', accountId, {
          method, path, status: err2.response?.status, body: err2.response?.data, message: err2.message
        });
        throw err2;
      }
    }
    throw err;
  }
}

async function mlApiGet(path, accountId) { return mlApiRequest('GET', path, null, accountId); }
async function mlApiPut(path, body, accountId) { return mlApiRequest('PUT', path, body, accountId); }
async function mlApiPost(path, body, accountId) { return mlApiRequest('POST', path, body, accountId); }
async function mlApiDelete(path, accountId) { return mlApiRequest('DELETE', path, null, accountId); }

async function mlEnsureSellerUserId(accountId) {
  const creds = await getMLCredentials(accountId);
  if (creds?.mlUserId) return String(creds.mlUserId);
  const token = await refreshMLTokenIfNeeded(accountId);
  if (!token) throw new Error('Token ML indisponível');
  const me = await mlApiGet('/users/me', accountId);
  db.run('UPDATE ml_accounts SET ml_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [String(me.id), accountId]);
  return String(me.id);
}

/** Vendedores com tag user_product_seller não podem usar array variations; cada variação é um POST /items com family_name (Price per variation / User Products). */
async function mlSellerIsUserProductSeller(accountId) {
  const uid = await mlEnsureSellerUserId(accountId);
  const u = await mlApiGet(`/users/${uid}`, accountId);
  return Array.isArray(u.tags) && u.tags.includes('user_product_seller');
}

// ─── ML Accounts ───
app.get('/api/ml/accounts', (req, res) => {
  db.all(`SELECT id, name, client_id, redirect_uri, ml_user_id,
                 CASE WHEN client_secret IS NOT NULL AND client_secret != '' THEN 1 ELSE 0 END AS has_secret,
                 bling_account_id,
                 COALESCE(auto_invoice_enabled, 0) AS auto_invoice_enabled,
                 COALESCE(auto_sync_enabled, 0) AS auto_sync_enabled,
                 last_items_sync_at, tax_pct,
                 created_at, updated_at FROM ml_accounts ORDER BY id`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ accounts: rows || [] });
  });
});

app.post('/api/ml/accounts', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
  db.run('INSERT INTO ml_accounts (name) VALUES (?)', [name], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID, name });
  });
});

app.put('/api/ml/accounts/:id/credentials', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = (req.body.client_id || '').trim();
  const clientSecret = (req.body.client_secret || '').trim();
  const redirectUri = (req.body.redirect_uri || '').trim();
  if (!clientId || !redirectUri) return res.status(400).json({ error: 'client_id e redirect_uri obrigatórios' });
  db.get('SELECT client_secret FROM ml_accounts WHERE id = ?', [id], (err, row) => {
    if (err || !row) return res.status(404).json({ error: 'Conta não encontrada' });
    const secret = clientSecret || row.client_secret;
    db.run('UPDATE ml_accounts SET client_id = ?, client_secret = ?, redirect_uri = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [clientId, secret, redirectUri, id], function(e) {
        if (e) return res.status(500).json({ error: e.message });
        res.json({ success: true });
      });
  });
});

// Vincula a conta ML a uma conta Bling e/ou habilita a auto-fatura.
// Usado pelo "Mapeamento de faturamento" em External APIs.
app.put('/api/ml/accounts/:id/mapping', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { bling_account_id, auto_invoice_enabled } = req.body || {};
  const sets = [];
  const params = [];
  if (bling_account_id !== undefined) {
    sets.push('bling_account_id = ?');
    params.push(bling_account_id === null || bling_account_id === '' ? null : parseInt(bling_account_id, 10));
  }
  if (auto_invoice_enabled !== undefined) {
    sets.push('auto_invoice_enabled = ?');
    params.push(auto_invoice_enabled ? 1 : 0);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  params.push(id);
  db.run(`UPDATE ml_accounts SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, params, function (e) {
    if (e) return res.status(500).json({ error: e.message });
    res.json({ success: true, changes: this.changes });
  });
});

app.delete('/api/ml/accounts/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.serialize(() => {
    db.run('DELETE FROM ml_stock_config WHERE ml_account_id = ?', [id]);
    db.run('DELETE FROM ml_items WHERE ml_account_id = ?', [id]);
    db.run('DELETE FROM api_tokens WHERE provider = ? AND account_id = ?', ['mercado_livre', id]);
    db.run('DELETE FROM ml_accounts WHERE id = ?', [id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, deleted: this.changes });
    });
  });
});

// Configurações fiscais da conta ML. A alíquota se aplica sobre a receita
// bruta dos pedidos e é usada como `taxes_seller` no relatório de custos.
// Restrito a role=4 porque impacta cálculos financeiros sensíveis.
app.put('/api/ml/accounts/:id/tax-settings', authenticateToken, requireRoleAtLeast(4), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const raw = req.body.tax_pct;
  const value = (raw === '' || raw == null || Number.isNaN(Number(raw))) ? null : Number(raw);
  if (value != null && (value < 0 || value > 100)) {
    return res.status(400).json({ error: 'tax_pct deve ser um percentual entre 0 e 100' });
  }
  db.run('UPDATE ml_accounts SET tax_pct = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [value, id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    if (!this.changes) return res.status(404).json({ error: 'Conta não encontrada' });
    res.json({ success: true, tax_pct: value });
  });
});

// ─── ML OAuth ───
app.get('/api/ml/auth', async (req, res) => {
  const accountId = parseInt(req.query.accountId, 10) || 1;
  const creds = await getMLCredentials(accountId);
  if (!creds) return res.status(400).json({ error: 'Credenciais ML não configuradas' });
  const state = `${accountId}:${Math.random().toString(36).substring(7)}`;
  // scope=offline_access é obrigatório para obter refresh_token e renovar tokens automaticamente
  const scope = 'offline_access read write';
  const url = `${ML_AUTH_URL}?response_type=code&client_id=${creds.clientId}&redirect_uri=${encodeURIComponent(creds.redirectUri)}&scope=${encodeURIComponent(scope)}&state=${encodeURIComponent(state)}`;
  res.json({ url, state, accountId });
});

app.get('/api/ml/callback', async (req, res) => {
  const { code, error: authError, state } = req.query;
  if (authError) return res.status(400).send('Erro na autorização ML: ' + authError);
  if (!code) return res.status(400).send('Código de autorização não recebido.');
  let accountId = 1;
  if (state && state.includes(':')) accountId = parseInt(state.split(':')[0], 10) || 1;
  try {
    const creds = await getMLCredentials(accountId);
    if (!creds) return res.status(400).send('Credenciais ML não configuradas.');
    const resp = await axios.post(ML_TOKEN_URL, qs.stringify({
      grant_type: 'authorization_code',
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      code,
      redirect_uri: creds.redirectUri
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const tokenPayload = { ...resp.data, created_at: new Date().toISOString() };
    if (!tokenPayload.refresh_token) {
      console.warn(`[ML] Callback conta ${accountId}: API não retornou refresh_token. Reautorize com scope offline_access. Resposta:`, JSON.stringify({ ...resp.data, refresh_token: '(omitido)' }));
    }
    await saveMLToken(tokenPayload, accountId);
    if (resp.data.user_id) {
      db.run('UPDATE ml_accounts SET ml_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [String(resp.data.user_id), accountId]);
    }
    res.send('<h2>Mercado Livre conectado com sucesso! Pode fechar esta janela.</h2>');
  } catch (err) {
    console.error('[ML] Callback error:', err.response?.data || err.message);
    res.status(500).send('Erro ao autorizar com Mercado Livre.');
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Webhook do Mercado Livre (quase tempo real para pedidos)
// ──────────────────────────────────────────────────────────────────────────────
// ML publica notificações para topics inscritos no App (orders_v2, shipments,
// claims, messages, items…). Aqui só roteamos os topics relevantes para
// pedidos e reaproveitamos fetchMlOrderFull + applyFreshOrderToDb, que já
// cuidam de INSERT/UPDATE, history, hash, hidratação e recálculo de custos
// em background. O resultado é que um pedido novo (ou um update de status,
// pagamento, envio) chega no DB em segundos — sem esperar o cron delta.
//
// Segurança: ML não assina as requisições. O defense-in-depth é (a) só aceitar
// topics na whitelist e (b) só processar se user_id bate com algum ml_account
// conectado (qualquer outro valor é ignorado). Um atacante que adivinhar esses
// dados só consegue nos forçar a re-sincronizar pedidos legítimos da própria
// conta — inócuo.

// Dedup em memória: coalesce notificações repetidas do mesmo pedido enquanto
// uma sync já está rodando. ML reenvia a mesma notif várias vezes durante
// alguns minutos se não der 200 OK rápido o suficiente.
const mlWebhookInFlight = new Map(); // key: `${accountId}:${orderId}` → Promise

async function resolveAccountIdFromMlUserId(userId) {
  if (!userId) return null;
  return await new Promise((rs) => db.get(
    'SELECT id FROM ml_accounts WHERE ml_user_id = ? LIMIT 1',
    [String(userId)], (e, r) => rs(r ? r.id : null)
  ));
}

async function syncSingleMlOrder(accountId, orderId, { reason = 'ml_webhook' } = {}) {
  if (!accountId || !orderId) return;
  const key = `${accountId}:${orderId}`;
  if (mlWebhookInFlight.has(key)) return mlWebhookInFlight.get(key);
  const task = (async () => {
    try {
      let row = await new Promise((rs) => db.get(
        'SELECT * FROM marketplace_orders WHERE marketplace = ? AND marketplace_order_id = ? AND account_id = ?',
        ['ml', String(orderId), accountId], (e, r) => rs(r || null)
      ));
      if (!row) {
        // Insere shell mínimo; applyFreshOrderToDb preenche o resto logo em seguida.
        await new Promise((rs, rj) => db.run(
          `INSERT OR IGNORE INTO marketplace_orders (marketplace, marketplace_order_id, account_id, status, order_date, synced_at)
           VALUES ('ml', ?, ?, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [String(orderId), accountId], (e) => e ? rj(e) : rs()
        ));
        row = await new Promise((rs) => db.get(
          'SELECT * FROM marketplace_orders WHERE marketplace = ? AND marketplace_order_id = ? AND account_id = ?',
          ['ml', String(orderId), accountId], (e, r) => rs(r || null)
        ));
      }
      if (!row) {
        console.warn(`[MlWebhook] falha inserindo shell para pedido ${orderId} (account ${accountId})`);
        return;
      }
      const fresh = await fetchMlOrderFull(row);
      await applyFreshOrderToDb(row, fresh, reason);
      console.log(`[MlWebhook] pedido ${orderId} sincronizado (account ${accountId}, reason=${reason})`);
    } catch (e) {
      if (e && e.notFound) {
        console.warn(`[MlWebhook] pedido ${orderId} não existe mais no ML (account ${accountId})`);
      } else {
        console.error(`[MlWebhook] erro sincronizando pedido ${orderId} (account ${accountId}):`, e?.response?.data?.message || e.message);
      }
    } finally {
      mlWebhookInFlight.delete(key);
    }
  })();
  mlWebhookInFlight.set(key, task);
  return task;
}

async function syncOrderFromMlShipment(accountId, shipmentId) {
  if (!accountId || !shipmentId) return;
  try {
    const ship = await mlApiGet(`/shipments/${shipmentId}`, accountId);
    // order_id costuma vir direto, mas alguns endpoints devolvem o array orders[].
    let orderId = ship?.order_id || null;
    if (!orderId && Array.isArray(ship?.orders) && ship.orders[0]?.id) {
      orderId = ship.orders[0].id;
    }
    if (orderId) {
      await syncSingleMlOrder(accountId, String(orderId), { reason: 'ml_webhook_shipment' });
    } else {
      console.warn(`[MlWebhook] shipment ${shipmentId} sem order_id (account ${accountId})`);
    }
  } catch (e) {
    const status = e?.response?.status;
    if (status === 404 || status === 410) return; // shipment sumiu — ignorar
    console.warn(`[MlWebhook] erro resolvendo shipment ${shipmentId}:`, e?.response?.data?.message || e.message);
  }
}

async function processMlNotification({ topic, resource, user_id }) {
  if (!topic || !resource) return;
  const accountId = await resolveAccountIdFromMlUserId(user_id);
  if (!accountId) {
    console.warn(`[MlWebhook] ignorando notificação com user_id desconhecido: ${user_id} (topic=${topic})`);
    return;
  }
  const res = String(resource);
  if (topic === 'orders_v2' || topic === 'orders') {
    const m = /\/orders\/([^/?#]+)/.exec(res);
    if (m) await syncSingleMlOrder(accountId, m[1], { reason: 'ml_webhook_order' });
    return;
  }
  if (topic === 'shipments') {
    const m = /\/shipments\/([^/?#]+)/.exec(res);
    if (m) await syncOrderFromMlShipment(accountId, m[1]);
    return;
  }
  // Outros topics (items, claims, messages, post_purchase, etc.) ficam fora
  // de escopo deste webhook — tratados pelos fluxos próprios ou pelo cron.
}

app.post('/api/ml/callback', async (req, res) => {
  const { topic, resource, user_id, application_id } = req.body || {};
  // ML exige resposta 200 em <500ms, senão reenfileira e spamma a fila.
  // Responder imediatamente e processar em background.
  res.status(200).json({ ok: true });
  if (process.env.ML_WEBHOOK_ENABLED === '0') return;
  try {
    console.log(`[MlWebhook] recebido: topic=${topic} resource=${resource} user_id=${user_id} app=${application_id || '-'}`);
    setImmediate(() => {
      processMlNotification({ topic, resource, user_id }).catch((err) => {
        console.error('[MlWebhook] erro processando notificação:', err?.message || err);
      });
    });
  } catch (e) {
    console.error('[MlWebhook] erro inesperado:', e.message);
  }
});

app.get('/api/ml/status', async (req, res) => {
  const accountId = parseInt(req.query.accountId, 10) || 1;
  try {
    const token = await refreshMLTokenIfNeeded(accountId);
    if (!token || !token.access_token) {
      const rawToken = await loadMLToken(accountId);
      const reason = !rawToken ? 'no_token' : !rawToken.refresh_token ? 'no_refresh_token' : 'refresh_failed';
      return res.json({ accountId, connected: false, reason });
    }
    const user = await mlApiGet('/users/me', accountId);
    res.json({ accountId, connected: true, nickname: user.nickname, ml_user_id: user.id, site_id: user.site_id });
  } catch (err) {
    console.error(`[ML] Status check failed for account ${accountId}:`, err.response?.data || err.message);
    res.json({ accountId, connected: false, reason: 'api_error', error: err.response?.data?.message || err.message });
  }
});

app.delete('/api/ml/tokens/revoke', (req, res) => {
  const accountId = parseInt(req.query.accountId, 10) || 1;
  db.run('DELETE FROM api_tokens WHERE provider = ? AND account_id = ?', ['mercado_livre', accountId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, removed: this.changes });
  });
});

// ─── ML Items Sync ───
app.post('/api/ml/items/sync', async (req, res) => {
  const accountId = parseInt(req.query.accountId || req.body.accountId, 10) || 1;
  try {
    const creds = await getMLCredentials(accountId);
    if (!creds || !creds.mlUserId) {
      const token = await refreshMLTokenIfNeeded(accountId);
      if (!token) return res.status(400).json({ error: 'Não conectado ao ML' });
      const me = await mlApiGet('/users/me', accountId);
      db.run('UPDATE ml_accounts SET ml_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [String(me.id), accountId]);
      creds.mlUserId = String(me.id);
    }
    let allItemIds = [];
    let scrollId = null;
    let hasMore = true;
    const firstPage = await mlApiGet(`/users/${creds.mlUserId}/items/search?search_type=scan&limit=100`, accountId);
    allItemIds = allItemIds.concat(firstPage.results || []);
    scrollId = firstPage.scroll_id;
    while (scrollId && hasMore) {
      try {
        const page = await mlApiGet(`/users/${creds.mlUserId}/items/search?search_type=scan&scroll_id=${scrollId}&limit=100`, accountId);
        if (!page.results || page.results.length === 0) { hasMore = false; break; }
        allItemIds = allItemIds.concat(page.results);
        scrollId = page.scroll_id;
      } catch { hasMore = false; }
    }
    let synced = 0;
    const batchSize = 20;
    for (let i = 0; i < allItemIds.length; i += batchSize) {
      const batch = allItemIds.slice(i, i + batchSize);
      const ids = batch.join(',');
      try {
        const items = await mlApiGet(`/items?ids=${ids}&include_attributes=all`, accountId);

        const salePrices = {};
        const spPromises = batch.map(async (itemId) => {
          try {
            const sp = await mlApiGet(`/items/${itemId}/sale_price`, accountId);
            if (sp && sp.amount != null) salePrices[itemId] = sp;
          } catch {}
        });
        await Promise.all(spPromises);

        for (const wrapper of (items || [])) {
          const item = wrapper.body || wrapper;
          if (!item || !item.id) continue;

          const sp = salePrices[item.id];
          let finalPrice = item.price;
          let finalOriginalPrice = item.original_price || null;
          if (sp) {
            finalPrice = sp.amount;
            if (sp.regular_amount && sp.regular_amount > sp.amount) {
              finalOriginalPrice = sp.regular_amount;
            }
          }

          let sku = null;
          if (item.variations && item.variations.length > 0) {
            for (const v of item.variations) {
              if (v.attributes) {
                const skuAttr = v.attributes.find(a => a.id === 'SELLER_SKU');
                if (skuAttr && skuAttr.value_name) { sku = skuAttr.value_name; break; }
              }
              if (!sku && v.seller_custom_field) { sku = v.seller_custom_field; break; }
            }
          }
          if (!sku && item.attributes) {
            const itemSkuAttr = item.attributes.find(a => a.id === 'SELLER_SKU');
            if (itemSkuAttr && itemSkuAttr.value_name) sku = itemSkuAttr.value_name;
          }
          if (!sku) sku = item.seller_custom_field || null;
          const catalogId = item.catalog_product_id || null;
          const listingType = item.listing_type_id || null;
          const isCatalog = Array.isArray(item.tags) && item.tags.includes('catalog_listing') ? 1 : 0;

          let variationCount = 0;
          let variationTypes = '';
          if (item.variations && item.variations.length > 0) {
            variationCount = item.variations.length;
            const attrMap = {};
            for (const v of item.variations) {
              if (v.attribute_combinations) {
                for (const ac of v.attribute_combinations) {
                  const key = ac.name || ac.id;
                  if (!attrMap[key]) attrMap[key] = new Set();
                  if (ac.value_name) attrMap[key].add(ac.value_name);
                }
              }
            }
            variationTypes = Object.entries(attrMap).map(([k, vals]) => `${k}: ${[...vals].join(', ')}`).join(' | ');
          }

          db.run(`INSERT OR REPLACE INTO ml_items (id, ml_item_id, ml_account_id, title, sku, price, original_price, permalink, status, ml_available_quantity, thumbnail, catalog_product_id, listing_type_id, is_catalog_listing, variation_count, variation_types, last_synced_at, created_at)
                  VALUES ((SELECT id FROM ml_items WHERE ml_item_id = ? AND ml_account_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, COALESCE((SELECT created_at FROM ml_items WHERE ml_item_id = ? AND ml_account_id = ?), CURRENT_TIMESTAMP))`,
            [item.id, accountId, item.id, accountId, item.title, sku, finalPrice, finalOriginalPrice, item.permalink, item.status, item.available_quantity || 0, item.thumbnail || null, catalogId, listingType, isCatalog, variationCount, variationTypes, item.id, accountId]);

          if (item.variations && item.variations.length > 0) {
            for (const v of item.variations) {
              let vSku = null;
              if (v.attributes) {
                const skuA = v.attributes.find(a => a.id === 'SELLER_SKU');
                if (skuA && skuA.value_name) vSku = skuA.value_name;
              }
              if (!vSku) vSku = v.seller_custom_field || null;
              const combos = JSON.stringify(v.attribute_combinations || []);
              const picIds = JSON.stringify(v.picture_ids || []);
              const vThumb = v.picture_ids && v.picture_ids[0] && item.pictures
                ? (item.pictures.find(p => p.id === v.picture_ids[0]) || {}).secure_url || null
                : null;
              db.run(`INSERT OR REPLACE INTO ml_item_variations (id, ml_item_id, ml_account_id, variation_id, sku, price, available_quantity, sold_quantity, attribute_combinations, picture_ids, thumbnail, catalog_product_id)
                      VALUES ((SELECT id FROM ml_item_variations WHERE ml_item_id = ? AND ml_account_id = ? AND variation_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [item.id, accountId, String(v.id), item.id, accountId, String(v.id), vSku, v.price || item.price, v.available_quantity || 0, v.sold_quantity || 0, combos, picIds, vThumb, v.catalog_product_id || null]);
            }
          }
          synced++;
        }
      } catch (batchErr) { console.error('[ML] Batch fetch error:', batchErr.message); }
    }

    // Remove local items that no longer exist on ML
    let removedItems = 0;
    try {
      const activeItemIds = new Set(allItemIds);
      const localItems = await new Promise((resolve, reject) => {
        db.all(`SELECT id, ml_item_id FROM ml_items WHERE ml_account_id = ?`, [accountId], (e, r) => e ? reject(e) : resolve(r || []));
      });
      for (const local of localItems) {
        if (!activeItemIds.has(local.ml_item_id)) {
          db.run('DELETE FROM ml_item_variations WHERE ml_item_id = ? AND ml_account_id = ?', [local.ml_item_id, accountId]);
          db.run('DELETE FROM ml_stock_config WHERE ml_item_id = ? AND ml_account_id = ?', [local.ml_item_id, accountId]);
          db.run('DELETE FROM ml_variation_stock_config WHERE ml_item_id = ? AND ml_account_id = ?', [local.ml_item_id, accountId]);
          db.run('DELETE FROM ml_items WHERE id = ?', [local.id]);
          removedItems++;
        }
      }
      if (removedItems > 0) console.log(`[ML Sync] ${removedItems} itens locais removidos (não existem mais no ML)`);
    } catch (rmErr) { console.error('[ML Sync] Error removing stale items:', rmErr.message); }

    // Verify ad model publications: mark as 'removed' if the item no longer exists on ML
    let removedPubs = 0;
    try {
      const pubs = await new Promise((resolve, reject) => {
        db.all(`SELECT id, published_item_id FROM ad_model_publications WHERE account_id = ? AND status = 'published' AND published_item_id IS NOT NULL`, [accountId], (e, r) => e ? reject(e) : resolve(r || []));
      });
      if (pubs.length > 0) {
        const activeItemIds = new Set(allItemIds);
        for (const pub of pubs) {
          if (!activeItemIds.has(pub.published_item_id)) {
            db.run(`UPDATE ad_model_publications SET status = 'removed', error_message = 'Anúncio não encontrado na conta ML' WHERE id = ?`, [pub.id]);
            removedPubs++;
          }
        }
        if (removedPubs > 0) console.log(`[ML Sync] ${removedPubs} publicações de modelos marcadas como removidas (anúncios não encontrados)`);
      }
    } catch (pubErr) { console.error('[ML Sync] Error checking ad model publications:', pubErr.message); }

    res.json({ success: true, total: allItemIds.length, synced, removed: removedItems, removedPublications: removedPubs });
  } catch (err) {
    console.error('[ML] Sync error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Erro ao sincronizar anúncios', details: err.message });
  }
});

app.get('/api/ml/items', (req, res) => {
  const accountId = req.query.accountId ? parseInt(req.query.accountId, 10) : null;
  const search = req.query.search || '';
  let sql = 'SELECT i.*, a.name as account_name, sc.id as config_id, sc.inventory_id, sc.use_real_stock, sc.fictitious_min, sc.fictitious_max, sc.fictitious_value, sc.enabled, sc.last_pushed_at, inv.sku as linked_sku, inv.quantity as real_quantity FROM ml_items i LEFT JOIN ml_accounts a ON a.id = i.ml_account_id LEFT JOIN ml_stock_config sc ON sc.ml_item_id = i.ml_item_id AND sc.ml_account_id = i.ml_account_id LEFT JOIN inventory inv ON inv.id = sc.inventory_id';
  const params = [];
  const conditions = [];
  if (accountId) {
    conditions.push('i.ml_account_id = ?');
    params.push(accountId);
  }
  if (search) {
    conditions.push('(i.title LIKE ? OR i.ml_item_id LIKE ? OR i.sku LIKE ?)');
    const s = `%${search}%`;
    params.push(s, s, s);
  }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY i.title ASC';
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const items = rows || [];
    const mlItemIds = items.filter(i => i.variation_count > 0).map(i => `'${i.ml_item_id}'`);
    if (mlItemIds.length === 0) return res.json(items);
    db.all(`SELECT v.*, vc.id as var_config_id, vc.inventory_id as var_inventory_id, vc.use_real_stock as var_use_real_stock, vc.fictitious_min as var_fict_min, vc.fictitious_max as var_fict_max, vc.fictitious_value as var_fict_value, vc.enabled as var_enabled, vc.last_pushed_at as var_last_pushed_at, inv.sku as var_linked_sku, inv.quantity as var_real_quantity
            FROM ml_item_variations v
            LEFT JOIN ml_variation_stock_config vc ON vc.ml_item_id = v.ml_item_id AND vc.ml_account_id = v.ml_account_id AND vc.variation_id = v.variation_id
            LEFT JOIN inventory inv ON inv.id = vc.inventory_id
            WHERE v.ml_item_id IN (${mlItemIds.join(',')})`, (err2, vars) => {
      if (err2 || !vars) return res.json(items);
      const varMap = {};
      for (const v of vars) {
        const key = `${v.ml_item_id}_${v.ml_account_id}`;
        if (!varMap[key]) varMap[key] = [];
        varMap[key].push(v);
      }
      for (const item of items) {
        const key = `${item.ml_item_id}_${item.ml_account_id}`;
        item.variations = varMap[key] || [];
      }
      res.json(items);
    });
  });
});

app.get('/api/ml/items/:mlItemId/variations', (req, res) => {
  const { mlItemId } = req.params;
  const accountId = req.query.accountId ? parseInt(req.query.accountId, 10) : null;
  let sql = 'SELECT * FROM ml_item_variations WHERE ml_item_id = ?';
  const params = [mlItemId];
  if (accountId) { sql += ' AND ml_account_id = ?'; params.push(accountId); }
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

// ─── ML Stock Config ───
app.get('/api/ml/stock-config', (req, res) => {
  const accountId = parseInt(req.query.accountId, 10) || 1;
  db.all(`SELECT sc.*, i.title as ml_title, i.ml_item_id, i.status as ml_status, i.ml_available_quantity, inv.sku, inv.title as inv_title, inv.quantity as real_quantity
          FROM ml_stock_config sc
          JOIN ml_items i ON i.ml_item_id = sc.ml_item_id AND i.ml_account_id = sc.ml_account_id
          JOIN inventory inv ON inv.id = sc.inventory_id
          WHERE sc.ml_account_id = ? ORDER BY inv.sku`, [accountId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.post('/api/ml/stock-config/link', (req, res) => {
  const { inventory_id, ml_account_id, ml_item_id } = req.body;
  if (!inventory_id || !ml_account_id || !ml_item_id) return res.status(400).json({ error: 'Campos obrigatórios faltando' });
  db.run(`INSERT OR REPLACE INTO ml_stock_config (id, inventory_id, ml_account_id, ml_item_id, use_real_stock, fictitious_min, fictitious_max, enabled, created_at, updated_at)
          VALUES ((SELECT id FROM ml_stock_config WHERE inventory_id = ? AND ml_item_id = ?), ?, ?, ?, 0, 450, 499, 1, COALESCE((SELECT created_at FROM ml_stock_config WHERE inventory_id = ? AND ml_item_id = ?), CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)`,
    [inventory_id, ml_item_id, inventory_id, ml_account_id, ml_item_id, inventory_id, ml_item_id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: this.lastID });
    });
});

app.delete('/api/ml/stock-config/:id', (req, res) => {
  db.run('DELETE FROM ml_stock_config WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// C2 — validação da faixa fictícia (min, max). Antes aceitava qualquer valor
// (inclusive min > max), o que quebrava `computeMarketplaceStock`. Também grava
// auditoria quando toggles/faixa mudam.
function validateFictitiousRange(min, max) {
  const a = Number(min);
  const b = Number(max);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 'fictitious_min/max devem ser números';
  if (a < 0 || b < 0) return 'fictitious_min/max não podem ser negativos';
  if (a > b) return 'fictitious_min não pode ser maior que fictitious_max';
  if (b > 100000) return 'fictitious_max muito alto (>100.000)';
  return null;
}

app.put('/api/ml/stock-config/:id', (req, res) => {
  const { use_real_stock, fictitious_min, fictitious_max, enabled } = req.body;
  const err = validateFictitiousRange(fictitious_min ?? 450, fictitious_max ?? 499);
  if (err) return res.status(400).json({ error: err });
  db.get('SELECT inventory_id, ml_account_id, use_real_stock, fictitious_min, fictitious_max, enabled FROM ml_stock_config WHERE id = ?', [req.params.id], (gerr, prev) => {
    db.run(`UPDATE ml_stock_config SET use_real_stock = ?, fictitious_min = ?, fictitious_max = ?, fictitious_value = CASE WHEN ? <> COALESCE(fictitious_min, -1) OR ? <> COALESCE(fictitious_max, -1) THEN NULL ELSE fictitious_value END, enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [use_real_stock ? 1 : 0, fictitious_min || 450, fictitious_max || 499, fictitious_min || 450, fictitious_max || 499, enabled !== undefined ? (enabled ? 1 : 0) : 1, req.params.id], function(upErr) {
        if (upErr) return res.status(500).json({ error: upErr.message });
        if (prev) {
          auditStockSafe('config_update', {
            inventory_id: prev.inventory_id,
            target_marketplace: 'ml',
            target_account: prev.ml_account_id,
            before: JSON.stringify({ use_real_stock: prev.use_real_stock, min: prev.fictitious_min, max: prev.fictitious_max, enabled: prev.enabled }),
            after: JSON.stringify({ use_real_stock: use_real_stock ? 1 : 0, min: fictitious_min || 450, max: fictitious_max || 499, enabled: enabled ? 1 : 0 }),
            meta: { config_id: Number(req.params.id) }
          }, req);
        }
        res.json({ success: true });
      });
  });
});

// Aplica uma mesma faixa fictícia em múltiplos configs ML (por lista de ids ou
// por ml_account_id). Usado pelo modal "Ajustar faixa em massa" do grid.
app.post('/api/ml/stock-config/bulk-range', (req, res) => {
  const { config_ids, account_id, fictitious_min, fictitious_max, use_real_stock } = req.body || {};
  const err = validateFictitiousRange(fictitious_min, fictitious_max);
  if (err) return res.status(400).json({ error: err });
  const ids = Array.isArray(config_ids) ? config_ids.map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n) && n > 0) : [];
  if (!ids.length && !account_id) return res.status(400).json({ error: 'Informe config_ids ou account_id' });
  const extraSet = use_real_stock !== undefined ? `, use_real_stock = ${use_real_stock ? 1 : 0}` : '';
  const whereSql = ids.length ? `WHERE id IN (${ids.map(() => '?').join(',')})` : 'WHERE ml_account_id = ?';
  const params = ids.length ? ids : [parseInt(account_id, 10)];
  db.run(`UPDATE ml_stock_config SET fictitious_min = ?, fictitious_max = ?, fictitious_value = NULL, updated_at = CURRENT_TIMESTAMP${extraSet} ${whereSql}`,
    [Number(fictitious_min), Number(fictitious_max), ...params], function(uErr) {
      if (uErr) return res.status(500).json({ error: uErr.message });
      auditStockSafe('config_bulk_range', { target_marketplace: 'ml', meta: { ids, account_id, min: fictitious_min, max: fictitious_max } }, req);
      res.json({ success: true, updated: this.changes });
    });
});

// ─── ML Stock Push Logic ───
// Decide qual quantidade empurrar para o marketplace. Comportamento:
// 1. Se o real é zero, zera no canal (evita vender sem estoque).
// 2. Se `use_real_stock` está ligado, empurra o real.
// 3. Se já existe um `fictitious_value` dentro da faixa, reutiliza (estabilidade
//    entre pushes — útil para não ficar trocando número a cada sync).
// 4. Caso contrário, gera um valor determinístico dentro da faixa (ponto médio)
//    a menos que a config tenha `random_enabled = 1`, aí usa o comportamento
//    antigo (aleatório). O default determinístico evita valores diferentes em
//    pushes consecutivos do mesmo item, facilitando auditoria e suporte.
function computeMarketplaceStock(realQty, config) {
  if (realQty <= 0) return 0;
  if (config.use_real_stock) return realQty;
  const min = Number(config.fictitious_min);
  const max = Number(config.fictitious_max);
  const current = Number(config.fictitious_value);
  if (Number.isFinite(current) && current >= min && current <= max) {
    return current;
  }
  if (config.random_enabled) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
  return Math.floor((min + max) / 2);
}

// Helper: resolve o estoque que será efetivamente enviado para um config.
// Usa `resolveRealAvailable` (kits + pedidos abertos) e depois aplica a faixa
// fictícia conforme configurado. Async porque depende de consultas.
async function computeMarketplaceStockForConfig(config) {
  const real = await resolveRealAvailable(config.inventory_id);
  return computeMarketplaceStock(real, config);
}

// Atualiza/limpa telemetria de erro em *_stock_config. Unifica a gravação de
// `last_error_message` / `last_error_at` entre push unitário e push-all (antes
// só o push-all gravava — badge "Erro" no grid ficava inconsistente).
function markPushError(table, id, err) {
  const msg = describeErrorSafe(err);
  db.run(`UPDATE ${table} SET last_error_message = ?, last_error_at = CURRENT_TIMESTAMP WHERE id = ?`, [msg, id], (e) => {
    if (e) console.warn(`[Stock] falha ao gravar erro em ${table}#${id}:`, e.message);
  });
}
function clearPushError(table, id) {
  db.run(`UPDATE ${table} SET last_error_message = NULL, last_error_at = NULL WHERE id = ?`, [id], (e) => {
    if (e) console.warn(`[Stock] falha ao limpar erro em ${table}#${id}:`, e.message);
  });
}
// `describeError` é definido mais abaixo no arquivo; usamos um proxy seguro
// para evitar problemas caso essa função seja chamada antes do hoisting nos
// helpers acima (são function declarations também, então tudo bem, mas usar um
// try/catch aqui protege de mensagens de erro exóticas de libs externas).
function describeErrorSafe(e) {
  try { return describeError(e); } catch { return String(e && e.message ? e.message : e).slice(0, 300); }
}

// Auditoria de estoque. Implementada de fato em D4 (tabela stock_audit_log).
// Aqui exposta como wrapper seguro para ser chamada em todos os pontos de
// push/toggle sem acoplar os callers à tabela. A implementação real fica em
// `_auditStockInsert` (definida abaixo, junto com a migração).
// D4 — insert real na tabela stock_audit_log. Mantida isolada para não
// quebrar o fluxo em caso de erro (fault-tolerant — ver wrapper abaixo).
function _auditStockInsert(entry) {
  db.run(`INSERT INTO stock_audit_log
            (action, user_id, inventory_id, target_marketplace, target_account, before_value, after_value, meta)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [entry.action, entry.user_id, entry.inventory_id, entry.target_marketplace, entry.target_account, entry.before_value, entry.after_value, entry.meta],
    (err) => { if (err) console.warn('[Audit] falha ao registrar:', err.message); });
}

function auditStockSafe(action, data, req) {
  if (typeof _auditStockInsert !== 'function') return;
  try {
    _auditStockInsert({
      action,
      user_id: req?.user?.id || null,
      inventory_id: data?.inventory_id || null,
      target_marketplace: data?.target_marketplace || null,
      target_account: data?.target_account || null,
      before_value: data?.before != null ? String(data.before) : null,
      after_value: data?.after != null ? String(data.after) : null,
      meta: data?.meta ? JSON.stringify(data.meta) : null,
    });
  } catch (e) {
    // auditoria nunca deve quebrar o fluxo principal
  }
}

// B1 + B2 — Resolução do saldo "real" que vai para o canal.
//
// - `is_composite = 1`: o SKU é um kit e não tem saldo próprio; quantidade
//   disponível = MIN(componente.quantity / receita). Cai para 0 se qualquer
//   componente está zerado. Sem componentes cadastrados → 0 (nada a enviar).
// - Pedidos em aberto (paid/confirmado, ainda não despachados) são descontados
//   para reduzir o risco de oversell quando o marketplace demorar para refletir
//   a baixa via webhook/sync.
async function resolveRealAvailable(inventoryId) {
  if (!inventoryId) return 0;
  const inv = await new Promise((resolve) =>
    db.get('SELECT id, quantity, is_composite FROM inventory WHERE id = ?', [inventoryId], (e, r) => resolve(r || null))
  );
  if (!inv) return 0;
  let base;
  if (inv.is_composite) {
    const comps = await new Promise((resolve) =>
      db.all(`SELECT cs.quantity AS receita, inv_c.quantity AS componente_qty
              FROM composite_skus cs
              JOIN inventory inv_c ON inv_c.id = cs.component_sku_id
              WHERE cs.main_sku_id = ? AND cs.quantity > 0`, [inventoryId], (e, r) => resolve(r || []))
    );
    if (comps.length === 0) base = 0;
    else base = comps.reduce((min, c) => {
      const possivel = Math.floor(Number(c.componente_qty || 0) / Number(c.receita || 1));
      return Math.min(min, possivel);
    }, Number.POSITIVE_INFINITY);
    if (!Number.isFinite(base)) base = 0;
  } else {
    base = Number(inv.quantity) || 0;
  }
  const openQty = await new Promise((resolve) =>
    db.get(`SELECT COALESCE(SUM(oi.quantity), 0) AS q
            FROM marketplace_order_items oi
            JOIN marketplace_orders o ON o.id = oi.order_id
            JOIN inventory inv ON inv.sku = oi.sku
            WHERE inv.id = ?
              AND o.status NOT IN ('cancelled','refunded')
              AND (o.shipping_status IS NULL OR o.shipping_status NOT IN ('shipped','delivered','in_transit','not_delivered','cancelled'))`,
      [inventoryId], (e, r) => resolve(r ? Number(r.q) : 0))
  );
  return Math.max(0, base - openQty);
}

// Serializa `pushStockForInventoryId` por inventoryId. Duas movimentações
// concorrentes no mesmo SKU poderiam disparar dois pushes paralelos e chegar
// no canal fora de ordem — o último a terminar (não o mais recente) venceria.
// O lock encadeia pushes do mesmo inventory_id em fila.
const _inventoryPushLocks = new Map();
async function pushStockForInventoryId(inventoryId) {
  if (!inventoryId) return;
  const prev = _inventoryPushLocks.get(inventoryId) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => _pushStockForInventoryIdInner(inventoryId));
  _inventoryPushLocks.set(inventoryId, next);
  try {
    await next;
  } finally {
    if (_inventoryPushLocks.get(inventoryId) === next) _inventoryPushLocks.delete(inventoryId);
  }
}

async function _pushStockForInventoryIdInner(inventoryId) {
  // Push to Mercado Livre
  await new Promise((resolve) => {
    db.all(`SELECT sc.*, inv.quantity as real_quantity FROM ml_stock_config sc JOIN inventory inv ON inv.id = sc.inventory_id WHERE sc.inventory_id = ? AND sc.enabled = 1`, [inventoryId], async (err, configs) => {
      if (err || !configs || configs.length === 0) return resolve();
      for (const config of configs) {
        try {
          const qty = await computeMarketplaceStockForConfig(config);
          await mlApiPut(`/items/${config.ml_item_id}`, { available_quantity: qty }, config.ml_account_id);
          db.run('UPDATE ml_stock_config SET fictitious_value = ?, last_pushed_at = CURRENT_TIMESTAMP, last_error_message = NULL, last_error_at = NULL WHERE id = ?', [qty, config.id]);
          db.run('UPDATE ml_items SET ml_available_quantity = ?, last_synced_at = CURRENT_TIMESTAMP WHERE ml_item_id = ? AND ml_account_id = ?', [qty, config.ml_item_id, config.ml_account_id]);
          auditStockSafe('push_auto', { inventory_id: inventoryId, target_marketplace: 'ml', target_account: config.ml_account_id, after: qty, meta: { ml_item_id: config.ml_item_id, config_id: config.id } });
          console.log(`[ML] Pushed stock for ${config.ml_item_id}: ${qty}`);
        } catch (e) {
          markPushError('ml_stock_config', config.id, e);
          console.error(`[ML] Push stock error for ${config.ml_item_id}:`, e.response?.data || e.message);
        }
      }
      resolve();
    });
  });
  // Push to ML Variations
  await new Promise((resolve) => {
    db.all(`SELECT vc.*, inv.quantity as real_quantity FROM ml_variation_stock_config vc JOIN inventory inv ON inv.id = vc.inventory_id WHERE vc.inventory_id = ? AND vc.enabled = 1`, [inventoryId], async (err, configs) => {
      if (err || !configs || configs.length === 0) return resolve();
      for (const config of configs) {
        try {
          const qty = await computeMarketplaceStockForConfig(config);
          await mlApiPut(`/items/${config.ml_item_id}/variations/${config.variation_id}`, { available_quantity: qty }, config.ml_account_id);
          db.run('UPDATE ml_variation_stock_config SET fictitious_value = ?, last_pushed_at = CURRENT_TIMESTAMP, last_error_message = NULL, last_error_at = NULL WHERE id = ?', [qty, config.id]);
          db.run('UPDATE ml_item_variations SET available_quantity = ? WHERE ml_item_id = ? AND ml_account_id = ? AND variation_id = ?', [qty, config.ml_item_id, config.ml_account_id, config.variation_id]);
          auditStockSafe('push_auto', { inventory_id: inventoryId, target_marketplace: 'ml', target_account: config.ml_account_id, after: qty, meta: { ml_item_id: config.ml_item_id, variation_id: config.variation_id, config_id: config.id } });
          console.log(`[ML] Pushed variation stock for ${config.ml_item_id}/${config.variation_id}: ${qty}`);
        } catch (e) {
          markPushError('ml_variation_stock_config', config.id, e);
          console.error(`[ML] Push variation stock error for ${config.ml_item_id}/${config.variation_id}:`, e.response?.data || e.message);
        }
      }
      resolve();
    });
  });
  // Push to Shopee
  await new Promise((resolve) => {
    db.all(`SELECT sc.*, inv.quantity as real_quantity FROM shopee_stock_config sc JOIN inventory inv ON inv.id = sc.inventory_id WHERE sc.inventory_id = ? AND sc.enabled = 1`, [inventoryId], async (err, configs) => {
      if (err || !configs || configs.length === 0) return resolve();
      for (const config of configs) {
        try {
          const qty = await computeMarketplaceStockForConfig(config);
          await shopeeApiPost('/api/v2/product/update_stock', {
            item_id: parseInt(config.shopee_item_id, 10),
            stock_list: [{ model_id: 0, seller_stock: [{ stock: qty }] }]
          }, config.shopee_account_id);
          db.run('UPDATE shopee_stock_config SET fictitious_value = ?, last_pushed_at = CURRENT_TIMESTAMP, last_error_message = NULL, last_error_at = NULL WHERE id = ?', [qty, config.id]);
          db.run('UPDATE shopee_items SET shopee_stock = ?, last_synced_at = CURRENT_TIMESTAMP WHERE shopee_item_id = ? AND shopee_account_id = ?', [qty, config.shopee_item_id, config.shopee_account_id]);
          auditStockSafe('push_auto', { inventory_id: inventoryId, target_marketplace: 'shopee', target_account: config.shopee_account_id, after: qty, meta: { shopee_item_id: config.shopee_item_id, config_id: config.id } });
          console.log(`[Shopee] Pushed stock for ${config.shopee_item_id}: ${qty}`);
        } catch (e) {
          markPushError('shopee_stock_config', config.id, e);
          console.error(`[Shopee] Push stock error for ${config.shopee_item_id}:`, e.response?.data || e.message);
        }
      }
      resolve();
    });
  });
  // Push to Shopee Variations
  await new Promise((resolve) => {
    db.all(`SELECT vsc.*, inv.quantity as real_quantity FROM shopee_variation_stock_config vsc JOIN inventory inv ON inv.id = vsc.inventory_id WHERE vsc.inventory_id = ? AND vsc.enabled = 1`, [inventoryId], async (err, configs) => {
      if (err || !configs || configs.length === 0) return resolve();
      for (const config of configs) {
        try {
          const qty = await computeMarketplaceStockForConfig(config);
          await shopeeApiPost('/api/v2/product/update_stock', {
            item_id: parseInt(config.shopee_item_id, 10),
            stock_list: [{ model_id: parseInt(config.model_id, 10), seller_stock: [{ stock: qty }] }]
          }, config.shopee_account_id);
          db.run('UPDATE shopee_variation_stock_config SET fictitious_value = ?, last_pushed_at = CURRENT_TIMESTAMP, last_error_message = NULL, last_error_at = NULL WHERE id = ?', [qty, config.id]);
          db.run('UPDATE shopee_item_models SET stock = ?, last_synced_at = CURRENT_TIMESTAMP WHERE shopee_item_id = ? AND shopee_account_id = ? AND model_id = ?', [qty, config.shopee_item_id, config.shopee_account_id, config.model_id]);
          auditStockSafe('push_auto', { inventory_id: inventoryId, target_marketplace: 'shopee', target_account: config.shopee_account_id, after: qty, meta: { shopee_item_id: config.shopee_item_id, model_id: config.model_id, config_id: config.id } });
        } catch (e) {
          markPushError('shopee_variation_stock_config', config.id, e);
          console.error(`[Shopee] Push variation stock error for ${config.shopee_item_id}/${config.model_id}:`, e.response?.data || e.message);
        }
      }
      resolve();
    });
  });
}

app.post('/api/ml/stock/push', async (req, res) => {
  const configId = parseInt(req.body.configId, 10);
  if (!configId) return res.status(400).json({ error: 'configId obrigatório' });
  db.get('SELECT sc.*, inv.quantity as real_quantity FROM ml_stock_config sc JOIN inventory inv ON inv.id = sc.inventory_id WHERE sc.id = ?', [configId], async (err, config) => {
    if (err || !config) return res.status(404).json({ error: 'Config não encontrada' });
    try {
      const qty = await computeMarketplaceStockForConfig(config);
      await mlApiPut(`/items/${config.ml_item_id}`, { available_quantity: qty }, config.ml_account_id);
      db.run('UPDATE ml_stock_config SET fictitious_value = ?, last_pushed_at = CURRENT_TIMESTAMP, last_error_message = NULL, last_error_at = NULL WHERE id = ?', [qty, config.id]);
      db.run('UPDATE ml_items SET ml_available_quantity = ?, last_synced_at = CURRENT_TIMESTAMP WHERE ml_item_id = ? AND ml_account_id = ?', [qty, config.ml_item_id, config.ml_account_id]);
      auditStockSafe('push_manual', { inventory_id: config.inventory_id, target_marketplace: 'ml', target_account: config.ml_account_id, after: qty, meta: { ml_item_id: config.ml_item_id, config_id: config.id } }, req);
      res.json({ success: true, ml_item_id: config.ml_item_id, pushed_quantity: qty });
    } catch (e) {
      markPushError('ml_stock_config', config.id, e);
      res.status(500).json({ error: 'Erro ao enviar estoque', details: e.response?.data || e.message });
    }
  });
});

// Utilitário — roda `worker(item)` sobre uma lista com concorrência limitada.
// Usado para acelerar push-all mantendo a pressão sobre a API dos marketplaces
// controlada (evita 429s).
async function mapWithConcurrency(list, concurrency, worker) {
  const out = { ok: 0, fail: 0 };
  let i = 0;
  const next = async () => {
    while (i < list.length) {
      const idx = i++;
      try { await worker(list[idx]); out.ok++; }
      catch { out.fail++; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, list.length)) }, next));
  return out;
}

const describeError = (e) => {
  const payload = e?.response?.data;
  if (typeof payload === 'string') return payload.slice(0, 300);
  if (payload?.message) return String(payload.message).slice(0, 300);
  if (payload?.error) return String(payload.error).slice(0, 300);
  return (e?.message || 'erro desconhecido').slice(0, 300);
};

app.post('/api/ml/stock/push-all', async (req, res) => {
  // A1: exigir accountId explícito. Antes caía em `|| 1` silenciosamente, o
  // que podia jogar estoque na conta errada se o front mandasse valor vazio
  // ou inválido após um refresh de contas.
  const rawAccountId = req.query.accountId ?? req.body.accountId;
  const accountId = parseInt(rawAccountId, 10);
  if (!Number.isFinite(accountId) || accountId <= 0) {
    console.warn('[ML push-all] accountId inválido:', rawAccountId);
    return res.status(400).json({ error: 'accountId obrigatório e válido' });
  }
  db.all(`SELECT sc.*, inv.quantity as real_quantity FROM ml_stock_config sc JOIN inventory inv ON inv.id = sc.inventory_id WHERE sc.ml_account_id = ? AND sc.enabled = 1`, [accountId], async (err, configs) => {
    if (err) return res.status(500).json({ error: err.message });
    configs = configs || [];
    const itemResult = await mapWithConcurrency(configs, 4, async (config) => {
      try {
        const qty = await computeMarketplaceStockForConfig(config);
        await mlApiPut(`/items/${config.ml_item_id}`, { available_quantity: qty }, config.ml_account_id);
        db.run('UPDATE ml_stock_config SET fictitious_value = ?, last_pushed_at = CURRENT_TIMESTAMP, last_error_message = NULL, last_error_at = NULL WHERE id = ?', [qty, config.id]);
        db.run('UPDATE ml_items SET ml_available_quantity = ?, last_synced_at = CURRENT_TIMESTAMP WHERE ml_item_id = ? AND ml_account_id = ?', [qty, config.ml_item_id, config.ml_account_id]);
        auditStockSafe('push_bulk', { inventory_id: config.inventory_id, target_marketplace: 'ml', target_account: config.ml_account_id, after: qty, meta: { ml_item_id: config.ml_item_id, config_id: config.id } }, req);
      } catch (e) {
        markPushError('ml_stock_config', config.id, e);
        throw e;
      }
    });
    const varConfigs = await new Promise((resolve) =>
      db.all(`SELECT vc.*, inv.quantity as real_quantity FROM ml_variation_stock_config vc JOIN inventory inv ON inv.id = vc.inventory_id WHERE vc.ml_account_id = ? AND vc.enabled = 1`, [accountId], (e, r) => resolve(e ? [] : (r || [])))
    );
    const varResult = await mapWithConcurrency(varConfigs, 4, async (vc) => {
      try {
        const qty = await computeMarketplaceStockForConfig(vc);
        await mlApiPut(`/items/${vc.ml_item_id}/variations/${vc.variation_id}`, { available_quantity: qty }, vc.ml_account_id);
        db.run('UPDATE ml_variation_stock_config SET fictitious_value = ?, last_pushed_at = CURRENT_TIMESTAMP, last_error_message = NULL, last_error_at = NULL WHERE id = ?', [qty, vc.id]);
        db.run('UPDATE ml_item_variations SET available_quantity = ? WHERE ml_item_id = ? AND ml_account_id = ? AND variation_id = ?', [qty, vc.ml_item_id, vc.ml_account_id, vc.variation_id]);
        auditStockSafe('push_bulk', { inventory_id: vc.inventory_id, target_marketplace: 'ml', target_account: vc.ml_account_id, after: qty, meta: { ml_item_id: vc.ml_item_id, variation_id: vc.variation_id, config_id: vc.id } }, req);
      } catch (e) {
        markPushError('ml_variation_stock_config', vc.id, e);
        throw e;
      }
    });
    res.json({
      success: true,
      pushed: itemResult.ok + varResult.ok,
      errors: itemResult.fail + varResult.fail,
      total: configs.length + varConfigs.length,
    });
  });
});

// ─── ML Variation Stock Config ───
app.post('/api/ml/variation-stock/link', (req, res) => {
  const { inventory_id, ml_account_id, ml_item_id, variation_id } = req.body;
  if (!inventory_id || !ml_account_id || !ml_item_id || !variation_id) return res.status(400).json({ error: 'Campos obrigatórios faltando' });
  db.run(`INSERT OR REPLACE INTO ml_variation_stock_config (id, inventory_id, ml_account_id, ml_item_id, variation_id, use_real_stock, fictitious_min, fictitious_max, enabled, created_at)
          VALUES ((SELECT id FROM ml_variation_stock_config WHERE inventory_id = ? AND ml_item_id = ? AND variation_id = ?), ?, ?, ?, ?, 0, 450, 499, 1, COALESCE((SELECT created_at FROM ml_variation_stock_config WHERE inventory_id = ? AND ml_item_id = ? AND variation_id = ?), CURRENT_TIMESTAMP))`,
    [inventory_id, ml_item_id, variation_id, inventory_id, ml_account_id, ml_item_id, variation_id, inventory_id, ml_item_id, variation_id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: this.lastID });
    });
});

app.delete('/api/ml/variation-stock/:id', (req, res) => {
  db.run('DELETE FROM ml_variation_stock_config WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.put('/api/ml/variation-stock/:id', (req, res) => {
  const { use_real_stock, fictitious_min, fictitious_max, enabled } = req.body;
  db.run(`UPDATE ml_variation_stock_config SET use_real_stock = ?, fictitious_min = ?, fictitious_max = ?, enabled = ?, created_at = COALESCE(created_at, CURRENT_TIMESTAMP) WHERE id = ?`,
    [use_real_stock ? 1 : 0, fictitious_min || 450, fictitious_max || 499, enabled !== undefined ? (enabled ? 1 : 0) : 1, req.params.id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
});

app.post('/api/ml/variation-stock/push', async (req, res) => {
  const configId = parseInt(req.body.configId, 10);
  if (!configId) return res.status(400).json({ error: 'configId obrigatório' });
  db.get('SELECT vc.*, inv.quantity as real_quantity FROM ml_variation_stock_config vc JOIN inventory inv ON inv.id = vc.inventory_id WHERE vc.id = ?', [configId], async (err, config) => {
    if (err || !config) return res.status(404).json({ error: 'Config não encontrada' });
    try {
      const qty = await computeMarketplaceStockForConfig(config);
      await mlApiPut(`/items/${config.ml_item_id}/variations/${config.variation_id}`, { available_quantity: qty }, config.ml_account_id);
      db.run('UPDATE ml_variation_stock_config SET fictitious_value = ?, last_pushed_at = CURRENT_TIMESTAMP, last_error_message = NULL, last_error_at = NULL WHERE id = ?', [qty, config.id]);
      db.run('UPDATE ml_item_variations SET available_quantity = ? WHERE ml_item_id = ? AND ml_account_id = ? AND variation_id = ?', [qty, config.ml_item_id, config.ml_account_id, config.variation_id]);
      auditStockSafe('push_manual', { inventory_id: config.inventory_id, target_marketplace: 'ml', target_account: config.ml_account_id, after: qty, meta: { ml_item_id: config.ml_item_id, variation_id: config.variation_id, config_id: config.id } }, req);
      res.json({ success: true, variation_id: config.variation_id, pushed_quantity: qty });
    } catch (e) {
      markPushError('ml_variation_stock_config', config.id, e);
      res.status(500).json({ error: 'Erro ao enviar estoque da variação', details: e.response?.data || e.message });
    }
  });
});

// ─── ML Variation Manual Stock Update ───
app.put('/api/ml/items/:mlItemId/variations/:variationId/stock', async (req, res) => {
  const { mlItemId, variationId } = req.params;
  const accountId = parseInt(req.body.accountId, 10) || 1;
  const qty = parseInt(req.body.available_quantity, 10);
  if (isNaN(qty) || qty < 0) return res.status(400).json({ error: 'Quantidade inválida' });
  try {
    await mlApiPut(`/items/${mlItemId}/variations/${variationId}`, { available_quantity: qty }, accountId);
    db.run('UPDATE ml_item_variations SET available_quantity = ? WHERE ml_item_id = ? AND ml_account_id = ? AND variation_id = ?', [qty, mlItemId, accountId, variationId]);
    res.json({ success: true, pushed_quantity: qty });
  } catch (e) {
    console.error(`[ML] Manual variation stock error:`, e.response?.data || e.message);
    res.status(500).json({ error: 'Erro ao atualizar estoque na API do ML', details: e.response?.data || e.message });
  }
});

// ─── ML Item Actions (pause, activate, refresh, update price) ───
app.put('/api/ml/items/:mlItemId/status', async (req, res) => {
  const { mlItemId } = req.params;
  const { status: newStatus, accountId } = req.body;
  const accId = parseInt(accountId, 10) || 1;
  if (!['active', 'paused', 'closed'].includes(newStatus)) return res.status(400).json({ error: 'Status inválido' });
  try {
    await mlApiPut(`/items/${mlItemId}`, { status: newStatus }, accId);
    db.run('UPDATE ml_items SET status = ?, last_synced_at = CURRENT_TIMESTAMP WHERE ml_item_id = ? AND ml_account_id = ?', [newStatus, mlItemId, accId]);
    res.json({ success: true, ml_item_id: mlItemId, status: newStatus });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao alterar status', details: e.response?.data || e.message });
  }
});

app.put('/api/ml/items/:mlItemId/price', async (req, res) => {
  const { mlItemId } = req.params;
  const { price, accountId } = req.body;
  const accId = parseInt(accountId, 10) || 1;
  if (!price || price <= 0) return res.status(400).json({ error: 'Preço inválido' });
  try {
    await mlApiPut(`/items/${mlItemId}`, { price: Number(price) }, accId);
    db.run('UPDATE ml_items SET price = ?, last_synced_at = CURRENT_TIMESTAMP WHERE ml_item_id = ? AND ml_account_id = ?', [price, mlItemId, accId]);
    res.json({ success: true, ml_item_id: mlItemId, price });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao alterar preço', details: e.response?.data || e.message });
  }
});

app.post('/api/ml/items/:mlItemId/refresh', async (req, res) => {
  const { mlItemId } = req.params;
  const accId = parseInt(req.body.accountId, 10) || 1;
  try {
    const item = await mlApiGet(`/items/${mlItemId}?include_attributes=all`, accId);

    let finalPrice = item.price;
    let finalOriginalPrice = item.original_price || null;
    try {
      const sp = await mlApiGet(`/items/${mlItemId}/sale_price`, accId);
      if (sp && sp.amount != null) {
        finalPrice = sp.amount;
        if (sp.regular_amount && sp.regular_amount > sp.amount) {
          finalOriginalPrice = sp.regular_amount;
        }
      }
    } catch {}

    let sku = null;
    if (item.variations && item.variations.length > 0) {
      for (const v of item.variations) {
        if (v.attributes) {
          const skuAttr = v.attributes.find(a => a.id === 'SELLER_SKU');
          if (skuAttr && skuAttr.value_name) { sku = skuAttr.value_name; break; }
        }
        if (!sku && v.seller_custom_field) { sku = v.seller_custom_field; break; }
      }
    }
    if (!sku && item.attributes) {
      const itemSkuAttr = item.attributes.find(a => a.id === 'SELLER_SKU');
      if (itemSkuAttr && itemSkuAttr.value_name) sku = itemSkuAttr.value_name;
    }
    if (!sku) sku = item.seller_custom_field || null;
    const catalogId = item.catalog_product_id || null;
    const listingType = item.listing_type_id || null;
    const isCatalog = Array.isArray(item.tags) && item.tags.includes('catalog_listing') ? 1 : 0;

    let variationCount = 0;
    let variationTypes = '';
    if (item.variations && item.variations.length > 0) {
      variationCount = item.variations.length;
      const attrMap = {};
      for (const v of item.variations) {
        if (v.attribute_combinations) {
          for (const ac of v.attribute_combinations) {
            const key = ac.name || ac.id;
            if (!attrMap[key]) attrMap[key] = new Set();
            if (ac.value_name) attrMap[key].add(ac.value_name);
          }
        }
      }
      variationTypes = Object.entries(attrMap).map(([k, vals]) => `${k}: ${[...vals].join(', ')}`).join(' | ');
    }

    db.run(`UPDATE ml_items SET title = ?, sku = ?, price = ?, original_price = ?, status = ?, ml_available_quantity = ?, thumbnail = ?, catalog_product_id = ?, listing_type_id = ?, is_catalog_listing = ?, variation_count = ?, variation_types = ?, last_synced_at = CURRENT_TIMESTAMP WHERE ml_item_id = ? AND ml_account_id = ?`,
      [item.title, sku, finalPrice, finalOriginalPrice, item.status, item.available_quantity || 0, item.thumbnail || null, catalogId, listingType, isCatalog, variationCount, variationTypes, mlItemId, accId]);

    if (item.variations && item.variations.length > 0) {
      for (const v of item.variations) {
        let vSku = null;
        if (v.attributes) {
          const skuA = v.attributes.find(a => a.id === 'SELLER_SKU');
          if (skuA && skuA.value_name) vSku = skuA.value_name;
        }
        if (!vSku) vSku = v.seller_custom_field || null;
        const combos = JSON.stringify(v.attribute_combinations || []);
        const picIds = JSON.stringify(v.picture_ids || []);
        const vThumb = v.picture_ids && v.picture_ids[0] && item.pictures
          ? (item.pictures.find(p => p.id === v.picture_ids[0]) || {}).secure_url || null
          : null;
        db.run(`INSERT OR REPLACE INTO ml_item_variations (id, ml_item_id, ml_account_id, variation_id, sku, price, available_quantity, sold_quantity, attribute_combinations, picture_ids, thumbnail, catalog_product_id)
                VALUES ((SELECT id FROM ml_item_variations WHERE ml_item_id = ? AND ml_account_id = ? AND variation_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [mlItemId, accId, String(v.id), mlItemId, accId, String(v.id), vSku, v.price || item.price, v.available_quantity || 0, v.sold_quantity || 0, combos, picIds, vThumb, v.catalog_product_id || null]);
      }
    }

    res.json({ success: true, item: { id: item.id, title: item.title, sku, price: finalPrice, original_price: finalOriginalPrice, status: item.status, available_quantity: item.available_quantity, is_catalog_listing: isCatalog, variation_count: variationCount, variation_types: variationTypes } });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao atualizar item', details: e.response?.data || e.message });
  }
});

// ─── ML Questions (Pré Venda) ───
/** Fila por questionId: evita duas respostas HTTP simultâneas na mesma pergunta (race). */
const mlAnswerQueueByQuestion = new Map();
function runMlAnswerExclusive(questionId, fn) {
  const key = String(questionId);
  const prev = mlAnswerQueueByQuestion.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => fn());
  mlAnswerQueueByQuestion.set(key, next);
  return next.finally(() => {
    if (mlAnswerQueueByQuestion.get(key) === next) mlAnswerQueueByQuestion.delete(key);
  });
}

app.get('/api/ml/questions', async (req, res) => {
  const { status, accountId, offset, limit } = req.query;
  try {
    const accounts = await new Promise((resolve) => {
      if (accountId) {
        db.all('SELECT id, name, ml_user_id FROM ml_accounts WHERE id = ? AND ml_user_id IS NOT NULL', [accountId], (e, r) => resolve(r || []));
      } else {
        db.all('SELECT id, name, ml_user_id FROM ml_accounts WHERE ml_user_id IS NOT NULL', (e, r) => resolve(r || []));
      }
    });
    if (!accounts.length) return res.json({ total: 0, questions: [], accounts: [] });

    const fetchResults = await Promise.all(accounts.map(async (acc) => {
      let url = `/questions/search?seller_id=${acc.ml_user_id}&api_version=4&sort_fields=date_created&sort_types=DESC`;
      if (status) url += `&status=${status}`;
      if (offset) url += `&offset=${offset}`;
      if (limit) url += `&limit=${limit}`;
      try {
        const data = await mlApiGet(url, acc.id);
        const qs = (data.questions || []).map(q => ({
          ...q,
          _accountId: acc.id,
          _accountUserId: acc.ml_user_id,
          _accountName: acc.name || 'Conta ' + acc.id,
          _marketplace: 'mercadolivre'
        }));
        return { total: data.total || 0, qs };
      } catch (e) {
        console.error(`[ML Questions] Erro conta ${acc.id}:`, e.response?.data || e.message);
        return { total: 0, qs: [] };
      }
    }));

    let total = 0;
    let allQuestions = [];
    fetchResults.forEach((fr) => {
      total += fr.total;
      allQuestions = allQuestions.concat(fr.qs);
    });

    const itemIds = [...new Set(allQuestions.map(q => q.item_id).filter(Boolean))];
    const itemMap = {};
    if (itemIds.length > 0) {
      const rows = await new Promise((resolve) => {
        const placeholders = itemIds.map(() => '?').join(',');
        db.all(`SELECT ml_item_id, title, thumbnail, permalink, sku, listing_type_id FROM ml_items WHERE ml_item_id IN (${placeholders})`, itemIds, (e, r) => resolve(r || []));
      });
      rows.forEach(r => { itemMap[r.ml_item_id] = r; });
    }

    const thumbHttps = (t) => {
      if (!t || typeof t !== 'string') return t;
      return t.startsWith('http://') ? 'https://' + t.slice(7) : t;
    };

    const missingItemIds = itemIds.filter(id => id && !itemMap[id]);
    await Promise.all(missingItemIds.map(async (mid) => {
      const sampleQ = allQuestions.find(q => q.item_id === mid);
      if (!sampleQ) return;
      try {
        const item = await mlApiGet(`/items/${mid}`, sampleQ._accountId);
        const thumb = item.secure_thumbnail || item.thumbnail
          || (item.pictures && item.pictures[0] && (item.pictures[0].secure_url || item.pictures[0].url)) || null;
        itemMap[mid] = {
          ml_item_id: mid,
          title: item.title,
          thumbnail: thumbHttps(thumb),
          permalink: item.permalink,
          sku: null,
          listing_type_id: item.listing_type_id
        };
      } catch (e) {
        console.error(`[ML Questions] Item ${mid} (cache miss) fetch falhou:`, e.response?.data || e.message);
      }
    }));

    Object.keys(itemMap).forEach((id) => {
      const row = itemMap[id];
      if (row && row.thumbnail) row.thumbnail = thumbHttps(row.thumbnail);
    });

    const buyerIds = [...new Set(allQuestions.map(q => q.from && q.from.id).filter(Boolean))];
    const nicknameMap = {};
    if (accounts.length && buyerIds.length) {
      const acc0 = accounts[0].id;
      const uidBatch = buyerIds.slice(0, 50);
      await Promise.all(uidBatch.map(async (uid) => {
        try {
          const u = await mlApiGet(`/users/${uid}`, acc0);
          if (u && u.nickname) nicknameMap[uid] = u.nickname;
        } catch (e) { /* ignore */ }
      }));
    }

    const enriched = allQuestions.map(q => ({
      ...q,
      _item: itemMap[q.item_id] || null,
      _buyerNickname: (q.from && q.from.id && nicknameMap[q.from.id]) || (q.from && q.from.nickname) || null
    }));

    enriched.sort((a, b) => new Date(b.date_created) - new Date(a.date_created));

    res.json({ total, questions: enriched, accounts: accounts.map(a => ({ id: a.id, name: a.name })) });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao buscar perguntas', details: e.message });
  }
});

app.get('/api/ml/questions/count', async (req, res) => {
  try {
    const accounts = await new Promise((resolve) => {
      db.all('SELECT id, ml_user_id FROM ml_accounts WHERE ml_user_id IS NOT NULL', (e, r) => resolve(r || []));
    });
    const totals = await Promise.all((accounts || []).map(async (acc) => {
      try {
        const data = await mlApiGet(`/questions/search?seller_id=${acc.ml_user_id}&status=UNANSWERED&api_version=4&limit=0`, acc.id);
        return data.total || 0;
      } catch (e) {
        return 0;
      }
    }));
    const unanswered = totals.reduce((a, b) => a + b, 0);
    res.json({ unanswered });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ml/questions/:questionId/answer', async (req, res) => {
  const { questionId } = req.params;
  const { text, accountId } = req.body;
  if (!text) return res.status(400).json({ error: 'Texto da resposta é obrigatório' });
  const accId = parseInt(accountId, 10) || 1;
  const qid = parseInt(questionId, 10);
  if (!Number.isFinite(qid)) return res.status(400).json({ error: 'ID da pergunta inválido' });
  try {
    await runMlAnswerExclusive(qid, async () => {
      let q;
      try {
        q = await mlApiGet(`/questions/${qid}`, accId);
      } catch (e) {
        const mlStatus = e.response?.status;
        if (!res.headersSent) {
          if (mlStatus === 404) return res.status(404).json({ error: 'Pergunta não encontrada.' });
          return res.status(502).json({ error: e.message || 'Erro ao verificar pergunta', details: e.response?.data || e.message });
        }
        return;
      }
      const st = (q && q.status) ? String(q.status).toUpperCase() : '';
      if (st !== 'UNANSWERED') {
        if (!res.headersSent) {
          return res.status(409).json({
            error: 'Esta pergunta já foi respondida ou não está mais disponível para resposta.',
            code: 'QUESTION_ALREADY_ANSWERED'
          });
        }
        return;
      }
      try {
        const data = await mlApiPost('/answers', { question_id: qid, text: String(text).trim() }, accId);
        if (!res.headersSent) res.json({ success: true, data });
      } catch (e) {
        const mlStatus = e.response?.status;
        const body = e.response?.data;
        const mlMsg = (body && (body.message || body.error)) || e.message || 'Erro desconhecido';
        console.error('[ML answer]', { questionId: qid, accId, mlStatus, body: body || e.message });
        const httpStatus = mlStatus && mlStatus >= 400 && mlStatus < 600 ? mlStatus : 502;
        const hint = body?.error === 'unauthorized_scopes'
          ? 'No DevCenter do Mercado Livre, edite o aplicativo e habilite a permissão funcional "Comunicação pré e pós-venda" com leitura e escrita (inclui responder perguntas). Depois desconecte e conecte de novo a conta no Miti para gerar token com os novos escopos.'
          : undefined;
        if (!res.headersSent) {
          res.status(httpStatus).json({ error: mlMsg, details: body || e.message, hint });
        }
      }
    });
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message || 'Erro ao processar resposta' });
  }
});

app.delete('/api/ml/questions/:questionId', async (req, res) => {
  const { questionId } = req.params;
  const accId = parseInt(req.query.accountId, 10) || 1;
  try {
    await mlApiDelete(`/questions/${encodeURIComponent(questionId)}`, accId);
    res.json({ success: true });
  } catch (e) {
    const mlStatus = e.response?.status;
    const body = e.response?.data;
    const httpStatus = mlStatus && mlStatus >= 400 && mlStatus < 600 ? mlStatus : 502;
    res.status(httpStatus).json({ error: body?.message || body?.error || 'Erro ao deletar pergunta', details: body || e.message });
  }
});

app.get('/api/ml/items/search-autocomplete', async (req, res) => {
  const { q, accountId } = req.query;
  const raw = normalizeMlAutocompleteQuery(q);
  if (raw.length < 2) return res.json([]);
  const tokens = raw.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return res.json([]);

  let sql = `SELECT ml_item_id, title, thumbnail, permalink, sku, price, status, listing_type_id FROM ml_items WHERE status = 'active'`;
  const params = [];

  if (tokens.length === 1) {
    const search = `%${tokens[0]}%`;
    sql += ` AND (title LIKE ? OR sku LIKE ? OR ml_item_id LIKE ?)`;
    params.push(search, search, search);
  } else {
    // Candidatos amplos (token mais longo); filtro final em JS com todas as palavras no título, qualquer ordem, sem depender de acento/caixa
    const longest = [...tokens].sort((a, b) => b.length - a.length)[0];
    sql += ` AND (LOWER(title) LIKE LOWER(?) OR LOWER(COALESCE(sku,'')) LIKE LOWER(?) OR LOWER(COALESCE(ml_item_id,'')) LIKE LOWER(?))`;
    const broad = `%${longest}%`;
    params.push(broad, broad, broad);
  }

  if (accountId) {
    sql += ` AND ml_account_id = ?`;
    params.push(accountId);
  }
  sql += tokens.length === 1 ? ` ORDER BY title LIMIT 200` : ` ORDER BY title LIMIT 400`;
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    let filtered = (rows || []).filter((r) => mlItemMatchesSearchTokens(r, tokens));
    if (filtered.length === 0 && tokens.length > 1) {
      const orParts = [];
      const orParams = [];
      tokens.forEach((t) => {
        const p = `%${t}%`;
        orParts.push('(LOWER(title) LIKE LOWER(?) OR LOWER(COALESCE(sku,\'\')) LIKE LOWER(?) OR LOWER(COALESCE(ml_item_id,\'\')) LIKE LOWER(?))');
        orParams.push(p, p, p);
      });
      let sql2 = `SELECT ml_item_id, title, thumbnail, permalink, sku, price, status, listing_type_id FROM ml_items WHERE status = 'active' AND (${orParts.join(' OR ')})`;
      const params2 = [...orParams];
      if (accountId) {
        sql2 += ` AND ml_account_id = ?`;
        params2.push(accountId);
      }
      sql2 += ` ORDER BY title LIMIT 600`;
      return db.all(sql2, params2, (err2, rows2) => {
        if (err2) return res.status(500).json({ error: err2.message });
        filtered = (rows2 || []).filter((r) => mlItemMatchesSearchTokens(r, tokens));
        res.json(filtered.slice(0, 15));
      });
    }
    res.json(filtered.slice(0, 15));
  });
});

// ─── ML Item Templates (Import/Export) ───

async function fetchFullMLItem(mlItemId, accountId) {
  const item = await mlApiGet(`/items/${mlItemId}?include_attributes=all`, accountId);
  let description = '';
  try {
    const desc = await mlApiGet(`/items/${mlItemId}/description`, accountId);
    description = desc.plain_text || desc.text || '';
  } catch { /* some items have no description */ }
  return { item, description };
}

/**
 * Busca dados completos de um item da Shopee para construir um modelo.
 * Agrega base + extra info + lista de modelos (variações quando `has_model`).
 */
async function fetchFullShopeeItem(itemId, accountId) {
  const baseResp = await shopeeApiGet('/api/v2/product/get_item_base_info', {
    item_id_list: String(itemId),
    need_tax_info: 'false',
    need_complaint_policy: 'false',
  }, accountId);
  const item = ((baseResp.response || baseResp).item_list || [])[0] || null;
  if (!item) throw new Error(`Item ${itemId} não encontrado na Shopee`);

  let models = [];
  let tierVariations = [];
  if (item.has_model) {
    try {
      const mResp = await shopeeApiGet('/api/v2/product/get_model_list', {
        item_id: String(itemId),
      }, accountId);
      const payload = mResp.response || mResp;
      models = payload.model || [];
      tierVariations = payload.tier_variation || [];
    } catch (e) {
      console.error('[Shopee import] get_model_list error:', e.message);
    }
  }

  let extra = null;
  try {
    const xResp = await shopeeApiGet('/api/v2/product/get_item_extra_info', {
      item_id_list: String(itemId),
    }, accountId);
    extra = ((xResp.response || xResp).item_list || [])[0] || null;
  } catch { /* opcional */ }

  return { item, models, tierVariations, extra };
}

/**
 * Converte um item Shopee (base + modelos) para o shape canônico de ad_model.
 * Mantém o mesmo formato que `buildTemplateFromMLItem` retorna, para que a persistência
 * reaproveite os mesmos campos (pictures, attributes, variations...).
 */
function buildAdModelFromShopeeItem({ item, models, tierVariations, extra }, accountId) {
  const imageUrls = item.image?.image_url_list || [];
  const imageIds = item.image?.image_id_list || [];
  const pictures = imageUrls.map((url, i) => ({
    id: imageIds[i] || null,
    source: url,
    size: null,
    max_size: null,
  }));

  const attrs = (item.attribute_list || []).map((a) => ({
    id: `SHOPEE_${a.attribute_id}`,
    name: a.original_attribute_name || a.attribute_name || '',
    value_id: a.attribute_value_list?.[0]?.value_id
      ? String(a.attribute_value_list[0].value_id)
      : null,
    value_name: a.attribute_value_list?.[0]?.original_value_name
      || a.attribute_value_list?.[0]?.value_name
      || '',
    value_struct: null,
    attribute_group_id: '',
    attribute_group_name: '',
  }));

  const tvOptions = (tierVariations || []).map((tv) => ({
    name: tv.name,
    options: (tv.option_list || []).map((o) => ({
      option: o.option,
      image_url: o.image?.image_url || null,
      image_id: o.image?.image_id || null,
    })),
  }));

  const variations = (models || []).map((m) => {
    const idxList = m.tier_index || [];
    const combos = idxList.map((optIdx, tvIdx) => {
      const tv = tvOptions[tvIdx];
      const opt = tv?.options?.[optIdx];
      return {
        id: tv?.name ? `SHOPEE_TV_${tvIdx}` : `VAR_${tvIdx}`,
        name: tv?.name || `Variação ${tvIdx + 1}`,
        value_id: null,
        value_name: opt?.option || '',
      };
    });
    const modelPrice = m.price_info?.[0]?.current_price || m.price_info?.[0]?.original_price || 0;
    const modelStock = m.stock_info_v2?.summary_info?.total_available_stock
      ?? m.stock_info?.[0]?.current_stock ?? 0;
    return {
      id: m.model_id != null ? String(m.model_id) : null,
      attribute_combinations: combos,
      price: modelPrice,
      available_quantity: modelStock,
      sold_quantity: m.stock_info_v2?.summary_info?.total_reserved_stock ?? 0,
      picture_ids: [],
      seller_custom_field: m.model_sku || null,
      attributes: [],
      catalog_product_id: null,
    };
  });

  const weight = item.weight ? Number(item.weight) : null;
  const dims = item.dimension || null;
  const shipping = {
    mode: '',
    free_shipping: false,
    local_pick_up: false,
    logistic_type: '',
    tags: [],
    dimensions: dims ? {
      length: dims.package_length || null,
      width: dims.package_width || null,
      height: dims.package_height || null,
      weight,
    } : null,
    methods: [],
  };

  const basePrice = item.price_info?.[0]?.current_price
    || item.price_info?.[0]?.original_price
    || 0;
  const baseStock = item.stock_info_v2?.summary_info?.total_available_stock
    ?? item.stock_info?.[0]?.current_stock ?? 0;

  const description = item.description || extra?.description || '';

  return {
    source_marketplace: 'shopee',
    source_shopee_item_id: String(item.item_id),
    source_ml_item_id: null,
    source_account_id: accountId,
    title: item.item_name || '',
    category_id: item.category_id ? String(item.category_id) : '',
    price: basePrice,
    currency_id: 'BRL',
    condition: item.condition === 'USED' ? 'used' : 'new',
    buying_mode: 'buy_it_now',
    listing_type_id: 'gold_special',
    available_quantity: baseStock,
    pictures: JSON.stringify(pictures),
    attributes: JSON.stringify(attrs),
    variations: JSON.stringify(variations),
    description,
    shipping: JSON.stringify(shipping),
    sale_terms: JSON.stringify([]),
    video_id: null,
    _tier_variations: tvOptions,
  };
}

function buildTemplateFromMLItem(item, description, accountId) {
  const pictures = (item.pictures || []).map(p => ({
    id: p.id || null,
    source: p.secure_url || p.url,
    size: p.size || null,
    max_size: p.max_size || null
  }));
  const attrs = (item.attributes || []).map(a => ({
    id: a.id,
    name: a.name || '',
    value_id: a.value_id || null,
    value_name: a.value_name || '',
    value_struct: a.value_struct || null,
    attribute_group_id: a.attribute_group_id || '',
    attribute_group_name: a.attribute_group_name || ''
  }));
  const variations = (item.variations || []).map(v => {
    let varSku = v.seller_custom_field || null;
    if (!varSku && v.attributes) {
      const skuAttr = v.attributes.find(a => a.id === 'SELLER_SKU');
      if (skuAttr && skuAttr.value_name) varSku = skuAttr.value_name;
    }
    return {
      id: v.id || null,
      attribute_combinations: v.attribute_combinations || [],
      price: v.price || item.price,
      available_quantity: v.available_quantity || 0,
      sold_quantity: v.sold_quantity || 0,
      picture_ids: v.picture_ids || [],
      seller_custom_field: varSku,
      attributes: (v.attributes || []).map(a => ({
        id: a.id, name: a.name || '', value_id: a.value_id || null, value_name: a.value_name || ''
      })),
      catalog_product_id: v.catalog_product_id || null
    };
  });
  const shipping = item.shipping ? {
    mode: item.shipping.mode || '',
    free_shipping: item.shipping.free_shipping || false,
    local_pick_up: item.shipping.local_pick_up || false,
    logistic_type: item.shipping.logistic_type || '',
    tags: item.shipping.tags || [],
    dimensions: item.shipping.dimensions || null,
    methods: item.shipping.methods || []
  } : null;
  const saleTerms = (item.sale_terms || []).map(t => ({
    id: t.id, name: t.name || '', value_id: t.value_id || null, value_name: t.value_name || ''
  }));
  return {
    source_ml_item_id: item.id,
    source_account_id: accountId,
    title: item.title || '',
    category_id: item.category_id || '',
    price: item.price || 0,
    currency_id: item.currency_id || 'BRL',
    condition: item.condition || 'new',
    buying_mode: item.buying_mode || 'buy_it_now',
    listing_type_id: item.listing_type_id || 'gold_special',
    available_quantity: item.available_quantity || 1,
    pictures: JSON.stringify(pictures),
    attributes: JSON.stringify(attrs),
    variations: JSON.stringify(variations),
    description,
    shipping: JSON.stringify(shipping),
    sale_terms: JSON.stringify(saleTerms),
    video_id: item.video_id || null
  };
}

// ─── DEPRECATED: /api/ml/templates/* ───
// O sistema de templates legado foi consolidado em /api/ad-models/*. Mantemos stubs
// devolvendo 410 Gone para qualquer cliente antigo que ainda chame essas rotas. A
// tabela ml_item_templates é copiada para ad_models na migração (ver initDatabase).
const ML_TEMPLATES_GONE_BODY = {
  error: 'O sistema de Templates foi substituído por Modelos de Anúncio. Use /api/ad-models/*.',
  gone: true,
};

app.all('/api/ml/templates', (req, res) => res.status(410).json(ML_TEMPLATES_GONE_BODY));
app.all('/api/ml/templates/import', (req, res) => res.status(410).json(ML_TEMPLATES_GONE_BODY));
app.all('/api/ml/templates/import-bulk', (req, res) => res.status(410).json(ML_TEMPLATES_GONE_BODY));
app.all('/api/ml/templates/publish-bulk', (req, res) => res.status(410).json(ML_TEMPLATES_GONE_BODY));
app.all('/api/ml/templates/:id', (req, res) => res.status(410).json(ML_TEMPLATES_GONE_BODY));
app.all('/api/ml/templates/:id/publish', (req, res) => res.status(410).json(ML_TEMPLATES_GONE_BODY));

app.get('/api/ml/categories/:categoryId/attributes', async (req, res) => {
  try {
    const resp = await axios.get(`https://api.mercadolibre.com/categories/${req.params.categoryId}/attributes`);
    res.json(resp.data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ═══  AD MODELS (Modelos de Anúncio)  ════════════════════════
// ═══════════════════════════════════════════════════════════════

app.get('/api/ad-models', (req, res) => {
  const { search } = req.query;
  let sql = `SELECT m.*, GROUP_CONCAT(
    json_object('id', p.id, 'marketplace', p.marketplace, 'account_id', p.account_id,
      'published_item_id', p.published_item_id, 'status', p.status, 'error_message', p.error_message,
      'published_at', p.published_at)
  ) as publications_json
  FROM ad_models m
  LEFT JOIN ad_model_publications p ON p.ad_model_id = m.id`;
  const params = [];
  if (search) {
    sql += ` WHERE (m.title LIKE ? OR m.sku LIKE ? OR m.ean LIKE ? OR m.source_ml_item_id LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  sql += ' GROUP BY m.id ORDER BY m.updated_at DESC';
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const models = (rows || []).map(r => {
      let publications = [];
      if (r.publications_json) {
        try {
          publications = r.publications_json.split('},{').map((chunk, i, arr) => {
            let s = chunk;
            if (i > 0) s = '{' + s;
            if (i < arr.length - 1) s = s + '}';
            try { return JSON.parse(s); } catch { return null; }
          }).filter(Boolean);
        } catch {}
      }
      const { publications_json, ...rest } = r;
      return { ...rest, publications };
    });
    res.json({ models });
  });
});

// GET /api/ad-models/enriched - must be before /:id to avoid route conflict
app.get('/api/ad-models/enriched', async (req, res) => {
  const { search } = req.query;
  try {
    let modelSql = `SELECT m.*, GROUP_CONCAT(
      json_object('id', p.id, 'marketplace', p.marketplace, 'account_id', p.account_id,
        'published_item_id', p.published_item_id, 'status', p.status, 'error_message', p.error_message,
        'published_at', p.published_at)
    ) as publications_json
    FROM ad_models m
    LEFT JOIN ad_model_publications p ON p.ad_model_id = m.id`;
    const params = [];
    if (search) {
      modelSql += ` WHERE (m.title LIKE ? OR m.sku LIKE ? OR m.ean LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    modelSql += ' GROUP BY m.id ORDER BY m.updated_at DESC';

    const models = await new Promise((resolve, reject) => {
      db.all(modelSql, params, (err, rows) => {
        if (err) return reject(err);
        resolve((rows || []).map(r => {
          let publications = [];
          if (r.publications_json) {
            try {
              publications = r.publications_json.split('},{').map((chunk, i, arr) => {
                let s = chunk;
                if (i > 0) s = '{' + s;
                if (i < arr.length - 1) s = s + '}';
                try { return JSON.parse(s); } catch { return null; }
              }).filter(Boolean);
            } catch {}
          }
          const { publications_json, ...rest } = r;
          return { ...rest, publications };
        }));
      });
    });

    if (!models.length) return res.json({ models: [] });

    const skus = [...new Set(models.map(m => m.sku).filter(Boolean))];
    const inventoryIds = [...new Set(models.map(m => m.inventory_id).filter(Boolean))];

    let inventoryMap = {};
    if (inventoryIds.length > 0) {
      const invPlaceholders = inventoryIds.map(() => '?').join(',');
      const invRows = await new Promise((resolve) => {
        db.all(`SELECT id, sku, title, quantity, min_quantity, image FROM inventory WHERE id IN (${invPlaceholders})`, inventoryIds, (e, r) => resolve(r || []));
      });
      for (const inv of invRows) inventoryMap[inv.id] = inv;
    }

    let mlListings = [];
    if (skus.length > 0) {
      const skuPlaceholders = skus.map(() => '?').join(',');
      mlListings = await new Promise((resolve) => {
        db.all(`SELECT mi.id, mi.ml_item_id, mi.ml_account_id, mi.title, mi.sku, mi.price, mi.permalink, mi.status,
          mi.ml_available_quantity, mi.thumbnail, mi.listing_type_id, mi.is_catalog_listing, mi.variation_count,
          msc.id as stock_config_id, msc.use_real_stock, msc.enabled as stock_enabled, msc.fictitious_value, msc.last_pushed_at,
          msc.inventory_id as stock_inventory_id
          FROM ml_items mi
          LEFT JOIN ml_stock_config msc ON msc.ml_item_id = mi.ml_item_id AND msc.ml_account_id = mi.ml_account_id
          WHERE mi.sku IN (${skuPlaceholders})`, skus, (e, r) => resolve(r || []));
      });

      const varListings = await new Promise((resolve) => {
        db.all(`SELECT DISTINCT mi.id, mi.ml_item_id, mi.ml_account_id, mi.title, mi.sku as item_sku, mi.price, mi.permalink, mi.status,
          mi.ml_available_quantity, mi.thumbnail, mi.listing_type_id, mi.is_catalog_listing, mi.variation_count,
          miv.sku as variation_sku, miv.variation_id, miv.available_quantity as var_available_quantity,
          msc.id as stock_config_id, msc.use_real_stock, msc.enabled as stock_enabled, msc.fictitious_value, msc.last_pushed_at,
          msc.inventory_id as stock_inventory_id
          FROM ml_item_variations miv
          JOIN ml_items mi ON mi.ml_item_id = miv.ml_item_id AND mi.ml_account_id = miv.ml_account_id
          LEFT JOIN ml_stock_config msc ON msc.ml_item_id = mi.ml_item_id AND msc.ml_account_id = mi.ml_account_id
          WHERE miv.sku IN (${skuPlaceholders})
          AND mi.ml_item_id NOT IN (SELECT ml_item_id FROM ml_items WHERE sku IN (${skuPlaceholders}))`,
          [...skus, ...skus], (e, r) => resolve(r || []));
      });

      const seen = new Set(mlListings.map(l => `${l.ml_item_id}_${l.ml_account_id}`));
      for (const vl of varListings) {
        const key = `${vl.ml_item_id}_${vl.ml_account_id}`;
        if (!seen.has(key)) {
          seen.add(key);
          mlListings.push({ ...vl, sku: vl.variation_sku || vl.item_sku, matched_via: 'variation' });
        }
      }
    }

    let shopeeListings = [];
    if (skus.length > 0) {
      const skuPlaceholders = skus.map(() => '?').join(',');
      shopeeListings = await new Promise((resolve) => {
        db.all(`SELECT si.*, ssc.id as stock_config_id, ssc.use_real_stock, ssc.enabled as stock_enabled,
          ssc.fictitious_value, ssc.last_pushed_at, ssc.inventory_id as stock_inventory_id
          FROM shopee_items si
          LEFT JOIN shopee_stock_config ssc ON ssc.shopee_item_id = si.shopee_item_id AND ssc.shopee_account_id = si.shopee_account_id
          WHERE si.sku IN (${skuPlaceholders})`, skus, (e, r) => resolve(r || []));
      });
    }

    const mlAccountNames = {};
    const mlAccRows = await new Promise((resolve) => { db.all('SELECT id, name FROM ml_accounts', (e, r) => resolve(r || [])); });
    for (const a of mlAccRows) mlAccountNames[a.id] = a.name;
    const shopeeAccountNames = {};
    const spAccRows = await new Promise((resolve) => { db.all('SELECT id, name FROM shopee_accounts', (e, r) => resolve(r || [])); });
    for (const a of spAccRows) shopeeAccountNames[a.id] = a.name;

    const enrichedModels = models.map(model => {
      const modelSku = model.sku;
      const inv = model.inventory_id ? inventoryMap[model.inventory_id] : null;

      const ml = mlListings.filter(l => l.sku === modelSku || l.variation_sku === modelSku || l.item_sku === modelSku)
        .map(l => ({ ...l, account_name: mlAccountNames[l.ml_account_id] || `Conta ${l.ml_account_id}` }));

      const shopee = shopeeListings.filter(l => l.sku === modelSku)
        .map(l => ({ ...l, account_name: shopeeAccountNames[l.shopee_account_id] || `Conta ${l.shopee_account_id}` }));

      const mlStatus = ml.length > 0 ? (ml.some(l => l.status === 'active') ? 'active' : ml.some(l => l.status === 'paused') ? 'paused' : 'closed') : 'none';
      const shopeeStatus = shopee.length > 0 ? (shopee.some(l => l.status === 'NORMAL' || l.status === 'active') ? 'active' : 'paused') : 'none';

      return {
        ...model,
        inventory: inv,
        marketplace_listings: { ml, shopee },
        marketplace_status: { ml: mlStatus, shopee: shopeeStatus },
        total_listings: ml.length + shopee.length,
      };
    });

    res.json({ models: enrichedModels });
  } catch (err) {
    console.error('[Ad Models Enriched] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/package-presets', (req, res) => {
  db.all('SELECT id, name, width_cm, height_cm, depth_cm, weight_kg, created_at FROM package_presets ORDER BY name COLLATE NOCASE', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ presets: rows || [] });
  });
});

app.post('/api/package-presets', (req, res) => {
  const { name, width_cm, height_cm, depth_cm, weight_kg } = req.body;
  const n = (name || '').trim();
  if (!n) return res.status(400).json({ error: 'Nome obrigatório' });
  const w = Number(width_cm);
  const h = Number(height_cm);
  const d = Number(depth_cm);
  const kg = Number(weight_kg);
  if (![w, h, d, kg].every((x) => Number.isFinite(x) && x > 0)) {
    return res.status(400).json({ error: 'Largura, altura, profundidade (cm) e peso (kg) devem ser números positivos' });
  }
  db.run('INSERT INTO package_presets (name, width_cm, height_cm, depth_cm, weight_kg) VALUES (?,?,?,?,?)',
    [n, w, h, d, kg], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: this.lastID });
    });
});

app.put('/api/package-presets/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, width_cm, height_cm, depth_cm, weight_kg } = req.body;
  const n = (name || '').trim();
  if (!n) return res.status(400).json({ error: 'Nome obrigatório' });
  const w = Number(width_cm);
  const h = Number(height_cm);
  const d = Number(depth_cm);
  const kg = Number(weight_kg);
  if (![w, h, d, kg].every((x) => Number.isFinite(x) && x > 0)) {
    return res.status(400).json({ error: 'Medidas inválidas' });
  }
  db.run('UPDATE package_presets SET name = ?, width_cm = ?, height_cm = ?, depth_cm = ?, weight_kg = ? WHERE id = ?',
    [n, w, h, d, kg, id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      if (!this.changes) return res.status(404).json({ error: 'Preset não encontrado' });
      res.json({ success: true });
    });
});

app.delete('/api/package-presets/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.run('DELETE FROM package_presets WHERE id = ?', [id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, deleted: this.changes });
  });
});

/**
 * Extrai a lista plana de SKUs de um modelo (principal + variações) para rastrear em
 * ad_model_skus. Retorna [{ sku, role, variation_key, inventory_id }].
 */
function deriveAdModelSkuRows({ sku, inventory_id, variations }) {
  const out = [];
  if (sku && String(sku).trim()) {
    out.push({ sku: String(sku).trim(), role: 'main', variation_key: null, inventory_id: inventory_id || null });
  }
  let vars = [];
  if (Array.isArray(variations)) vars = variations;
  else if (typeof variations === 'string') {
    try { vars = JSON.parse(variations || '[]'); } catch { vars = []; }
  }
  if (Array.isArray(vars)) {
    for (const v of vars) {
      const vSku = v?.seller_custom_field || null;
      if (!vSku) continue;
      let varKey = null;
      if (Array.isArray(v.attribute_combinations)) {
        varKey = v.attribute_combinations
          .map((c) => `${c.id || ''}:${c.value_name || c.value_id || ''}`)
          .join('|');
      }
      out.push({ sku: String(vSku).trim(), role: 'variation', variation_key: varKey, inventory_id: v?.inventory_id || null });
    }
  }
  return out;
}

/**
 * Cria/atualiza a linha em ad_model_publications (uma por marketplace+conta) e grava os
 * itens individuais em ad_model_publication_items. Itens antigos da mesma publicação são
 * substituídos para manter a tabela alinhada com o último resultado.
 */
async function savePublicationWithItems({ adModelId, marketplace, accountId, publishedItemId, publishedPrice, publishedListingType, status, errorMessage, items }) {
  const st = status || 'published';
  const primaryItemId = publishedItemId != null ? String(publishedItemId) : (Array.isArray(items) && items[0]?.published_item_id ? String(items[0].published_item_id) : null);
  await new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO ad_model_publications (ad_model_id, marketplace, account_id, published_item_id, status, error_message, published_at, published_price, published_listing_type)
       VALUES (?, ?, ?, ?, ?, ?, CASE WHEN ? = 'published' THEN CURRENT_TIMESTAMP ELSE NULL END, ?, ?)
       ON CONFLICT(ad_model_id, marketplace, account_id) DO UPDATE SET
         published_item_id = excluded.published_item_id,
         status = excluded.status,
         error_message = excluded.error_message,
         published_at = CASE WHEN excluded.status = 'published' THEN CURRENT_TIMESTAMP ELSE ad_model_publications.published_at END,
         published_price = excluded.published_price,
         published_listing_type = excluded.published_listing_type`,
      [adModelId, marketplace, accountId, primaryItemId, st, errorMessage || null, st, publishedPrice || null, publishedListingType || null],
      (err) => err ? reject(err) : resolve()
    );
  });
  const pub = await new Promise((resolve, reject) => {
    db.get('SELECT id FROM ad_model_publications WHERE ad_model_id = ? AND marketplace = ? AND account_id = ?',
      [adModelId, marketplace, accountId], (e, r) => e ? reject(e) : resolve(r));
  });
  if (!pub) return;
  await new Promise((resolve) => {
    db.run('DELETE FROM ad_model_publication_items WHERE publication_id = ?', [pub.id], () => resolve());
  });
  if (!Array.isArray(items) || !items.length) return;
  await new Promise((resolve, reject) => {
    db.serialize(() => {
      const stmt = db.prepare(`INSERT INTO ad_model_publication_items
        (publication_id, published_item_id, external_sku, variation_key, permalink, status, error_message)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const it of items) {
        stmt.run([
          pub.id,
          it.published_item_id != null ? String(it.published_item_id) : null,
          it.external_sku || null,
          it.variation_key || null,
          it.permalink || null,
          it.status || st,
          it.error_message || null,
        ]);
      }
      stmt.finalize((err) => err ? reject(err) : resolve());
    });
  });
}

/**
 * Sincroniza ad_model_skus para um modelo (apaga tudo do modelo e insere o estado atual).
 * Feito em uma única serialize; callback opcional é chamado após concluir.
 */
function syncAdModelSkus(adModelId, rows, cb) {
  db.serialize(() => {
    db.run('DELETE FROM ad_model_skus WHERE ad_model_id = ?', [adModelId]);
    if (!Array.isArray(rows) || rows.length === 0) {
      if (cb) cb(null);
      return;
    }
    const stmt = db.prepare(
      `INSERT INTO ad_model_skus (ad_model_id, inventory_id, sku, role, variation_key) VALUES (?, ?, ?, ?, ?)`
    );
    for (const r of rows) {
      stmt.run([adModelId, r.inventory_id || null, r.sku, r.role || 'main', r.variation_key || null]);
    }
    stmt.finalize((err) => { if (cb) cb(err || null); });
  });
}

app.get('/api/ad-models/:id', (req, res) => {
  db.get('SELECT * FROM ad_models WHERE id = ?', [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Modelo não encontrado' });
    db.all('SELECT * FROM ad_model_publications WHERE ad_model_id = ?', [row.id], (err2, pubs) => {
      if (err2) return res.status(500).json({ error: err2.message });
      const pubIds = (pubs || []).map((p) => p.id);
      const afterItems = (items) => {
        db.all('SELECT * FROM ad_model_skus WHERE ad_model_id = ? ORDER BY id', [row.id], (err4, skus) => {
          if (err4) return res.status(500).json({ error: err4.message });
          res.json({
            ...row,
            publications: pubs || [],
            publication_items: items || [],
            skus: skus || [],
          });
        });
      };
      if (!pubIds.length) return afterItems([]);
      const ph = pubIds.map(() => '?').join(',');
      db.all(`SELECT * FROM ad_model_publication_items WHERE publication_id IN (${ph}) ORDER BY id`, pubIds, (err3, items) => {
        if (err3) return res.status(500).json({ error: err3.message });
        afterItems(items);
      });
    });
  });
});

app.post('/api/ad-models', (req, res) => {
  const { sku, ean, title, category_id, category_name, price, currency_id, condition, buying_mode, listing_type_id,
    available_quantity, pictures, attributes, variations, description, shipping, sale_terms, video_id,
    inventory_id, source_ml_item_id, source_account_id, package_measures, marketplace_mappings } = req.body;
  if (!title) return res.status(400).json({ error: 'Título obrigatório' });
  db.run(`INSERT INTO ad_models (inventory_id, sku, ean, title, category_id, category_name, price, currency_id, condition, buying_mode,
    listing_type_id, available_quantity, pictures, attributes, variations, description, shipping, sale_terms, video_id,
    source_ml_item_id, source_account_id, package_measures, marketplace_mappings)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [inventory_id || null, sku || null, ean || null, title, category_id || null, category_name || null,
      price || 0, currency_id || 'BRL', condition || 'new', buying_mode || 'buy_it_now',
      listing_type_id || 'gold_special', available_quantity || 1,
      typeof pictures === 'object' ? JSON.stringify(pictures) : (pictures || '[]'),
      typeof attributes === 'object' ? JSON.stringify(attributes) : (attributes || '[]'),
      typeof variations === 'object' ? JSON.stringify(variations) : (variations || '[]'),
      description || '', typeof shipping === 'object' ? JSON.stringify(shipping) : (shipping || null),
      typeof sale_terms === 'object' ? JSON.stringify(sale_terms) : (sale_terms || '[]'),
      video_id || null, source_ml_item_id || null, source_account_id || null,
      package_measures != null ? (typeof package_measures === 'object' ? JSON.stringify(package_measures) : package_measures) : null,
      marketplace_mappings != null ? (typeof marketplace_mappings === 'object' ? JSON.stringify(marketplace_mappings) : marketplace_mappings) : null],
    function(err) {
      if (err) {
        if (err.message.includes('UNIQUE constraint')) return res.status(409).json({ error: 'Já existe um modelo com esse SKU' });
        return res.status(500).json({ error: err.message });
      }
      const newId = this.lastID;
      const skuRows = deriveAdModelSkuRows({ sku, inventory_id, variations });
      syncAdModelSkus(newId, skuRows, () => {
        res.json({ success: true, id: newId });
      });
    });
});

/**
 * Importa um item Shopee como ad_model. Segue a mesma estratégia do import ML:
 * tenta encontrar um modelo existente por source_shopee_item_id ou sku e, se
 * houver colisão, retorna 409 a menos que `forceOverwrite` seja true.
 */
async function importAdModelFromShopee(req, res, opts) {
  const { itemId, accountId, forceOverwrite, sku, ean, inventoryId } = opts;
  if (!itemId || !accountId) {
    return res.status(400).json({ error: 'shopeeItemId e shopeeAccountId (ou accountId) obrigatórios' });
  }
  try {
    const full = await fetchFullShopeeItem(itemId, accountId);
    const t = buildAdModelFromShopeeItem(full, accountId);

    let itemSku = sku || null;
    if (!itemSku) {
      const vars = JSON.parse(t.variations || '[]');
      for (const v of vars) {
        if (v.seller_custom_field) { itemSku = v.seller_custom_field; break; }
      }
    }
    if (!itemSku) itemSku = full.item.item_sku || null;

    let itemEan = ean || null;

    const existing = await new Promise((resolve) => {
      db.get(
        `SELECT id, sku FROM ad_models
          WHERE (source_marketplace = 'shopee' AND source_shopee_item_id = ?)
             OR (? IS NOT NULL AND sku IS NOT NULL AND sku = ?)
          LIMIT 1`,
        [t.source_shopee_item_id, itemSku, itemSku],
        (e, row) => resolve(row || null)
      );
    });

    if (existing && !forceOverwrite) {
      return res.status(409).json({
        error: 'Já existe um modelo para este item Shopee/SKU',
        existingId: existing.id,
        existingSku: existing.sku,
      });
    }

    let categoryName = null;
    if (full.item.category_id) {
      try {
        const c = await shopeeApiGet('/api/v2/product/get_category', {
          language: 'pt-br',
        }, accountId);
        const list = (c.response || c).category_list || [];
        const found = list.find((x) => String(x.category_id) === String(full.item.category_id));
        if (found) categoryName = found.original_category_name || found.display_category_name || null;
      } catch { /* best effort */ }
    }

    if (existing && forceOverwrite) {
      db.run(
        `UPDATE ad_models SET inventory_id = COALESCE(?, inventory_id), sku = COALESCE(?, sku),
          ean = ?, title = ?, category_id = ?, category_name = ?, price = ?, currency_id = ?,
          condition = ?, buying_mode = ?, listing_type_id = ?, available_quantity = ?,
          pictures = ?, attributes = ?, variations = ?, description = ?, shipping = ?,
          sale_terms = ?, video_id = ?,
          source_marketplace = 'shopee', source_shopee_item_id = ?, source_account_id = ?,
          updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [inventoryId || null, itemSku, itemEan, t.title, t.category_id, categoryName, t.price, t.currency_id,
          t.condition, t.buying_mode, t.listing_type_id, t.available_quantity, t.pictures, t.attributes,
          t.variations, t.description, t.shipping, t.sale_terms, t.video_id,
          t.source_shopee_item_id, t.source_account_id, existing.id],
        function (uErr) {
          if (uErr) return res.status(500).json({ error: uErr.message });
          const skuRows = deriveAdModelSkuRows({ sku: itemSku, inventory_id: inventoryId, variations: t.variations });
          syncAdModelSkus(existing.id, skuRows, () => {
            res.json({ success: true, id: existing.id, title: t.title, sku: itemSku, updated: true, marketplace: 'shopee' });
          });
        }
      );
      return;
    }

    db.run(
      `INSERT INTO ad_models (inventory_id, sku, ean, title, category_id, category_name, price, currency_id,
        condition, buying_mode, listing_type_id, available_quantity, pictures, attributes, variations,
        description, shipping, sale_terms, video_id,
        source_marketplace, source_shopee_item_id, source_account_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'shopee',?,?)`,
      [inventoryId || null, itemSku, itemEan, t.title, t.category_id, categoryName, t.price, t.currency_id,
        t.condition, t.buying_mode, t.listing_type_id, t.available_quantity, t.pictures, t.attributes,
        t.variations, t.description, t.shipping, t.sale_terms, t.video_id,
        t.source_shopee_item_id, t.source_account_id],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        const newId = this.lastID;
        const skuRows = deriveAdModelSkuRows({ sku: itemSku, inventory_id: inventoryId, variations: t.variations });
        syncAdModelSkus(newId, skuRows, () => {
          res.json({ success: true, id: newId, title: t.title, sku: itemSku, marketplace: 'shopee' });
        });
      }
    );
  } catch (err) {
    console.error('[Ad Models] Shopee import error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
}

app.post('/api/ad-models/import', async (req, res) => {
  const {
    mlItemId, accountId, sku, ean, inventoryId,
    marketplace, shopeeItemId, shopeeAccountId,
  } = req.body;
  const mp = (marketplace || (shopeeItemId ? 'shopee' : 'ml')).toLowerCase();

  if (mp === 'shopee') {
    return importAdModelFromShopee(req, res, {
      itemId: shopeeItemId || mlItemId,
      accountId: shopeeAccountId || accountId,
      forceOverwrite: req.body.forceOverwrite === true,
      sku, ean, inventoryId,
    });
  }

  if (!mlItemId || !accountId) return res.status(400).json({ error: 'mlItemId e accountId obrigatórios' });
  try {
    const { item, description } = await fetchFullMLItem(mlItemId, accountId);
    const t = buildTemplateFromMLItem(item, description, accountId);
    let itemSku = sku || null;
    if (!itemSku && item.variations && item.variations.length > 0) {
      for (const v of item.variations) {
        if (v.attributes) {
          const skuAttr = v.attributes.find(a => a.id === 'SELLER_SKU');
          if (skuAttr && skuAttr.value_name) { itemSku = skuAttr.value_name; break; }
        }
        if (!itemSku && v.seller_custom_field) { itemSku = v.seller_custom_field; break; }
      }
    }
    if (!itemSku && item.attributes) {
      const skuAttr = item.attributes.find(a => a.id === 'SELLER_SKU');
      if (skuAttr && skuAttr.value_name) itemSku = skuAttr.value_name;
    }
    if (!itemSku) itemSku = item.seller_custom_field || null;

    let itemEan = ean || null;
    if (!itemEan && item.attributes) {
      for (const attrId of ['GTIN', 'EAN', 'UPC', 'MPN']) {
        const found = item.attributes.find(a => a.id === attrId);
        if (found && found.value_name && found.value_name !== '-1' && found.value_name !== '') { itemEan = found.value_name; break; }
      }
    }
    if (!itemEan && item.sale_terms) {
      const gtinTerm = item.sale_terms.find(t => t.id === 'GTIN');
      if (gtinTerm && gtinTerm.value_name && gtinTerm.value_name !== '-1') itemEan = gtinTerm.value_name;
    }
    if (!itemEan && item.variations && item.variations.length > 0) {
      for (const v of item.variations) {
        if (v.attributes) {
          const eanAttr = v.attributes.find(a => a.id === 'GTIN' || a.id === 'EAN');
          if (eanAttr && eanAttr.value_name && eanAttr.value_name !== '-1') { itemEan = eanAttr.value_name; break; }
        }
      }
    }

    let categoryName = null;
    if (t.category_id) {
      try {
        const catResp = await axios.get(`https://api.mercadolibre.com/categories/${t.category_id}`);
        if (catResp.data) {
          const pathNames = (catResp.data.path_from_root || []).map(p => p.name);
          categoryName = pathNames.length > 0 ? pathNames.join(' > ') : (catResp.data.name || null);
        }
      } catch (e) { console.log('[Ad Models] Category fetch error:', e.message); }
    }

    const forceOverwrite = req.body.forceOverwrite === true;

    // Sem UNIQUE(sku), a detecção de "já importado" precisa ser explícita: olhamos
    // primeiro por source_ml_item_id, depois por sku. Se forceOverwrite, atualizamos; senão
    // devolvemos 409 para o usuário decidir.
    const existing = await new Promise((resolve) => {
      db.get(
        `SELECT id, sku FROM ad_models WHERE (source_ml_item_id IS NOT NULL AND source_ml_item_id = ?)
           OR (? IS NOT NULL AND sku IS NOT NULL AND sku = ?) LIMIT 1`,
        [t.source_ml_item_id || null, itemSku, itemSku],
        (e, row) => resolve(row || null)
      );
    });

    if (existing && !forceOverwrite) {
      return res.status(409).json({ error: 'Já existe um modelo para este anúncio/SKU', existingId: existing.id, existingSku: existing.sku });
    }

    if (existing && forceOverwrite) {
      db.run(
        `UPDATE ad_models SET inventory_id = COALESCE(?, inventory_id), sku = COALESCE(?, sku),
          ean = ?, title = ?, category_id = ?, category_name = ?, price = ?, currency_id = ?,
          condition = ?, buying_mode = ?, listing_type_id = ?, available_quantity = ?,
          pictures = ?, attributes = ?, variations = ?, description = ?, shipping = ?,
          sale_terms = ?, video_id = ?, source_ml_item_id = ?, source_account_id = ?,
          updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [inventoryId || null, itemSku, itemEan, t.title, t.category_id, categoryName, t.price, t.currency_id,
         t.condition, t.buying_mode, t.listing_type_id, t.available_quantity, t.pictures, t.attributes,
         t.variations, t.description, t.shipping, t.sale_terms, t.video_id, t.source_ml_item_id,
         t.source_account_id, existing.id],
        function(uErr) {
          if (uErr) return res.status(500).json({ error: uErr.message });
          const skuRows = deriveAdModelSkuRows({ sku: itemSku, inventory_id: inventoryId, variations: t.variations });
          syncAdModelSkus(existing.id, skuRows, () => {
            res.json({ success: true, id: existing.id, title: t.title, sku: itemSku, updated: true });
          });
        }
      );
      return;
    }

    db.run(`INSERT INTO ad_models (inventory_id, sku, ean, title, category_id, category_name, price, currency_id, condition, buying_mode,
      listing_type_id, available_quantity, pictures, attributes, variations, description, shipping, sale_terms, video_id,
      source_ml_item_id, source_account_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [inventoryId || null, itemSku, itemEan, t.title, t.category_id, categoryName, t.price, t.currency_id, t.condition,
        t.buying_mode, t.listing_type_id, t.available_quantity, t.pictures, t.attributes, t.variations,
        t.description, t.shipping, t.sale_terms, t.video_id, t.source_ml_item_id, t.source_account_id],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        const newId = this.lastID;
        const skuRows = deriveAdModelSkuRows({ sku: itemSku, inventory_id: inventoryId, variations: t.variations });
        syncAdModelSkus(newId, skuRows, () => {
          res.json({ success: true, id: newId, title: t.title, sku: itemSku });
        });
      });
  } catch (err) {
    console.error('[Ad Models] Import error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

app.put('/api/ad-models/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const fields = ['sku', 'ean', 'title', 'category_id', 'category_name', 'price', 'currency_id', 'condition', 'buying_mode',
    'listing_type_id', 'available_quantity', 'pictures', 'attributes', 'variations', 'description',
    'shipping', 'sale_terms', 'video_id', 'inventory_id', 'package_measures', 'marketplace_mappings'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      const val = req.body[f];
      if (val === null) params.push(null);
      else if (typeof val === 'object') params.push(JSON.stringify(val));
      else params.push(val);
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  updates.push('updated_at = CURRENT_TIMESTAMP');
  params.push(id);
  db.run(`UPDATE ad_models SET ${updates.join(', ')} WHERE id = ?`, params, function(err) {
    if (err) {
      if (err.message.includes('UNIQUE constraint')) return res.status(409).json({ error: 'Já existe um modelo com esse SKU' });
      return res.status(500).json({ error: err.message });
    }
    const changes = this.changes;
    // Quando sku, inventory_id ou variations foram tocados, ressincroniza ad_model_skus.
    const touchedSkuSource = ['sku', 'inventory_id', 'variations'].some((f) => req.body[f] !== undefined);
    if (!touchedSkuSource) return res.json({ success: true, changes });
    db.get('SELECT sku, inventory_id, variations FROM ad_models WHERE id = ?', [id], (gErr, row) => {
      if (gErr || !row) return res.json({ success: true, changes });
      const skuRows = deriveAdModelSkuRows({ sku: row.sku, inventory_id: row.inventory_id, variations: row.variations });
      syncAdModelSkus(id, skuRows, () => res.json({ success: true, changes }));
    });
  });
});

app.delete('/api/ad-models/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.serialize(() => {
    db.run(`DELETE FROM ad_model_publication_items WHERE publication_id IN
      (SELECT id FROM ad_model_publications WHERE ad_model_id = ?)`, [id]);
    db.run('DELETE FROM ad_model_publications WHERE ad_model_id = ?', [id]);
    db.run('DELETE FROM ad_model_skus WHERE ad_model_id = ?', [id]);
    db.run('DELETE FROM ad_models WHERE id = ?', [id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, deleted: this.changes });
    });
  });
});

app.delete('/api/ad-models', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids (array) obrigatório' });
  const placeholders = ids.map(() => '?').join(',');
  db.serialize(() => {
    db.run(`DELETE FROM ad_model_publication_items WHERE publication_id IN
      (SELECT id FROM ad_model_publications WHERE ad_model_id IN (${placeholders}))`, ids);
    db.run(`DELETE FROM ad_model_publications WHERE ad_model_id IN (${placeholders})`, ids);
    db.run(`DELETE FROM ad_model_skus WHERE ad_model_id IN (${placeholders})`, ids);
    db.run(`DELETE FROM ad_models WHERE id IN (${placeholders})`, ids, function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, deleted: this.changes });
    });
  });
});

/** picture_ids no modelo: índices 0..n-1 na lista de fotos ou ids importados do ML — normaliza para índices (API aceita na criação). */
function normalizeAdModelVariationPictureIds(variations, pictures) {
  const pics = Array.isArray(pictures) ? pictures : [];
  const len = pics.length;
  return (variations || []).map((v) => {
    const raw = v.picture_ids || [];
    const resolved = [];
    for (const pid of raw) {
      const n = Number(pid);
      if (Number.isInteger(n) && n >= 0 && n < len) {
        resolved.push(n);
        continue;
      }
      const idx = pics.findIndex((p) => p && p.id != null && String(p.id) === String(pid));
      if (idx >= 0) resolved.push(idx);
    }
    return { ...v, picture_ids: [...new Set(resolved)] };
  });
}

/** ML rejeita body.invalid_fields se price/qty forem string (comum vindo do SQLite). */
function toMlPriceNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function toMlQuantityInt(v) {
  const n = parseInt(String(v == null ? '' : v), 10);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

/**
 * POST /items: cada combinação deve ter só id, value_id, value_name (sem `name` etc.).
 * @see https://developers.mercadolibre.com.ar/en_us/listing-types
 */
function sanitizeAttributeCombinationForMl(ac) {
  if (!ac || !ac.id) return null;
  const o = { id: String(ac.id) };
  const vid = ac.value_id != null && String(ac.value_id).trim() !== '' ? String(ac.value_id) : null;
  const vname = ac.value_name != null && String(ac.value_name).trim() !== '' ? String(ac.value_name).trim() : null;
  if (!vid && !vname) return null;
  if (vid) o.value_id = vid;
  if (vname) o.value_name = vname;
  return o;
}

function sanitizeAttributeCombinationsForMl(combos) {
  return (combos || []).map(sanitizeAttributeCombinationForMl).filter(Boolean);
}

/**
 * picture_ids no POST /items: índices 0..n-1 na lista `pictures` do mesmo body.
 * NÃO usar parseInt em IDs ML ("553111-MLA...") — parseInt trunca em 553111 e corrompe o payload (body.invalid_fields).
 */
function sanitizeVariationPictureIds(raw, numPictures) {
  const max = Number.isFinite(numPictures) && numPictures > 0 ? Math.floor(numPictures) : 12;
  return (raw || [])
    .map((x) => {
      const s = String(x).trim();
      if (!/^\d+$/.test(s)) return null;
      const n = parseInt(s, 10);
      if (Number.isInteger(n) && n >= 0 && n < max) return n;
      return null;
    })
    .filter((n) => n != null);
}

/** Monta mensagem legível a partir de cause[] (body.invalid_fields costuma trazer referência ao campo). */
function mlApiErrorToUserMessage(err) {
  const data = err.response?.data || {};
  const causes = Array.isArray(data.cause) ? data.cause : [];
  const parts = causes
    .filter((c) => !c.type || c.type === 'error')
    .map((c) => {
      if (typeof c === 'string') return c;
      const ref = c.reference || (Array.isArray(c.references) ? c.references.join(', ') : c.references);
      const msg = c.message || '';
      if (ref && msg) return `${msg} [${ref}]`;
      return msg || ref || '';
    })
    .filter(Boolean);
  if (parts.length) return parts.join('; ');
  const msg = data.message || err.message || 'Erro API Mercado Livre';
  const errStr = typeof data.error === 'string' ? data.error.trim() : '';
  if (errStr && errStr !== msg && !msg.includes(errStr)) {
    return `${msg} — ${errStr}`;
  }
  if (msg === 'body.invalid_fields' && !parts.length) {
    return `${msg}. Campos inválidos para esta categoria ou tipo de anúncio (atributos, frete, fotos). Confira category_id e atributos obrigatórios em /categories/$CATEGORY_ID/attributes.`;
  }
  return msg;
}

function mapSaleTermsForMlBody(saleTerms) {
  return (saleTerms || [])
    .filter((t) => t && t.id && (t.value_id || (t.value_name != null && String(t.value_name).trim() !== '')))
    .map((t) => ({
      id: t.id,
      ...(t.value_id ? { value_id: t.value_id } : {}),
      ...(t.value_name != null && String(t.value_name).trim() !== '' ? { value_name: t.value_name } : {}),
    }));
}

/** ML POST /items: family_name máximo 60 caracteres (erro item.family_name.length_invalid). */
const ML_ITEM_FAMILY_NAME_MAX = 60;

function trimMlItemFamilyName(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return '';
  return s.length <= ML_ITEM_FAMILY_NAME_MAX ? s : s.substring(0, ML_ITEM_FAMILY_NAME_MAX);
}

/** EAN na coluna ad_models.ean (ou EAN/UPC em attributes) → GTIN no POST /items; ML exige GTIN em várias categorias. */
function mergeModelEanIntoGtinAttribute(publishAttrs, modelEan) {
  const attrs = [...(publishAttrs || [])];
  let digits = String(modelEan == null ? '' : modelEan).trim().replace(/\D/g, '');
  if (!digits) {
    const eanAttr = attrs.find(
      (a) =>
        a &&
        (a.id === 'EAN' || a.id === 'UPC') &&
        a.value_name != null &&
        String(a.value_name).trim() !== '' &&
        String(a.value_name).trim() !== '-1'
    );
    if (eanAttr) digits = String(eanAttr.value_name).replace(/\D/g, '');
  }
  if (!digits || digits.length < 8 || digits.length > 14) return publishAttrs;
  const idx = attrs.findIndex((a) => a && a.id === 'GTIN');
  if (idx >= 0) {
    const ex = attrs[idx];
    const hasVal =
      (ex.value_name != null &&
        String(ex.value_name).trim() !== '' &&
        String(ex.value_name).trim() !== '-1') ||
      (ex.value_id != null && String(ex.value_id).trim() !== '');
    if (!hasVal) attrs[idx] = { ...ex, id: 'GTIN', value_name: digits, value_id: null };
  } else {
    attrs.push({ id: 'GTIN', value_name: digits, value_id: null });
  }
  return attrs;
}

const mlCategoryAttributesCache = new Map();

async function fetchMlCategoryAttributesPublic(categoryId) {
  if (!categoryId) return [];
  const cached = mlCategoryAttributesCache.get(categoryId);
  if (cached && Date.now() - cached.at < 30 * 60 * 1000) return cached.data;
  const resp = await axios.get(
    `https://api.mercadolibre.com/categories/${encodeURIComponent(categoryId)}/attributes`,
    { timeout: 15000 }
  );
  const data = Array.isArray(resp.data) ? resp.data : [];
  mlCategoryAttributesCache.set(categoryId, { at: Date.now(), data });
  return data;
}

function mlAttrDefsRequiredForListing(categoryAttrs) {
  return (categoryAttrs || []).filter(
    (a) => a && a.id && a.tags && (a.tags.required === true || a.tags.catalog_required === true)
  );
}

function collectPresentAttrIdsFromPublishModel(publishAttrs, variations) {
  const ids = new Set();
  const addVal = (a) => {
    if (!a || !a.id) return;
    const hasVal =
      (a.value_id != null && String(a.value_id).trim() !== '') ||
      (a.value_name != null && String(a.value_name).trim() !== '');
    if (hasVal) ids.add(a.id);
  };
  for (const a of publishAttrs || []) addVal(a);
  for (const v of variations || []) {
    for (const a of v.attributes || []) addVal(a);
    for (const ac of v.attribute_combinations || []) {
      if (ac && ac.id) {
        const hasVal =
          (ac.value_id != null && String(ac.value_id).trim() !== '') ||
          (ac.value_name != null && String(ac.value_name).trim() !== '');
        if (hasVal) ids.add(ac.id);
      }
    }
  }
  return ids;
}

/** Valida atributos obrigatórios (tags.required) da categoria antes do POST /items (evita item.attributes.missing_required). */
async function mlValidateRequiredAttributesForPublish(categoryId, publishAttrs, variations) {
  if (!categoryId) return { ok: true };
  try {
    const defs = await fetchMlCategoryAttributesPublic(categoryId);
    const required = mlAttrDefsRequiredForListing(defs);
    if (required.length === 0) return { ok: true };
    const present = collectPresentAttrIdsFromPublishModel(publishAttrs, variations);
    const missing = required.filter((r) => !present.has(r.id));
    if (missing.length === 0) return { ok: true };
    return {
      ok: false,
      missing: missing.map((m) => ({ id: m.id, name: m.name || m.id })),
    };
  } catch (e) {
    console.warn('[ML] Não foi possível validar atributos obrigatórios da categoria:', e.message);
    return { ok: true };
  }
}

/** Anúncio com variações: soma available_quantity no item; mantém family_name (ML exige em muitas categorias / preço por variação). */
function finalizeMlPublishBodyWithVariations(body, effectiveQtyFallback) {
  const vars = body.variations;
  if (!Array.isArray(vars) || vars.length === 0) return;
  const sum = vars.reduce((acc, v) => acc + (Number(v && v.available_quantity) || 0), 0);
  const fb = Number(effectiveQtyFallback);
  body.available_quantity = sum > 0 ? sum : (Number.isFinite(fb) && fb > 0 ? fb : 1);
}

/**
 * POST /items — contas em preço por variação / família de produto:
 * - Exigem `family_name` (body.required_fields) e rejeitam `title` no mesmo body (body.invalid_fields [title]).
 * - Documentação ML (User Products): não enviar title; o site monta o título a partir de atributos.
 * Garante family_name a partir do title do body se faltar; remove sempre `title` antes do POST.
 */
function mlFinalizeMlItemPostBody(body) {
  if (!body) return;
  let fn = body.family_name != null ? String(body.family_name).trim() : '';
  if (!fn) {
    const t = body.title != null ? String(body.title).trim() : '';
    fn = t || 'Produto';
  }
  body.family_name = trimMlItemFamilyName(fn) || 'Produto';
  delete body.title;
}

function mlAttrToPayload(a) {
  if (!a || !a.id) return null;
  const o = { id: a.id };
  if (a.value_id) o.value_id = a.value_id;
  if (a.value_name != null && String(a.value_name).trim() !== '') o.value_name = a.value_name;
  return o.value_id || o.value_name ? o : null;
}

/**
 * Modo User Products: cada variação vira um POST /items separado. O array `attributes` do modelo
 * costuma incluir SELLER_SKU do nível do item (estoque / SKU único); ao mesclar em todas as
 * variações, o mesmo SKU ia para todos os anúncios. Importações do ML trazem SKU por variação
 * em seller_custom_field / attributes da variação — não repetem esse atributo no item.
 */
function omitItemLevelSellerSkuForUserProductPosts(attrs) {
  return (attrs || []).filter((a) => a && String(a.id || '') !== 'SELLER_SKU');
}

function mergeAttributesForMlUserProductVariation(publishAttrs, variation) {
  const byId = new Map();
  for (const a of publishAttrs || []) {
    const p = mlAttrToPayload(a);
    if (p) byId.set(p.id, p);
  }
  for (const ac of variation.attribute_combinations || []) {
    if (!ac || !ac.id) continue;
    const p = { id: ac.id };
    if (ac.value_id) p.value_id = ac.value_id;
    if (ac.value_name != null && String(ac.value_name).trim() !== '') p.value_name = ac.value_name;
    if (p.value_id || p.value_name) byId.set(p.id, p);
  }
  for (const a of variation.attributes || []) {
    const p = mlAttrToPayload(a);
    if (p) byId.set(p.id, p);
  }
  return Array.from(byId.values());
}

/** Alinha atributo SELLER_SKU ao seller_custom_field da linha (evita divergência com merge). */
function finalizeUserProductVariationAttributes(merged, variation) {
  const sku = String(variation.seller_custom_field || '').trim();
  if (!sku) return merged;
  const rest = (merged || []).filter((a) => a && a.id !== 'SELLER_SKU');
  rest.push({ id: 'SELLER_SKU', value_name: sku });
  return rest;
}

function mlPicturesPayloadForVariation(pictures, variation) {
  const pics = Array.isArray(pictures) ? pictures : [];
  const all = pics.map(p => ({ source: p.source || p.secure_url })).filter((p) => p.source);
  const ids = variation.picture_ids || [];
  if (!ids.length) return all;
  const picked = ids.map((i) => all[Number(i)]).filter(Boolean);
  return picked.length ? picked : all;
}

/** Objeto shipping do item ML (JSON no modelo) para repostagem — evita body.invalid_fields por campos extras. */
function mlShippingFromAdModelRow(row) {
  if (!row || row.shipping == null || row.shipping === '') return null;
  try {
    const o = typeof row.shipping === 'string' ? JSON.parse(row.shipping) : row.shipping;
    if (!o || typeof o !== 'object') return null;
    const out = {};
    if (o.mode != null && o.mode !== '') out.mode = o.mode;
    if (o.free_shipping != null) out.free_shipping = !!o.free_shipping;
    if (o.local_pick_up != null) out.local_pick_up = !!o.local_pick_up;
    if (o.logistic_type != null && o.logistic_type !== '') out.logistic_type = o.logistic_type;
    if (Array.isArray(o.tags)) out.tags = o.tags;
    if (o.dimensions && typeof o.dimensions === 'object') out.dimensions = o.dimensions;
    if (Array.isArray(o.methods)) out.methods = o.methods;
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

/** Remove atributos de embalagem antigos ou duplicados (ML usa PACKAGE_* ou seller_package_* conforme categoria). */
const ML_PACKAGE_ATTR_IDS = [
  'PACKAGE_WIDTH', 'PACKAGE_HEIGHT', 'PACKAGE_LENGTH', 'PACKAGE_WEIGHT',
  'seller_package_width', 'seller_package_height', 'seller_package_length', 'seller_package_weight',
];

function parseAdModelPackageMeasures(row) {
  if (!row || row.package_measures == null || row.package_measures === '') return null;
  try {
    const o = typeof row.package_measures === 'string' ? JSON.parse(row.package_measures) : row.package_measures;
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

/** Inclui atributos de embalagem no POST /items. Muitas categorias exigem seller_package_* (erro API se faltar). Dimensões em cm; peso em kg no modelo → gramas na API. */
function applyPackageMeasuresToMlAttributes(attrs, packageMeasures) {
  const pkgSet = new Set(ML_PACKAGE_ATTR_IDS);
  const base = (attrs || []).filter((a) => a && !pkgSet.has(a.id));
  if (!packageMeasures || packageMeasures.has_factory_packaging === false) return base;
  const w = Number(packageMeasures.width_cm);
  const h = Number(packageMeasures.height_cm);
  const d = Number(packageMeasures.depth_cm);
  const kg = Number(packageMeasures.weight_kg);
  if (![w, h, d, kg].every((n) => Number.isFinite(n) && n > 0)) return base;
  const grams = Math.max(1, Math.round(kg * 1000));
  return [
    ...base,
    { id: 'seller_package_width', value_name: `${w} cm` },
    { id: 'seller_package_height', value_name: `${h} cm` },
    { id: 'seller_package_length', value_name: `${d} cm` },
    { id: 'seller_package_weight', value_name: `${grams} g` },
  ];
}

/**
 * Pré-validação leve de um modelo antes de publicar. Útil para a UI apontar problemas
 * (imagens, preço, categoria Shopee/ML, atributos obrigatórios ML) sem consumir a API
 * dos marketplaces.
 */
app.post('/api/ad-models/:id/validate-publish', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { marketplace } = req.body || {};
  const mp = (marketplace || 'ml').toLowerCase();
  try {
    const model = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM ad_models WHERE id = ?', [id], (err, row) => {
        if (err) return reject(err);
        if (!row) return reject(new Error('Modelo não encontrado'));
        resolve(row);
      });
    });
    const issues = [];
    const warnings = [];
    let pictures = []; try { pictures = JSON.parse(model.pictures || '[]'); } catch {}
    let variations = []; try { variations = JSON.parse(model.variations || '[]'); } catch {}
    let attributes = []; try { attributes = JSON.parse(model.attributes || '[]'); } catch {}

    if (!model.title || !String(model.title).trim()) issues.push({ code: 'title', message: 'Título vazio' });
    if (!pictures.length) issues.push({ code: 'pictures', message: 'Modelo sem imagens' });

    if (mp === 'shopee') {
      const maps = parseAdModelMarketplaceMappings(model);
      const catId = maps.channels?.shopee?.category_id;
      if (!catId || !Number.isFinite(parseInt(catId, 10))) {
        issues.push({ code: 'shopee_category', message: 'Categoria Shopee não definida (Modelo → Mapeamento multi-marketplace)' });
      }
      const hasVar = variations.some((v) => v.attribute_combinations && v.attribute_combinations.length > 0);
      if (hasVar) {
        const { tierVariation } = buildShopeeTierVariationsFromVariations(variations);
        if (tierVariation.length > 2) {
          warnings.push({ code: 'shopee_tiers_excess', message: `A Shopee aceita no máximo 2 tiers de variação; ${tierVariation.length} detectados — somente os 2 primeiros serão usados.` });
        }
        for (const v of variations) {
          if (!Number(v.price) || Number(v.price) <= 0) {
            warnings.push({ code: 'shopee_variation_price', message: `Variação "${(v.attribute_combinations || []).map((c) => c.value_name).filter(Boolean).join(' / ') || v.seller_custom_field || '?'}" sem preço — usará o preço base.` });
          }
        }
      }
      if (!Number(model.price) || Number(model.price) <= 0) {
        issues.push({ code: 'price', message: 'Preço base inválido' });
      }
    } else if (mp === 'ml') {
      if (!model.category_id) issues.push({ code: 'ml_category', message: 'category_id (ML) não definido' });
      try {
        const check = await mlValidateRequiredAttributesForPublish(model.category_id, attributes, variations);
        if (!check.ok) {
          for (const m of check.missing) {
            issues.push({ code: `ml_attr_${m.id}`, message: `Atributo obrigatório do ML faltando: ${m.name} (${m.id})` });
          }
        }
      } catch (e) {
        warnings.push({ code: 'ml_attr_check_fail', message: `Não foi possível validar atributos ML: ${e.message}` });
      }
    } else {
      return res.status(400).json({ error: 'Marketplace não suportado' });
    }
    res.json({ ok: issues.length === 0, issues, warnings, marketplace: mp });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Publica um modelo em múltiplos destinos em uma única chamada.
 * Body: { targets: [{ marketplace: 'ml'|'shopee', accountId: number, price?, listing_type_id?, available_quantity? }] }
 * Itera os destinos sequencialmente (com pequeno delay) e devolve um relatório.
 * Cada destino reutiliza o mesmo endpoint /publish via chamada interna HTTP (inclui auth do requester).
 */
/**
 * Biblioteca de mídia: devolve URLs únicas de imagens usadas em ad_models.
 * Usada pelo frontend no modal de edição para reaproveitar fotos sem reupload.
 * Query params: search (texto para filtrar por título do modelo), limit (default 60).
 */
app.get('/api/ad-models/media-library', (req, res) => {
  const search = (req.query.search || '').toString().trim();
  const limit = Math.min(parseInt(req.query.limit, 10) || 60, 300);
  const rowsSql = search
    ? `SELECT id, title, pictures FROM ad_models WHERE (title LIKE ? OR sku LIKE ?) AND pictures IS NOT NULL AND pictures != '' ORDER BY updated_at DESC LIMIT 500`
    : `SELECT id, title, pictures FROM ad_models WHERE pictures IS NOT NULL AND pictures != '' ORDER BY updated_at DESC LIMIT 500`;
  const params = search ? [`%${search}%`, `%${search}%`] : [];
  db.all(rowsSql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const seen = new Map();
    for (const r of rows || []) {
      let pics = [];
      try { pics = JSON.parse(r.pictures || '[]'); } catch { pics = []; }
      for (const p of pics) {
        const url = p.source || p.secure_url;
        if (!url) continue;
        if (seen.has(url)) {
          const prev = seen.get(url);
          prev.usage_count = (prev.usage_count || 1) + 1;
        } else {
          seen.set(url, {
            url,
            id: p.id || null,
            source_model_id: r.id,
            source_model_title: r.title || '',
            usage_count: 1,
          });
        }
      }
      if (seen.size >= limit * 3) break;
    }
    const items = Array.from(seen.values()).slice(0, limit);
    res.json({ items });
  });
});

app.post('/api/ad-models/:id/publish-multi', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const targets = Array.isArray(req.body?.targets) ? req.body.targets : [];
  if (targets.length === 0) return res.status(400).json({ error: 'targets é obrigatório e deve ser uma lista não vazia' });

  const exists = await new Promise((resolve) => {
    db.get('SELECT id FROM ad_models WHERE id = ?', [id], (err, row) => resolve(!err && row));
  });
  if (!exists) return res.status(404).json({ error: 'Modelo não encontrado' });

  const base = `http://127.0.0.1:${PORT}`;
  const headers = {};
  if (req.headers.authorization) headers.Authorization = req.headers.authorization;

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i] || {};
    if (i > 0) await delay(700);
    const mp = (t.marketplace || '').toLowerCase();
    if (mp !== 'ml' && mp !== 'shopee') { results.push({ ...t, success: false, error: 'Marketplace não suportado' }); continue; }
    if (!t.accountId) { results.push({ ...t, success: false, error: 'accountId obrigatório' }); continue; }
    try {
      const body = {
        marketplace: mp,
        accountId: t.accountId,
        price: t.price,
        listing_type_id: t.listing_type_id,
        available_quantity: t.available_quantity,
        variation_prices: t.variation_prices,
      };
      const r = await axios.post(`${base}/api/ad-models/${id}/publish`, body, { headers, timeout: 120000 });
      results.push({
        marketplace: mp,
        accountId: t.accountId,
        success: true,
        item_id: r.data?.newItemId,
        permalink: r.data?.permalink,
        variationsPublished: r.data?.variationsPublished,
      });
    } catch (err) {
      const msg = err.response?.data?.error || err.message || 'Erro desconhecido';
      console.error('[publish-multi] target failed:', msg);
      results.push({ marketplace: mp, accountId: t.accountId, success: false, error: msg, details: err.response?.data });
    }
  }

  const ok = results.filter((r) => r.success).length;
  res.json({ success: ok === targets.length, total: targets.length, published: ok, results });
});

app.post('/api/ad-models/:id/publish', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { marketplace, accountId, price: overridePrice, listing_type_id: overrideListingType,
    available_quantity: overrideQty, variation_prices: overrideVarPrices } = req.body;
  if (!marketplace || !accountId) return res.status(400).json({ error: 'marketplace e accountId obrigatórios' });
  if (marketplace !== 'ml' && marketplace !== 'shopee') return res.status(400).json({ error: 'Marketplace não suportado' });

  try {
    const model = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM ad_models WHERE id = ?', [id], (err, row) => {
        if (err) return reject(err);
        if (!row) return reject(new Error('Modelo não encontrado'));
        resolve(row);
      });
    });

    if (marketplace === 'shopee') {
      const result = await publishAdModelToShopee(model, accountId, { price: overridePrice, qty: overrideQty });
      const pubPrice = Number(overridePrice != null ? overridePrice : model.price) || 0;
      const items = (result.items && result.items.length > 0)
        ? result.items
        : [{ published_item_id: String(result.item_id), permalink: result.permalink || null }];
      await savePublicationWithItems({
        adModelId: id,
        marketplace: 'shopee',
        accountId,
        publishedItemId: String(result.item_id),
        publishedPrice: pubPrice,
        publishedListingType: null,
        items,
      });
      return res.json({
        success: true,
        newItemId: String(result.item_id),
        permalink: result.permalink,
        marketplace: 'shopee',
        variationsPublished: items.length > 1 ? items.length : undefined,
      });
    }

    const pictures = JSON.parse(model.pictures || '[]');
    const attributes = JSON.parse(model.attributes || '[]');
    let variations = normalizeAdModelVariationPictureIds(JSON.parse(model.variations || '[]'), pictures);
    const saleTerms = JSON.parse(model.sale_terms || '[]');

    const effectivePrice = toMlPriceNumber(overridePrice != null ? overridePrice : model.price);
    const effectiveListingType = overrideListingType || model.listing_type_id || 'gold_special';
    const effectiveQty = toMlQuantityInt(overrideQty != null ? overrideQty : model.available_quantity);

    let title = model.title || '';
    if (title.length > 60) title = title.substring(0, 60);
    // User Products (ML): family_name obrigatório; máx. 60 chars (item.family_name.length_invalid)
    const familyName = trimMlItemFamilyName(String(model.title || '').trim()) || trimMlItemFamilyName(title) || 'Produto';

    let publishAttrs = attributes.filter(a => {
      if (['ITEM_CONDITION'].includes(a.id)) return false;
      return a.value_id || a.value_name;
    });
    publishAttrs = mergeModelEanIntoGtinAttribute(publishAttrs, model.ean);
    publishAttrs = applyPackageMeasuresToMlAttributes(publishAttrs, parseAdModelPackageMeasures(model));

    const validVariations = variations.filter(v => v.attribute_combinations && v.attribute_combinations.length > 0);

    const reqAttrCheck = await mlValidateRequiredAttributesForPublish(model.category_id, publishAttrs, variations);
    if (!reqAttrCheck.ok) {
      const list = reqAttrCheck.missing.map((m) => `${m.name} (${m.id})`).join(', ');
      return res.status(400).json({
        error: `Faltam atributos obrigatórios Mercado Livre para esta categoria: ${list}. Edite o modelo e preencha na ficha técnica (atributos do item ou importe um anúncio ML completo).`,
        missingAttributes: reqAttrCheck.missing,
        category_id: model.category_id,
      });
    }

    let isUpSeller = false;
    try {
      isUpSeller = await mlSellerIsUserProductSeller(accountId);
    } catch (e) {
      console.warn('[Ad Models] Não foi possível ler tags do vendedor ML:', e.message);
    }

    const publishAttrsUserProduct = omitItemLevelSellerSkuForUserProductPosts(publishAttrs);

    if (validVariations.length > 0 && isUpSeller) {
      const newResults = [];
      for (let idx = 0; idx < validVariations.length; idx++) {
        const v = validVariations[idx];
        const varPrice = toMlPriceNumber(
          overrideVarPrices && overrideVarPrices[String(idx)] != null
            ? overrideVarPrices[String(idx)]
            : (v.price != null ? v.price : effectivePrice)
        );
        const bodyUp = {
          family_name: familyName,
          category_id: model.category_id,
          price: varPrice,
          currency_id: model.currency_id || 'BRL',
          available_quantity: toMlQuantityInt(v.available_quantity),
          buying_mode: model.buying_mode || 'buy_it_now',
          listing_type_id: effectiveListingType,
          condition: model.condition || 'new',
          pictures: mlPicturesPayloadForVariation(pictures, v),
          attributes: finalizeUserProductVariationAttributes(
            mergeAttributesForMlUserProductVariation(publishAttrsUserProduct, v),
            v
          ),
        };
        if (v.seller_custom_field) bodyUp.seller_custom_field = v.seller_custom_field;
        if (saleTerms.length > 0) bodyUp.sale_terms = mapSaleTermsForMlBody(saleTerms);
        const shipUp = mlShippingFromAdModelRow(model);
        if (shipUp) bodyUp.shipping = shipUp;
        if (model.video_id && String(model.video_id).trim() !== '' && String(model.video_id).toLowerCase() !== 'null') {
          bodyUp.video_id = model.video_id;
        }

        console.log('[Ad Models] Publishing to ML (User Products):', JSON.stringify({ variant: idx + 1, total: validVariations.length, listing_type: effectiveListingType, price: varPrice }));
        const result = await mlApiPost('/items', bodyUp, accountId);
        newResults.push(result);
        if (model.description) {
          try { await mlApiPost(`/items/${result.id}/description`, { plain_text: model.description }, accountId); } catch {}
        }
        if (idx < validVariations.length - 1) await delay(400);
      }

      const first = newResults[0];
      await savePublicationWithItems({
        adModelId: id,
        marketplace: 'ml',
        accountId,
        publishedItemId: first.id,
        publishedPrice: effectivePrice,
        publishedListingType: effectiveListingType,
        items: newResults.map((r, idx) => {
          const v = validVariations[idx] || {};
          let variationKey = null;
          if (Array.isArray(v.attribute_combinations)) {
            variationKey = v.attribute_combinations
              .map((c) => `${c.id || ''}:${c.value_name || c.value_id || ''}`)
              .join('|');
          }
          return {
            published_item_id: r.id,
            permalink: r.permalink || null,
            external_sku: v.seller_custom_field || null,
            variation_key: variationKey,
          };
        }),
      });

      return res.json({
        success: true,
        newItemId: first.id,
        permalink: first.permalink,
        newItemIds: newResults.map(r => r.id),
        permalinks: newResults.map(r => r.permalink),
        userProductMode: true,
      });
    }

    const body = {
      title,
      category_id: model.category_id,
      price: effectivePrice,
      currency_id: model.currency_id || 'BRL',
      condition: model.condition || 'new',
      buying_mode: model.buying_mode || 'buy_it_now',
      listing_type_id: effectiveListingType,
      pictures: pictures.map(p => ({ source: p.source || p.secure_url })).filter((p) => p.source),
      attributes: publishAttrs.map(a => ({ id: a.id, ...(a.value_id ? { value_id: a.value_id } : {}), ...(a.value_name ? { value_name: a.value_name } : {}) })),
    };
    if (familyName) body.family_name = familyName;

    const shipPost = mlShippingFromAdModelRow(model);
    if (shipPost) body.shipping = shipPost;
    if (model.video_id && String(model.video_id).trim() !== '' && String(model.video_id).toLowerCase() !== 'null') {
      body.video_id = model.video_id;
    }

    if (variations.length > 0) {
      body.variations = variations
        .filter(v => v.attribute_combinations && v.attribute_combinations.length > 0)
        .map((v, idx) => {
          const varPrice = toMlPriceNumber(
            overrideVarPrices && overrideVarPrices[String(idx)] != null
              ? overrideVarPrices[String(idx)]
              : (v.price != null ? v.price : effectivePrice)
          );
          const varObj = {
            attribute_combinations: sanitizeAttributeCombinationsForMl(v.attribute_combinations),
            price: varPrice,
            available_quantity: toMlQuantityInt(v.available_quantity),
            picture_ids: sanitizeVariationPictureIds(v.picture_ids, pictures.length),
          };
          if (v.seller_custom_field) varObj.seller_custom_field = v.seller_custom_field;
          if (v.attributes && v.attributes.length > 0) {
            varObj.attributes = v.attributes.filter(a => a.id && (a.value_name || a.value_id))
              .map(a => ({ id: a.id, ...(a.value_id ? { value_id: a.value_id } : {}), ...(a.value_name ? { value_name: a.value_name } : {}) }));
          }
          return varObj;
        })
        .filter(v => v.attribute_combinations && v.attribute_combinations.length > 0);
      if (body.variations.length > 0) finalizeMlPublishBodyWithVariations(body, effectiveQty);
      else { body.available_quantity = effectiveQty; delete body.variations; }
    } else {
      body.available_quantity = effectiveQty;
    }

    if (saleTerms.length > 0) {
      body.sale_terms = mapSaleTermsForMlBody(saleTerms);
    }

    mlFinalizeMlItemPostBody(body);

    console.log('[Ad Models] Publishing to ML:', JSON.stringify({ listing_type: effectiveListingType, price: effectivePrice, variations: body.variations?.length || 0 }));
    const result = await mlApiPost('/items', body, accountId);

    await savePublicationWithItems({
      adModelId: id,
      marketplace: 'ml',
      accountId,
      publishedItemId: result.id,
      publishedPrice: effectivePrice,
      publishedListingType: effectiveListingType,
      items: [{ published_item_id: result.id, permalink: result.permalink || null }],
    });

    if (model.description) {
      try { await mlApiPost(`/items/${result.id}/description`, { plain_text: model.description }, accountId); } catch {}
    }

    res.json({ success: true, newItemId: result.id, permalink: result.permalink });
  } catch (err) {
    console.error('[Ad Models] Publish error:', err.message || err);
    if (err.response?.data) console.error('[Ad Models] Publish error details:', err.response.data);
    let errMsg = marketplace === 'ml' ? mlApiErrorToUserMessage(err) : (err.message || String(err));
    const shopeeDetails = { missingAttributes: [], missingValueIds: [], logisticsIssue: false, hint: null };
    if (marketplace === 'shopee') {
      // Pre-flight nosso: quando detectamos dropdown fechado sem value_id oficial,
      // o debug_message vem como "pre-flight: missing value_id for strict dropdown"
      // e a lista em err.response.data.missing_value_ids. Propaga pro frontend
      // para ele abrir direto o painel de importação.
      const preflightMissing = err.response?.data?.missing_value_ids;
      if (Array.isArray(preflightMissing) && preflightMissing.length > 0) {
        shopeeDetails.missingValueIds = preflightMissing;
      }
      // A Shopee retorna mensagens detalhadas no formato:
      //   "validation: [Rule Type: classification.attribute.mandatory,
      //     Detail: {"code":100010237,"msg":"Attribute is mandatory: id: 102385,
      //     name: Electrical Cables"}] ..."
      // Parseamos para destacar quais attribute_ids faltam.
      const attrMatches = [...String(errMsg).matchAll(/Attribute is mandatory:\s*id:\s*(\d+),\s*name:\s*([^"\]}]+)/gi)];
      if (attrMatches.length > 0) {
        shopeeDetails.missingAttributes = attrMatches.map(m => ({ attribute_id: parseInt(m[1], 10), name: m[2].trim() }));
        const humanList = shopeeDetails.missingAttributes.map(a => `• ${a.name} (id ${a.attribute_id})`).join('\n');
        errMsg = `A Shopee rejeitou a publicação porque faltam atributos obrigatórios da categoria:\n${humanList}\n\nAbra o Modelo → Mapeamento Multi-marketplace → Shopee → "Ficha técnica" e preencha cada um antes de republicar.`;
      } else if (/invalid_brand|brand.*required|Brand information required/i.test(errMsg)) {
        errMsg = 'Shopee exige o atributo "Marca" nessa categoria. Abra o modelo → Mapeamento Multi-marketplace → Shopee e escolha uma marca (use "Sem Marca" se não tiver).';
      }
      if (/logistics?\.channel(\.exist)?|channel not found in shop/i.test(String(err.response?.data?.debug_message || errMsg))) {
        shopeeDetails.logisticsIssue = true;
        const logHint = 'A loja Shopee não tem canais de envio ativos — habilite pelo menos um canal em Seller Center → Envio antes de publicar.';
        errMsg = shopeeDetails.missingAttributes.length > 0 ? `${errMsg}\n\n${logHint}` : logHint;
      }
      // Erro code 3013 (attribute_single_drop_down) = value enviado sem value_id
      // oficial ou com value_id que a Shopee não reconhece. Acontece quando o
      // seller usou as opções do catálogo "Sugerido" do miti (value_id=null).
      const debugMsg = String(err.response?.data?.debug_message || '');
      const cannotCustomize = /cannot be customized/i.test(String(errMsg)) || /attribute_single_drop_down/i.test(debugMsg);
      if (cannotCustomize) {
        shopeeDetails.customizeIssue = true;
        const hint = 'A Shopee rejeitou valores de dropdown porque eles precisam do value_id OFICIAL (numérico) da categoria. O catálogo "Sugerido" do miti só funciona quando a Shopee aceita o nome em inglês, o que não é o caso aqui.\n\nComo resolver:\n  1. Abra o modelo → "Ficha técnica Shopee" e clique em "Importar de anúncio Shopee".\n  2. Cole a URL/ID de um anúncio seu JÁ publicado nesta categoria — o miti copia os value_ids corretos.\n  3. Se este é o seu 1º item nesta categoria, publique pelo Seller Center (web) uma vez e depois use a importação aqui para todos os próximos.';
        errMsg = `${errMsg}\n\n${hint}`;
      }
    }
    const mp = marketplace === 'shopee' ? 'shopee' : 'ml';
    await savePublicationWithItems({
      adModelId: id, marketplace: mp, accountId, status: 'error', errorMessage: errMsg, items: [],
    }).catch(() => {});
    res.status(500).json({
      error: errMsg,
      details: err.response?.data,
      shopee: marketplace === 'shopee' ? shopeeDetails : undefined,
    });
  }
});

// Lista os atributos (ficha técnica) de uma categoria Shopee.
// Retorna 424 com motivo quando o endpoint /get_attributes é bloqueado (403),
// para o frontend mostrar modo manual.
app.get('/api/shopee/categories/:categoryId/attributes', async (req, res) => {
  const categoryId = parseInt(req.params.categoryId, 10);
  const accountId = parseInt(req.query.accountId, 10);
  if (!categoryId || !accountId) return res.status(400).json({ error: 'categoryId e accountId obrigatórios' });
  try {
    const list = await shopeeGetCategoryAttributes(accountId, categoryId);
    const catDefaults = shopeeCategoryDefaultsMem.get(String(categoryId)) || new Map();
    const simplified = list.map(a => {
      const def = catDefaults.get(String(a.attribute_id)) || null;
      return {
        attribute_id: a.attribute_id,
        name: a.display_attribute_name || a.original_attribute_name || a.attribute_name || `Atributo ${a.attribute_id}`,
        original_name: a.original_attribute_name || a.attribute_name || '',
        is_mandatory: !!a.is_mandatory,
        input_type: a.input_type,
        input_validation_type: a.input_validation_type,
        format_type: a.format_type,
        attribute_unit: a.attribute_unit || [],
        // Indica se o atributo veio do catálogo manual do miti (não da API
        // oficial). O frontend pode mostrar um selo "sugerido" para deixar
        // claro que são valores curados e não oficiais.
        from_static_catalog: !!a._fromStaticCatalog,
        from_manual_override: !!a._fromManualOverride,
        values: (a.attribute_value_list || a.values || []).map(v => ({
          value_id: v.value_id,
          name: v.display_value_name || v.original_value_name || v.value_name || '',
          original_name: v.original_value_name || '',
        })),
        // Default salvo pela categoria (último import/merge). Frontend usa
        // pra pré-preencher campos vazios em modelos novos.
        default: def ? {
          value_id: def.value_id,
          original_value_name: def.original_value_name,
          display_value_name: def.display_value_name,
          value_unit: def.value_unit,
        } : null,
      };
    });
    simplified.sort((a, b) => (b.is_mandatory ? 1 : 0) - (a.is_mandatory ? 1 : 0));
    if (simplified.length === 0) {
      // Nenhum dos endpoints conhecidos devolveu atributos — mesmo efeito prático
      // de ser bloqueado por permissão. Frontend cai em modo manual.
      return res.status(424).json({
        error: 'blocked',
        message: 'A Shopee não retornou atributos para essa categoria nos endpoints testados (get_attribute_tree / get_recommend_attribute / global_product). Isso costuma indicar que o app Shopee conectado ainda não tem a permissão "Product Info" ou "Product Read" aprovada, ou que a categoria não é publicável pelo app atual. Configure os atributos manualmente abaixo — os IDs obrigatórios aparecem na mensagem de erro ao tentar publicar.',
        shopee_status: 200,
        shopee_error: 'empty_list',
      });
    }
    res.json({
      attributes: simplified,
      mandatory_count: simplified.filter(a => a.is_mandatory).length,
      total: simplified.length,
    });
  } catch (err) {
    const status = err.response?.status;
    const payload = err.response?.data || {};
    const msg = payload.message || err.message || 'erro desconhecido';
    console.error('[Shopee] get_attribute_tree error:', payload || msg);
    // 403 / KYC = API Product Info ainda não aprovada para o partner/app Shopee
    // OU loja sem KYC validado. Caímos no modo manual para o seller não ficar travado.
    if (status === 403 || /permission|error_auth|access.*forbidden|kyc/i.test(msg)) {
      return res.status(424).json({
        error: 'blocked',
        message: 'A Shopee bloqueou a listagem de atributos dessa categoria (status 403). Motivo usual: app Shopee sem a permissão "Product Info" aprovada, ou a loja ainda não passou o KYC no Seller Center. Enquanto isso, configure os atributos manualmente aqui (informe attribute_id + valor). Os IDs obrigatórios aparecem nas mensagens de erro quando você tenta publicar.',
        shopee_status: status,
        shopee_error: payload.error || null,
      });
    }
    res.status(500).json({ error: msg, details: payload });
  }
});

// Lista as marcas (brand_list) oficiais de uma categoria Shopee.
// Filtra por ?search= quando enviado (case-insensitive em display/original).
app.get('/api/shopee/categories/:categoryId/brands', async (req, res) => {
  const categoryId = parseInt(req.params.categoryId, 10);
  const accountId = parseInt(req.query.accountId, 10);
  const search = (req.query.search || '').toString().trim().toLowerCase();
  if (!categoryId || !accountId) return res.status(400).json({ error: 'categoryId e accountId obrigatórios' });
  try {
    const list = await shopeeGetBrandList(accountId, categoryId);
    // Garante que "Sem marca" / "No Brand" apareça primeiro na lista.
    const noBrandIdx = list.findIndex(b =>
      b.brand_id === 0 ||
      /^no\s*brand$/i.test(b.original_brand_name) ||
      /^sem\s*marca$/i.test(b.display_brand_name)
    );
    if (noBrandIdx > 0) {
      const nb = list.splice(noBrandIdx, 1)[0];
      list.unshift(nb);
    } else if (noBrandIdx === -1) {
      list.unshift({ brand_id: 0, original_brand_name: 'No Brand', display_brand_name: 'Sem Marca' });
    }

    const filtered = search
      ? list.filter(b =>
          b.original_brand_name.toLowerCase().includes(search) ||
          b.display_brand_name.toLowerCase().includes(search) ||
          String(b.brand_id) === search
        )
      : list;

    res.json({
      brands: filtered.slice(0, 80).map(b => ({
        brand_id: b.brand_id,
        name: b.display_brand_name || b.original_brand_name,
        original_name: b.original_brand_name,
      })),
      total: filtered.length,
    });
  } catch (err) {
    console.error('[Shopee] get_brand_list error:', err.response?.data || err.message);
    res.status(500).json({
      error: err.response?.data?.message || err.message,
      details: err.response?.data,
    });
  }
});

// Extrai o item_id de uma URL Shopee (aceita também puro número).
// Ex.: "https://shopee.com.br/trilho-2-spots-i.1234567.8901234" → 8901234
function extractShopeeItemId(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) return s;
  // Formato padrão: -i.SHOPID.ITEMID
  const m = s.match(/i\.(\d+)\.(\d+)/);
  if (m) return m[2];
  // Fallback: último segmento numérico longo da URL
  const digits = s.match(/\d{6,}/g);
  if (digits && digits.length) return digits[digits.length - 1];
  return null;
}

// Importa os attribute_list de um anúncio Shopee JÁ PUBLICADO.
// Use quando o get_attribute_tree está bloqueado por permissão: basta um
// item_id de produto similar já ativo na loja (ou em qualquer loja da Shopee)
// para copiar os value_ids oficiais.
app.get('/api/shopee/items/:itemId/attributes', async (req, res) => {
  const accountId = parseInt(req.query.accountId, 10);
  const itemId = extractShopeeItemId(req.params.itemId);
  if (!itemId || !accountId) return res.status(400).json({ error: 'itemId (ou URL Shopee) e accountId são obrigatórios' });
  try {
    const baseResp = await shopeeApiGet('/api/v2/product/get_item_base_info', {
      item_id_list: String(itemId),
      need_attribute: 'true',
      need_tax_info: 'false',
      need_complaint_policy: 'false',
    }, accountId);
    const item = ((baseResp.response || baseResp).item_list || [])[0];
    if (!item) return res.status(404).json({ error: `Item ${itemId} não encontrado na sua loja Shopee. Ele precisa estar publicado na conta conectada.` });
    const attrs = item.attribute_list || [];
    const simplified = attrs.map(a => {
      const first = (a.attribute_value_list || [])[0] || {};
      return {
        attribute_id: a.attribute_id,
        name: a.display_attribute_name || a.original_attribute_name || a.attribute_name || `Atributo ${a.attribute_id}`,
        original_name: a.original_attribute_name || a.attribute_name || '',
        is_mandatory: !!a.is_mandatory,
        value_id: first.value_id != null ? Number(first.value_id) : null,
        original_value_name: first.original_value_name || '',
        display_value_name: first.display_value_name || '',
        value_unit: first.value_unit || '',
      };
    });
    // Persiste merge+defaults para a categoria — assim próximos modelos da
    // mesma categoria já abrem com value_ids oficiais e campos pré-preenchidos.
    let persistInfo = null;
    if (item.category_id && simplified.length > 0) {
      try {
        persistInfo = shopeeMergeAttributesForCategory(item.category_id, simplified);
      } catch (e) {
        console.warn('[Shopee] failed to persist imported attributes:', e.message);
      }
    }
    res.json({
      item_id: String(itemId),
      category_id: item.category_id,
      item_name: item.item_name,
      attributes: simplified,
      persisted: persistInfo,
    });
  } catch (err) {
    const status = err.response?.status || 500;
    const payload = err.response?.data || {};
    console.error(`[Shopee] get_item_base_info(attributes) error for item ${itemId}:`, payload || err.message);
    res.status(status === 200 ? 500 : status).json({
      error: payload.message || err.message || 'erro desconhecido',
      shopee_error: payload.error || null,
    });
  }
});

// Grava um override manual de ficha técnica para uma categoria Shopee.
// Fluxo alternativo (quando o seller não quer/pode publicar pelo Seller Center
// primeiro): o seller abre o Seller Center com DevTools, copia o JSON da
// requisição `get_attribute` (ou similar) e cola aqui. O miti detecta o formato,
// extrai attribute_id/value_id/nomes e salva como override por categoria.
// Aceita vários formatos de colagem: a resposta direta do Seller Center, ou só
// o array de atributos, ou a resposta da API pública Open Platform.
app.post('/api/shopee/categories/:categoryId/attributes/override', async (req, res) => {
  const categoryId = parseInt(req.params.categoryId, 10);
  const { json, raw } = req.body || {};
  if (!categoryId) return res.status(400).json({ error: 'categoryId obrigatório' });
  // Aceita tanto objeto já parseado (`json`) quanto string crua (`raw`).
  let parsed = json;
  if (!parsed && typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch (e) {
      return res.status(400).json({ error: 'JSON inválido: ' + e.message });
    }
  }
  if (!parsed) return res.status(400).json({ error: 'forneça "json" (objeto) ou "raw" (string JSON).' });

  // Normaliza: tenta encontrar o array de atributos em vários caminhos possíveis.
  const findAttrArray = (obj) => {
    if (!obj) return null;
    if (Array.isArray(obj)) return obj;
    // Seller Center Shopee: { data: { attribute_list: [...] } } OU { data: { list: [...] } }
    if (Array.isArray(obj.attribute_list)) return obj.attribute_list;
    if (Array.isArray(obj.attributes)) return obj.attributes;
    if (Array.isArray(obj.list)) return obj.list;
    if (Array.isArray(obj.data)) return obj.data;
    if (obj.data) return findAttrArray(obj.data);
    if (obj.response) return findAttrArray(obj.response);
    if (obj.result) return findAttrArray(obj.result);
    return null;
  };
  const attrs = findAttrArray(parsed);
  if (!attrs || attrs.length === 0) {
    return res.status(400).json({ error: 'Não consegui encontrar um array de atributos no JSON colado. Verifique se você copiou a resposta completa da requisição get_attribute do Seller Center.' });
  }

  // Converte para o formato canônico usado pelo miti (igual ao da API oficial).
  const normalized = attrs
    .map((a) => {
      const attributeId = Number(a.attribute_id || a.id);
      if (!Number.isFinite(attributeId) || attributeId <= 0) return null;
      const values = (a.attribute_value_list || a.values || a.value_list || a.options || []).map((v) => {
        const valueId = Number(v.value_id || v.id || v.val_id);
        return {
          value_id: Number.isFinite(valueId) ? valueId : 0,
          original_value_name: v.original_value_name || v.original_name || v.name || v.value || '',
          display_value_name: v.display_value_name || v.display_name || v.translate_value || v.name || v.value || '',
          value_unit: v.value_unit || '',
        };
      }).filter(v => v.original_value_name || v.value_id);
      return {
        attribute_id: attributeId,
        original_attribute_name: a.original_attribute_name || a.original_name || a.attribute_name || a.name || '',
        display_attribute_name: a.display_attribute_name || a.display_name || a.translate_name || a.name || '',
        is_mandatory: !!(a.is_mandatory || a.mandatory || a.required),
        input_type: a.input_type || a.input || 'DROP_DOWN',
        input_validation_type: a.input_validation_type || 'STRING_TYPE',
        attribute_unit: a.attribute_unit || [],
        attribute_value_list: values,
      };
    })
    .filter(Boolean);
  if (normalized.length === 0) {
    return res.status(400).json({ error: 'Extraí 0 atributos válidos. Confira o JSON: os itens precisam ter attribute_id e attribute_value_list.' });
  }

  // Persiste em mem + SQLite.
  shopeeAttrsOverrideMem.set(String(categoryId), normalized);
  try {
    db.run(
      `INSERT INTO shopee_category_attrs_override (category_id, attributes_json, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(category_id) DO UPDATE SET attributes_json = excluded.attributes_json, updated_at = CURRENT_TIMESTAMP`,
      [categoryId, JSON.stringify(normalized)]
    );
  } catch (e) {
    console.error('[Shopee override] DB save failed:', e.message);
  }
  // Invalida cache da categoria para forçar refetch/rematch.
  for (const k of shopeeCategoryAttrsCache.keys()) {
    if (k.includes(`|${categoryId}|`)) shopeeCategoryAttrsCache.delete(k);
  }
  const withValueIds = normalized.filter(a => (a.attribute_value_list || []).some(v => v.value_id)).length;
  res.json({
    success: true,
    total: normalized.length,
    with_value_ids: withValueIds,
    preview: normalized.slice(0, 5).map(a => ({
      attribute_id: a.attribute_id,
      name: a.display_attribute_name || a.original_attribute_name,
      values_count: (a.attribute_value_list || []).length,
    })),
  });
});

// Remove override manual (volta a usar API/catálogo estático).
app.delete('/api/shopee/categories/:categoryId/attributes/override', async (req, res) => {
  const categoryId = parseInt(req.params.categoryId, 10);
  if (!categoryId) return res.status(400).json({ error: 'categoryId obrigatório' });
  shopeeAttrsOverrideMem.delete(String(categoryId));
  try {
    db.run('DELETE FROM shopee_category_attrs_override WHERE category_id = ?', [categoryId]);
  } catch (_) {}
  for (const k of shopeeCategoryAttrsCache.keys()) {
    if (k.includes(`|${categoryId}|`)) shopeeCategoryAttrsCache.delete(k);
  }
  res.json({ success: true });
});

// Mescla uma lista de atributos (com value_ids descobertos) dentro do override
// da categoria + grava como "default" por categoria/atributo. Usado pelo
// frontend após importar de um anúncio Shopee: o miti guarda os value_ids
// encontrados pra que próximos modelos da mesma categoria já usem os IDs
// oficiais, sem depender de novo import.
// Body esperado: { attributes: [{ attribute_id, value_id, original_value_name, display_value_name, value_unit? }] }
app.post('/api/shopee/categories/:categoryId/attributes/merge', async (req, res) => {
  const categoryId = parseInt(req.params.categoryId, 10);
  if (!categoryId) return res.status(400).json({ error: 'categoryId obrigatório' });
  const attributes = req.body?.attributes;
  if (!Array.isArray(attributes) || attributes.length === 0) {
    return res.status(400).json({ error: 'attributes deve ser um array com pelo menos 1 entrada.' });
  }
  try {
    const result = shopeeMergeAttributesForCategory(categoryId, attributes);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Shopee merge] endpoint error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Lista itens da loja Shopee filtrando por categoria. Útil pra mostrar ao seller
// "suas publicações nessa categoria" e copiar os atributos delas.
app.get('/api/shopee/items/by-category', async (req, res) => {
  const accountId = parseInt(req.query.accountId, 10);
  const categoryId = parseInt(req.query.categoryId, 10);
  const pageSize = Math.min(50, parseInt(req.query.pageSize, 10) || 20);
  if (!accountId) return res.status(400).json({ error: 'accountId obrigatório' });
  try {
    // 1) Pega lista dos itens NORMAL (ativos) da loja.
    const listResp = await shopeeApiGet('/api/v2/product/get_item_list', {
      offset: 0,
      page_size: pageSize,
      item_status: 'NORMAL',
    }, accountId);
    const listInner = listResp.response || listResp;
    const items = listInner.item || listInner.item_list || [];
    const ids = items.map(i => i.item_id).filter(Boolean);
    if (ids.length === 0) return res.json({ items: [] });
    // 2) Busca info básica em lote — só filtro quem bateu categoria.
    const infoResp = await shopeeApiGet('/api/v2/product/get_item_base_info', {
      item_id_list: ids.join(','),
    }, accountId);
    const infoItems = ((infoResp.response || infoResp).item_list || []);
    const filtered = categoryId
      ? infoItems.filter(i => Number(i.category_id) === Number(categoryId))
      : infoItems;
    res.json({
      items: filtered.map(i => ({
        item_id: i.item_id,
        item_name: i.item_name,
        category_id: i.category_id,
        item_sku: i.item_sku || '',
        item_status: i.item_status,
      })),
    });
  } catch (err) {
    const status = err.response?.status || 500;
    const payload = err.response?.data || {};
    console.error('[Shopee] items/by-category error:', payload || err.message);
    res.status(status === 200 ? 500 : status).json({
      error: payload.message || err.message || 'erro desconhecido',
    });
  }
});

app.post('/api/ad-models/bulk-publish', async (req, res) => {
  const { marketplace, accountId, items } = req.body;
  if (!marketplace || !accountId || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'marketplace, accountId e items (array) obrigatórios' });
  }
  if (marketplace !== 'ml' && marketplace !== 'shopee') return res.status(400).json({ error: 'Marketplace não suportado' });

  const results = { total: items.length, published: 0, errors: [] };
  const delay = ms => new Promise(r => setTimeout(r, ms));

  let bulkIsUpSeller = false;
  try {
    bulkIsUpSeller = await mlSellerIsUserProductSeller(accountId);
  } catch (e) {
    console.warn('[Bulk Publish] Não foi possível ler tags do vendedor ML:', e.message);
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const { modelId, price: overridePrice, listing_type_id: overrideListingType,
      available_quantity: overrideQty, variation_prices: overrideVarPrices,
      attribute_overrides } = item;

    if (i > 0) await delay(500);

    try {
      const model = await new Promise((resolve, reject) => {
        db.get('SELECT * FROM ad_models WHERE id = ?', [modelId], (err, row) => {
          if (err) return reject(err);
          if (!row) return reject(new Error('Modelo não encontrado'));
          resolve(row);
        });
      });

      if (marketplace === 'shopee') {
        try {
          const result = await publishAdModelToShopee(model, accountId, { price: overridePrice, qty: overrideQty });
          const pubPrice = Number(overridePrice != null ? overridePrice : model.price) || 0;
          const pubItems = (result.items && result.items.length > 0)
            ? result.items
            : [{ published_item_id: String(result.item_id), permalink: result.permalink || null }];
          await savePublicationWithItems({
            adModelId: modelId,
            marketplace: 'shopee',
            accountId,
            publishedItemId: String(result.item_id),
            publishedPrice: pubPrice,
            publishedListingType: null,
            items: pubItems,
          });
          results.published++;
        } catch (e) {
          results.errors.push({
            modelId,
            title: item.title || `#${modelId}`,
            error: e.message || String(e),
            details: e.response?.data,
          });
        }
        continue;
      }

      const pictures = JSON.parse(model.pictures || '[]');
      let attributes = JSON.parse(model.attributes || '[]');
      let variations = normalizeAdModelVariationPictureIds(JSON.parse(model.variations || '[]'), pictures);
      const saleTerms = JSON.parse(model.sale_terms || '[]');

      if (attribute_overrides && typeof attribute_overrides === 'object') {
        for (const [attrId, attrValue] of Object.entries(attribute_overrides)) {
          const idx = attributes.findIndex(a => a.id === attrId);
          if (idx >= 0) {
            attributes[idx] = { ...attributes[idx], value_name: attrValue, value_id: null };
          } else {
            attributes.push({ id: attrId, value_name: attrValue });
          }
        }
      }

      const effectivePrice = toMlPriceNumber(overridePrice != null ? overridePrice : model.price);
      const effectiveListingType = overrideListingType || model.listing_type_id || 'gold_special';
      const effectiveQty = toMlQuantityInt(overrideQty != null ? overrideQty : model.available_quantity);

      let title = model.title || '';
      if (title.length > 60) title = title.substring(0, 60);
      const familyName = trimMlItemFamilyName(String(model.title || '').trim()) || trimMlItemFamilyName(title) || 'Produto';

      let publishAttrs = attributes.filter(a => {
        if (['ITEM_CONDITION'].includes(a.id)) return false;
        return a.value_id || a.value_name;
      });
      publishAttrs = mergeModelEanIntoGtinAttribute(publishAttrs, model.ean);
      publishAttrs = applyPackageMeasuresToMlAttributes(publishAttrs, parseAdModelPackageMeasures(model));

      const validVariations = variations.filter(v => v.attribute_combinations && v.attribute_combinations.length > 0);

      const reqAttrCheck = await mlValidateRequiredAttributesForPublish(model.category_id, publishAttrs, variations);
      if (!reqAttrCheck.ok) {
        const list = reqAttrCheck.missing.map((m) => `${m.name} (${m.id})`).join(', ');
        const errMsg = `Faltam atributos obrigatórios Mercado Livre para esta categoria: ${list}. Edite o modelo e preencha na ficha técnica.`;
        results.errors.push({
          modelId,
          title: item.title || `#${modelId}`,
          error: errMsg,
          missingAttributes: reqAttrCheck.missing,
          category_id: model.category_id,
        });
        continue;
      }

      const publishAttrsUserProduct = omitItemLevelSellerSkuForUserProductPosts(publishAttrs);

      if (validVariations.length > 0 && bulkIsUpSeller) {
        const newResults = [];
        for (let idx = 0; idx < validVariations.length; idx++) {
          const v = validVariations[idx];
          const varPrice = toMlPriceNumber(
            overrideVarPrices && overrideVarPrices[String(idx)] != null
              ? overrideVarPrices[String(idx)]
              : (v.price != null ? v.price : effectivePrice)
          );
          const bodyUp = {
            family_name: familyName,
            category_id: model.category_id,
            price: varPrice,
            currency_id: model.currency_id || 'BRL',
            available_quantity: toMlQuantityInt(v.available_quantity),
            buying_mode: model.buying_mode || 'buy_it_now',
            listing_type_id: effectiveListingType,
            condition: model.condition || 'new',
            pictures: mlPicturesPayloadForVariation(pictures, v),
            attributes: finalizeUserProductVariationAttributes(
              mergeAttributesForMlUserProductVariation(publishAttrsUserProduct, v),
              v
            ),
          };
          if (v.seller_custom_field) bodyUp.seller_custom_field = v.seller_custom_field;
          if (saleTerms.length > 0) bodyUp.sale_terms = mapSaleTermsForMlBody(saleTerms);
          const shipUpBulk = mlShippingFromAdModelRow(model);
          if (shipUpBulk) bodyUp.shipping = shipUpBulk;
          if (model.video_id && String(model.video_id).trim() !== '' && String(model.video_id).toLowerCase() !== 'null') {
            bodyUp.video_id = model.video_id;
          }

          let result;
          let retries = 0;
          while (retries <= 2) {
            try {
              result = await mlApiPost('/items', bodyUp, accountId);
              break;
            } catch (apiErr) {
              if (apiErr.response?.status === 429 && retries < 2) {
                retries++;
                console.log(`[Bulk Publish] Rate limited, retry ${retries}/2 after 2s`);
                await delay(2000);
              } else {
                throw apiErr;
              }
            }
          }
          newResults.push(result);
          if (model.description) {
            try { await mlApiPost(`/items/${result.id}/description`, { plain_text: model.description }, accountId); } catch {}
          }
          if (idx < validVariations.length - 1) await delay(400);
        }

        const first = newResults[0];
        await savePublicationWithItems({
          adModelId: modelId,
          marketplace: 'ml',
          accountId,
          publishedItemId: first.id,
          publishedPrice: effectivePrice,
          publishedListingType: effectiveListingType,
          items: newResults.map((r, idx) => {
            const v = validVariations[idx] || {};
            let variationKey = null;
            if (Array.isArray(v.attribute_combinations)) {
              variationKey = v.attribute_combinations
                .map((c) => `${c.id || ''}:${c.value_name || c.value_id || ''}`)
                .join('|');
            }
            return {
              published_item_id: r.id,
              permalink: r.permalink || null,
              external_sku: v.seller_custom_field || null,
              variation_key: variationKey,
            };
          }),
        });

        console.log(`[Bulk Publish] ${i + 1}/${items.length} - Model ${modelId} to ML (User Products, ${validVariations.length} itens)`);
        results.published++;
        continue;
      }

      const body = {
        title,
        category_id: model.category_id,
        price: effectivePrice,
        currency_id: model.currency_id || 'BRL',
        condition: model.condition || 'new',
        buying_mode: model.buying_mode || 'buy_it_now',
        listing_type_id: effectiveListingType,
        pictures: pictures.map(p => ({ source: p.source || p.secure_url })).filter((p) => p.source),
        attributes: publishAttrs.map(a => ({ id: a.id, ...(a.value_id ? { value_id: a.value_id } : {}), ...(a.value_name ? { value_name: a.value_name } : {}) })),
      };
      if (familyName) body.family_name = familyName;

      const shipPostBulk = mlShippingFromAdModelRow(model);
      if (shipPostBulk) body.shipping = shipPostBulk;
      if (model.video_id && String(model.video_id).trim() !== '' && String(model.video_id).toLowerCase() !== 'null') {
        body.video_id = model.video_id;
      }

      if (variations.length > 0) {
        body.variations = variations
          .filter(v => v.attribute_combinations && v.attribute_combinations.length > 0)
          .map((v, idx) => {
            const varPrice = toMlPriceNumber(
              overrideVarPrices && overrideVarPrices[String(idx)] != null
                ? overrideVarPrices[String(idx)]
                : (v.price != null ? v.price : effectivePrice)
            );
            const varObj = {
              attribute_combinations: sanitizeAttributeCombinationsForMl(v.attribute_combinations),
              price: varPrice,
              available_quantity: toMlQuantityInt(v.available_quantity),
              picture_ids: sanitizeVariationPictureIds(v.picture_ids, pictures.length),
            };
            if (v.seller_custom_field) varObj.seller_custom_field = v.seller_custom_field;
            if (v.attributes && v.attributes.length > 0) {
              varObj.attributes = v.attributes.filter(a => a.id && (a.value_name || a.value_id))
                .map(a => ({ id: a.id, ...(a.value_id ? { value_id: a.value_id } : {}), ...(a.value_name ? { value_name: a.value_name } : {}) }));
            }
            return varObj;
          })
          .filter(v => v.attribute_combinations && v.attribute_combinations.length > 0);
        if (body.variations.length > 0) finalizeMlPublishBodyWithVariations(body, effectiveQty);
        else { body.available_quantity = effectiveQty; delete body.variations; }
      } else {
        body.available_quantity = effectiveQty;
      }

      if (saleTerms.length > 0) {
        body.sale_terms = mapSaleTermsForMlBody(saleTerms);
      }

      mlFinalizeMlItemPostBody(body);

      console.log(`[Bulk Publish] ${i + 1}/${items.length} - Model ${modelId} to ML`);

      let result;
      let retries = 0;
      while (retries <= 2) {
        try {
          result = await mlApiPost('/items', body, accountId);
          break;
        } catch (apiErr) {
          if (apiErr.response?.status === 429 && retries < 2) {
            retries++;
            console.log(`[Bulk Publish] Rate limited, retry ${retries}/2 after 2s`);
            await delay(2000);
          } else {
            throw apiErr;
          }
        }
      }

      await savePublicationWithItems({
        adModelId: modelId,
        marketplace: 'ml',
        accountId,
        publishedItemId: result.id,
        publishedPrice: effectivePrice,
        publishedListingType: effectiveListingType,
        items: [{ published_item_id: result.id, permalink: result.permalink || null }],
      });

      if (model.description) {
        try { await mlApiPost(`/items/${result.id}/description`, { plain_text: model.description }, accountId); } catch {}
      }

      results.published++;
    } catch (err) {
      console.error(`[Bulk Publish] Error model ${modelId}:`, err.response?.data || err.message);
      const errMsg = mlApiErrorToUserMessage(err);
      await savePublicationWithItems({
        adModelId: modelId, marketplace: 'ml', accountId, status: 'error', errorMessage: errMsg, items: [],
      }).catch(() => {});
      results.errors.push({
        modelId,
        title: item.title || `#${modelId}`,
        error: errMsg,
        details: err.response?.data,
      });
    }
  }

  console.log(`[Bulk Publish] Done: ${results.published}/${results.total} published, ${results.errors.length} errors`);
  res.json(results);
});

app.get('/api/ad-models/:id/pictures/download', async (req, res) => {
  try {
    const model = await new Promise((resolve, reject) => {
      db.get('SELECT id, sku, title, pictures FROM ad_models WHERE id = ?', [req.params.id], (err, row) => {
        if (err) return reject(err);
        if (!row) return reject(new Error('Modelo não encontrado'));
        resolve(row);
      });
    });

    const pictures = JSON.parse(model.pictures || '[]');
    if (pictures.length === 0) return res.status(404).json({ error: 'Nenhuma imagem neste modelo' });

    const safeName = (model.sku || model.title || 'modelo').replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}_fotos.zip"`);

    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.on('error', (err) => { console.error('[Ad Models] Archive error:', err); res.status(500).end(); });
    archive.pipe(res);

    for (let i = 0; i < pictures.length; i++) {
      const pic = pictures[i];
      const url = pic.source || pic.secure_url;
      if (!url) continue;
      try {
        const imgRes = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
        const ext = (imgRes.headers['content-type'] || '').includes('png') ? 'png' : 'jpg';
        archive.append(Buffer.from(imgRes.data), { name: `${safeName}_${i + 1}.${ext}` });
      } catch (imgErr) {
        console.error(`[Ad Models] Failed to download image ${i + 1}:`, imgErr.message);
      }
    }

    await archive.finalize();
  } catch (err) {
    console.error('[Ad Models] Download pictures error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// POST /api/ad-models/:id/push-stock - push stock from inventory to all linked marketplaces
app.post('/api/ad-models/:id/push-stock', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const model = await new Promise((resolve, reject) => {
      db.get('SELECT id, sku, inventory_id FROM ad_models WHERE id = ?', [id], (e, r) => e ? reject(e) : resolve(r));
    });
    if (!model) return res.status(404).json({ error: 'Modelo não encontrado' });
    if (!model.inventory_id) return res.status(400).json({ error: 'Modelo sem vínculo com inventário. Vincule o modelo a um item do inventário primeiro.' });

    await pushStockForInventoryId(model.inventory_id);
    res.json({ success: true, inventory_id: model.inventory_id, message: 'Estoque enviado para todos os marketplaces vinculados' });
  } catch (err) {
    console.error('[Ad Models Push Stock] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ad-models/:id/toggle-listing-status - toggle active/paused for a specific marketplace listing
app.post('/api/ad-models/:id/toggle-listing-status', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { mlItemId, mlAccountId, status } = req.body;
  if (!mlItemId || !status) return res.status(400).json({ error: 'mlItemId e status obrigatórios' });
  try {
    const tokenObj = await refreshMLTokenIfNeeded(mlAccountId || 1);
    if (!tokenObj || !tokenObj.access_token) return res.status(401).json({ error: 'Token ML indisponível' });

    await mlApiPut(`/items/${mlItemId}`, { status }, mlAccountId || 1);
    db.run('UPDATE ml_items SET status = ? WHERE ml_item_id = ? AND ml_account_id = ?', [status, mlItemId, mlAccountId || 1]);
    res.json({ success: true, ml_item_id: mlItemId, new_status: status });
  } catch (err) {
    console.error('[Ad Models Toggle Status] Error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ═══  END MERCADO LIVRE INTEGRATION  ═════════════════════════
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// ═══  SHOPEE INTEGRATION  ════════════════════════════════════
// ═══════════════════════════════════════════════════════════════

// API Live (produção) - use SHOPEE_HOST=https://partner.test-stable.shopeemobile.com para sandbox
const SHOPEE_HOST = process.env.SHOPEE_HOST || 'https://partner.shopeemobile.com';
const crypto = require('crypto');

function generateShopeeSign(partnerId, path, timestamp, accessToken, shopId, partnerKey, method) {
  let key;
  const m = method || 'full';
  if (m === 'strip') {
    key = partnerKey && partnerKey.startsWith('shpk') ? partnerKey.substring(4) : partnerKey;
  } else if (m === 'hex') {
    const hex = partnerKey && partnerKey.startsWith('shpk') ? partnerKey.substring(4) : partnerKey;
    key = Buffer.from(hex, 'hex');
  } else {
    key = partnerKey;
  }
  let baseStr = `${partnerId}${path}${timestamp}`;
  if (accessToken) baseStr += accessToken;
  if (shopId) baseStr += shopId;
  return crypto.createHmac('sha256', key).update(baseStr).digest('hex');
}

function getShopeeCredentials(accountId) {
  return new Promise((resolve) => {
    db.get('SELECT partner_id, partner_key, shop_id, redirect_uri FROM shopee_accounts WHERE id = ?', [accountId], (err, row) => {
      if (err || !row || !row.partner_id) return resolve(null);
      resolve({
        partnerId: String(row.partner_id).trim(),
        partnerKey: String(row.partner_key).trim(),
        shopId: row.shop_id ? String(row.shop_id).trim() : null,
        redirectUri: row.redirect_uri ? String(row.redirect_uri).trim() : null
      });
    });
  });
}

function loadShopeeToken(accountId) {
  return new Promise((resolve) => {
    db.get('SELECT * FROM api_tokens WHERE provider = ? AND account_id = ? ORDER BY updated_at DESC LIMIT 1',
      ['shopee', accountId], (err, row) => resolve(err ? null : row));
  });
}

function saveShopeeToken(tokenData, accountId) {
  return new Promise((resolve, reject) => {
    // Gravamos created_at/updated_at em ISO UTC ("...Z"). SQLite aceita DATETIME como TEXT
    // e o parsing em JS fica sem ambiguidade de fuso — evita bug onde CURRENT_TIMESTAMP
    // (sem sufixo Z) era interpretado como horário local no cálculo de expiração.
    const nowIso = new Date().toISOString();
    db.run(`INSERT OR REPLACE INTO api_tokens (id, provider, account_id, access_token, refresh_token, expires_in, token_type, created_at, updated_at)
            VALUES ((SELECT id FROM api_tokens WHERE provider = 'shopee' AND account_id = ?), 'shopee', ?, ?, ?, ?, 'Bearer', ?, ?)`,
      [accountId, accountId, tokenData.access_token, tokenData.refresh_token, tokenData.expire_in || 14400, tokenData.created_at || nowIso, nowIso],
      function(err) { err ? reject(err) : resolve(); });
  });
}

// Cooldown entre tentativas de refresh que falharam — evita rajadas de chamadas
// quando o refresh_token está inválido (ex.: conta precisa reautorizar).
const shopeeRefreshFailures = {};

async function refreshShopeeTokenIfNeeded(accountId, forceRefresh = false) {
  const token = await loadShopeeToken(accountId);
  if (!token) {
    logMarketplaceConnection('shopee', 'no_token_row', 'WARN', accountId, {});
    throw new Error('Shopee token not found');
  }
  const creds = await getShopeeCredentials(accountId);
  if (!creds) {
    logMarketplaceConnection('shopee', 'no_credentials', 'WARN', accountId, {});
    throw new Error('Shopee credentials not found');
  }
  const refRaw = token.updated_at || token.created_at;
  const refDate = parseSqliteUtcDate(refRaw);
  const refTs = refDate.getTime();
  const elapsed = Number.isFinite(refTs) ? (Date.now() - refTs) / 1000 : Infinity;
  if (!forceRefresh && elapsed < (token.expires_in || 14400) - 300) return token;

  // Cooldown só bloqueia refresh automático; 401 em chamada real (forceRefresh) passa direto.
  if (!forceRefresh && shopeeRefreshFailures[accountId] && Date.now() - shopeeRefreshFailures[accountId] < 3 * 60 * 1000) {
    logMarketplaceConnection('shopee', 'refresh_skipped_cooldown', 'WARN', accountId, {
      cooldownRemainingSec: Math.ceil((3 * 60 * 1000 - (Date.now() - shopeeRefreshFailures[accountId])) / 1000)
    });
    return token;
  }

  if (!token.refresh_token) {
    logMarketplaceConnection('shopee', 'no_refresh_token', 'ERROR', accountId, {});
    throw new Error('Shopee refresh_token ausente — reautorize a conta');
  }

  const path = '/api/v2/auth/access_token/get';
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = generateShopeeSign(creds.partnerId, path, timestamp, null, creds.shopId, creds.partnerKey);
  let resp;
  try {
    resp = await axios.post(`${SHOPEE_HOST}${path}?partner_id=${creds.partnerId}&timestamp=${timestamp}&sign=${sign}`, {
      shop_id: parseInt(creds.shopId, 10),
      refresh_token: token.refresh_token,
      partner_id: parseInt(creds.partnerId, 10)
    });
  } catch (err) {
    shopeeRefreshFailures[accountId] = Date.now();
    logMarketplaceConnection('shopee', 'refresh_http_failed', 'ERROR', accountId, {
      status: err.response?.status,
      body: err.response?.data,
      message: err.message
    });
    throw err;
  }
  if (resp.data.error) {
    shopeeRefreshFailures[accountId] = Date.now();
    logMarketplaceConnection('shopee', 'refresh_api_error', 'ERROR', accountId, { error: resp.data.error, message: resp.data.message });
    throw new Error(resp.data.message || resp.data.error);
  }
  // Shopee rotaciona o refresh_token a cada refresh; se a resposta não trouxer um novo,
  // preservamos o antigo (mesma estratégia usada no ML).
  const payload = { ...resp.data };
  if (!payload.refresh_token) payload.refresh_token = token.refresh_token;
  await saveShopeeToken(payload, accountId);
  delete shopeeRefreshFailures[accountId];
  console.log(`[Shopee] Token refreshed OK para conta ${accountId} (new refresh_token: ${resp.data.refresh_token ? 'yes' : 'preserved old'})`);
  return await loadShopeeToken(accountId);
}

// Cache do método de sign que funcionou por conta (evita tentar todos os métodos em toda chamada).
// Persistido em app_settings (`shopee_sign_method_<accountId>`) para sobreviver a restarts —
// sem isso, logo depois de um boot o primeiro request sempre tenta 'full', e se o token estiver
// expirado o branch de auth-retry não cicla métodos, travando em error_sign.
const shopeeSignMethodByAccount = new Map();
const shopeeSignMethodKey = (accountId) => `shopee_sign_method_${accountId}`;
function rememberShopeeSignMethod(accountId, method) {
  shopeeSignMethodByAccount.set(accountId, method);
  try { setSetting(shopeeSignMethodKey(accountId), method).catch(() => {}); } catch (_) { /* best-effort */ }
}
function readShopeeSignMethod(accountId) {
  const mem = shopeeSignMethodByAccount.get(accountId);
  if (mem) return mem;
  const persisted = getSetting(shopeeSignMethodKey(accountId), null);
  if (persisted) shopeeSignMethodByAccount.set(accountId, persisted);
  return persisted || null;
}

async function shopeeApiRequest(method, apiPath, params, body, accountId) {
  const makeRequest = async (signMethod, forceRefresh = false) => {
    const token = await refreshShopeeTokenIfNeeded(accountId, forceRefresh);
    const creds = await getShopeeCredentials(accountId);
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = generateShopeeSign(creds.partnerId, apiPath, timestamp, token.access_token, creds.shopId, creds.partnerKey, signMethod);
    const baseParams = {
      partner_id: creds.partnerId,
      timestamp: String(timestamp),
      access_token: token.access_token,
      shop_id: creds.shopId,
      sign
    };
    if (method === 'GET') {
      const query = new URLSearchParams({ ...baseParams, ...params }).toString();
      return axios.get(`${SHOPEE_HOST}${apiPath}?${query}`);
    } else {
      const query = new URLSearchParams(baseParams).toString();
      return axios.post(`${SHOPEE_HOST}${apiPath}?${query}`, body);
    }
  };

  // Alguns partner_keys são entregues pela Shopee com prefixo "shpk" + hex; a Shopee espera
  // que o HMAC use a hex decodificada (método 'hex') ou sem prefixo (método 'strip').
  // Tentamos o método conhecido para essa conta primeiro; se não houver, tentamos 'full' com
  // fallback automático para 'strip' e 'hex' em caso de "error_sign" / 403 "Wrong sign".
  const preferred = readShopeeSignMethod(accountId) || 'full';
  const methodOrder = [preferred, 'full', 'strip', 'hex'].filter((m, i, a) => a.indexOf(m) === i);

  const isSignError = (err) => {
    const data = err?.response?.data || {};
    const msg = (data.message || err?.message || '').toLowerCase();
    return data.error === 'error_sign' || msg.includes('wrong sign');
  };

  // Códigos de erro da Shopee que representam falhas transientes — servidor
  // sobrecarregado ou rate limit excedido. Devolvemos como status 429 pro
  // withRetryBackoff retentar com exponential backoff (se viesse como 200
  // ele abandonaria imediatamente e o caller acabaria sem dados).
  const SHOPEE_TRANSIENT_ERRORS = new Set([
    'error_server', 'error_busy', 'error_timeout', 'request_reach_rate_limit',
    'error_service_rate', 'error_too_frequency', 'error_inner', 'error_network',
  ]);
  const isTransientShopeeError = (code) => typeof code === 'string' && SHOPEE_TRANSIENT_ERRORS.has(code);

  let firstErr = null;
  for (const signMethod of methodOrder) {
    try {
      const resp = await withRetryBackoff(async () => {
        const r = await makeRequest(signMethod);
        // Shopee devolve erros de negócio com HTTP 200 + payload { error, message }.
        // Promovemos erros transientes a 429 pra disparar retry.
        if (r.data?.error) {
          const retriable = isTransientShopeeError(r.data.error);
          const err = new Error(r.data.message || r.data.error);
          err.response = { data: r.data, status: retriable ? 429 : 200 };
          throw err;
        }
        return r;
      }, `Shopee ${method} ${apiPath}`);
      rememberShopeeSignMethod(accountId, signMethod);
      return resp.data;
    } catch (err) {
      if (!firstErr) firstErr = err;
      if (isSignError(err)) {
        console.warn(`[Shopee] sign "${signMethod}" falhou em ${apiPath} (${err.response?.data?.message || err.message}); tentando próximo método…`);
        continue;
      }
      // 401 real (token inválido) → retry único com refresh forçado.
      // Shopee também devolve 401 via payload com error === 'error_auth' / 'invalid_access_token'.
      const shopeeAuthErr = (() => {
        const code = err?.response?.data?.error || '';
        return typeof code === 'string' && /auth|token/i.test(code);
      })();
      if (err.response?.status === 401 || shopeeAuthErr) {
        logMarketplaceConnection('shopee', 'api_auth_challenge', 'WARN', accountId, {
          method, apiPath, status: err.response?.status, body: err.response?.data
        });
        console.log(`[Shopee] auth error em ${method} ${apiPath}, forçando refresh e retry…`);
        try {
          // forceRefresh=true garante refresh real mesmo se o "elapsed" calculado achar que token está fresco.
          const resp = await withRetryBackoff(async () => {
            const r = await makeRequest(signMethod, true);
            // Mesmo tratamento: erro "error_sign" precisa virar exceção p/ isSignError.
            if (r.data?.error) {
              const e2 = new Error(r.data.message || r.data.error);
              e2.response = { data: r.data, status: 200 };
              throw e2;
            }
            return r;
          }, `Shopee ${method} ${apiPath} retry-401`);
          rememberShopeeSignMethod(accountId, signMethod);
          return resp.data;
        } catch (err2) {
          // Se o retry pós-refresh virou erro de assinatura, é sinal que o token
          // tava OK mas o método de sign está errado pra essa partner_key — o
          // loop externo precisa tentar o próximo método ('strip', 'hex'). Sem
          // isso, um token expirado no início do request deixa o caller refém
          // do método default 'full' mesmo com cache vazio (pós-restart).
          if (isSignError(err2)) {
            console.warn(`[Shopee] sign "${signMethod}" falhou após refresh em ${apiPath}; tentando próximo método…`);
            if (!firstErr || !isSignError(firstErr)) firstErr = err2;
            continue;
          }
          logMarketplaceConnection('shopee', 'api_retry_failed', 'ERROR', accountId, {
            method, apiPath, message: err2.message, status: err2.response?.status, body: err2.response?.data
          });
          throw err2;
        }
      }
      throw err; // demais erros (403 não-sign, 5xx, rede) saem
    }
  }

  // Todos os métodos falharam — coleta diagnóstico das credenciais para
  // facilitar o troubleshooting (SEM vazar a partner_key em si, só o tamanho
  // e prefixo). Se "shpk..." estiver correto e mesmo assim tudo falha, é
  // quase sempre credencial desatualizada (partner_key regenerada no console
  // Shopee, ou access_token pertencente a outra shop).
  try {
    const creds = await getShopeeCredentials(accountId);
    const token = await loadShopeeToken(accountId);
    const keyPreview = creds?.partnerKey
      ? `${creds.partnerKey.slice(0, 6)}…len=${creds.partnerKey.length}`
      : 'AUSENTE';
    console.error(
      `[Shopee] TODOS os métodos de sign falharam em ${apiPath}. ` +
      `accountId=${accountId} partner_id=${creds?.partnerId || 'AUSENTE'} ` +
      `shop_id=${creds?.shopId || 'AUSENTE'} partner_key=${keyPreview} ` +
      `has_token=${!!token?.access_token} ` +
      `error=${firstErr?.response?.data?.error || firstErr?.message}. ` +
      `Provável causa: partner_key regenerada no console Shopee ou access_token ` +
      `pertence a outra shop. Reautorize a conta em Configurações → Shopee.`
    );
  } catch (_) { /* best-effort */ }
  logMarketplaceConnection('shopee', 'api_sign_all_methods_failed', 'ERROR', accountId, {
    method, apiPath, tried: methodOrder, message: firstErr?.message, body: firstErr?.response?.data
  });
  throw firstErr || new Error('Falha ao chamar Shopee API');
}

async function shopeeApiGet(apiPath, params, accountId) { return shopeeApiRequest('GET', apiPath, params, null, accountId); }
async function shopeeApiPost(apiPath, body, accountId) { return shopeeApiRequest('POST', apiPath, null, body, accountId); }

// Baixa conteúdo binário da Shopee (ex.: download_shipping_document → PDF).
// Mesma lógica de assinatura do shopeeApiRequest, porém com responseType='arraybuffer'.
async function shopeeApiDownload(method, apiPath, params, body, accountId) {
  const token = await refreshShopeeTokenIfNeeded(accountId);
  const creds = await getShopeeCredentials(accountId);
  const signMethod = readShopeeSignMethod(accountId) || 'full';
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = generateShopeeSign(creds.partnerId, apiPath, timestamp, token.access_token, creds.shopId, creds.partnerKey, signMethod);
  const baseParams = {
    partner_id: creds.partnerId,
    timestamp: String(timestamp),
    access_token: token.access_token,
    shop_id: creds.shopId,
    sign,
  };
  if (method === 'GET') {
    const query = new URLSearchParams({ ...baseParams, ...(params || {}) }).toString();
    const resp = await axios.get(`${SHOPEE_HOST}${apiPath}?${query}`, { responseType: 'arraybuffer' });
    return Buffer.from(resp.data);
  }
  const query = new URLSearchParams(baseParams).toString();
  const resp = await axios.post(`${SHOPEE_HOST}${apiPath}?${query}`, body || {}, { responseType: 'arraybuffer' });
  return Buffer.from(resp.data);
}

// Baixa conteúdo binário do Mercado Livre (ex.: /shipment_labels → PDF).
async function mlApiGetBinary(path, accountId) {
  const token = await refreshMLTokenIfNeeded(accountId);
  if (!token) throw new Error('Token ML indisponível');
  const resp = await axios.get(`${ML_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
    responseType: 'arraybuffer',
  });
  return Buffer.from(resp.data);
}

// Extrai chave/número/série/data de um XML de NFe (modelo 55) sem depender
// de libs externas. Funciona para o formato padrão nfeProc > NFe > infNFe.
function parseNfeXmlFields(xml) {
  if (!xml || typeof xml !== 'string') return null;
  try {
    const idMatch = xml.match(/Id=["']NFe(\d{44})["']/i);
    const chMatch = xml.match(/<chNFe>\s*(\d{44})\s*<\/chNFe>/i);
    const key = (idMatch?.[1] || chMatch?.[1] || '').replace(/\D/g, '') || null;
    const nNF = xml.match(/<nNF>\s*(\d+)\s*<\/nNF>/i)?.[1] || null;
    const serie = xml.match(/<serie>\s*(\d+)\s*<\/serie>/i)?.[1] || null;
    const dhEmi = xml.match(/<dhEmi>\s*([^<]+)\s*<\/dhEmi>/i)?.[1] || null;
    const dEmi = xml.match(/<dEmi>\s*([^<]+)\s*<\/dEmi>/i)?.[1] || null;
    const issuedAt = (dhEmi || dEmi || '').trim() || null;
    if (!key) return null;
    return { key, number: nNF, serie, issuedAt };
  } catch {
    return null;
  }
}

function parseAdModelMarketplaceMappings(row) {
  if (!row || row.marketplace_mappings == null || row.marketplace_mappings === '') return {};
  try {
    const o = typeof row.marketplace_mappings === 'string' ? JSON.parse(row.marketplace_mappings) : row.marketplace_mappings;
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

async function shopeeApiPostMultipart(apiPath, form, accountId) {
  const token = await refreshShopeeTokenIfNeeded(accountId);
  const creds = await getShopeeCredentials(accountId);
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = generateShopeeSign(creds.partnerId, apiPath, timestamp, token.access_token, creds.shopId, creds.partnerKey);
  const baseParams = {
    partner_id: creds.partnerId,
    timestamp: String(timestamp),
    access_token: token.access_token,
    shop_id: creds.shopId,
    sign,
  };
  const query = new URLSearchParams(baseParams).toString();
  const url = `${SHOPEE_HOST}${apiPath}?${query}`;
  const resp = await axios.post(url, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 120000,
  });
  if (resp.data && resp.data.error) throw new Error(resp.data.message || resp.data.error);
  return resp.data;
}

/**
 * Normaliza uma imagem para os requisitos da Shopee:
 *   • Formato: JPEG (Shopee aceita PNG/JPG; convertemos sempre p/ JPEG p/ simplificar).
 *   • Dimensões: mínimo 500x500, máximo 2048x2048. Usamos 1600x1600 como alvo,
 *     mantendo aspect-ratio, sem upscale forçado de imagens grandes.
 *   • Se <500px em algum lado, faz upscale para 800px para atender o mínimo.
 *   • Tamanho de arquivo: re-encoda com qualidade 85 (ajustada p/ ficar < 2MB).
 *   • Remove metadata (evita imagens de fontes obscuras rejeitadas).
 * Retorna { buffer, mime: 'image/jpeg' }.
 */
async function normalizeImageForShopee(inputBuffer) {
  if (!sharpLib) {
    // Fallback: sem sharp, tenta enviar como veio (pode falhar em webp/gif)
    return { buffer: inputBuffer, mime: 'image/jpeg' };
  }
  const meta = await sharpLib(inputBuffer).metadata();
  const w = meta.width || 0;
  const h = meta.height || 0;

  let pipeline = sharpLib(inputBuffer, { failOn: 'none' })
    .rotate(); // respeita EXIF orientation

  // Upscale para garantir mínimo de 800 (acima do mínimo 500 da Shopee)
  if (w && h && (w < 500 || h < 500)) {
    const scale = 800 / Math.min(w, h);
    pipeline = pipeline.resize({
      width: Math.round(w * scale),
      height: Math.round(h * scale),
      fit: 'inside',
      withoutEnlargement: false,
    });
  } else {
    // Redimensiona para caber em 1600x1600 (abaixo do máximo 2048, leve e nítido)
    pipeline = pipeline.resize({
      width: 1600,
      height: 1600,
      fit: 'inside',
      withoutEnlargement: true,
    });
  }

  // Achata transparência em branco (Shopee não gosta de PNG transparente em JPEG)
  let buf = await pipeline
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .jpeg({ quality: 85, mozjpeg: true, chromaSubsampling: '4:2:0' })
    .withMetadata({ exif: undefined })
    .toBuffer();

  // Se ficar > 2MB, re-encoda com qualidade menor
  if (buf.length > 2 * 1024 * 1024) {
    buf = await sharpLib(buf).jpeg({ quality: 72, mozjpeg: true }).toBuffer();
  }
  if (buf.length > 2 * 1024 * 1024) {
    buf = await sharpLib(buf).resize({ width: 1200, height: 1200, fit: 'inside' }).jpeg({ quality: 70, mozjpeg: true }).toBuffer();
  }

  return { buffer: buf, mime: 'image/jpeg' };
}

// CDNs públicos (em especial o do Mercado Livre, http2.mlstatic.com) rejeitam
// User-Agents genéricos com 403. Usamos um UA de navegador real + referer do
// host correspondente para destravar o download. Se ainda assim vier 403,
// tentamos variações de resolução (mlstatic usa sufixo _O/_V/_S/_F etc.).
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function refererForImageHost(imageUrl) {
  try {
    const u = new URL(imageUrl);
    if (/mlstatic\.com$/i.test(u.hostname)) return 'https://www.mercadolivre.com.br/';
    if (/cbx-prod\.shopee\.com\.br|shopee\.com\.br|shopeecdn|mms-mms\.shopeemobile/i.test(u.hostname)) return 'https://shopee.com.br/';
    if (/images-na\.ssl-images-amazon|amazonaws|amazon\.com/i.test(u.hostname)) return 'https://www.amazon.com.br/';
    return `${u.protocol}//${u.hostname}/`;
  } catch { return undefined; }
}

async function downloadImageWithFallbacks(imageUrl) {
  const headers = {
    'User-Agent': BROWSER_UA,
    'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
  };
  const ref = refererForImageHost(imageUrl);
  if (ref) headers['Referer'] = ref;

  const tryGet = (url, extraHeaders) => axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 45000,
    maxContentLength: 20 * 1024 * 1024,
    headers: { ...headers, ...(extraHeaders || {}) },
    // Vários CDNs devolvem 403 em uma variação e 200 em outra — tratamos manualmente
    validateStatus: () => true,
  });

  const attempts = [];

  // 1) URL original com UA de browser + Referer do host
  attempts.push({ label: 'original', url: imageUrl });

  // 2) Variações do CDN do Mercado Livre (sufixo _O/_V/_F/_W e extensão webp/jpg)
  if (/mlstatic\.com/i.test(imageUrl)) {
    const seen = new Set([imageUrl]);
    const pushIf = (u, lbl) => { if (u && !seen.has(u)) { seen.add(u); attempts.push({ label: lbl, url: u }); } };
    pushIf(imageUrl.replace(/\.webp(\?|$)/i, '.jpg$1'), 'mlstatic→jpg');
    pushIf(imageUrl.replace(/\.jpg(\?|$)/i, '.webp$1'), 'mlstatic→webp');
    for (const from of ['O', 'V', 'F', 'W', 'S']) {
      for (const to of ['O', 'V', 'F', 'W']) {
        if (from === to) continue;
        pushIf(imageUrl.replace(new RegExp(`_${from}\\.`), `_${to}.`), `mlstatic_${from}→${to}`);
      }
    }
  }

  // 3) Proxy público images.weserv.nl (gratuito, caching, converte para JPG).
  //    Funciona sem auth e passa por nós do Cloudflare, burlando bloqueios de UA
  //    do CDN original. Remove o "https://" da URL conforme a API deles.
  try {
    const u = new URL(imageUrl);
    const hostPath = `${u.hostname}${u.pathname}${u.search || ''}`;
    const weserv = `https://images.weserv.nl/?url=${encodeURIComponent(hostPath)}&output=jpg&q=90`;
    attempts.push({ label: 'weserv-proxy', url: weserv, noReferer: true });
  } catch { /* URL malformada */ }

  let lastStatus = 0;
  let lastText = '';
  for (const att of attempts) {
    try {
      const r = await tryGet(att.url, att.noReferer ? { Referer: undefined } : undefined);
      if (r.status >= 200 && r.status < 300 && r.data && r.data.byteLength > 0) {
        if (att.label !== 'original') {
          console.log(`[Shopee publish] imagem recuperada via fallback "${att.label}" para ${imageUrl}`);
        }
        return Buffer.from(r.data);
      }
      lastStatus = r.status;
      lastText = r.statusText || '';
    } catch (e) {
      lastText = e.message || '';
      lastStatus = 0;
    }
  }

  const err = new Error(`não foi possível baixar a imagem (último status: HTTP ${lastStatus}${lastText ? ' ' + lastText : ''})`);
  err.statusCode = lastStatus || 502;
  throw err;
}

async function shopeeUploadProductImageFromUrl(accountId, imageUrl) {
  const rawBuf = await downloadImageWithFallbacks(imageUrl);

  // Normaliza antes do upload (evita "image is invalid or not supported" da Shopee
  // por WEBP/GIF, tamanho excessivo, dimensões fora do aceito ou metadata bizarra).
  let finalBuf = rawBuf;
  let finalMime = 'image/jpeg';
  try {
    const normalized = await normalizeImageForShopee(rawBuf);
    finalBuf = normalized.buffer;
    finalMime = normalized.mime;
  } catch (e) {
    console.warn('[Shopee publish] falha ao normalizar imagem, enviando original:', e.message);
  }

  const form = new FormData();
  form.append('image', finalBuf, { filename: 'img.jpg', contentType: finalMime });
  const data = await shopeeApiPostMultipart('/api/v2/media_space/upload_image', form, accountId);
  const inner = data.response || data;
  const id =
    inner.image_info?.image_id ||
    inner.image_id ||
    (Array.isArray(inner.image_info_list) && inner.image_info_list[0] && (inner.image_info_list[0].image_info?.image_id || inner.image_info_list[0].image_id));
  if (!id) throw new Error('Shopee não devolveu image_id no upload da imagem.');
  return String(id);
}

async function shopeeGetLogisticInfoForAddItem(accountId) {
  const data = await shopeeApiGet('/api/v2/logistics/get_channel_list', {}, accountId);
  const inner = data.response || data;
  const list = inner.logistic_channel_list || inner.logistics_channel_list || [];
  const out = [];
  for (const ch of list) {
    const lid = ch.logistic_id ?? ch.logistics_channel_id;
    if (lid == null) continue;
    // A Shopee marca cada canal com "enabled" (a loja já aceitou esse canal) e
    // "mask_channel_id" (canal suspenso). O erro "channel not found in shop"
    // acontece quando enviamos um logistic_id que a loja não habilitou —
    // então filtramos para mandar SÓ os canais realmente ativos na loja.
    const isEnabled = ch.enabled === true || ch.enabled === 1;
    const isMasked = ch.mask_channel_id === true || ch.mask_channel_id === 1;
    if (!isEnabled || isMasked) continue;
    out.push({ logistic_id: Number(lid), enabled: true });
  }
  return out;
}

// ── Catálogo manual de atributos Shopee ───────────────────────────────────
// Quando o partner do miti não tem permissão "Product Info" aprovada, a API
// devolve 403/vazio em get_attribute_tree. Para não travar o seller, mantemos
// um catálogo curado dos atributos obrigatórios mais comuns por categoria.
//
// Como preencher este catálogo (quando aparecer categoria nova):
//   1. Publique um produto teste direto no Seller Center da Shopee.
//   2. Copie os nomes dos atributos obrigatórios e as opções que aparecem nos
//      dropdowns.
//   3. Adicione aqui usando a mesma estrutura do endpoint oficial
//      (get_attribute_tree) para a UI tratar igual.
//
// Observações:
//   • Usamos value_id = 0 quando não sabemos o ID real. Nesse caso, a Shopee
//     tenta casar pelo original_value_name (nome em inglês). Se o add_item
//     recusar, a mensagem de erro traz os IDs aceitos para refinarmos aqui.
//   • input_type DROP_DOWN = seller escolhe uma opção fixa da lista.
//   • is_mandatory = true força a UI a destacar como "Obrigatório".
const SHOPEE_STATIC_ATTRS = {
  // Casa e Decoração > Iluminação (100719)
  // Opções abaixo refletem o que a Shopee mostra no Seller Center BR. value_id=0
  // é intencional: a Shopee NÃO publica os IDs oficiais em lugar nenhum — eles
  // só vêm da API get_attribute_tree. Enquanto o seller não importa de um item
  // já publicado (ou cola o JSON do DevTools), enviamos apenas original_value_name
  // e o pre-flight bloqueia a publicação com instruções claras.
  '100719': [
    {
      attribute_id: 102385,
      original_attribute_name: 'Electrical Cables',
      display_attribute_name: 'Cabos Elétricos',
      is_mandatory: true,
      input_type: 'DROP_DOWN',
      attribute_value_list: [
        { value_id: 0, original_value_name: 'Yes', display_value_name: 'Sim' },
        { value_id: 0, original_value_name: 'No', display_value_name: 'Não' },
      ],
    },
    {
      attribute_id: 100408,
      original_attribute_name: 'Connection Type',
      display_attribute_name: 'Tipo de Conexão',
      is_mandatory: true,
      input_type: 'DROP_DOWN',
      attribute_value_list: [
        { value_id: 0, original_value_name: 'Bluetooth', display_value_name: 'Bluetooth' },
        { value_id: 0, original_value_name: 'Wi-Fi', display_value_name: 'Wi-Fi' },
        { value_id: 0, original_value_name: 'Hardwired', display_value_name: 'Ligação direta' },
        { value_id: 0, original_value_name: 'Plug-in', display_value_name: 'Plugue na tomada' },
        { value_id: 0, original_value_name: 'USB', display_value_name: 'USB' },
        { value_id: 0, original_value_name: 'Battery', display_value_name: 'Pilha / bateria' },
        { value_id: 0, original_value_name: 'Others', display_value_name: 'Outros' },
      ],
    },
  ],
};

// Mescla o catálogo manual com a lista vinda da API. A API tem prioridade
// (os value_ids dela são reais). O catálogo só adiciona atributos que a API
// não trouxe.
function mergeShopeeStaticAttrs(apiList, categoryId) {
  const staticList = SHOPEE_STATIC_ATTRS[String(categoryId)] || [];
  if (staticList.length === 0) return apiList;
  const byId = new Map(apiList.map(a => [String(a.attribute_id), a]));
  for (const sa of staticList) {
    if (!byId.has(String(sa.attribute_id))) {
      byId.set(String(sa.attribute_id), { ...sa, _fromStaticCatalog: true });
    }
  }
  return Array.from(byId.values());
}

// ── Atributos da Shopee (ficha técnica) ───────────────────────────────────
// IMPORTANTE: o endpoint correto é /api/v2/product/get_attribute_tree
// (e NÃO /api/v2/product/get_attributes — este último recebe item_id,
// não category_id, e devolvia 403 "forbidden" com os params errados).
//
// Resposta de /api/v2/product/get_attribute_tree:
//   {
//     attribute_list: [{
//       attribute_id: number,
//       original_attribute_name: string,      // nome em inglês (ex: "Connection Type")
//       display_attribute_name: string,        // nome traduzido
//       is_mandatory: boolean,
//       input_validation_type: "INT_TYPE"|"STRING_TYPE"|"FLOAT_TYPE"|...,
//       format_type: "NORMAL"|"QUANTITATIVE",
//       date_format_type: string,
//       input_type: "DROP_DOWN"|"COMBO_BOX"|"MULTIPLE_SELECT"|"TEXT_FILED"|"MULTIPLE_SELECT_COMBO_BOX",
//       attribute_unit: string[],
//       attribute_value_list: [
//         { value_id: number, original_value_name: string, display_value_name: string, value_unit: string }
//       ]
//     }]
//   }
const shopeeCategoryAttrsCache = new Map(); // accountId|categoryId -> { list, at }
// Bump quando mudarmos a estrutura do catálogo estático ou a lógica de fetch.
// Evita retornar cache antigo incompatível.
const SHOPEE_ATTRS_CACHE_VERSION = 4;

// Overrides manuais (por categoria) carregados via endpoint
// POST /api/shopee/categories/:categoryId/attributes/override.
// Quando o seller cola um JSON do DevTools (Seller Center Shopee), gravamos
// o attribute_list completo aqui para usar como se fosse resposta da API.
// Persistência fica na tabela shopee_category_attrs_override.
const shopeeAttrsOverrideMem = new Map(); // categoryId -> attribute_list

function loadShopeeAttrsOverridesFromDb() {
  db.all('SELECT category_id, attributes_json FROM shopee_category_attrs_override', [], (err, rows) => {
    if (err) {
      // Tabela ainda não existe (primeira execução) — ok, initDatabase cria.
      return;
    }
    for (const r of rows || []) {
      try {
        const parsed = JSON.parse(r.attributes_json);
        if (Array.isArray(parsed)) shopeeAttrsOverrideMem.set(String(r.category_id), parsed);
      } catch (_) {}
    }
    if (rows && rows.length) console.log(`[Shopee] loaded ${rows.length} attribute override(s) from DB`);
  });
}

// Valores padrão por categoria, usados pra pré-preencher a ficha técnica de
// novos modelos Shopee. Chave: String(categoryId) -> Map(String(attribute_id) -> { value_id, original_value_name, display_value_name, value_unit }).
const shopeeCategoryDefaultsMem = new Map();

function loadShopeeCategoryDefaultsFromDb() {
  db.all('SELECT category_id, attribute_id, value_id, original_value_name, display_value_name, value_unit FROM shopee_category_default_values', [], (err, rows) => {
    if (err) return;
    for (const r of rows || []) {
      const catKey = String(r.category_id);
      if (!shopeeCategoryDefaultsMem.has(catKey)) shopeeCategoryDefaultsMem.set(catKey, new Map());
      shopeeCategoryDefaultsMem.get(catKey).set(String(r.attribute_id), {
        value_id: r.value_id,
        original_value_name: r.original_value_name,
        display_value_name: r.display_value_name,
        value_unit: r.value_unit,
      });
    }
    if (rows && rows.length) console.log(`[Shopee] loaded ${rows.length} default value(s) from DB`);
  });
}

// Helper interno usado pelo endpoint /attributes/merge e também pelo import
// de item (`get_item_base_info`) para gravar um snapshot do que o seller
// escolheu num anúncio já publicado. Faz duas coisas:
//   1) Mescla os value_ids descobertos dentro do override da categoria
//      (shopee_category_attrs_override), pra que as listas de dropdown
//      passem a exibir o ID oficial nas próximas consultas.
//   2) Upserta o último valor escolhido em shopee_category_default_values,
//      que é lido no GET /attributes pra pré-preencher novos modelos.
// Parâmetros:
//   categoryId  number  obrigatório
//   incoming    Array<{ attribute_id, value_id?, original_value_name?, display_value_name?, value_unit? }>
// Retorna: { merged: N, updated_value_ids: M, defaults_upserted: K }
function shopeeMergeAttributesForCategory(categoryId, incoming) {
  if (!Number.isFinite(Number(categoryId))) throw new Error('categoryId inválido');
  const norm = (Array.isArray(incoming) ? incoming : [])
    .map(a => ({
      attribute_id: Number(a.attribute_id),
      value_id: a.value_id != null && Number.isFinite(Number(a.value_id)) ? Number(a.value_id) : null,
      original_value_name: (a.original_value_name || a.display_value_name || '').toString().trim(),
      display_value_name: (a.display_value_name || a.original_value_name || '').toString().trim(),
      value_unit: a.value_unit || '',
    }))
    .filter(a => Number.isFinite(a.attribute_id) && a.attribute_id > 0 && (a.value_id || a.original_value_name));

  if (norm.length === 0) return { merged: 0, updated_value_ids: 0, defaults_upserted: 0 };

  // 1) Merge no override. Parte do que já estiver lá; se não houver override
  //    ainda, parte do catálogo estático (se existir) pra evitar jogar fora
  //    a lista de opções conhecidas pra categoria.
  const catKey = String(categoryId);
  const existingOverride = shopeeAttrsOverrideMem.get(catKey);
  const staticFallback = SHOPEE_STATIC_ATTRS[catKey] || [];
  const baseList = Array.isArray(existingOverride) && existingOverride.length > 0
    ? existingOverride.map(a => ({ ...a, attribute_value_list: Array.isArray(a.attribute_value_list) ? a.attribute_value_list.map(v => ({ ...v })) : [] }))
    : staticFallback.map(a => ({ ...a, attribute_value_list: Array.isArray(a.attribute_value_list) ? a.attribute_value_list.map(v => ({ ...v })) : [] }));
  const byAttrId = new Map(baseList.map(a => [Number(a.attribute_id), a]));

  let updatedValueIds = 0;
  for (const inc of norm) {
    let attr = byAttrId.get(inc.attribute_id);
    if (!attr) {
      attr = {
        attribute_id: inc.attribute_id,
        original_attribute_name: '',
        display_attribute_name: '',
        is_mandatory: false,
        input_type: 'DROP_DOWN',
        attribute_value_list: [],
      };
      byAttrId.set(inc.attribute_id, attr);
      baseList.push(attr);
    }
    const list = Array.isArray(attr.attribute_value_list) ? attr.attribute_value_list : (attr.attribute_value_list = []);
    const nameKey = inc.original_value_name.toLowerCase();
    const idx = list.findIndex(v => {
      const vn = (v.original_value_name || v.display_value_name || '').toString().trim().toLowerCase();
      return vn && vn === nameKey;
    });
    if (idx >= 0) {
      if (inc.value_id && list[idx].value_id !== inc.value_id) {
        list[idx].value_id = inc.value_id;
        updatedValueIds += 1;
      }
      if (inc.display_value_name && !list[idx].display_value_name) list[idx].display_value_name = inc.display_value_name;
      if (inc.original_value_name && !list[idx].original_value_name) list[idx].original_value_name = inc.original_value_name;
      if (inc.value_unit && !list[idx].value_unit) list[idx].value_unit = inc.value_unit;
    } else if (inc.original_value_name || inc.value_id) {
      list.push({
        value_id: inc.value_id || 0,
        original_value_name: inc.original_value_name || '',
        display_value_name: inc.display_value_name || inc.original_value_name || '',
        value_unit: inc.value_unit || '',
      });
      if (inc.value_id) updatedValueIds += 1;
    }
  }

  shopeeAttrsOverrideMem.set(catKey, baseList);
  try {
    db.run(
      `INSERT INTO shopee_category_attrs_override (category_id, attributes_json, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(category_id) DO UPDATE SET attributes_json = excluded.attributes_json, updated_at = CURRENT_TIMESTAMP`,
      [Number(categoryId), JSON.stringify(baseList)]
    );
  } catch (e) {
    console.error('[Shopee merge] failed to persist override:', e.message);
  }

  // 2) Upsert em shopee_category_default_values — só guarda como default o
  //    que tem nome (value_id pode estar null se a gente só tiver o nome).
  let defaultsUpserted = 0;
  if (!shopeeCategoryDefaultsMem.has(catKey)) shopeeCategoryDefaultsMem.set(catKey, new Map());
  const catDefaultsMem = shopeeCategoryDefaultsMem.get(catKey);
  for (const inc of norm) {
    if (!inc.original_value_name && !inc.value_id) continue;
    catDefaultsMem.set(String(inc.attribute_id), {
      value_id: inc.value_id,
      original_value_name: inc.original_value_name,
      display_value_name: inc.display_value_name,
      value_unit: inc.value_unit,
    });
    try {
      db.run(
        `INSERT INTO shopee_category_default_values (category_id, attribute_id, value_id, original_value_name, display_value_name, value_unit, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(category_id, attribute_id) DO UPDATE SET
           value_id = excluded.value_id,
           original_value_name = excluded.original_value_name,
           display_value_name = excluded.display_value_name,
           value_unit = excluded.value_unit,
           updated_at = CURRENT_TIMESTAMP`,
        [Number(categoryId), inc.attribute_id, inc.value_id, inc.original_value_name, inc.display_value_name, inc.value_unit]
      );
      defaultsUpserted += 1;
    } catch (e) {
      console.error('[Shopee merge] failed to upsert default:', e.message);
    }
  }

  // Invalida cache de atributos da categoria pra próxima leitura reler override.
  for (const k of shopeeCategoryAttrsCache.keys()) {
    if (k.includes(`|${categoryId}|`)) shopeeCategoryAttrsCache.delete(k);
  }

  return { merged: norm.length, updated_value_ids: updatedValueIds, defaults_upserted: defaultsUpserted };
}
async function shopeeGetCategoryAttributes(accountId, categoryId) {
  // 0) Override manual do seller (cola de DevTools Seller Center) tem prioridade
  //    absoluta. Como traz value_ids reais, o ideal é usar essa lista sempre
  //    que estiver presente, pulando o cascade de endpoints Shopee.
  const manualOverride = shopeeAttrsOverrideMem.get(String(categoryId));
  if (Array.isArray(manualOverride) && manualOverride.length > 0) {
    return manualOverride.map(a => ({ ...a, _fromManualOverride: true }));
  }
  const key = `${accountId}|${categoryId}|v${SHOPEE_ATTRS_CACHE_VERSION}`;
  const cached = shopeeCategoryAttrsCache.get(key);
  const TTL_MS = 6 * 60 * 60 * 1000;
  if (cached && (Date.now() - cached.at) < TTL_MS) return cached.list;
  let bestList = [];
  let lastErr = null;
  // Helper: tenta um endpoint e retorna { list, raw } para podermos inspecionar.
  const tryCall = async (path, params) => {
    const r = await shopeeApiGet(path, params, accountId);
    // A Shopee v2 costuma aninhar a resposta em .response; algumas rotas devolvem
    // o payload direto. Cobrimos os dois.
    const root = r?.response || r || {};
    const list =
      root.attribute_list ||
      root.attributes ||           // algumas regiões devolvem "attributes"
      root.recommend_attribute ||  // get_recommend_attribute
      root.data?.attribute_list ||
      [];
    return { list: Array.isArray(list) ? list : [], raw: r };
  };
  const attempts = [
    // 1) Endpoint oficial — loja BR devolve nomes em pt-br.
    ['/api/v2/product/get_attribute_tree', { category_id: categoryId, language: 'pt-br' }],
    ['/api/v2/product/get_attribute_tree', { category_id: categoryId, language: 'en' }],
    ['/api/v2/product/get_attribute_tree', { category_id: categoryId }],
    // 2) "Atributos recomendados" — endpoint alternativo que a Shopee usa pra
    //    categorias onde get_attribute_tree volta vazio (algumas verticais BR).
    ['/api/v2/product/get_recommend_attribute', { category_id: categoryId, language: 'pt-br' }],
    ['/api/v2/product/get_recommend_attribute', { category_id: categoryId }],
    // 3) Módulo global (alguns partners só têm o global_product aprovado).
    ['/api/v2/global_product/get_attribute_tree', { category_id: categoryId, language: 'pt-br' }],
    ['/api/v2/global_product/get_attribute_tree', { category_id: categoryId, language: 'en' }],
    // 4) Endpoint antigo (espera item_id em teoria, mas algumas contas aceitam category_id).
    ['/api/v2/product/get_attributes', { category_id: categoryId, language: 'pt-br' }],
    ['/api/v2/product/get_attributes', { category_id: categoryId }],
  ];
  for (const [path, params] of attempts) {
    try {
      const { list, raw } = await tryCall(path, params);
      if (list.length > 0) {
        bestList = list;
        console.log(`[Shopee] atributos da categoria ${categoryId} recuperados via ${path} (lang=${params.language || 'default'}) — ${list.length} atributos.`);
        lastErr = null;
        break;
      }
      // Resposta OK porém vazia: loga um preview da raw pra diagnóstico.
      console.log(`[Shopee] ${path} (lang=${params.language || 'default'}) devolveu lista vazia para cat ${categoryId}. Keys:`, Object.keys(raw?.response || raw || {}).join(','));
    } catch (e) {
      lastErr = e;
      console.warn(`[Shopee] ${path} (lang=${params.language || 'default'}) falhou para cat ${categoryId}: ${e.response?.data?.message || e.message}`);
    }
  }
  // Mescla com o catálogo manual (preenche atributos que a API não retornou).
  const merged = mergeShopeeStaticAttrs(bestList, categoryId);
  if (merged.length === 0 && lastErr) throw lastErr;
  // Cacheia somente se encontramos alguma coisa — assim, enquanto tudo voltar
  // vazio, seguimos tentando em cada request (não trava o seller num estado
  // incorreto por 6h).
  if (merged.length > 0) {
    shopeeCategoryAttrsCache.set(key, { list: merged, at: Date.now() });
  }
  return merged;
}

// ── Brand/Marca da Shopee ─────────────────────────────────────────────────
// Na Shopee v2, BRAND é um campo top-level de add_item/update_item (não um
// attribute_list!). Vem com brand_id + original_brand_name. A lista é
// fechada por categoria — só aceita marcas oficialmente cadastradas OU
// brand_id=0 "No Brand" (quando a categoria permite).
// Docs: /api/v2/product/get_brand_list
//
// get_attributes retorna 403 pro app em várias contas — não é obrigatório
// nosso fluxo, só precisamos do brand_list.
const shopeeBrandListCache = new Map(); // accountId|categoryId -> { list, at }

async function shopeeGetBrandList(accountId, categoryId) {
  const key = `${accountId}|${categoryId}`;
  const cached = shopeeBrandListCache.get(key);
  const TTL_MS = 6 * 60 * 60 * 1000;
  if (cached && (Date.now() - cached.at) < TTL_MS) return cached.list;

  // Paginação: Shopee limita page_size a 100 por request.
  const list = [];
  let offset = 0;
  const pageSize = 100;
  let safety = 0;
  while (safety++ < 50) {
    const resp = await shopeeApiGet('/api/v2/product/get_brand_list', {
      category_id: categoryId,
      status: 1,
      page_size: pageSize,
      offset,
    }, accountId);
    const inner = resp?.response || resp || {};
    const page = inner.brand_list || [];
    for (const b of page) {
      list.push({
        brand_id: Number(b.brand_id) || 0,
        original_brand_name: String(b.original_brand_name || b.display_brand_name || '').trim(),
        display_brand_name: String(b.display_brand_name || b.original_brand_name || '').trim(),
      });
    }
    if (!inner.has_next_page || page.length < pageSize) break;
    offset += pageSize;
  }
  shopeeBrandListCache.set(key, { list, at: Date.now() });
  return list;
}

// Resolve a marca informada pelo seller em {brand_id, original_brand_name}
// válidos para a categoria. Se nada bater, cai no "No Brand" (id=0).
async function resolveShopeeBrandForPublish(accountId, categoryId, brandNameRaw) {
  const brandName = (brandNameRaw || '').toString().trim();
  let list = [];
  try {
    list = await shopeeGetBrandList(accountId, categoryId);
  } catch (e) {
    console.warn('[Shopee publish] get_brand_list falhou, usando fallback No Brand:', e.response?.data?.message || e.message);
  }

  // 1) Match exato (case-insensitive)
  if (brandName) {
    const exact = list.find(b =>
      b.original_brand_name.toLowerCase() === brandName.toLowerCase() ||
      b.display_brand_name.toLowerCase() === brandName.toLowerCase()
    );
    if (exact) return { brand_id: exact.brand_id, original_brand_name: exact.original_brand_name, matched: 'exact' };
  }

  // 2) "Sem Marca"/"No Brand" — tenta achar o id=0 real da categoria
  const noBrand = list.find(b =>
    b.brand_id === 0 ||
    /^no\s*brand$/i.test(b.original_brand_name) ||
    /^sem\s*marca$/i.test(b.display_brand_name) ||
    /^sem\s*marca$/i.test(b.original_brand_name)
  );
  if (noBrand) return { brand_id: noBrand.brand_id, original_brand_name: noBrand.original_brand_name || 'No Brand', matched: 'no_brand' };

  // 3) Fallback cego — Shopee aceita brand_id=0 em quase todas as categorias.
  return { brand_id: 0, original_brand_name: brandName || 'No Brand', matched: 'fallback' };
}

/**
 * Publica modelo na Shopee usando category_id e title_override em marketplace_mappings.channels.shopee.
 */
/**
 * Constrói `tier_variation` + `model` no formato exigido pela Shopee a partir das
 * `attribute_combinations` do modelo. Se houver variações, a chamada add_item
 * começa com stock=0 e em seguida chamamos init_tier_variation para criar os
 * modelos com preço e estoque corretos.
 *
 * Regras:
 * - Agrupa valores únicos por nome de atributo preservando a ordem de primeira ocorrência.
 * - Limita a 2 tiers (regra Shopee) — tiers adicionais são concatenados na primeira opção para evitar erro.
 * - Combina `value_name` em lowercase para dedupe tolerante a capitalização.
 */
function buildShopeeTierVariationsFromVariations(variations) {
  const tierMap = new Map();
  for (const v of variations) {
    for (const c of v.attribute_combinations || []) {
      const key = (c.name || c.id || '').toString().trim();
      if (!key) continue;
      if (!tierMap.has(key)) tierMap.set(key, new Map());
      const options = tierMap.get(key);
      const optName = (c.value_name || c.value_id || '').toString().trim();
      if (!optName) continue;
      const nk = optName.toLowerCase();
      if (!options.has(nk)) options.set(nk, optName);
    }
  }
  const tierNames = Array.from(tierMap.keys()).slice(0, 2);
  const tierVariation = tierNames.map((name) => ({
    name,
    option_list: Array.from(tierMap.get(name).values()).map((opt) => ({ option: opt })),
  }));

  const indexMaps = tierNames.map((name) => {
    const arr = Array.from(tierMap.get(name).keys());
    const m = new Map();
    arr.forEach((k, i) => m.set(k, i));
    return m;
  });

  const models = variations.map((v) => {
    const combos = v.attribute_combinations || [];
    const tier_index = tierNames.map((name, ti) => {
      const c = combos.find((x) => (x.name || x.id) === name);
      const val = (c?.value_name || c?.value_id || '').toString().trim().toLowerCase();
      return indexMaps[ti].get(val) ?? 0;
    });
    return { tier_index, variation: v };
  });
  return { tierVariation, models };
}

async function publishAdModelToShopee(model, accountId, overrides) {
  const variations = JSON.parse(model.variations || '[]');
  const hasVar = variations.some((v) => v.attribute_combinations && v.attribute_combinations.length > 0);
  const maps = parseAdModelMarketplaceMappings(model);
  const shopeeCh = maps.channels?.shopee || {};
  const catRaw = shopeeCh.category_id != null && String(shopeeCh.category_id).trim() !== ''
    ? String(shopeeCh.category_id).trim()
    : '';
  const categoryId = parseInt(catRaw, 10);
  if (!Number.isFinite(categoryId) || categoryId <= 0) {
    throw new Error('Informe o ID da categoria Shopee em Modelo → Mapeamento multi-marketplace.');
  }
  const pictures = JSON.parse(model.pictures || '[]');
  const firstUrl = (pictures[0] && (pictures[0].source || pictures[0].secure_url)) || '';
  if (!firstUrl) throw new Error('É necessário pelo menos uma imagem no modelo para publicar na Shopee.');
  const basePrice = Number(overrides.price != null ? overrides.price : model.price);
  const baseStock = Number(overrides.qty != null ? overrides.qty : model.available_quantity);
  if (!Number.isFinite(basePrice) || basePrice <= 0) throw new Error('Preço inválido.');
  const baseStockInt = Math.max(0, Math.min(999999, Math.floor(Number.isFinite(baseStock) ? baseStock : 0)));

  const pkg = parseAdModelPackageMeasures(model);
  let pkgLen = 10;
  let pkgW = 10;
  let pkgH = 10;
  let weightKg = 0.5;
  if (pkg && pkg.has_factory_packaging !== false) {
    const w = Number(pkg.width_cm);
    const h = Number(pkg.height_cm);
    const d = Number(pkg.depth_cm);
    const kg = Number(pkg.weight_kg);
    if (Number.isFinite(w) && w > 0) pkgW = w;
    if (Number.isFinite(h) && h > 0) pkgH = h;
    if (Number.isFinite(d) && d > 0) pkgLen = d;
    if (Number.isFinite(kg) && kg > 0) weightKg = kg;
  }

  const titleBase = (shopeeCh.title_override || model.title || '').trim().slice(0, 255);
  if (!titleBase) throw new Error('Título obrigatório.');

  const desc = String(model.description || '').trim().slice(0, 5000) || '—';

  const imageIds = [];
  const imgErrors = [];
  const imgsToUpload = pictures.slice(0, 9);
  for (const p of imgsToUpload) {
    const u = p.source || p.secure_url;
    if (!u) continue;
    try {
      const id = await shopeeUploadProductImageFromUrl(accountId, u);
      if (id) imageIds.push(id);
    } catch (e) {
      const msg = e.message || String(e);
      console.error(`[Shopee publish] image upload failed for ${u}:`, msg);
      imgErrors.push(msg);
    }
  }
  if (imageIds.length === 0) {
    const hint = imgErrors.length > 0 ? ` Detalhes: ${imgErrors.slice(0, 3).join(' | ')}` : '';
    const sharpHint = !sharpLib ? ' Dica: instale a dependência "sharp" no servidor (`npm install sharp`) para que o miti converta automaticamente imagens WebP/GIF e redimensione fotos grandes antes do envio.' : '';
    throw new Error(`Falha ao enviar imagens para a Shopee.${hint}${sharpHint}`);
  }

  let logistic_info = await shopeeGetLogisticInfoForAddItem(accountId);
  if (!logistic_info.length) {
    throw new Error('Não foi possível obter canais de logística na Shopee. Configure envio na loja e tente novamente.');
  }

  const itemSku = (model.sku && String(model.sku).trim()) || `miti-${model.id}`;

  // Brand é top-level na Shopee v2 (não attribute_list) e a lista é fechada
  // por categoria. Se o seller digitou uma marca que não existe no cadastro
  // oficial da Shopee, caímos automaticamente em "No Brand" (brand_id=0).
  const brandNameRaw = (shopeeCh.brand_name || shopeeCh.brand || '').toString().trim();
  const brand = await resolveShopeeBrandForPublish(accountId, categoryId, brandNameRaw);
  if (brandNameRaw && brand.matched !== 'exact') {
    console.warn(`[Shopee publish] Marca "${brandNameRaw}" não encontrada na categoria ${categoryId} — usando ${brand.matched === 'no_brand' ? '"Sem marca" oficial' : 'fallback brand_id=0'}.`);
  }

  // Shopee v2 depreciou o campo "stock" (Int) e agora exige "seller_stock" como
  // array com pelo menos um item { location_id?, stock }. Para itens com
  // variações o estoque vai depois via init_tier_variation/update_stock; mas
  // ainda assim o add_item precisa de um seller_stock inicial no produto-pai
  // (mesmo que 0) — do contrário: "invalid field seller_stock, value must Not Null".
  const initialStock = hasVar ? 0 : baseStockInt;

  // Ficha técnica: o seller configura pares {attribute_id → valor} no modelo,
  // aba "Mapeamento multi-marketplace → Shopee". Cada valor pode ser:
  //   • { value_id: number, original_value_name: string }  (escolha de dropdown)
  //   • { original_value_name: string, value_unit?: string }  (texto/numero livre)
  const shopeeAttributesCfg = (shopeeCh.attributes && typeof shopeeCh.attributes === 'object') ? shopeeCh.attributes : {};
  const attribute_list = [];
  const riskyDropdowns = [];
  // Pre-flight: pega o schema da categoria (API ou catálogo estático) pra saber
  // quais atributos são dropdown fechado. Assim conseguimos falhar com mensagem
  // clara antes de bater na Shopee e receber o opaco "cannot be customized".
  let categoryAttrsSchema = [];
  try {
    categoryAttrsSchema = await shopeeGetCategoryAttributes(accountId, categoryId);
  } catch (_) {
    categoryAttrsSchema = [];
  }
  const schemaById = new Map(categoryAttrsSchema.map(a => [Number(a.attribute_id), a]));
  const STRICT_DROPDOWNS = new Set(['DROP_DOWN', 'MULTI_SELECT', 'MULTI_SELECT_COMBO_BOX']);
  for (const [attrIdRaw, v] of Object.entries(shopeeAttributesCfg)) {
    const attribute_id = parseInt(attrIdRaw, 10);
    if (!Number.isFinite(attribute_id) || attribute_id <= 0) continue;
    if (!v) continue;
    const entry = {};
    if (v.value_id != null && Number.isFinite(Number(v.value_id))) entry.value_id = Number(v.value_id);
    const name = (v.original_value_name || v.value_name || '').toString().trim();
    if (name) entry.original_value_name = name;
    if (v.value_unit) entry.value_unit = String(v.value_unit);
    // Entrada vazia não é enviada (sem value_id nem original_value_name).
    if (entry.value_id == null && !entry.original_value_name) continue;
    // Se o atributo é dropdown estrito E não temos value_id, Shopee rejeita
    // com code 3013 "cannot be customized". Coletamos pra falhar junto no fim.
    const schema = schemaById.get(attribute_id);
    if (entry.value_id == null && schema && STRICT_DROPDOWNS.has(String(schema.input_type || '').toUpperCase())) {
      riskyDropdowns.push({
        attribute_id,
        name: schema.display_attribute_name || schema.original_attribute_name || `Atributo ${attribute_id}`,
        value: entry.original_value_name,
      });
    }
    attribute_list.push({
      attribute_id,
      attribute_value_list: [entry],
    });
  }
  if (riskyDropdowns.length > 0) {
    const lines = riskyDropdowns.map(r => `  • ${r.name} (id ${r.attribute_id}) — valor "${r.value}" sem ID oficial`).join('\n');
    const err = new Error(
      `A Shopee exige o ID numérico oficial para estes atributos de dropdown fechado:\n${lines}\n\n` +
      `Como o app do miti não tem permissão para listar esses IDs pela API, resolva assim:\n` +
      `  1. Publique UM item nesta categoria diretamente pelo Seller Center Shopee (web, shopee.com.br/shop/...).\n` +
      `  2. Volte no miti, abra o modelo → aba "Ficha técnica Shopee" → clique em "Importar de anúncio Shopee".\n` +
      `  3. Escolha o anúncio que você acabou de criar. Os value_ids serão copiados automaticamente.\n\n` +
      `Depois desta importação inicial, todos os próximos modelos desta categoria funcionam automaticamente.`
    );
    err.response = { data: { debug_message: 'pre-flight: missing value_id for strict dropdown', missing_value_ids: riskyDropdowns } };
    throw err;
  }

  const addBody = {
    item_name: titleBase,
    description: desc,
    category_id: categoryId,
    item_sku: itemSku.slice(0, 100),
    image: { image_id_list: imageIds },
    original_price: basePrice,
    item_status: 'NORMAL',
    weight: weightKg,
    dimension: {
      package_length: Math.max(1, Math.round(pkgLen)),
      package_width: Math.max(1, Math.round(pkgW)),
      package_height: Math.max(1, Math.round(pkgH)),
    },
    logistic_info,
    seller_stock: [{ stock: initialStock }],
    brand: {
      brand_id: brand.brand_id,
      original_brand_name: brand.original_brand_name,
    },
  };
  if (attribute_list.length > 0) addBody.attribute_list = attribute_list;

  const data = await shopeeApiPost('/api/v2/product/add_item', addBody, accountId);
  const inner = data.response || data;
  const itemId = inner.item_id;
  if (!itemId) throw new Error(data.message || 'Resposta Shopee sem item_id.');

  const creds = await getShopeeCredentials(accountId);
  const permalink = creds.shopId ? `https://shopee.com.br/product/${creds.shopId}/${itemId}` : '';

  if (!hasVar) {
    return { item_id: itemId, permalink, items: [{ published_item_id: String(itemId), external_sku: itemSku, permalink }] };
  }

  try {
    const { tierVariation, models } = buildShopeeTierVariationsFromVariations(variations);
    if (tierVariation.length === 0 || models.length === 0) {
      console.warn('[Shopee publish] modelo com variações porém sem tiers — pulando init_tier_variation.');
      return { item_id: itemId, permalink, items: [{ published_item_id: String(itemId), external_sku: itemSku, permalink }] };
    }
    const modelPayload = models.map(({ tier_index, variation }) => {
      const price = Number(variation.price) > 0 ? Number(variation.price) : basePrice;
      const stock = Math.max(0, Math.min(999999, Math.floor(Number(variation.available_quantity) || 0)));
      // Shopee v2 atual: seller_stock (array) substitui normal_stock. Mantemos
      // ambos por compatibilidade — shops antigas ainda aceitam normal_stock,
      // mas o novo contrato exige seller_stock.
      return {
        tier_index,
        original_price: price,
        normal_stock: stock,
        seller_stock: [{ stock }],
        model_sku: (variation.seller_custom_field || '').toString().slice(0, 100) || undefined,
      };
    });
    await shopeeApiPost('/api/v2/product/init_tier_variation', {
      item_id: itemId,
      tier_variation: tierVariation,
      model: modelPayload,
    }, accountId);

    let createdModels = [];
    try {
      const lr = await shopeeApiGet('/api/v2/product/get_model_list', { item_id: String(itemId) }, accountId);
      createdModels = ((lr.response || lr).model || []);
    } catch (e) {
      console.error('[Shopee publish] get_model_list failed after init:', e.message);
    }

    const items = [];
    for (let i = 0; i < models.length; i++) {
      const spec = models[i];
      const matched = createdModels.find((cm) => Array.isArray(cm.tier_index)
        && cm.tier_index.length === spec.tier_index.length
        && cm.tier_index.every((v, idx) => v === spec.tier_index[idx]));
      const vKey = (spec.variation.attribute_combinations || [])
        .map((c) => `${c.id || c.name || ''}:${c.value_name || c.value_id || ''}`)
        .join('|');
      items.push({
        published_item_id: matched?.model_id != null ? String(matched.model_id) : String(itemId),
        external_sku: spec.variation.seller_custom_field || null,
        variation_key: vKey,
        permalink,
      });
    }
    return { item_id: itemId, permalink, items };
  } catch (err) {
    console.error('[Shopee publish] init_tier_variation error:', err.response?.data || err.message);
    throw new Error(`Item criado (id ${itemId}) mas falhou ao inicializar variações: ${err.response?.data?.message || err.message}`);
  }
}

// --- Shopee Account Management ---

/**
 * Árvore de categorias Shopee, com cache em memória por conta.
 * Usado pelo autocomplete do modal de Mapeamento Multi-marketplace.
 * Query params: accountId (obrigatório), search (opcional, filtra por nome/id).
 */
const shopeeCategoryCache = new Map(); // accountId -> { items, fetchedAt }
app.get('/api/shopee/categories', async (req, res) => {
  const accountId = parseInt(req.query.accountId, 10);
  const search = (req.query.search || '').toString().trim().toLowerCase();
  if (!accountId) return res.status(400).json({ error: 'accountId obrigatório' });
  try {
    let cached = shopeeCategoryCache.get(accountId);
    const TTL_MS = 6 * 60 * 60 * 1000; // 6h
    if (!cached || (Date.now() - cached.fetchedAt) > TTL_MS) {
      let c;
      try {
        c = await shopeeApiGet('/api/v2/product/get_category', { language: 'pt-br' }, accountId);
      } catch (err) {
        // Fallback sem language se a Shopee reclamar por algum motivo.
        try { c = await shopeeApiGet('/api/v2/product/get_category', {}, accountId); }
        catch { throw err; }
      }
      const list = (c.response || c).category_list || [];
      const items = list.map((x) => ({
        category_id: String(x.category_id),
        parent_id: String(x.parent_category_id || '0'),
        name: x.original_category_name || x.display_category_name || '',
        display_name: x.display_category_name || x.original_category_name || '',
        has_children: !!x.has_children,
      }));
      const byId = new Map(items.map((i) => [i.category_id, i]));
      // Compõe o breadcrumb de cada categoria para exibição/busca.
      for (const it of items) {
        const path = [];
        let cur = it;
        const seen = new Set();
        while (cur && !seen.has(cur.category_id)) {
          path.unshift(cur.display_name || cur.name);
          seen.add(cur.category_id);
          cur = byId.get(cur.parent_id);
        }
        it.path = path.join(' > ');
      }
      cached = { items, fetchedAt: Date.now() };
      shopeeCategoryCache.set(accountId, cached);
    }
    const items = cached.items;
    const filtered = search
      ? items.filter((it) => (it.path || '').toLowerCase().includes(search) || it.category_id.includes(search))
      : items;
    const leaves = filtered.filter((it) => !it.has_children);
    res.json({ items: leaves.slice(0, 80), total: leaves.length, fetchedAt: cached.fetchedAt });
  } catch (err) {
    const shopeeBody = err.response?.data || {};
    console.error('[Shopee Categories] erro:', shopeeBody, err.message);
    const shopeeMsg = shopeeBody.message || shopeeBody.error || err.message || 'Falha ao carregar categorias Shopee';
    // Retorna 502 para diferenciar de erro interno e inclui detalhes úteis.
    res.status(502).json({
      error: shopeeMsg,
      shopee_error: shopeeBody.error || null,
      request_id: shopeeBody.request_id || null,
      hint: 'Se a mensagem for "Wrong sign"/"error_sign", a chave da conta pode precisar ser reconfigurada. Você ainda pode digitar o ID da categoria Shopee manualmente.',
    });
  }
});

app.get('/api/shopee/accounts', (req, res) => {
  db.all(`SELECT id, name, partner_id, partner_key, shop_id, redirect_uri,
                 bling_account_id,
                 COALESCE(auto_invoice_enabled, 0) AS auto_invoice_enabled,
                 COALESCE(auto_sync_enabled, 0) AS auto_sync_enabled,
                 last_items_sync_at, tax_pct,
                 created_at, updated_at
            FROM shopee_accounts ORDER BY id`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ accounts: rows || [] });
  });
});

app.post('/api/shopee/accounts', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
  db.run('INSERT INTO shopee_accounts (name) VALUES (?)', [name], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, id: this.lastID });
  });
});

app.put('/api/shopee/accounts/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { partner_id, partner_key, redirect_uri } = req.body;
  if (!partner_id || !partner_key) return res.status(400).json({ error: 'Partner ID e Partner Key obrigatórios' });
  db.run('UPDATE shopee_accounts SET partner_id = ?, partner_key = ?, redirect_uri = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [partner_id, partner_key, redirect_uri || '', id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
});

app.put('/api/shopee/accounts/:id/mapping', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { bling_account_id, auto_invoice_enabled } = req.body || {};
  const sets = [];
  const params = [];
  if (bling_account_id !== undefined) {
    sets.push('bling_account_id = ?');
    params.push(bling_account_id === null || bling_account_id === '' ? null : parseInt(bling_account_id, 10));
  }
  if (auto_invoice_enabled !== undefined) {
    sets.push('auto_invoice_enabled = ?');
    params.push(auto_invoice_enabled ? 1 : 0);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  params.push(id);
  db.run(`UPDATE shopee_accounts SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, params, function (e) {
    if (e) return res.status(500).json({ error: e.message });
    res.json({ success: true, changes: this.changes });
  });
});

app.delete('/api/shopee/accounts/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.serialize(() => {
    db.run('DELETE FROM shopee_stock_config WHERE shopee_account_id = ?', [id]);
    db.run('DELETE FROM shopee_items WHERE shopee_account_id = ?', [id]);
    db.run('DELETE FROM api_tokens WHERE provider = ? AND account_id = ?', ['shopee', id]);
    db.run('DELETE FROM shopee_accounts WHERE id = ?', [id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, deleted: this.changes });
    });
  });
});

// Configurações fiscais da conta Shopee. Mesma semântica da rota ML.
app.put('/api/shopee/accounts/:id/tax-settings', authenticateToken, requireRoleAtLeast(4), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const raw = req.body.tax_pct;
  const value = (raw === '' || raw == null || Number.isNaN(Number(raw))) ? null : Number(raw);
  if (value != null && (value < 0 || value > 100)) {
    return res.status(400).json({ error: 'tax_pct deve ser um percentual entre 0 e 100' });
  }
  db.run('UPDATE shopee_accounts SET tax_pct = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [value, id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    if (!this.changes) return res.status(404).json({ error: 'Conta não encontrada' });
    res.json({ success: true, tax_pct: value });
  });
});

// --- Shopee OAuth ---

app.get('/api/shopee/test-sign/:id', async (req, res) => {
  const accountId = parseInt(req.params.id, 10);
  const creds = await getShopeeCredentials(accountId);
  if (!creds || !creds.partnerId || !creds.partnerKey) return res.status(400).json({ error: 'Credenciais não configuradas' });
  let redirectUri = creds.redirectUri || `${req.protocol}://${req.get('host')}/api/shopee/callback`;
  if (redirectUri && !redirectUri.includes('/api/shopee/callback')) {
    redirectUri = redirectUri.replace(/\/+$/, '') + '/api/shopee/callback';
  }
  const apiPath = '/api/v2/shop/auth_partner';
  const timestamp = Math.floor(Date.now() / 1000);
  const partnerId = parseInt(creds.partnerId, 10);
  const baseStr = `${partnerId}${apiPath}${timestamp}`;

  const rawKey = creds.partnerKey;
  const keyChars = rawKey ? rawKey.split('').map((c, i) => c.charCodeAt(0)) : [];
  const hasInvalidChars = keyChars.some(c => c > 127 || c < 32);
  const keyHex = rawKey ? Buffer.from(rawKey).toString('hex') : '';

  const methods = ['full', 'strip', 'hex'];
  const results = {};
  for (const m of methods) {
    try {
      const sign = generateShopeeSign(partnerId, apiPath, timestamp, null, null, rawKey, m);
      results[m] = {
        sign,
        url: `${SHOPEE_HOST}${apiPath}?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sign}&redirect=${encodeURIComponent(redirectUri)}`
      };
    } catch (e) {
      results[m] = { error: e.message };
    }
  }

  // If user passes ?key= in query, also compute with that key for comparison
  let manualKeyResult = null;
  if (req.query.key) {
    const mk = req.query.key.trim();
    try {
      const sign = generateShopeeSign(partnerId, apiPath, timestamp, null, null, mk, 'full');
      manualKeyResult = {
        keyLength: mk.length,
        first8: mk.substring(0, 8),
        last4: mk.substring(mk.length - 4),
        matchesDb: mk === rawKey,
        sign,
        url: `${SHOPEE_HOST}${apiPath}?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sign}&redirect=${encodeURIComponent(redirectUri)}`
      };
    } catch (e) {
      manualKeyResult = { error: e.message };
    }
  }

  const keyInfo = {
    rawLength: rawKey?.length,
    startsWithShpk: rawKey?.startsWith('shpk'),
    first16: rawKey?.substring(0, 16),
    last8: rawKey?.substring(rawKey.length - 8),
    hasInvalidChars,
    keyAsHex: keyHex.substring(0, 32) + '...' + keyHex.substring(keyHex.length - 16)
  };
  console.log('[Shopee Test Sign]', { partnerId, baseStr, keyInfo });
  res.json({ partnerId, baseStr, timestamp, keyInfo, redirectUri, results, manualKeyResult });
});

app.get('/api/shopee/live-test/:id', async (req, res) => {
  const accountId = parseInt(req.params.id, 10);
  const creds = await getShopeeCredentials(accountId);
  if (!creds || !creds.partnerId || !creds.partnerKey) return res.status(400).json({ error: 'Credenciais não configuradas' });
  let redirectUri = creds.redirectUri || `${req.protocol}://${req.get('host')}/api/shopee/callback`;
  if (redirectUri && !redirectUri.includes('/api/shopee/callback')) {
    redirectUri = redirectUri.replace(/\/+$/, '') + '/api/shopee/callback';
  }
  const apiPath = '/api/v2/shop/auth_partner';
  const timestamp = Math.floor(Date.now() / 1000);
  const partnerId = parseInt(creds.partnerId, 10);
  const methods = ['full', 'strip', 'hex'];
  const liveResults = {};
  for (const m of methods) {
    try {
      const sign = generateShopeeSign(partnerId, apiPath, timestamp, null, null, creds.partnerKey, m);
      const testUrl = `${SHOPEE_HOST}${apiPath}?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sign}&redirect=${encodeURIComponent(redirectUri)}`;
      const resp = await axios.get(testUrl, { maxRedirects: 0, validateStatus: () => true, timeout: 10000 });
      liveResults[m] = {
        status: resp.status,
        headers: resp.headers?.location ? { location: resp.headers.location } : undefined,
        body: typeof resp.data === 'string' ? resp.data.substring(0, 500) : resp.data,
        worked: resp.status === 302 || resp.status === 200 && !resp.data?.error
      };
    } catch (e) {
      liveResults[m] = { error: e.message };
    }
  }
  const serverTime = new Date().toISOString();
  console.log('[Shopee Live Test]', { serverTime, timestamp, partnerId, liveResults });
  res.json({ serverTime, timestamp, partnerId, host: SHOPEE_HOST, redirectUri, liveResults });
});

app.get('/api/shopee/auth-url/:id', async (req, res) => {
  const accountId = parseInt(req.params.id, 10);
  const method = req.query.method || process.env.SHOPEE_SIGN_METHOD || 'full';
  const creds = await getShopeeCredentials(accountId);
  if (!creds || !creds.partnerId || !creds.partnerKey) return res.status(400).json({ error: 'Configure Partner ID e Partner Key primeiro' });
  let redirectUri = creds.redirectUri || `${req.protocol}://${req.get('host')}/api/shopee/callback`;
  if (redirectUri && !redirectUri.includes('/api/shopee/callback')) {
    redirectUri = redirectUri.replace(/\/+$/, '') + '/api/shopee/callback';
  }
  const apiPath = '/api/v2/shop/auth_partner';
  const timestamp = Math.floor(Date.now() / 1000);
  const partnerId = parseInt(creds.partnerId, 10);
  const sign = generateShopeeSign(partnerId, apiPath, timestamp, null, null, creds.partnerKey, method);
  const url = `${SHOPEE_HOST}${apiPath}?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sign}&redirect=${encodeURIComponent(redirectUri)}`;
  console.log('[Shopee Auth]', { host: SHOPEE_HOST, partnerId, method, sign, redirectUri });
  res.json({ url, redirectUri });
});

app.get('/api/shopee/callback', async (req, res) => {
  const { code, shop_id } = req.query;
  if (!code || !shop_id) return res.status(400).send('Parâmetros inválidos');
  try {
    const accounts = await new Promise((resolve, reject) => {
      db.all('SELECT id, partner_id, partner_key FROM shopee_accounts WHERE partner_id IS NOT NULL', (err, rows) => err ? reject(err) : resolve(rows || []));
    });
    if (accounts.length === 0) return res.status(400).send('Nenhuma conta Shopee configurada');
    const acc = accounts[0];
    db.run('UPDATE shopee_accounts SET shop_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [String(shop_id), acc.id]);
    const path = '/api/v2/auth/token/get';
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = generateShopeeSign(acc.partner_id, path, timestamp, null, null, acc.partner_key);
    const resp = await axios.post(`${SHOPEE_HOST}${path}?partner_id=${acc.partner_id}&timestamp=${timestamp}&sign=${sign}`, {
      code,
      shop_id: parseInt(shop_id, 10),
      partner_id: parseInt(acc.partner_id, 10)
    });
    if (resp.data.error) return res.status(400).send('Erro ao obter token: ' + (resp.data.message || resp.data.error));
    await saveShopeeToken(resp.data, acc.id);
    res.redirect('/external-apis?shopee=connected');
  } catch (e) {
    console.error('[Shopee] Callback error:', e.response?.data || e.message);
    res.status(500).send('Erro na autenticação Shopee: ' + (e.response?.data?.message || e.message));
  }
});

app.get('/api/shopee/connection-status/:id', async (req, res) => {
  const accountId = parseInt(req.params.id, 10);
  try {
    const token = await loadShopeeToken(accountId);
    if (!token) return res.json({ connected: false });
    const creds = await getShopeeCredentials(accountId);
    if (!creds || !creds.shopId) return res.json({ connected: false });
    await shopeeApiGet('/api/v2/shop/get_shop_info', {}, accountId);
    res.json({ connected: true, shop_id: creds.shopId });
  } catch (e) {
    res.json({ connected: false, error: e.message });
  }
});

// --- Shopee Items Sync ---

app.post('/api/shopee/items/sync', async (req, res) => {
  const accountId = parseInt(req.body.accountId, 10);
  if (!accountId) return res.status(400).json({ error: 'accountId obrigatório' });
  try {
    const allItemIds = [];
    let offset = 0;
    const pageSize = 100;
    let hasMore = true;
    while (hasMore) {
      const listResp = await shopeeApiGet('/api/v2/product/get_item_list', {
        offset: String(offset),
        page_size: String(pageSize),
        item_status: 'NORMAL'
      }, accountId);
      const response = listResp.response || listResp;
      const items = response.item || [];
      items.forEach(i => allItemIds.push(i.item_id));
      hasMore = response.has_next_page || false;
      offset += pageSize;
    }
    // Also fetch BANNED items
    offset = 0; hasMore = true;
    while (hasMore) {
      try {
        const listResp = await shopeeApiGet('/api/v2/product/get_item_list', {
          offset: String(offset), page_size: String(pageSize), item_status: 'BANNED'
        }, accountId);
        const response = listResp.response || listResp;
        const items = response.item || [];
        items.forEach(i => allItemIds.push(i.item_id));
        hasMore = response.has_next_page || false;
        offset += pageSize;
      } catch { hasMore = false; }
    }
    // Also fetch UNLIST items
    offset = 0; hasMore = true;
    while (hasMore) {
      try {
        const listResp = await shopeeApiGet('/api/v2/product/get_item_list', {
          offset: String(offset), page_size: String(pageSize), item_status: 'UNLIST'
        }, accountId);
        const response = listResp.response || listResp;
        const items = response.item || [];
        items.forEach(i => allItemIds.push(i.item_id));
        hasMore = response.has_next_page || false;
        offset += pageSize;
      } catch { hasMore = false; }
    }

    let synced = 0;
    const creds = await getShopeeCredentials(accountId);
    for (let i = 0; i < allItemIds.length; i += 50) {
      const batch = allItemIds.slice(i, i + 50);
      try {
        const infoResp = await shopeeApiGet('/api/v2/product/get_item_base_info', {
          item_id_list: batch.join(',')
        }, accountId);
        const itemList = (infoResp.response || infoResp).item_list || [];
        for (const item of itemList) {
          let sku = '';
          if (item.item_sku) sku = item.item_sku;
          const hasModel = item.has_model || false;
          const price = item.price_info?.[0]?.current_price || item.price_info?.[0]?.original_price || 0;
          const origPrice = item.price_info?.[0]?.original_price || null;
          const stock = item.stock_info_v2?.summary_info?.total_available_stock ?? item.stock_info?.[0]?.current_stock ?? 0;
          const img = item.image?.image_url_list?.[0] || '';
          const status = item.item_status || 'NORMAL';
          const permalink = creds.shopId ? `https://shopee.com.br/product/${creds.shopId}/${item.item_id}` : '';

          db.run(`INSERT OR REPLACE INTO shopee_items (id, shopee_item_id, shopee_account_id, title, sku, price, original_price, permalink, status, shopee_stock, thumbnail, has_model, last_synced_at, created_at)
                  VALUES ((SELECT id FROM shopee_items WHERE shopee_item_id = ? AND shopee_account_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, COALESCE((SELECT created_at FROM shopee_items WHERE shopee_item_id = ? AND shopee_account_id = ?), CURRENT_TIMESTAMP))`,
            [String(item.item_id), accountId, String(item.item_id), accountId, item.item_name || '', sku, price, origPrice, permalink, status, stock, img, hasModel ? 1 : 0, String(item.item_id), accountId]);
          synced++;
        }
      } catch (batchErr) { console.error('[Shopee] Batch fetch error:', batchErr.message); }
    }

    // Hidrata os modelos (variações Shopee) — apenas para itens com has_model=1.
    // Faz com concorrência limitada para respeitar o rate-limit da API Shopee.
    try {
      const modelItems = await new Promise((resolve) => {
        db.all(`SELECT shopee_item_id FROM shopee_items WHERE shopee_account_id = ? AND has_model = 1`, [accountId], (e, r) => resolve(e ? [] : (r || [])));
      });
      let mIdx = 0;
      let modelsSynced = 0;
      const concurrency = 3;
      const work = async () => {
        while (mIdx < modelItems.length) {
          const i = mIdx++;
          const itemId = modelItems[i].shopee_item_id;
          try {
            const mResp = await shopeeApiGet('/api/v2/product/get_model_list', { item_id: String(itemId) }, accountId);
            const m = mResp.response || mResp;
            const models = m.model || [];
            const tierVariations = m.tier_variation || [];
            // Limpa modelos que não existem mais antes de re-inserir.
            const validIds = models.map((mm) => String(mm.model_id));
            if (validIds.length === 0) {
              db.run('DELETE FROM shopee_item_models WHERE shopee_item_id = ? AND shopee_account_id = ?', [itemId, accountId]);
              db.run('DELETE FROM shopee_variation_stock_config WHERE shopee_item_id = ? AND shopee_account_id = ?', [itemId, accountId]);
              continue;
            }
            const placeholders = validIds.map(() => '?').join(',');
            db.run(`DELETE FROM shopee_item_models WHERE shopee_item_id = ? AND shopee_account_id = ? AND model_id NOT IN (${placeholders})`, [itemId, accountId, ...validIds]);
            db.run(`DELETE FROM shopee_variation_stock_config WHERE shopee_item_id = ? AND shopee_account_id = ? AND model_id NOT IN (${placeholders})`, [itemId, accountId, ...validIds]);
            for (const mm of models) {
              // Monta o nome legível pelo tier_variation (ex.: "Vermelho · Grande").
              const idxs = mm.tier_index || [];
              const parts = idxs.map((vi, ti) => tierVariations?.[ti]?.option_list?.[vi]?.option || '').filter(Boolean);
              const name = parts.join(' · ');
              const mPrice = mm.price_info?.[0]?.current_price ?? mm.price_info?.[0]?.original_price ?? 0;
              const mStock = mm.stock_info_v2?.summary_info?.total_available_stock ?? mm.stock_info?.[0]?.current_stock ?? 0;
              const mThumb = tierVariations?.[0]?.option_list?.[idxs?.[0]]?.image?.image_url || '';
              const mStatus = mm.model_status || '';
              db.run(`INSERT OR REPLACE INTO shopee_item_models (id, shopee_item_id, shopee_account_id, model_id, model_sku, tier_index, name, price, stock, thumbnail, status, last_synced_at)
                      VALUES ((SELECT id FROM shopee_item_models WHERE shopee_item_id = ? AND shopee_account_id = ? AND model_id = ?),
                              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                [itemId, accountId, String(mm.model_id),
                 itemId, accountId, String(mm.model_id),
                 mm.model_sku || '', JSON.stringify(idxs), name, mPrice, mStock, mThumb, mStatus]);
              modelsSynced++;
            }
          } catch (e) {
            console.warn(`[Shopee] get_model_list falhou para item ${itemId}:`, e.message);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, modelItems.length) }, work));
      console.log(`[Shopee Sync] Modelos sincronizados: ${modelsSynced} (em ${modelItems.length} itens com variação)`);
    } catch (mErr) {
      console.error('[Shopee Sync] Erro ao hidratar modelos:', mErr.message);
    }

    res.json({ success: true, total: allItemIds.length, synced });
  } catch (err) {
    console.error('[Shopee] Sync error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Erro ao sincronizar', details: err.response?.data || err.message });
  }
});

app.get('/api/shopee/items', (req, res) => {
  const accountId = req.query.accountId ? parseInt(req.query.accountId, 10) : null;
  const search = req.query.search || '';
  let sql = `SELECT i.*, a.name as account_name,
    sc.id as config_id, sc.inventory_id, sc.use_real_stock, sc.fictitious_min, sc.fictitious_max, sc.fictitious_value, sc.enabled, sc.last_pushed_at,
    inv.sku as linked_sku, inv.quantity as real_quantity
    FROM shopee_items i
    LEFT JOIN shopee_accounts a ON a.id = i.shopee_account_id
    LEFT JOIN shopee_stock_config sc ON sc.shopee_item_id = i.shopee_item_id AND sc.shopee_account_id = i.shopee_account_id
    LEFT JOIN inventory inv ON inv.id = sc.inventory_id`;
  const params = [];
  const conditions = [];
  if (accountId) { conditions.push('i.shopee_account_id = ?'); params.push(accountId); }
  if (search) {
    conditions.push('(i.title LIKE ? OR i.shopee_item_id LIKE ? OR i.sku LIKE ?)');
    const s = `%${search}%`; params.push(s, s, s);
  }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY i.title ASC';
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ad-items — endpoint agregado de Anúncios Ativos (ML + Shopee).
//
// Substitui as duas chamadas separadas que o front fazia (/api/ml/items +
// /api/shopee/items) e implementa paginação + filtros 100% server-side, para
// catálogos grandes não travarem o cliente.
//
// Query params suportados:
//   page         — número da página (1-based, default 1)
//   pageSize     — itens por página (default 50, max 200)
//   marketplace  — 'all' | 'ml' | 'shopee'   (default 'all')
//   accountId    — id da conta dentro do marketplace selecionado
//   status       — string literal aceita por cada marketplace (ex.: 'active',
//                  'paused', 'NORMAL', 'UNLIST'…). Aplica em ambos quando
//                  marketplace='all'.
//   linked       — 'all' | 'linked' | 'unlinked'
//   hasStock     — 'all' | 'yes' | 'no'   (estoque do marketplace)
//   divergence   — 'all' | 'yes'         (real vs marketplace, só configs com
//                                          use_real_stock = 1)
//   search       — busca em título / item_id / sku
//   sort         — 'title' (default) | 'updated' | 'stock'
//   order        — 'asc' | 'desc'
//
// Resposta:
//   { items, page, pageSize, total, totalPages, totals: { ml, shopee } }
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/ad-items', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
  const marketplace = ['all', 'ml', 'shopee'].includes(req.query.marketplace) ? req.query.marketplace : 'all';
  const accountId = req.query.accountId ? parseInt(req.query.accountId, 10) : null;
  const statusRaw = (req.query.status || '').toString().trim() || null;
  // Status semântico (active|paused|closed) é traduzido para os literais
  // específicos de cada marketplace. Também aceitamos o valor literal direto.
  const STATUS_GROUPS = {
    active: { ml: ['active'], shopee: ['NORMAL'] },
    paused: { ml: ['paused'], shopee: ['UNLIST'] },
    closed: { ml: ['closed'], shopee: ['BANNED', 'DELETED'] },
    review: { ml: ['under_review'], shopee: [] },
  };
  const statusGroup = statusRaw && STATUS_GROUPS[statusRaw] ? STATUS_GROUPS[statusRaw] : null;
  const statusLiteral = statusRaw && !statusGroup ? statusRaw : null;
  const linked = ['all', 'linked', 'unlinked'].includes(req.query.linked) ? req.query.linked : 'all';
  const hasStock = ['all', 'yes', 'no'].includes(req.query.hasStock) ? req.query.hasStock : 'all';
  const divergence = req.query.divergence === 'yes' ? 'yes' : 'all';
  const search = (req.query.search || '').toString().trim();
  const sort = ['title', 'updated', 'stock'].includes(req.query.sort) ? req.query.sort : 'title';
  const order = req.query.order === 'desc' ? 'DESC' : 'ASC';

  // Constrói uma SELECT normalizada para um dos marketplaces. Mantemos as
  // colunas legacy (ml_item_id/shopee_item_id, ml_account_id/shopee_account_id,
  // ml_available_quantity/shopee_stock) para que os handlers já existentes no
  // front continuem funcionando sem refator.
  const buildLeg = (mp) => {
    const params = [];
    const where = [];
    if (mp === 'ml') {
      const select = `
        SELECT 'ml' AS source,
               i.id AS local_id,
               i.ml_item_id     AS ml_item_id,
               NULL             AS shopee_item_id,
               i.ml_account_id  AS ml_account_id,
               NULL             AS shopee_account_id,
               i.ml_account_id  AS account_id,
               a.name           AS account_name,
               i.title          AS title,
               i.sku            AS sku,
               i.thumbnail      AS thumbnail,
               i.permalink      AS permalink,
               i.status         AS status,
               i.price          AS price,
               i.original_price AS original_price,
               i.ml_available_quantity AS ml_available_quantity,
               NULL             AS shopee_stock,
               i.ml_available_quantity AS mkt_stock,
               i.variation_count       AS variation_count,
               i.listing_type_id       AS listing_type_id,
               i.is_catalog_listing    AS is_catalog_listing,
               NULL                     AS has_model,
               i.last_synced_at         AS last_synced_at,
               sc.id            AS config_id,
               sc.inventory_id  AS inventory_id,
               sc.use_real_stock AS use_real_stock,
               sc.fictitious_min AS fictitious_min,
               sc.fictitious_max AS fictitious_max,
               sc.fictitious_value AS fictitious_value,
               sc.enabled        AS enabled,
               sc.last_pushed_at AS last_pushed_at,
               sc.last_error_message AS last_error_message,
               sc.last_error_at      AS last_error_at,
               inv.sku           AS linked_sku,
               inv.quantity      AS real_quantity,
               inv.is_composite  AS is_composite,
               CASE WHEN EXISTS(SELECT 1 FROM composite_skus cs_exists WHERE cs_exists.main_sku_id = inv.id) THEN 1 ELSE 0 END AS has_components,
               COALESCE(cm.composite_qty, 0) AS composite_qty,
               COALESCE(oo.open_qty, 0) AS open_orders_qty,
               MAX(0,
                   (CASE WHEN inv.is_composite = 1 THEN COALESCE(cm.composite_qty, 0) ELSE COALESCE(inv.quantity, 0) END)
                   - COALESCE(oo.open_qty, 0)) AS real_available
        FROM ml_items i
        LEFT JOIN ml_accounts a ON a.id = i.ml_account_id
        LEFT JOIN ml_stock_config sc ON sc.ml_item_id = i.ml_item_id AND sc.ml_account_id = i.ml_account_id
        LEFT JOIN inventory inv ON inv.id = sc.inventory_id
        LEFT JOIN (
          SELECT cs.main_sku_id AS inventory_id, MIN(inv_c.quantity / cs.quantity) AS composite_qty
          FROM composite_skus cs
          JOIN inventory inv_c ON inv_c.id = cs.component_sku_id
          WHERE cs.quantity > 0
          GROUP BY cs.main_sku_id
        ) cm ON cm.inventory_id = sc.inventory_id
        LEFT JOIN (
          SELECT inv2.id AS inventory_id, SUM(oi.quantity) AS open_qty
          FROM marketplace_order_items oi
          JOIN marketplace_orders o ON o.id = oi.order_id
          JOIN inventory inv2 ON inv2.sku = oi.sku
          WHERE o.status NOT IN ('cancelled','refunded')
            AND (o.shipping_status IS NULL OR o.shipping_status NOT IN ('shipped','delivered','in_transit','not_delivered','cancelled'))
          GROUP BY inv2.id
        ) oo ON oo.inventory_id = sc.inventory_id`;
      if (accountId) { where.push('i.ml_account_id = ?'); params.push(accountId); }
      if (statusGroup) {
        const list = statusGroup.ml;
        if (list.length === 0) where.push('1 = 0');
        else { where.push(`i.status IN (${list.map(() => '?').join(',')})`); params.push(...list); }
      } else if (statusLiteral) {
        where.push('i.status = ?'); params.push(statusLiteral);
      }
      if (search) {
        where.push('(i.title LIKE ? OR i.ml_item_id LIKE ? OR i.sku LIKE ?)');
        const s = `%${search}%`; params.push(s, s, s);
      }
      if (linked === 'linked') where.push('sc.id IS NOT NULL');
      else if (linked === 'unlinked') where.push('sc.id IS NULL');
      if (hasStock === 'yes') where.push('COALESCE(i.ml_available_quantity, 0) > 0');
      else if (hasStock === 'no') where.push('COALESCE(i.ml_available_quantity, 0) = 0');
      if (divergence === 'yes') where.push(`(
        (sc.id IS NOT NULL AND sc.use_real_stock = 1 AND ABS(COALESCE(i.ml_available_quantity, 0) - COALESCE(inv.quantity, 0)) > 0)
        OR EXISTS (
          SELECT 1 FROM ml_variation_stock_config vc
          JOIN ml_item_variations vi ON vi.ml_item_id = vc.ml_item_id AND vi.ml_account_id = vc.ml_account_id AND vi.variation_id = vc.variation_id
          JOIN inventory inv_v ON inv_v.id = vc.inventory_id
          WHERE vc.ml_item_id = i.ml_item_id AND vc.ml_account_id = i.ml_account_id
            AND vc.use_real_stock = 1
            AND ABS(COALESCE(vi.available_quantity, 0) - COALESCE(inv_v.quantity, 0)) > 0
        )
      )`);
      return { sql: select + (where.length ? ' WHERE ' + where.join(' AND ') : ''), params };
    } else {
      const select = `
        SELECT 'shopee' AS source,
               i.id AS local_id,
               NULL                AS ml_item_id,
               i.shopee_item_id    AS shopee_item_id,
               NULL                AS ml_account_id,
               i.shopee_account_id AS shopee_account_id,
               i.shopee_account_id AS account_id,
               a.name              AS account_name,
               i.title             AS title,
               i.sku               AS sku,
               i.thumbnail         AS thumbnail,
               i.permalink         AS permalink,
               i.status            AS status,
               i.price             AS price,
               i.original_price    AS original_price,
               NULL                AS ml_available_quantity,
               i.shopee_stock      AS shopee_stock,
               i.shopee_stock      AS mkt_stock,
               (SELECT COUNT(*) FROM shopee_item_models sm WHERE sm.shopee_item_id = i.shopee_item_id AND sm.shopee_account_id = i.shopee_account_id) AS variation_count,
               NULL                AS listing_type_id,
               NULL                AS is_catalog_listing,
               i.has_model         AS has_model,
               i.last_synced_at    AS last_synced_at,
               sc.id            AS config_id,
               sc.inventory_id  AS inventory_id,
               sc.use_real_stock AS use_real_stock,
               sc.fictitious_min AS fictitious_min,
               sc.fictitious_max AS fictitious_max,
               sc.fictitious_value AS fictitious_value,
               sc.enabled        AS enabled,
               sc.last_pushed_at AS last_pushed_at,
               sc.last_error_message AS last_error_message,
               sc.last_error_at      AS last_error_at,
               inv.sku           AS linked_sku,
               inv.quantity      AS real_quantity,
               inv.is_composite  AS is_composite,
               CASE WHEN EXISTS(SELECT 1 FROM composite_skus cs_exists WHERE cs_exists.main_sku_id = inv.id) THEN 1 ELSE 0 END AS has_components,
               COALESCE(cm.composite_qty, 0) AS composite_qty,
               COALESCE(oo.open_qty, 0) AS open_orders_qty,
               MAX(0,
                   (CASE WHEN inv.is_composite = 1 THEN COALESCE(cm.composite_qty, 0) ELSE COALESCE(inv.quantity, 0) END)
                   - COALESCE(oo.open_qty, 0)) AS real_available
        FROM shopee_items i
        LEFT JOIN shopee_accounts a ON a.id = i.shopee_account_id
        LEFT JOIN shopee_stock_config sc ON sc.shopee_item_id = i.shopee_item_id AND sc.shopee_account_id = i.shopee_account_id
        LEFT JOIN inventory inv ON inv.id = sc.inventory_id
        LEFT JOIN (
          SELECT cs.main_sku_id AS inventory_id, MIN(inv_c.quantity / cs.quantity) AS composite_qty
          FROM composite_skus cs
          JOIN inventory inv_c ON inv_c.id = cs.component_sku_id
          WHERE cs.quantity > 0
          GROUP BY cs.main_sku_id
        ) cm ON cm.inventory_id = sc.inventory_id
        LEFT JOIN (
          SELECT inv2.id AS inventory_id, SUM(oi.quantity) AS open_qty
          FROM marketplace_order_items oi
          JOIN marketplace_orders o ON o.id = oi.order_id
          JOIN inventory inv2 ON inv2.sku = oi.sku
          WHERE o.status NOT IN ('cancelled','refunded')
            AND (o.shipping_status IS NULL OR o.shipping_status NOT IN ('shipped','delivered','in_transit','not_delivered','cancelled'))
          GROUP BY inv2.id
        ) oo ON oo.inventory_id = sc.inventory_id`;
      if (accountId) { where.push('i.shopee_account_id = ?'); params.push(accountId); }
      if (statusGroup) {
        const list = statusGroup.shopee;
        if (list.length === 0) where.push('1 = 0');
        else { where.push(`i.status IN (${list.map(() => '?').join(',')})`); params.push(...list); }
      } else if (statusLiteral) {
        where.push('i.status = ?'); params.push(statusLiteral);
      }
      if (search) {
        where.push('(i.title LIKE ? OR i.shopee_item_id LIKE ? OR i.sku LIKE ?)');
        const s = `%${search}%`; params.push(s, s, s);
      }
      if (linked === 'linked') where.push('sc.id IS NOT NULL');
      else if (linked === 'unlinked') where.push('sc.id IS NULL');
      if (hasStock === 'yes') where.push('COALESCE(i.shopee_stock, 0) > 0');
      else if (hasStock === 'no') where.push('COALESCE(i.shopee_stock, 0) = 0');
      if (divergence === 'yes') where.push(`(
        (sc.id IS NOT NULL AND sc.use_real_stock = 1 AND ABS(COALESCE(i.shopee_stock, 0) - COALESCE(inv.quantity, 0)) > 0)
        OR EXISTS (
          SELECT 1 FROM shopee_variation_stock_config vsc
          JOIN shopee_item_models sm ON sm.shopee_item_id = vsc.shopee_item_id AND sm.shopee_account_id = vsc.shopee_account_id AND sm.model_id = vsc.model_id
          JOIN inventory inv_v ON inv_v.id = vsc.inventory_id
          WHERE vsc.shopee_item_id = i.shopee_item_id AND vsc.shopee_account_id = i.shopee_account_id
            AND vsc.use_real_stock = 1
            AND ABS(COALESCE(sm.stock, 0) - COALESCE(inv_v.quantity, 0)) > 0
        )
      )`);
      return { sql: select + (where.length ? ' WHERE ' + where.join(' AND ') : ''), params };
    }
  };

  // Decide quais sources entram na UNION conforme o filtro marketplace.
  const parts = [];
  if (marketplace !== 'shopee') parts.push(buildLeg('ml'));
  if (marketplace !== 'ml')     parts.push(buildLeg('shopee'));
  if (parts.length === 0) return res.json({ items: [], page, pageSize, total: 0, totalPages: 0, totals: { ml: 0, shopee: 0 } });

  // SQLite exige que cada SELECT da UNION fique "puro" (sem parênteses ao redor)
  // e que subqueries derivadas tenham alias. Sem isso, aparece
  // `SQLITE_ERROR: near "UNION": syntax error`.
  const unionSql = parts.map(p => p.sql).join(' UNION ALL ');
  const unionParams = parts.flatMap(p => p.params);

  const orderClause = sort === 'updated'
    ? `ORDER BY (last_synced_at IS NULL), last_synced_at ${order}, title ASC`
    : sort === 'stock'
      ? `ORDER BY COALESCE(mkt_stock, 0) ${order}, title ASC`
      : `ORDER BY title COLLATE NOCASE ${order}`;

  const countSql = `SELECT COUNT(*) AS n FROM (${unionSql}) t`;
  const pageSql  = `SELECT * FROM (${unionSql}) t ${orderClause} LIMIT ? OFFSET ?`;
  const pageParams = [...unionParams, pageSize, (page - 1) * pageSize];

  const baseFiltersForTotals = (mp) => {
    const { sql, params } = buildLeg(mp);
    return { sql: `SELECT COUNT(*) AS n FROM (${sql}) t`, params };
  };

  db.get(countSql, unionParams, (err, countRow) => {
    if (err) {
      console.error('[ad-items] count error:', err.message);
      return res.status(500).json({ error: err.message });
    }
    const total = countRow?.n || 0;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    db.all(pageSql, pageParams, (err2, rows) => {
      if (err2) {
        console.error('[ad-items] page error:', err2.message);
        return res.status(500).json({ error: err2.message });
      }
      const items = (rows || []).map((r) => ({
        ...r,
        item_id_display: r.source === 'ml' ? r.ml_item_id : r.shopee_item_id,
        stock_qty: r.source === 'ml' ? r.ml_available_quantity : r.shopee_stock,
        uid: `${r.source}-${r.local_id}`,
      }));

      // Hidrata variations ML (formato de /api/ml/items) e models Shopee.
      const mlIds = items
        .filter((i) => i.source === 'ml' && (i.variation_count || 0) > 0)
        .map((i) => `'${String(i.ml_item_id).replace(/'/g, "''")}'`);
      const shopeeIds = items
        .filter((i) => i.source === 'shopee' && (i.variation_count || 0) > 0)
        .map((i) => `'${String(i.shopee_item_id).replace(/'/g, "''")}'`);

      const respond = (totalsByMp) => {
        res.json({
          items, page, pageSize, total, totalPages,
          totals: totalsByMp,
        });
      };

      const totals = { ml: null, shopee: null };
      // Calcula contagem agregada por marketplace (ignorando o filtro marketplace
      // selecionado). Se a UI escolheu um marketplace específico, o outro vai
      // como null para evitar consultas extras.
      const countMp = (mp, cb) => {
        const { sql, params } = baseFiltersForTotals(mp);
        db.get(sql, params, (e, row) => cb(e ? 0 : (row?.n || 0)));
      };

      const hydrateShopee = (done) => {
        if (shopeeIds.length === 0) return done();
        const sSql = `SELECT m.*, vc.id as var_config_id, vc.inventory_id as var_inventory_id, vc.use_real_stock as var_use_real_stock,
                             vc.fictitious_min as var_fict_min, vc.fictitious_max as var_fict_max, vc.fictitious_value as var_fict_value,
                             vc.enabled as var_enabled, vc.last_pushed_at as var_last_pushed_at,
                             inv.sku as var_linked_sku, inv.quantity as var_real_quantity
                      FROM shopee_item_models m
                      LEFT JOIN shopee_variation_stock_config vc
                        ON vc.shopee_item_id = m.shopee_item_id
                       AND vc.shopee_account_id = m.shopee_account_id
                       AND vc.model_id = m.model_id
                      LEFT JOIN inventory inv ON inv.id = vc.inventory_id
                      WHERE m.shopee_item_id IN (${shopeeIds.join(',')})`;
        db.all(sSql, [], (e, rows) => {
          if (e || !rows) return done();
          const map = {};
          for (const r of rows) {
            const key = `${r.shopee_item_id}_${r.shopee_account_id}`;
            (map[key] ||= []).push(r);
          }
          for (const it of items) {
            if (it.source !== 'shopee') continue;
            it.variations = map[`${it.shopee_item_id}_${it.shopee_account_id}`] || [];
          }
          done();
        });
      };

      const finalize = () => {
        if (mlIds.length === 0) return hydrateShopee(() => respond(totals));
        const varSql = `SELECT v.*, vc.id as var_config_id, vc.inventory_id as var_inventory_id, vc.use_real_stock as var_use_real_stock,
                                vc.fictitious_min as var_fict_min, vc.fictitious_max as var_fict_max, vc.fictitious_value as var_fict_value,
                                vc.enabled as var_enabled, vc.last_pushed_at as var_last_pushed_at,
                                inv.sku as var_linked_sku, inv.quantity as var_real_quantity
                         FROM ml_item_variations v
                         LEFT JOIN ml_variation_stock_config vc
                           ON vc.ml_item_id = v.ml_item_id
                          AND vc.ml_account_id = v.ml_account_id
                          AND vc.variation_id = v.variation_id
                         LEFT JOIN inventory inv ON inv.id = vc.inventory_id
                         WHERE v.ml_item_id IN (${mlIds.join(',')})`;
        db.all(varSql, [], (eVar, vars) => {
          if (eVar || !vars) return hydrateShopee(() => respond(totals));
          const varMap = {};
          for (const v of vars) {
            const key = `${v.ml_item_id}_${v.ml_account_id}`;
            (varMap[key] ||= []).push(v);
          }
          for (const it of items) {
            if (it.source !== 'ml') continue;
            it.variations = varMap[`${it.ml_item_id}_${it.ml_account_id}`] || [];
          }
          hydrateShopee(() => respond(totals));
        });
      };

      countMp('ml', (n1) => {
        totals.ml = n1;
        countMp('shopee', (n2) => {
          totals.shopee = n2;
          finalize();
        });
      });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ad-items/sync-fast  (A6)
//
// Sync incremental para economizar chamadas à API e acelerar a atualização:
//   • Mercado Livre: pega só os ids via /users/:id/items/search (já rápido) e
//     revalida apenas itens desconhecidos (novos) ou com last_synced_at antigo
//     (> REFRESH_THRESHOLD_HOURS). Para os demais atualiza somente o
//     timestamp.
//   • Shopee: usa update_time_from = last_items_sync_at - margem para pedir só
//     os itens alterados desde a última sync. Processa-os com o mesmo fluxo
//     de get_item_base_info do sync completo.
// Aceita `accountId` para uma conta específica; sem ele itera todas.
// ─────────────────────────────────────────────────────────────────────────────
const SYNC_FAST_REFRESH_HOURS = 24;
const SYNC_FAST_SHOPEE_WINDOW_SEC = 60 * 60 * 24 * 15; // 15 dias máximo

async function runSyncFastForMlAccount(accountId) {
  const allItemIds = [];
  const out = { accountId, marketplace: 'ml', total: 0, refreshed: 0, touched: 0, added: 0, errors: 0 };
  try {
    const userRes = await mlApiGet('/users/me', accountId);
    const userId = userRes.id;
    let scrollId = null;
    while (true) {
      const url = scrollId
        ? `/users/${userId}/items/search?search_type=scan&scroll_id=${encodeURIComponent(scrollId)}`
        : `/users/${userId}/items/search?search_type=scan`;
      const resp = await mlApiGet(url, accountId);
      const results = resp.results || [];
      for (const id of results) allItemIds.push(id);
      scrollId = resp.scroll_id;
      if (!scrollId || results.length === 0) break;
    }
  } catch (e) {
    console.error('[SyncFast ML] scroll error:', e.message);
    return { ...out, errors: out.errors + 1 };
  }

  const rows = await new Promise((resolve) => {
    db.all(`SELECT ml_item_id, last_synced_at FROM ml_items WHERE ml_account_id = ?`, [accountId], (e, r) => resolve(e ? [] : (r || [])));
  });
  const known = new Map(rows.map((r) => [r.ml_item_id, r.last_synced_at]));
  const threshold = Date.now() - SYNC_FAST_REFRESH_HOURS * 3600 * 1000;
  const toRefresh = [];
  for (const id of allItemIds) {
    const last = known.get(id);
    if (!last) { toRefresh.push(id); out.added++; continue; }
    const t = new Date(last).getTime();
    if (!Number.isFinite(t) || t < threshold) { toRefresh.push(id); out.refreshed++; }
    else { out.touched++; }
  }
  // Toca o last_synced_at dos que ficaram de fora para sinalizar que ainda estão vivos.
  const stillAlive = allItemIds.filter((id) => !toRefresh.includes(id));
  if (stillAlive.length > 0) {
    const ph = stillAlive.map(() => '?').join(',');
    db.run(`UPDATE ml_items SET last_synced_at = CURRENT_TIMESTAMP WHERE ml_account_id = ? AND ml_item_id IN (${ph})`, [accountId, ...stillAlive]);
  }
  // Revalida em lotes de 20 (limite ML /items multi).
  for (let i = 0; i < toRefresh.length; i += 20) {
    const batch = toRefresh.slice(i, i + 20);
    try {
      const arr = await mlApiGet(`/items?ids=${batch.join(',')}&include_attributes=all`, accountId);
      for (const entry of arr) {
        if (!entry || entry.code !== 200 || !entry.body) continue;
        const body = entry.body;
        const img = body.pictures?.[0]?.secure_url || body.pictures?.[0]?.url || body.thumbnail || '';
        const price = body.price ?? null;
        const orig = body.original_price ?? null;
        const status = body.status || '';
        const qty = body.available_quantity ?? 0;
        const variationCount = Array.isArray(body.variations) ? body.variations.length : 0;
        const listingType = body.listing_type_id || null;
        const isCatalog = Array.isArray(body.tags) && body.tags.includes('catalog_listing') ? 1 : 0;
        db.run(`INSERT OR REPLACE INTO ml_items (id, ml_item_id, ml_account_id, title, sku, price, original_price, permalink, status, ml_available_quantity, thumbnail, listing_type_id, is_catalog_listing, variation_count, last_synced_at, created_at)
                VALUES ((SELECT id FROM ml_items WHERE ml_item_id = ? AND ml_account_id = ?),
                        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP,
                        COALESCE((SELECT created_at FROM ml_items WHERE ml_item_id = ? AND ml_account_id = ?), CURRENT_TIMESTAMP))`,
          [body.id, accountId, body.id, accountId, body.title || '', body.seller_custom_field || '',
           price, orig, body.permalink || '', status, qty, img, listingType, isCatalog, variationCount,
           body.id, accountId]);
      }
    } catch (e) {
      out.errors++;
      console.error('[SyncFast ML] batch refresh:', e.message);
    }
  }
  out.total = allItemIds.length;
  db.run(`UPDATE ml_accounts SET last_items_sync_at = CURRENT_TIMESTAMP WHERE id = ?`, [accountId]);
  return out;
}

async function runSyncFastForShopeeAccount(accountId) {
  const out = { accountId, marketplace: 'shopee', total: 0, synced: 0, errors: 0 };
  const acct = await new Promise((resolve) => db.get('SELECT last_items_sync_at FROM shopee_accounts WHERE id = ?', [accountId], (e, r) => resolve(r)));
  const nowSec = Math.floor(Date.now() / 1000);
  const lastSec = acct?.last_items_sync_at ? Math.floor(new Date(acct.last_items_sync_at).getTime() / 1000) : 0;
  // Shopee só aceita janelas curtas; fallback para 15 dias atrás.
  const fromSec = Math.max(nowSec - SYNC_FAST_SHOPEE_WINDOW_SEC, lastSec > 0 ? lastSec - 60 * 15 : nowSec - SYNC_FAST_SHOPEE_WINDOW_SEC);
  const allItemIds = [];
  for (const statusKey of ['NORMAL', 'UNLIST', 'BANNED']) {
    let offset = 0, hasMore = true;
    while (hasMore) {
      try {
        const listResp = await shopeeApiGet('/api/v2/product/get_item_list', {
          offset: String(offset), page_size: '100',
          item_status: statusKey,
          update_time_from: String(fromSec),
          update_time_to: String(nowSec),
        }, accountId);
        const response = listResp.response || listResp;
        const items = response.item || [];
        for (const it of items) allItemIds.push(it.item_id);
        hasMore = !!response.has_next_page;
        offset += 100;
      } catch { hasMore = false; }
    }
  }
  out.total = allItemIds.length;
  if (out.total === 0) {
    db.run('UPDATE shopee_accounts SET last_items_sync_at = CURRENT_TIMESTAMP WHERE id = ?', [accountId]);
    return out;
  }
  const creds = await getShopeeCredentials(accountId);
  for (let i = 0; i < allItemIds.length; i += 50) {
    const batch = allItemIds.slice(i, i + 50);
    try {
      const infoResp = await shopeeApiGet('/api/v2/product/get_item_base_info', { item_id_list: batch.join(',') }, accountId);
      const itemList = (infoResp.response || infoResp).item_list || [];
      for (const item of itemList) {
        const sku = item.item_sku || '';
        const hasModel = item.has_model ? 1 : 0;
        const price = item.price_info?.[0]?.current_price ?? item.price_info?.[0]?.original_price ?? 0;
        const origPrice = item.price_info?.[0]?.original_price ?? null;
        const stock = item.stock_info_v2?.summary_info?.total_available_stock ?? item.stock_info?.[0]?.current_stock ?? 0;
        const img = item.image?.image_url_list?.[0] || '';
        const status = item.item_status || 'NORMAL';
        const permalink = creds.shopId ? `https://shopee.com.br/product/${creds.shopId}/${item.item_id}` : '';
        db.run(`INSERT OR REPLACE INTO shopee_items (id, shopee_item_id, shopee_account_id, title, sku, price, original_price, permalink, status, shopee_stock, thumbnail, has_model, last_synced_at, created_at)
                VALUES ((SELECT id FROM shopee_items WHERE shopee_item_id = ? AND shopee_account_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, COALESCE((SELECT created_at FROM shopee_items WHERE shopee_item_id = ? AND shopee_account_id = ?), CURRENT_TIMESTAMP))`,
          [String(item.item_id), accountId, String(item.item_id), accountId, item.item_name || '', sku, price, origPrice, permalink, status, stock, img, hasModel, String(item.item_id), accountId]);
        out.synced++;
      }
    } catch (e) {
      out.errors++;
      console.error('[SyncFast Shopee] batch:', e.message);
    }
  }
  db.run('UPDATE shopee_accounts SET last_items_sync_at = CURRENT_TIMESTAMP WHERE id = ?', [accountId]);
  return out;
}

app.post('/api/ad-items/sync-fast', async (req, res) => {
  const single = req.body?.accountId ? { id: parseInt(req.body.accountId, 10), source: req.body.marketplace } : null;
  const results = [];
  const mlAccts = single?.source === 'ml' ? [{ id: single.id }] : single ? [] : await new Promise((rs) => db.all(
    `SELECT a.id FROM ml_accounts a INNER JOIN api_tokens t ON t.account_id = a.id AND t.provider = 'mercado_livre'
       WHERE t.refresh_token IS NOT NULL AND t.refresh_token != ''`,
    (e, r) => rs(e ? [] : (r || []))));
  const shopeeAccts = single?.source === 'shopee' ? [{ id: single.id }] : single ? [] : await new Promise((rs) => db.all(
    `SELECT a.id FROM shopee_accounts a INNER JOIN api_tokens t ON t.account_id = a.id AND t.provider = 'shopee'
       WHERE t.access_token IS NOT NULL AND t.access_token != ''`,
    (e, r) => rs(e ? [] : (r || []))));
  for (const acc of mlAccts) {
    try { results.push(await runSyncFastForMlAccount(acc.id)); }
    catch (e) { results.push({ accountId: acc.id, marketplace: 'ml', error: e.message }); }
  }
  for (const acc of shopeeAccts) {
    try { results.push(await runSyncFastForShopeeAccount(acc.id)); }
    catch (e) { results.push({ accountId: acc.id, marketplace: 'shopee', error: e.message }); }
  }
  res.json({ success: true, results });
});

// Agendador opcional — ligado quando AUTO_SYNC_INTERVAL_MIN > 0.
// Executa o sync rápido só para contas com auto_sync_enabled = 1.
const autoSyncMinutes = parseInt(process.env.AUTO_SYNC_INTERVAL_MIN || '0', 10);
if (autoSyncMinutes > 0) {
  setInterval(async () => {
    try {
      const mlAccts = await new Promise((rs) => db.all(
        `SELECT a.id FROM ml_accounts a INNER JOIN api_tokens t ON t.account_id = a.id AND t.provider = 'mercado_livre'
           WHERE t.refresh_token IS NOT NULL AND t.refresh_token != '' AND a.auto_sync_enabled = 1`,
        (e, r) => rs(e ? [] : (r || []))));
      const shopeeAccts = await new Promise((rs) => db.all(
        `SELECT a.id FROM shopee_accounts a INNER JOIN api_tokens t ON t.account_id = a.id AND t.provider = 'shopee'
           WHERE t.access_token IS NOT NULL AND t.access_token != '' AND a.auto_sync_enabled = 1`,
        (e, r) => rs(e ? [] : (r || []))));
      for (const acc of mlAccts) await runSyncFastForMlAccount(acc.id).catch((e) => console.error('[AutoSync ML]', e.message));
      for (const acc of shopeeAccts) await runSyncFastForShopeeAccount(acc.id).catch((e) => console.error('[AutoSync Shopee]', e.message));
    } catch (e) { console.error('[AutoSync] loop error:', e.message); }
  }, autoSyncMinutes * 60 * 1000);
  console.log(`[AutoSync] Habilitado — intervalo de ${autoSyncMinutes} min`);
}

// ─── M6: Worker híbrido de faturamento ──────────────────────────────────
// Ligado só quando MARKETPLACE_AUTO_INTERVAL_MIN > 0. Para cada conta com
// auto_invoice_enabled = 1 dispara um pipeline completo:
//   1) sync incremental (janela de 3 dias);
//   2) ML: fetch-ml-invoice nos pedidos sem chave;
//   3) Shopee: send-to-bling para 'awaiting_invoice' → poll → upload.
// Cada passo usa endpoints internos (axios POST 127.0.0.1) para reaproveitar
// as regras/resolvers/telemetria já existentes.
const autoInvoiceMinutes = parseInt(process.env.MARKETPLACE_AUTO_INTERVAL_MIN || '0', 10);
if (autoInvoiceMinutes > 0) {
  const runAutoInvoiceCycle = async () => {
    try {
      const mlAccts = await new Promise((rs) => db.all(
        `SELECT a.id FROM ml_accounts a INNER JOIN api_tokens t ON t.account_id = a.id AND t.provider = 'mercado_livre'
           WHERE t.refresh_token IS NOT NULL AND t.refresh_token != ''
             AND a.auto_invoice_enabled = 1 AND a.bling_account_id IS NOT NULL`,
        (e, r) => rs(e ? [] : (r || []))));
      const shopeeAccts = await new Promise((rs) => db.all(
        `SELECT a.id FROM shopee_accounts a INNER JOIN api_tokens t ON t.account_id = a.id AND t.provider = 'shopee'
           WHERE t.access_token IS NOT NULL AND t.access_token != ''
             AND a.auto_invoice_enabled = 1 AND a.bling_account_id IS NOT NULL`,
        (e, r) => rs(e ? [] : (r || []))));

      const windowDays = 3;
      const dateFrom = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

      const ireq = { headers: internalServiceHeaders() };
      for (const acc of mlAccts) {
        try {
          // 1) Sync de pedidos ML.
          await axios.post(`http://localhost:${PORT}/api/marketplace-orders/sync`,
            { marketplace: 'ml', accountId: acc.id, dateFrom }, ireq);
          // 2) Busca NFe ML para todo mundo sem chave.
          await axios.post(`http://localhost:${PORT}/api/marketplace-orders/fetch-ml-invoices`,
            { accountId: acc.id, dateFrom }, ireq);
        } catch (e) { console.error('[AutoInvoice ML]', acc.id, e.response?.data?.error || e.message); }
      }

      for (const acc of shopeeAccts) {
        try {
          // 1) Sync Shopee.
          await axios.post(`http://localhost:${PORT}/api/marketplace-orders/sync`,
            { marketplace: 'shopee', accountId: acc.id, dateFrom }, ireq);

          // 2) send-to-bling para pedidos prontos (awaiting_invoice).
          const toBill = await new Promise((rs) => db.all(
            `SELECT id FROM marketplace_orders
               WHERE marketplace = 'shopee' AND account_id = ?
                 AND (bling_pedido_id IS NULL OR bling_pedido_id = '')
                 AND (pipeline_stage = 'awaiting_invoice' OR status IN ('READY_TO_SHIP','PROCESSED'))`,
            [acc.id], (e, r) => rs(e ? [] : (r || []))));
          if (toBill.length) {
            await axios.post(`http://localhost:${PORT}/api/marketplace-orders/send-to-bling-bulk`,
              { orderIds: toBill.map(r => r.id) }, ireq);
          }

          // 3) poll-bling para NFes em processamento.
          await axios.post(`http://localhost:${PORT}/api/marketplace-orders/poll-bling-nfes`,
            { accountId: acc.id }, ireq);

          // 4) upload-invoice para pedidos com NFe autorizada + XML salvo.
          const toUpload = await new Promise((rs) => db.all(
            `SELECT id FROM marketplace_orders
               WHERE marketplace = 'shopee' AND account_id = ?
                 AND bling_nfe_xml IS NOT NULL AND bling_nfe_numero IS NOT NULL
                 AND nf_uploaded_at IS NULL`,
            [acc.id], (e, r) => rs(e ? [] : (r || []))));
          if (toUpload.length) {
            await axios.post(`http://localhost:${PORT}/api/marketplace-orders/upload-invoices-shopee`,
              { orderIds: toUpload.map(r => r.id) }, ireq);
          }
        } catch (e) { console.error('[AutoInvoice Shopee]', acc.id, e.response?.data?.error || e.message); }
      }
    } catch (e) { console.error('[AutoInvoice] loop error:', e.message); }
  };

  setInterval(runAutoInvoiceCycle, autoInvoiceMinutes * 60 * 1000);
  console.log(`[AutoInvoice] Habilitado — intervalo de ${autoInvoiceMinutes} min`);
}

// ─── Cron sempre ativo: busca automática de NFe (estilo Ideris) ─────────
// A cada NFE_AUTO_INTERVAL_MIN minutos (default 10), para TODAS as contas ML
// com token válido, consulta o Faturador ML pelas NFes dos pedidos sem chave,
// e em paralelo checa no Bling NFes vinculadas a pedidos sem bling_nfe_numero.
// Diferente do MARKETPLACE_AUTO_INTERVAL_MIN acima (que faz pipeline completo
// de emissão Shopee), este é apenas leitura e sempre roda, independente de
// auto_invoice_enabled. Para desativar, use NFE_AUTO_INTERVAL_MIN=0.
const nfeAutoMinutes = parseInt(process.env.NFE_AUTO_INTERVAL_MIN || '10', 10);
if (nfeAutoMinutes > 0) {
  const runAutoNfeCycle = async () => {
    const INTERNAL_BASE = `http://localhost:${PORT}`;
    const windowDays = parseInt(process.env.NFE_AUTO_WINDOW_DAYS || '30', 10);
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
    try {
      // 1) ML — fetch-ml-invoices para todas contas conectadas.
      const mlAccts = await new Promise((rs) => db.all(
        `SELECT a.id FROM ml_accounts a INNER JOIN api_tokens t ON t.account_id = a.id AND t.provider = 'mercado_livre'
           WHERE t.refresh_token IS NOT NULL AND t.refresh_token != ''`,
        (e, r) => rs(e ? [] : (r || []))));
      for (const acc of mlAccts) {
        try {
          await axios.post(`${INTERNAL_BASE}/api/marketplace-orders/fetch-ml-invoices`,
            { accountId: acc.id, dateFrom: since },
            { headers: internalServiceHeaders() });
        } catch (e) {
          const msg = e.response?.data?.error || e.response?.data?.details || e.message;
          console.error('[AutoNfe ML]', acc.id, msg);
        }
      }

      // 2) Bling — batch-nfe-check para pedidos sem NFe dos últimos `windowDays` dias.
      const pending = await new Promise((rs) => db.all(
        `SELECT id FROM marketplace_orders
           WHERE (bling_nfe_numero IS NULL OR bling_nfe_numero = '')
             AND (order_date IS NULL OR order_date >= ?)
           ORDER BY order_date DESC LIMIT 200`,
        [since], (e, r) => rs(e ? [] : (r || []))));
      for (let i = 0; i < pending.length; i += 50) {
        const chunk = pending.slice(i, i + 50).map(r => r.id);
        try {
          await axios.post(`${INTERNAL_BASE}/api/marketplace-orders/batch-nfe-check`,
            { orderIds: chunk },
            { headers: internalServiceHeaders() });
        } catch (e) {
          const msg = e.response?.data?.error || e.message;
          console.error('[AutoNfe Bling]', msg);
        }
      }

      // 3) Bling — poll-bling-nfes para pedidos com NFe em processamento
      // (independente de auto_invoice_enabled). Garante que o XML chegue.
      const pollPending = await new Promise((rs) => db.all(
        `SELECT id FROM marketplace_orders
           WHERE bling_nfe_id IS NOT NULL AND bling_nfe_id != ''
             AND (bling_nfe_status IS NULL OR bling_nfe_status IN ('pending','processing','generated')
                  OR bling_nfe_xml IS NULL OR bling_nfe_xml = '')
             AND (order_date IS NULL OR order_date >= ?)
           ORDER BY order_date DESC LIMIT 200`,
        [since], (e, r) => rs(e ? [] : (r || []))));
      for (let i = 0; i < pollPending.length; i += 50) {
        const chunk = pollPending.slice(i, i + 50).map(r => r.id);
        try {
          await axios.post(`${INTERNAL_BASE}/api/marketplace-orders/poll-bling-nfes`,
            { orderIds: chunk },
            { headers: internalServiceHeaders() });
        } catch (e) {
          const msg = e.response?.data?.error || e.message;
          console.error('[AutoNfe PollBling]', msg);
        }
      }

      // 4) Shopee — upload-invoices-shopee para pedidos com NFe autorizada
      // e XML salvo, mas ainda não enviados ao canal.
      const shopeePending = await new Promise((rs) => db.all(
        `SELECT id FROM marketplace_orders
           WHERE marketplace = 'shopee'
             AND bling_nfe_xml IS NOT NULL AND bling_nfe_xml != ''
             AND bling_nfe_numero IS NOT NULL AND bling_nfe_numero != ''
             AND (nf_uploaded_at IS NULL OR nf_uploaded_at = '')
             AND (order_date IS NULL OR order_date >= ?)
           ORDER BY order_date DESC LIMIT 200`,
        [since], (e, r) => rs(e ? [] : (r || []))));
      if (shopeePending.length) {
        try {
          await axios.post(`${INTERNAL_BASE}/api/marketplace-orders/upload-invoices-shopee`,
            { orderIds: shopeePending.map(r => r.id) },
            { headers: internalServiceHeaders() });
        } catch (e) {
          const msg = e.response?.data?.error || e.message;
          console.error('[AutoNfe UploadShopee]', msg);
        }
      }
    } catch (e) {
      console.error('[AutoNfe] loop error:', e.message);
    }
  };

  // Primeiro ciclo após 60s (dá tempo do boot completar) e depois no intervalo.
  setTimeout(runAutoNfeCycle, 60 * 1000);
  setInterval(runAutoNfeCycle, nfeAutoMinutes * 60 * 1000);
  console.log(`[AutoNfe] Habilitado — intervalo de ${nfeAutoMinutes} min (janela ${process.env.NFE_AUTO_WINDOW_DAYS || '30'} dias)`);
}

// ============================================================================
// Nightly backup worker — roda 1x/dia (default 00:00 local) e re-hidrata cada
// pedido ainda não congelado para capturar a última versão antes do marketplace
// apagar os dados da sua API. Congela pedidos que devolvem 404/410 após N
// tentativas consecutivas. Pacing lento (1.5s/req) + orçamento máximo (4h)
// para não competir com tráfego de produção.
// ============================================================================
// Configuração do backup noturno — valores são lidos de app_settings (editáveis
// via UI) com fallback para ENV e depois para defaults. Carregados/mutados por
// loadBackupConfig() abaixo.
const backupConfig = {
  enabled: true,
  hour: 0,
  paceMs: 1500,
  batch: 2000,
  maxRunMin: 240,
  freezeAfter: 3,
};

function parseIntOr(val, fallback) {
  const n = parseInt(val, 10);
  return Number.isFinite(n) ? n : fallback;
}

function loadBackupConfig() {
  backupConfig.enabled = (getSetting('nightly_backup_enabled', process.env.NIGHTLY_BACKUP_ENABLED ?? '1') ?? '1') !== '0';
  backupConfig.hour = parseIntOr(getSetting('nightly_backup_hour', process.env.NIGHTLY_BACKUP_HOUR), 0);
  backupConfig.paceMs = parseIntOr(getSetting('nightly_backup_pace_ms', process.env.NIGHTLY_BACKUP_PACE_MS), 1500);
  backupConfig.batch = parseIntOr(getSetting('nightly_backup_batch', process.env.NIGHTLY_BACKUP_BATCH), 2000);
  backupConfig.maxRunMin = parseIntOr(getSetting('nightly_backup_max_run_min', process.env.NIGHTLY_BACKUP_MAX_RUN_MIN), 240);
  backupConfig.freezeAfter = parseIntOr(getSetting('nightly_freeze_after', process.env.NIGHTLY_FREEZE_AFTER), 3);
  // Sanitização dos ranges aceitos pela UI.
  backupConfig.hour = Math.min(23, Math.max(0, backupConfig.hour));
  backupConfig.paceMs = Math.min(10000, Math.max(0, backupConfig.paceMs));
  backupConfig.batch = Math.min(20000, Math.max(10, backupConfig.batch));
  backupConfig.maxRunMin = Math.min(720, Math.max(5, backupConfig.maxRunMin));
  backupConfig.freezeAfter = Math.min(20, Math.max(1, backupConfig.freezeAfter));
  return backupConfig;
}

// Telemetria em memória do último run (exposta via /backup-status).
const nightlyBackupLastRun = {
  started_at: null,
  finished_at: null,
  stats: null,
  running: false,
  next_run_at: null,
};

async function nightlyBackupWorker(options = {}) {
  if (nightlyBackupLastRun.running) {
    console.warn('[NightlyBackup] já em execução — pulando gatilho');
    return;
  }
  const batchSize = options.batchSize || backupConfig.batch;
  const paceMs = options.paceMs ?? backupConfig.paceMs;
  const maxRunMs = (options.maxRunMin || backupConfig.maxRunMin) * 60 * 1000;
  const startedAt = Date.now();
  nightlyBackupLastRun.running = true;
  nightlyBackupLastRun.started_at = new Date().toISOString();
  nightlyBackupLastRun.stats = null;

  const stats = { scanned: 0, hydrated: 0, unchanged: 0, frozen: 0, errors: 0, skipped_empty: 0 };
  console.log(`[NightlyBackup] INÍCIO batch=${batchSize} pace=${paceMs}ms max=${maxRunMs / 60000}min`);

  try {
    const rows = await new Promise((rs) => db.all(
      `SELECT * FROM marketplace_orders
       WHERE frozen = 0
         AND (last_hydrated_at IS NULL OR last_hydrated_at < datetime('now','-20 hours'))
       ORDER BY (last_hydrated_at IS NULL) DESC, last_hydrated_at ASC, id ASC
       LIMIT ?`,
      [batchSize], (e, r) => rs(e ? [] : (r || []))
    ));
    console.log(`[NightlyBackup] selecionados ${rows.length} pedidos para hidratar`);

    for (const row of rows) {
      if (Date.now() - startedAt > maxRunMs) {
        console.warn(`[NightlyBackup] orçamento de ${maxRunMs / 60000}min estourou — parando`);
        break;
      }
      stats.scanned++;
      try {
        const fresh = row.marketplace === 'ml'
          ? await fetchMlOrderFull(row)
          : row.marketplace === 'shopee'
            ? await fetchShopeeOrderFull(row)
            : null;
        if (!fresh) { stats.skipped_empty++; continue; }
        const result = await applyFreshOrderToDb(row, fresh, 'nightly');
        if (result?.inserted) stats.hydrated++;
        else stats.unchanged++;
      } catch (e) {
        if (e && e.notFound) {
          const attempts = (row.hydrate_attempts || 0) + 1;
          if (attempts >= backupConfig.freezeAfter) {
            try { await freezeOrder(row, e.message || 'gone'); stats.frozen++; }
            catch (fe) { console.error('[NightlyBackup] freeze error:', fe.message); stats.errors++; }
          } else {
            markHydrateError(row, `notfound(${attempts}/${backupConfig.freezeAfter})`);
          }
        } else {
          const msg = e.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : (e.message || String(e));
          markHydrateError(row, msg);
          stats.errors++;
          if (stats.errors <= 5) console.warn(`[NightlyBackup] erro id=${row.id} ${row.marketplace}:${row.marketplace_order_id} — ${msg}`);
        }
      }
      if (paceMs > 0) await new Promise((r) => setTimeout(r, paceMs));
    }
  } catch (e) {
    console.error('[NightlyBackup] erro geral:', e.message);
  } finally {
    const durationSec = Math.round((Date.now() - startedAt) / 1000);
    nightlyBackupLastRun.stats = { ...stats, duration_sec: durationSec };
    nightlyBackupLastRun.finished_at = new Date().toISOString();
    nightlyBackupLastRun.running = false;
    console.log(`[NightlyBackup] FIM hidratados=${stats.hydrated} congelados=${stats.frozen} unchanged=${stats.unchanged} erros=${stats.errors} (${durationSec}s)`);
  }
}

// Agendador simples — sem node-cron. Dispara no próximo horário configurado
// com jitter de 0-15 min para não colidir com outros crons. Mantém o handle
// do setTimeout em módulo para permitir reagendar em runtime via PUT
// /api/marketplace-orders/backup-config.
let nightlyBackupTimeout = null;

function computeNextRunAt(hour) {
  const next = new Date();
  next.setHours(hour, Math.floor(Math.random() * 15), 0, 0);
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
  return next;
}

function scheduleNightlyBackup() {
  if (nightlyBackupTimeout) {
    clearTimeout(nightlyBackupTimeout);
    nightlyBackupTimeout = null;
  }
  if (!backupConfig.enabled) {
    nightlyBackupLastRun.next_run_at = null;
    console.log('[NightlyBackup] desabilitado');
    return;
  }
  const next = computeNextRunAt(backupConfig.hour);
  const delay = next.getTime() - Date.now();
  nightlyBackupLastRun.next_run_at = next.toISOString();
  nightlyBackupTimeout = setTimeout(async () => {
    try { await nightlyBackupWorker(); }
    catch (e) { console.error('[NightlyBackup] scheduler error:', e.message); }
    scheduleNightlyBackup();
  }, delay);
  const mins = Math.round(delay / 60000);
  console.log(`[NightlyBackup] próximo run em ${mins} min (${next.toISOString()}) — hora=${backupConfig.hour}:00 pacing=${backupConfig.paceMs}ms batch=${backupConfig.batch} freeze_after=${backupConfig.freezeAfter}`);
}

function rescheduleNightlyBackup() {
  scheduleNightlyBackup();
}

// Inicialização em 2 etapas: prime o cache de settings, carrega config e agenda.
(async () => {
  try {
    // Aguarda brevemente o initDatabase enfileirar as criações de tabela antes
    // de consultar app_settings. O driver sqlite3 é serial, então qualquer SELECT
    // enfileirado aqui só executa após os CREATE TABLE.
    await primeSettingsCache();
    loadBackupConfig();
    scheduleNightlyBackup();
  } catch (e) {
    console.error('[NightlyBackup] init error:', e && e.message ? e.message : e);
  }
})();

// --- Shopee Stock Config ---

app.post('/api/shopee/stock/link', (req, res) => {
  const { inventoryId, shopeeItemId, shopeeAccountId } = req.body;
  if (!inventoryId || !shopeeItemId) return res.status(400).json({ error: 'inventoryId e shopeeItemId obrigatórios' });
  const accId = shopeeAccountId || 1;
  db.run(`INSERT OR REPLACE INTO shopee_stock_config (id, inventory_id, shopee_account_id, shopee_item_id, use_real_stock, fictitious_min, fictitious_max, enabled, created_at, updated_at)
          VALUES ((SELECT id FROM shopee_stock_config WHERE inventory_id = ? AND shopee_item_id = ?), ?, ?, ?, 0, 450, 499, 1, COALESCE((SELECT created_at FROM shopee_stock_config WHERE inventory_id = ? AND shopee_item_id = ?), CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)`,
    [inventoryId, shopeeItemId, inventoryId, accId, shopeeItemId, inventoryId, shopeeItemId], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: this.lastID || this.changes });
    });
});

app.delete('/api/shopee/stock/:id', (req, res) => {
  db.run('DELETE FROM shopee_stock_config WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, deleted: this.changes });
  });
});

app.put('/api/shopee/stock/:id', (req, res) => {
  const { use_real_stock, fictitious_min, fictitious_max, enabled } = req.body;
  const verr = validateFictitiousRange(fictitious_min ?? 450, fictitious_max ?? 499);
  if (verr) return res.status(400).json({ error: verr });
  db.get('SELECT inventory_id, shopee_account_id, use_real_stock, fictitious_min, fictitious_max, enabled FROM shopee_stock_config WHERE id = ?', [req.params.id], (gerr, prev) => {
    db.run(`UPDATE shopee_stock_config SET use_real_stock = ?, fictitious_min = ?, fictitious_max = ?, fictitious_value = CASE WHEN ? <> COALESCE(fictitious_min, -1) OR ? <> COALESCE(fictitious_max, -1) THEN NULL ELSE fictitious_value END, enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [use_real_stock ? 1 : 0, fictitious_min || 450, fictitious_max || 499, fictitious_min || 450, fictitious_max || 499, enabled ? 1 : 0, req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (prev) {
          auditStockSafe('config_update', {
            inventory_id: prev.inventory_id,
            target_marketplace: 'shopee',
            target_account: prev.shopee_account_id,
            before: JSON.stringify({ use_real_stock: prev.use_real_stock, min: prev.fictitious_min, max: prev.fictitious_max, enabled: prev.enabled }),
            after: JSON.stringify({ use_real_stock: use_real_stock ? 1 : 0, min: fictitious_min || 450, max: fictitious_max || 499, enabled: enabled ? 1 : 0 }),
            meta: { config_id: Number(req.params.id) }
          }, req);
        }
        res.json({ success: true });
      });
  });
});

app.post('/api/shopee/stock-config/bulk-range', (req, res) => {
  const { config_ids, account_id, fictitious_min, fictitious_max, use_real_stock } = req.body || {};
  const verr = validateFictitiousRange(fictitious_min, fictitious_max);
  if (verr) return res.status(400).json({ error: verr });
  const ids = Array.isArray(config_ids) ? config_ids.map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n) && n > 0) : [];
  if (!ids.length && !account_id) return res.status(400).json({ error: 'Informe config_ids ou account_id' });
  const extraSet = use_real_stock !== undefined ? `, use_real_stock = ${use_real_stock ? 1 : 0}` : '';
  const whereSql = ids.length ? `WHERE id IN (${ids.map(() => '?').join(',')})` : 'WHERE shopee_account_id = ?';
  const params = ids.length ? ids : [parseInt(account_id, 10)];
  db.run(`UPDATE shopee_stock_config SET fictitious_min = ?, fictitious_max = ?, fictitious_value = NULL, updated_at = CURRENT_TIMESTAMP${extraSet} ${whereSql}`,
    [Number(fictitious_min), Number(fictitious_max), ...params], function(uErr) {
      if (uErr) return res.status(500).json({ error: uErr.message });
      auditStockSafe('config_bulk_range', { target_marketplace: 'shopee', meta: { ids, account_id, min: fictitious_min, max: fictitious_max } }, req);
      res.json({ success: true, updated: this.changes });
    });
});

app.post('/api/shopee/stock/push', async (req, res) => {
  const configId = parseInt(req.body.configId, 10);
  if (!configId) return res.status(400).json({ error: 'configId obrigatório' });
  db.get('SELECT sc.*, inv.quantity as real_quantity FROM shopee_stock_config sc JOIN inventory inv ON inv.id = sc.inventory_id WHERE sc.id = ?', [configId], async (err, config) => {
    if (err || !config) return res.status(404).json({ error: 'Config não encontrada' });
    try {
      const qty = await computeMarketplaceStockForConfig(config);
      await shopeeApiPost('/api/v2/product/update_stock', {
        item_id: parseInt(config.shopee_item_id, 10),
        stock_list: [{ model_id: 0, seller_stock: [{ stock: qty }] }]
      }, config.shopee_account_id);
      db.run('UPDATE shopee_stock_config SET fictitious_value = ?, last_pushed_at = CURRENT_TIMESTAMP, last_error_message = NULL, last_error_at = NULL WHERE id = ?', [qty, config.id]);
      db.run('UPDATE shopee_items SET shopee_stock = ?, last_synced_at = CURRENT_TIMESTAMP WHERE shopee_item_id = ? AND shopee_account_id = ?', [qty, config.shopee_item_id, config.shopee_account_id]);
      auditStockSafe('push_manual', { inventory_id: config.inventory_id, target_marketplace: 'shopee', target_account: config.shopee_account_id, after: qty, meta: { shopee_item_id: config.shopee_item_id, config_id: config.id } }, req);
      res.json({ success: true, shopee_item_id: config.shopee_item_id, pushed_quantity: qty });
    } catch (e) {
      markPushError('shopee_stock_config', config.id, e);
      res.status(500).json({ error: 'Erro ao enviar estoque', details: e.response?.data || e.message });
    }
  });
});

app.post('/api/shopee/stock/push-all', async (req, res) => {
  // A1: exigir accountId explícito (ver comentário no equivalente ML).
  const rawAccountId = req.query.accountId ?? req.body.accountId;
  const accountId = parseInt(rawAccountId, 10);
  if (!Number.isFinite(accountId) || accountId <= 0) {
    console.warn('[Shopee push-all] accountId inválido:', rawAccountId);
    return res.status(400).json({ error: 'accountId obrigatório e válido' });
  }
  db.all(`SELECT sc.*, inv.quantity as real_quantity FROM shopee_stock_config sc JOIN inventory inv ON inv.id = sc.inventory_id WHERE sc.shopee_account_id = ? AND sc.enabled = 1`, [accountId], async (err, configs) => {
    if (err) return res.status(500).json({ error: err.message });
    configs = configs || [];
    // Concorrência 3 na Shopee (o endpoint de update_stock permite até ~10req/s
    // por token; mantemos folga por causa do retry com backoff).
    const itemResult = await mapWithConcurrency(configs, 3, async (config) => {
      try {
        const qty = await computeMarketplaceStockForConfig(config);
        await shopeeApiPost('/api/v2/product/update_stock', {
          item_id: parseInt(config.shopee_item_id, 10),
          stock_list: [{ model_id: 0, seller_stock: [{ stock: qty }] }]
        }, config.shopee_account_id);
        db.run('UPDATE shopee_stock_config SET fictitious_value = ?, last_pushed_at = CURRENT_TIMESTAMP, last_error_message = NULL, last_error_at = NULL WHERE id = ?', [qty, config.id]);
        db.run('UPDATE shopee_items SET shopee_stock = ?, last_synced_at = CURRENT_TIMESTAMP WHERE shopee_item_id = ? AND shopee_account_id = ?', [qty, config.shopee_item_id, config.shopee_account_id]);
        auditStockSafe('push_bulk', { inventory_id: config.inventory_id, target_marketplace: 'shopee', target_account: config.shopee_account_id, after: qty, meta: { shopee_item_id: config.shopee_item_id, config_id: config.id } }, req);
      } catch (e) {
        markPushError('shopee_stock_config', config.id, e);
        console.error(`[Shopee] Push stock error for ${config.shopee_item_id}:`, e.response?.data || e.message);
        throw e;
      }
    });
    const varConfigs = await new Promise((resolve) => {
      db.all(`SELECT vsc.*, inv.quantity as real_quantity FROM shopee_variation_stock_config vsc JOIN inventory inv ON inv.id = vsc.inventory_id WHERE vsc.shopee_account_id = ? AND vsc.enabled = 1`, [accountId], (e, r) => resolve(e ? [] : (r || [])));
    });
    const varResult = await mapWithConcurrency(varConfigs, 3, async (vc) => {
      try {
        const qty = await computeMarketplaceStockForConfig(vc);
        await shopeeApiPost('/api/v2/product/update_stock', {
          item_id: parseInt(vc.shopee_item_id, 10),
          stock_list: [{ model_id: parseInt(vc.model_id, 10), seller_stock: [{ stock: qty }] }]
        }, vc.shopee_account_id);
        db.run('UPDATE shopee_variation_stock_config SET fictitious_value = ?, last_pushed_at = CURRENT_TIMESTAMP, last_error_message = NULL, last_error_at = NULL WHERE id = ?', [qty, vc.id]);
        db.run('UPDATE shopee_item_models SET stock = ?, last_synced_at = CURRENT_TIMESTAMP WHERE shopee_item_id = ? AND shopee_account_id = ? AND model_id = ?', [qty, vc.shopee_item_id, vc.shopee_account_id, vc.model_id]);
        auditStockSafe('push_bulk', { inventory_id: vc.inventory_id, target_marketplace: 'shopee', target_account: vc.shopee_account_id, after: qty, meta: { shopee_item_id: vc.shopee_item_id, model_id: vc.model_id, config_id: vc.id } }, req);
      } catch (e) {
        markPushError('shopee_variation_stock_config', vc.id, e);
        console.error(`[Shopee] Push variation stock error for ${vc.shopee_item_id}/${vc.model_id}:`, e.response?.data || e.message);
        throw e;
      }
    });
    res.json({
      success: true,
      pushed: itemResult.ok + varResult.ok,
      errors: itemResult.fail + varResult.fail,
      total: configs.length + varConfigs.length,
    });
  });
});

// ─── Shopee Variation Stock Config (modelos / variações) ─────────────────
app.get('/api/shopee/items/:shopeeItemId/models', (req, res) => {
  const { shopeeItemId } = req.params;
  const accountId = req.query.accountId ? parseInt(req.query.accountId, 10) : null;
  let sql = `SELECT m.*, vc.id as var_config_id, vc.inventory_id as var_inventory_id, vc.use_real_stock as var_use_real_stock,
                    vc.fictitious_min as var_fict_min, vc.fictitious_max as var_fict_max, vc.fictitious_value as var_fict_value,
                    vc.enabled as var_enabled, vc.last_pushed_at as var_last_pushed_at,
                    inv.sku as var_linked_sku, inv.quantity as var_real_quantity
             FROM shopee_item_models m
             LEFT JOIN shopee_variation_stock_config vc
               ON vc.shopee_item_id = m.shopee_item_id
              AND vc.shopee_account_id = m.shopee_account_id
              AND vc.model_id = m.model_id
             LEFT JOIN inventory inv ON inv.id = vc.inventory_id
             WHERE m.shopee_item_id = ?`;
  const params = [shopeeItemId];
  if (accountId) { sql += ' AND m.shopee_account_id = ?'; params.push(accountId); }
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.post('/api/shopee/variation-stock/link', (req, res) => {
  const { inventory_id, shopee_account_id, shopee_item_id, model_id } = req.body || {};
  if (!inventory_id || !shopee_account_id || !shopee_item_id || !model_id) {
    return res.status(400).json({ error: 'inventory_id, shopee_account_id, shopee_item_id e model_id são obrigatórios' });
  }
  db.run(`INSERT OR REPLACE INTO shopee_variation_stock_config
            (id, inventory_id, shopee_account_id, shopee_item_id, model_id, use_real_stock, fictitious_min, fictitious_max, enabled, created_at)
          VALUES ((SELECT id FROM shopee_variation_stock_config WHERE inventory_id = ? AND shopee_item_id = ? AND model_id = ?),
                  ?, ?, ?, ?, 0, 450, 499, 1,
                  COALESCE((SELECT created_at FROM shopee_variation_stock_config WHERE inventory_id = ? AND shopee_item_id = ? AND model_id = ?), CURRENT_TIMESTAMP))`,
    [inventory_id, shopee_item_id, model_id,
     inventory_id, shopee_account_id, shopee_item_id, model_id,
     inventory_id, shopee_item_id, model_id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: this.lastID });
    });
});

app.delete('/api/shopee/variation-stock/:id', (req, res) => {
  db.run('DELETE FROM shopee_variation_stock_config WHERE id = ?', [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, deleted: this.changes });
  });
});

app.put('/api/shopee/variation-stock/:id', (req, res) => {
  const { use_real_stock, fictitious_min, fictitious_max, enabled } = req.body || {};
  db.run(`UPDATE shopee_variation_stock_config SET use_real_stock = ?, fictitious_min = ?, fictitious_max = ?, enabled = ? WHERE id = ?`,
    [use_real_stock ? 1 : 0, fictitious_min || 450, fictitious_max || 499, enabled ? 1 : 0, req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
});

app.post('/api/shopee/variation-stock/push', async (req, res) => {
  const configId = parseInt(req.body.configId, 10);
  if (!configId) return res.status(400).json({ error: 'configId obrigatório' });
  db.get(`SELECT vsc.*, inv.quantity as real_quantity FROM shopee_variation_stock_config vsc JOIN inventory inv ON inv.id = vsc.inventory_id WHERE vsc.id = ?`, [configId], async (err, vc) => {
    if (err || !vc) return res.status(404).json({ error: 'Config não encontrada' });
    try {
      const qty = await computeMarketplaceStockForConfig(vc);
      await shopeeApiPost('/api/v2/product/update_stock', {
        item_id: parseInt(vc.shopee_item_id, 10),
        stock_list: [{ model_id: parseInt(vc.model_id, 10), seller_stock: [{ stock: qty }] }]
      }, vc.shopee_account_id);
      db.run('UPDATE shopee_variation_stock_config SET fictitious_value = ?, last_pushed_at = CURRENT_TIMESTAMP, last_error_message = NULL, last_error_at = NULL WHERE id = ?', [qty, vc.id]);
      db.run('UPDATE shopee_item_models SET stock = ?, last_synced_at = CURRENT_TIMESTAMP WHERE shopee_item_id = ? AND shopee_account_id = ? AND model_id = ?',
        [qty, vc.shopee_item_id, vc.shopee_account_id, vc.model_id]);
      auditStockSafe('push_manual', { inventory_id: vc.inventory_id, target_marketplace: 'shopee', target_account: vc.shopee_account_id, after: qty, meta: { shopee_item_id: vc.shopee_item_id, model_id: vc.model_id, config_id: vc.id } }, req);
      res.json({ success: true, model_id: vc.model_id, pushed_quantity: qty });
    } catch (e) {
      markPushError('shopee_variation_stock_config', vc.id, e);
      res.status(500).json({ error: 'Erro ao enviar estoque da variação Shopee', details: e.response?.data || e.message });
    }
  });
});

// --- Shopee: Editar preço e refresh ---------------------------------------

// Atualiza o preço de um item (ou de um model específico, via `model_id`) no
// Shopee. Usa /api/v2/product/update_price. Persiste localmente em shopee_items
// (item-level) ou shopee_item_models (model-level).
app.put('/api/shopee/items/:shopeeItemId/price', async (req, res) => {
  const { shopeeItemId } = req.params;
  const { price, accountId, modelId } = req.body || {};
  const accId = parseInt(accountId, 10);
  const p = Number(price);
  if (!accId) return res.status(400).json({ error: 'accountId obrigatório' });
  if (!Number.isFinite(p) || p <= 0) return res.status(400).json({ error: 'Preço inválido' });
  try {
    await shopeeApiPost('/api/v2/product/update_price', {
      item_id: parseInt(shopeeItemId, 10),
      price_list: [{ model_id: modelId ? parseInt(modelId, 10) : 0, original_price: p }],
    }, accId);
    if (modelId) {
      db.run('UPDATE shopee_item_models SET price = ?, last_synced_at = CURRENT_TIMESTAMP WHERE shopee_item_id = ? AND shopee_account_id = ? AND model_id = ?',
        [p, shopeeItemId, accId, String(modelId)]);
    } else {
      db.run('UPDATE shopee_items SET price = ?, last_synced_at = CURRENT_TIMESTAMP WHERE shopee_item_id = ? AND shopee_account_id = ?',
        [p, shopeeItemId, accId]);
    }
    res.json({ success: true, shopee_item_id: shopeeItemId, model_id: modelId || null, price: p });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao alterar preço Shopee', details: e.response?.data || e.message });
  }
});

// Atualiza as informações locais do item Shopee a partir da API. Se houver
// modelos, re-sincroniza também os modelos.
app.post('/api/shopee/items/:shopeeItemId/refresh', async (req, res) => {
  const { shopeeItemId } = req.params;
  const accId = parseInt(req.body?.accountId, 10) || 1;
  try {
    const infoResp = await shopeeApiGet('/api/v2/product/get_item_base_info', {
      item_id_list: String(shopeeItemId),
    }, accId);
    const itemList = (infoResp.response || infoResp).item_list || [];
    const item = itemList[0];
    if (!item) return res.status(404).json({ error: 'Item não encontrado no Shopee' });
    const creds = await getShopeeCredentials(accId);
    const price = item.price_info?.[0]?.current_price ?? item.price_info?.[0]?.original_price ?? 0;
    const origPrice = item.price_info?.[0]?.original_price ?? null;
    const stock = item.stock_info_v2?.summary_info?.total_available_stock ?? item.stock_info?.[0]?.current_stock ?? 0;
    const img = item.image?.image_url_list?.[0] || '';
    const status = item.item_status || 'NORMAL';
    const permalink = creds.shopId ? `https://shopee.com.br/product/${creds.shopId}/${item.item_id}` : '';
    const hasModel = item.has_model ? 1 : 0;
    db.run(`UPDATE shopee_items SET title = ?, sku = ?, price = ?, original_price = ?, status = ?, shopee_stock = ?, thumbnail = ?, permalink = ?, has_model = ?, last_synced_at = CURRENT_TIMESTAMP
            WHERE shopee_item_id = ? AND shopee_account_id = ?`,
      [item.item_name || '', item.item_sku || '', price, origPrice, status, stock, img, permalink, hasModel, shopeeItemId, accId]);
    // Se tem modelos, revalida-os também.
    let modelsSynced = 0;
    if (hasModel) {
      try {
        const mResp = await shopeeApiGet('/api/v2/product/get_model_list', { item_id: String(shopeeItemId) }, accId);
        const m = mResp.response || mResp;
        const models = m.model || [];
        const tierVariations = m.tier_variation || [];
        const validIds = models.map((mm) => String(mm.model_id));
        if (validIds.length > 0) {
          const ph = validIds.map(() => '?').join(',');
          db.run(`DELETE FROM shopee_item_models WHERE shopee_item_id = ? AND shopee_account_id = ? AND model_id NOT IN (${ph})`, [shopeeItemId, accId, ...validIds]);
          db.run(`DELETE FROM shopee_variation_stock_config WHERE shopee_item_id = ? AND shopee_account_id = ? AND model_id NOT IN (${ph})`, [shopeeItemId, accId, ...validIds]);
        }
        for (const mm of models) {
          const idxs = mm.tier_index || [];
          const parts = idxs.map((vi, ti) => tierVariations?.[ti]?.option_list?.[vi]?.option || '').filter(Boolean);
          const name = parts.join(' · ');
          const mPrice = mm.price_info?.[0]?.current_price ?? mm.price_info?.[0]?.original_price ?? 0;
          const mStock = mm.stock_info_v2?.summary_info?.total_available_stock ?? mm.stock_info?.[0]?.current_stock ?? 0;
          const mThumb = tierVariations?.[0]?.option_list?.[idxs?.[0]]?.image?.image_url || '';
          const mStatus = mm.model_status || '';
          db.run(`INSERT OR REPLACE INTO shopee_item_models (id, shopee_item_id, shopee_account_id, model_id, model_sku, tier_index, name, price, stock, thumbnail, status, last_synced_at)
                  VALUES ((SELECT id FROM shopee_item_models WHERE shopee_item_id = ? AND shopee_account_id = ? AND model_id = ?),
                          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            [shopeeItemId, accId, String(mm.model_id),
             shopeeItemId, accId, String(mm.model_id),
             mm.model_sku || '', JSON.stringify(idxs), name, mPrice, mStock, mThumb, mStatus]);
          modelsSynced++;
        }
      } catch (mErr) {
        console.warn('[Shopee refresh] get_model_list falhou:', mErr.message);
      }
    }
    res.json({ success: true, shopee_item_id: shopeeItemId, models_synced: modelsSynced });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao atualizar do Shopee', details: e.response?.data || e.message });
  }
});

// --- Shopee Item Status ---

app.post('/api/shopee/items/:shopeeItemId/status', async (req, res) => {
  const { shopeeItemId } = req.params;
  const { action, accountId } = req.body;
  const accId = parseInt(accountId, 10) || 1;
  try {
    if (action === 'unlist') {
      await shopeeApiPost('/api/v2/product/unlist_item', {
        item_list: [{ item_id: parseInt(shopeeItemId, 10), unlist: true }]
      }, accId);
      db.run('UPDATE shopee_items SET status = ? WHERE shopee_item_id = ? AND shopee_account_id = ?', ['UNLIST', shopeeItemId, accId]);
    } else if (action === 'relist') {
      await shopeeApiPost('/api/v2/product/unlist_item', {
        item_list: [{ item_id: parseInt(shopeeItemId, 10), unlist: false }]
      }, accId);
      db.run('UPDATE shopee_items SET status = ? WHERE shopee_item_id = ? AND shopee_account_id = ?', ['NORMAL', shopeeItemId, accId]);
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao alterar status', details: e.response?.data || e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ═══  END SHOPEE INTEGRATION  ════════════════════════════════
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// ═══  MARKETPLACE ORDERS  ═════════════════════════════════════
// ═══════════════════════════════════════════════════════════════

// Mapeamento consolidado (marketplace ↔ Bling) — usado pela tela
// "APIs Externas" e pelo worker híbrido de auto-fatura.
app.get('/api/marketplace-bling-mapping', (req, res) => {
  const sql = `
    SELECT 'ml' AS marketplace, ml.id AS account_id, ml.name AS account_name,
           ml.bling_account_id, b.name AS bling_account_name,
           COALESCE(ml.auto_invoice_enabled, 0) AS auto_invoice_enabled
      FROM ml_accounts ml
      LEFT JOIN bling_accounts b ON b.id = ml.bling_account_id
    UNION ALL
    SELECT 'shopee' AS marketplace, sh.id AS account_id, sh.name AS account_name,
           sh.bling_account_id, b.name AS bling_account_name,
           COALESCE(sh.auto_invoice_enabled, 0) AS auto_invoice_enabled
      FROM shopee_accounts sh
      LEFT JOIN bling_accounts b ON b.id = sh.bling_account_id
    ORDER BY marketplace, account_name COLLATE NOCASE`;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

// Atualiza o mapeamento em massa — aceita { marketplace, account_id, bling_account_id?, auto_invoice_enabled? }.
app.put('/api/marketplace-bling-mapping', (req, res) => {
  const { marketplace, account_id, bling_account_id, auto_invoice_enabled } = req.body || {};
  if (!marketplace || !account_id) return res.status(400).json({ error: 'marketplace e account_id obrigatórios' });
  const table = marketplace === 'ml' ? 'ml_accounts' : marketplace === 'shopee' ? 'shopee_accounts' : null;
  if (!table) return res.status(400).json({ error: 'marketplace inválido' });
  const sets = [];
  const params = [];
  if (bling_account_id !== undefined) {
    sets.push('bling_account_id = ?');
    params.push(bling_account_id === null || bling_account_id === '' ? null : parseInt(bling_account_id, 10));
  }
  if (auto_invoice_enabled !== undefined) {
    sets.push('auto_invoice_enabled = ?');
    params.push(auto_invoice_enabled ? 1 : 0);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  params.push(parseInt(account_id, 10));
  db.run(`UPDATE ${table} SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, params, function (e) {
    if (e) return res.status(500).json({ error: e.message });
    res.json({ success: true, changes: this.changes });
  });
});

// ============================================================================
// Nightly backup helpers — snapshot canônico, hash e gravação condicional
// em marketplace_orders_history. Usados tanto pelo sync do dia quanto pelo
// worker noturno.
// ============================================================================

// Campos que NÃO fazem parte do snapshot (metadados internos do miti).
const SNAPSHOT_EXCLUDED = new Set([
  'id', 'synced_at', 'created_at',
  'last_hydrated_at', 'hydrate_source', 'hydrate_attempts', 'hydrate_last_error',
  'marketplace_deleted_at', 'frozen', 'snapshot_hash',
  'bling_nfe_checked_at', 'last_updated_at',
  'pipeline_last_error_at',
]);

// Serializa um objeto com chaves ordenadas alfabeticamente — garante hash
// estável entre execuções.
function canonicalStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalStringify(obj[k])).join(',') + '}';
}

// Monta o snapshot canônico de um pedido (row de marketplace_orders + items).
function buildOrderSnapshot(orderRow, items) {
  const clean = {};
  for (const k of Object.keys(orderRow || {})) {
    if (SNAPSHOT_EXCLUDED.has(k)) continue;
    const v = orderRow[k];
    if (v === undefined) continue;
    clean[k] = v == null ? null : v;
  }
  const itemsClean = (items || []).map(it => ({
    marketplace_item_id: it.marketplace_item_id ?? null,
    variation_id: it.variation_id ?? null,
    sku: it.sku ?? null,
    title: it.title ?? null,
    quantity: it.quantity ?? null,
    unit_price: it.unit_price ?? null,
    thumbnail: it.thumbnail ?? null,
    variation_attributes_json: it.variation_attributes_json ?? null,
  })).sort((a, b) => String(a.marketplace_item_id || '').localeCompare(String(b.marketplace_item_id || '')));
  clean.__items__ = itemsClean;
  return clean;
}

function hashSnapshot(snap) {
  const cryptoLib = require('crypto');
  return cryptoLib.createHash('sha256').update(canonicalStringify(snap)).digest('hex');
}

// Deriva o estado de impressão da etiqueta a partir dos campos do pedido.
// Retorno:
//   { by: 'full' }                               → ML Full: etiqueta é de responsabilidade do ML
//   { by: 'ml'|'shopee', at: '<ISO>' }           → etiqueta já impressa pelo canal
//   null                                         → ainda pendente
// Observação: nunca sobrescrevemos carimbo já existente no banco — quem
// consome usa `COALESCE(label_printed_at, ...)` / `if (!row.label_printed_at)`.
function deriveLabelPrinted(fresh, marketplace) {
  const mk = String(marketplace || fresh?.marketplace || '').toLowerCase();
  const type = String(fresh?.shipping_type || '').toLowerCase();
  if (mk === 'ml') {
    if (type === 'fulfillment') return { by: 'full' };
    const sub = String(fresh?.shipping_substatus || '').toLowerCase();
    const st = String(fresh?.shipping_status || '').toLowerCase();
    if (['printed', 'picked_up', 'shipped', 'delivered'].includes(sub)
        || ['shipped', 'delivered', 'in_transit'].includes(st)) {
      return { by: 'ml', at: new Date().toISOString() };
    }
  } else if (mk === 'shopee') {
    const ls = String(fresh?.shipping_status || '').toUpperCase();
    if (['LOGISTICS_PICKUP_CREATED', 'LOGISTICS_PICKUP_DONE', 'LOGISTICS_DELIVERY_DONE'].includes(ls)) {
      return { by: 'shopee', at: new Date().toISOString() };
    }
  }
  return null;
}

// Compara dois snapshots e devolve array com nomes das chaves que mudaram.
function diffKeys(prev, next) {
  const changed = [];
  const keys = new Set([...Object.keys(prev || {}), ...Object.keys(next || {})]);
  for (const k of keys) {
    const a = prev ? prev[k] : undefined;
    const b = next ? next[k] : undefined;
    if (canonicalStringify(a) !== canonicalStringify(b)) changed.push(k);
  }
  return changed;
}

// Grava (se o hash mudou) um snapshot na tabela history. Devolve true se
// gravou, false se pulou. prevHash vem direto de marketplace_orders.snapshot_hash.
// prevSnapshotObj é opcional (se null, busca o último do history para diffar).
function insertOrderHistory(orderRow, items, source, prevHash, prevSnapshotObj) {
  return new Promise((resolve) => {
    try {
      const snap = buildOrderSnapshot(orderRow, items);
      const newHash = hashSnapshot(snap);
      if (prevHash && prevHash === newHash) return resolve({ inserted: false, hash: newHash });
      const doInsert = (prevObj) => {
        const changed = prevObj ? diffKeys(prevObj, snap) : Object.keys(snap);
        db.run(
          `INSERT INTO marketplace_orders_history
             (order_id, marketplace, marketplace_order_id, account_id, source, changed_fields_json, snapshot_json, snapshot_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [orderRow.id, orderRow.marketplace, orderRow.marketplace_order_id, orderRow.account_id,
            source || 'live_sync', JSON.stringify(changed), JSON.stringify(snap), newHash],
          function (err) {
            if (err) { console.error('[Backup] history insert error:', err.message); return resolve({ inserted: false, hash: newHash, error: err.message }); }
            resolve({ inserted: true, hash: newHash, changed });
          }
        );
      };
      if (prevSnapshotObj) return doInsert(prevSnapshotObj);
      db.get(
        `SELECT snapshot_json FROM marketplace_orders_history WHERE order_id = ? ORDER BY snapshot_at DESC LIMIT 1`,
        [orderRow.id], (e, r) => {
          let prevObj = null;
          if (!e && r && r.snapshot_json) { try { prevObj = JSON.parse(r.snapshot_json); } catch (_) {} }
          doInsert(prevObj);
        }
      );
    } catch (err) {
      console.error('[Backup] insertOrderHistory exception:', err.message);
      resolve({ inserted: false, error: err.message });
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// ANÁLISE DE CUSTOS DE PEDIDO
// Helpers que buscam as quebras de custo específicas de cada marketplace
// (ML e Shopee) e calculam a decomposição salva em marketplace_order_costs.
// ═══════════════════════════════════════════════════════════════════════════

// Utilitário: transforma valor em Number seguro (0 se NaN/null/undefined).
function toNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// Busca custos de envio do ponto de vista do vendedor. Endpoint relativamente
// novo no ML; retorna null se 404/403/sem permissão (nem todo pedido tem uma
// etiqueta ativa). Campos de interesse: senders_cost (frete efetivo pago
// pelo vendedor), receiver_cost (frete cobrado do comprador), gross_amount,
// discounts, compensation (subsídio de frete grátis do ML).
async function mlFetchShipmentCosts(shipmentId, accountId) {
  if (!shipmentId) return null;
  try {
    const raw = await mlApiGet(`/shipments/${shipmentId}/costs`, accountId);
    if (!raw || typeof raw !== 'object') return null;
    // Estrutura real do endpoint (abr/2026):
    //   {
    //     gross_amount: 132.8,
    //     receiver: { cost, save, compensation, discounts: [{ promoted_amount }], ... },
    //     senders:  [ { cost, save, compensation, discounts: [{ promoted_amount }], ... } ]
    //   }
    // `cost` em cada bloco já está líquido dos descontos. `save` é o subsídio
    // que o ML absorveu (frete grátis promocional) e é o que registramos como
    // shipping_subsidy. Mantemos fallbacks para variantes documentadas no
    // global-selling que trazem os valores flats.
    const sendersArr = Array.isArray(raw.senders) ? raw.senders : (raw.sender ? [raw.sender] : []);
    const sendersCost = sendersArr.reduce((acc, s) => acc + toNum(s?.cost), 0);
    const sendersSave = sendersArr.reduce((acc, s) => acc + toNum(s?.save), 0);
    const sendersCompensation = sendersArr.reduce((acc, s) => acc + toNum(s?.compensation), 0);
    const receiver = raw.receiver || null;
    const receiverCost = toNum(receiver?.cost);
    const receiverSave = toNum(receiver?.save);
    // Fallbacks (formato alternativo documentado)
    const fallbackSenders = toNum(raw.senders_cost ?? raw.sender_cost);
    const fallbackReceiver = toNum(raw.receiver_cost);
    return {
      gross_amount: toNum(raw.gross_amount),
      senders_cost: sendersCost || fallbackSenders,
      receiver_cost: receiverCost || fallbackReceiver,
      discounts: sendersSave + receiverSave,
      compensation: sendersCompensation + toNum(receiver?.compensation),
      raw,
    };
  } catch (e) {
    const st = e.response?.status;
    if (st === 403 || st === 404 || st === 410) return null;
    console.warn(`[OrderCosts] mlFetchShipmentCosts(${shipmentId}) falhou:`, e.message);
    return null;
  }
}

// Busca reclamações/devoluções de um pedido no ML. Retorna um array (vazio se
// sem claims). Útil para detectar reverse_shipping_fee e divergências de
// status. Cobre a maioria dos casos via `/post-purchase/v1/claims/search`.
async function mlFetchClaimsForOrder(orderId, accountId) {
  if (!orderId) return [];
  try {
    const raw = await mlApiGet(`/post-purchase/v1/claims/search?resource=order&resource_id=${encodeURIComponent(orderId)}`, accountId);
    const arr = Array.isArray(raw?.data) ? raw.data : (Array.isArray(raw?.results) ? raw.results : []);
    return arr.map(c => ({
      id: c.id || c.claim_id || null,
      type: c.type || null,
      status: c.status || null,
      stage: c.stage || null,
      reason_id: c.reason_id || null,
      date_created: c.date_created || null,
      resolution: c.resolution || null,
    }));
  } catch (e) {
    const st = e.response?.status;
    if (st === 403 || st === 404) return [];
    console.warn(`[OrderCosts] mlFetchClaimsForOrder(${orderId}) falhou:`, e.message);
    return [];
  }
}

// Busca a quebra financeira oficial da Shopee via get_escrow_detail. Retorna
// o objeto `order_income` normalizado. É a fonte da verdade — valores finais
// só são confiáveis após o release; antes disso vem `estimated_*`.
async function shopeeFetchEscrowDetail(orderSn, accountId) {
  if (!orderSn) return null;
  try {
    const resp = await shopeeApiGet('/api/v2/payment/get_escrow_detail', { order_sn: orderSn }, accountId);
    // Shopee devolve { error, response: { order_sn, order_income, buyer_user_name, return_order_sn_list, ... } }
    const data = resp?.response;
    if (!data) return null;
    const income = data.order_income || {};
    // A API Shopee BR expõe a taxa de transação (inclui PIX) em `transaction_fee`,
    // enquanto a fórmula oficial de escrow usa `seller_transaction_fee`. Lemos
    // ambos como alias para cobrir shops locais e cross-border.
    const buyerPaymentMethod = data.buyer_payment_info?.payment_method || null;
    return {
      commission_fee: toNum(income.commission_fee),
      service_fee: toNum(income.service_fee),
      seller_transaction_fee: toNum(income.seller_transaction_fee ?? income.transaction_fee),
      credit_card_transaction_fee: toNum(income.credit_card_transaction_fee),
      credit_card_promotion: toNum(income.credit_card_promotion),
      campaign_fee: toNum(income.campaign_fee),
      actual_shipping_fee: toNum(income.actual_shipping_fee),
      estimated_shipping_fee: toNum(income.estimated_shipping_fee),
      shopee_shipping_rebate: toNum(income.shopee_shipping_rebate),
      voucher_from_shopee: toNum(income.voucher_from_shopee),
      voucher_from_seller: toNum(income.voucher_from_seller),
      coins: toNum(income.coins),
      reverse_shipping_fee: toNum(income.reverse_shipping_fee),
      final_shipping_fee: toNum(income.final_shipping_fee),
      escrow_amount: toNum(income.escrow_amount_seller ?? income.escrow_amount),
      order_selling_price: toNum(income.order_selling_price),
      total_adjustment_amount: toNum(income.total_adjustment_amount),
      buyer_payment_method: buyerPaymentMethod,
      // order_income.items[] traz preço original vs. descontado por SKU,
      // usado para calcular o desconto promocional do anúncio (same-day/flash
      // sale, seller voucher por item etc.). Campos comuns:
      //   original_price, discounted_price, model_quantity_purchased.
      items: Array.isArray(income.items) ? income.items.map(it => ({
        item_id: it.item_id,
        item_sku: it.item_sku,
        model_id: it.model_id,
        model_name: it.model_name,
        model_sku: it.model_sku,
        original_price: toNum(it.original_price),
        discounted_price: toNum(it.discounted_price),
        quantity_purchased: toNum(it.model_quantity_purchased ?? it.quantity_purchased ?? it.quantity),
      })) : [],
      return_order_sn_list: Array.isArray(data.return_order_sn_list) ? data.return_order_sn_list : [],
      raw: data,
    };
  } catch (e) {
    const st = e.response?.status;
    const data = e.response?.data;
    const code = data?.error || '';
    const msg = data?.message || e.message;
    // 403/404 na HTTP real: pedido fora do escopo (loja diferente/token errado)
    // ou sn inexistente — sem retorno útil, evita poluir o log.
    if (st === 403 || st === 404) return null;
    // 'error_order_not_found', 'error_not_found' → pedido sem escrow ainda
    // (p.ex. cancelado antes do pagamento, muito novo, em dispute). Silencia
    // porque é esperado e não adianta logar toda vez.
    if (/not.?found|not_exist/i.test(code)) return null;
    console.warn(`[OrderCosts] shopeeFetchEscrowDetail(${orderSn}) falhou — status=${st || 'n/a'} code=${code || 'n/a'}: ${msg}`);
    return null;
  }
}

// Busca flexível no inventário para casar SKUs vindos dos marketplaces.
// Sellers costumam registrar SKU com sufixos/letras no anúncio (ex.: "80071B",
// "12345A") enquanto o estoque interno guarda só o número base ("80071").
// Estratégia: (1) match exato case-insensitive; (2) strip de letras e match
// exato; (3) prefixo numérico (só quando único). Espelha o padrão usado em
// client/src/components/Sales.js (findInventoryBySku + skuClean).
async function findInventoryBySkuFlex(rawSku) {
  const sku = String(rawSku || '').trim();
  if (!sku) return null;
  // 1) match exato case-insensitive
  let inv = await new Promise((rs) => db.get(
    'SELECT id, sku, cost_price FROM inventory WHERE TRIM(LOWER(sku)) = TRIM(LOWER(?)) LIMIT 1', [sku],
    (e, r) => rs(r || null)
  ));
  if (inv) return inv;
  // 2) strip letras e match exato (o caso mais comum: "80071B" -> "80071")
  const cleaned = sku.replace(/[a-zA-Z]+/g, '').trim();
  if (cleaned && cleaned !== sku) {
    inv = await new Promise((rs) => db.get(
      'SELECT id, sku, cost_price FROM inventory WHERE TRIM(LOWER(sku)) = TRIM(LOWER(?)) LIMIT 1', [cleaned],
      (e, r) => rs(r || null)
    ));
    if (inv) return inv;
  }
  // 3) prefixo numérico único (cobre casos onde o inventário tem sufixo, ex.:
  // SKU no anúncio "80071" e inventário "80071A"). Só aceitamos se existir
  // UM único candidato para evitar falsos positivos.
  const numeric = sku.replace(/[^0-9]/g, '').trim();
  if (numeric && numeric.length >= 3) {
    const rows = await new Promise((rs) => db.all(
      `SELECT id, sku, cost_price FROM inventory
         WHERE TRIM(LOWER(sku)) = TRIM(LOWER(?))
            OR TRIM(LOWER(sku)) LIKE TRIM(LOWER(?)) || '%'
         LIMIT 3`,
      [numeric, numeric],
      (e, r) => rs(r || [])
    ));
    if (rows.length === 1) return rows[0];
  }
  return null;
}

// Calcula o custo das mercadorias (COGS) de um conjunto de itens de pedido.
// Soma inventory.cost_price * quantity para cada SKU vinculado ao inventário.
// Para SKUs compostos, usa cost_price do composto (que já reflete a receita).
// Retorna { cogs, unknown_items, items_with_cost, items_total }.
async function computeCogs(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { cogs: 0, unknown: 0, total: 0, lines: [] };
  }
  const lines = [];
  let cogs = 0;
  let unknown = 0;
  for (const it of items) {
    const sku = (it.sku || '').trim();
    const qty = toNum(it.quantity) || 1;
    if (!sku) { unknown++; lines.push({ sku: null, quantity: qty, cost_price: null, line_cost: null }); continue; }
    const inv = await findInventoryBySkuFlex(sku);
    if (!inv || inv.cost_price == null) {
      unknown++;
      lines.push({ sku, quantity: qty, cost_price: null, line_cost: null });
      continue;
    }
    const lineCost = toNum(inv.cost_price) * qty;
    cogs += lineCost;
    // Preserva o SKU original do marketplace na linha para auditoria, mas
    // também expõe `matched_sku` (o SKU canônico do inventário) quando
    // diferente — útil para depurar casos "80071B -> 80071".
    const line = { sku, quantity: qty, cost_price: toNum(inv.cost_price), line_cost: lineCost, inventory_id: inv.id };
    if (String(inv.sku || '').trim() && inv.sku !== sku) line.matched_sku = inv.sku;
    lines.push(line);
  }
  return { cogs, unknown, total: items.length, lines };
}

// Calcula o imposto estimado do vendedor (Simples, PIS/COFINS etc.) para um
// conjunto de itens a partir de uma alíquota única configurada por CONTA de
// marketplace (ml_accounts.tax_pct / shopee_accounts.tax_pct).
//
// IMPORTANTE: o imposto incide sobre o valor efetivamente faturado (o que o
// cliente paga), que é `(receita bruta − desconto promocional)`. Quando o
// caller passa `taxBase` explicitamente, usamos esse valor; caso contrário,
// caímos na soma de `unit_price × quantity` dos itens (que já vem com o
// preço pós-desconto em marketplace_order_items). A versão com `taxBase` é
// mais robusta porque funciona mesmo quando `unit_price` do item foi
// gravado como preço cheio (caso que acontece em alguns retornos de
// Shopee onde `model_discounted_price` vem nulo).
//   line_tax = line_revenue × (tax_pct / 100)
//   taxes_seller = Σ line_tax (ou taxBase × tax_pct/100 se passado)
// Se `taxPct` não estiver configurado para a conta, retornamos 0 sem tratar
// como erro: basta o admin preencher o campo em "APIs Externas" e rodar o
// recálculo do período.
async function computeSellerTaxes(items, taxPct, taxBase = null) {
  const pct = toNum(taxPct);
  const configured = pct > 0;
  if (!Array.isArray(items) || items.length === 0) {
    return { taxes_seller: 0, tax_pct: pct || null, configured, total: 0, lines: [] };
  }
  // Soma bruta do que está gravado nos itens (discounted por item). Usada
  // como fallback quando `taxBase` não foi passado.
  const linesPreliminary = items.map(it => {
    const qty = toNum(it.quantity) || 1;
    const unit = toNum(it.unit_price);
    return { sku: (it.sku || '').trim() || null, qty, unit, line_revenue: unit * qty };
  });
  const sumItemsRevenue = linesPreliminary.reduce((a, l) => a + l.line_revenue, 0);
  // Base de cálculo: o valor faturado. Prioriza taxBase (vindo de
  // `gross_revenue − discounts_seller` no chamador) e cai pra soma dos
  // itens quando não informado.
  const resolvedBase = taxBase != null && Number.isFinite(Number(taxBase))
    ? Math.max(0, Number(taxBase))
    : sumItemsRevenue;
  const totalTax = configured ? resolvedBase * (pct / 100) : 0;
  // Rateio do imposto total por linha proporcional à receita do item.
  // Mantém `Σ line_tax === totalTax` mesmo quando `resolvedBase` foi
  // ajustado pra bater com a base oficial (gross − promo).
  const lines = linesPreliminary.map(l => {
    const share = sumItemsRevenue > 0 ? (l.line_revenue / sumItemsRevenue) : (1 / linesPreliminary.length);
    const line_tax = configured ? totalTax * share : 0;
    return {
      sku: l.sku,
      quantity: l.qty,
      tax_pct: configured ? pct : null,
      line_revenue: l.line_revenue,
      line_tax,
    };
  });
  return {
    taxes_seller: totalTax,
    tax_pct: configured ? pct : null,
    configured,
    total: items.length,
    lines,
    tax_base: resolvedBase,
  };
}

// Reconstrói a quebra de custos de um pedido usando os dados já disponíveis
// via API pública (ML: /orders/{id} + /shipments/{id}/costs + claims;
// Shopee: get_escrow_detail). Faz upsert em marketplace_order_costs com
// source='reconstructed'. Retorna a linha gravada ou null em caso de erro.
async function computeOrderCostsReconstructed(orderRow, items, opts = {}) {
  if (!orderRow) return null;
  const warnings = [];
  let out = {
    order_id: orderRow.id,
    source: 'reconstructed',
    gross_revenue: 0,
    discounts_seller: 0,
    discounts_marketplace: 0,
    marketplace_commission: 0,
    marketplace_service_fee: 0,
    payment_fee: 0,
    shipping_paid_by_buyer: toNum(orderRow.shipping_cost),
    shipping_cost_seller: 0,
    shipping_subsidy: 0,
    reverse_shipping_fee: 0,
    taxes_withheld: 0,
    taxes_seller: 0,
    other_adjustments: 0,
    net_received: null,
    cogs_estimated: null,
    gross_margin: null,
    currency: 'BRL',
    escrow_status: null,
    cogs_status: 'unknown',
    warnings: null,
    raw_json: null,
  };

  // Receita bruta: soma quantity * unit_price dos itens. Se vazio, cai pro
  // total_amount do pedido (menos preciso mas sempre disponível).
  const linesForCogs = (items || []).map(it => ({ sku: it.sku, quantity: it.quantity, unit_price: it.unit_price }));
  if (linesForCogs.length > 0) {
    out.gross_revenue = linesForCogs.reduce((acc, it) => acc + toNum(it.unit_price) * toNum(it.quantity || 1), 0);
  } else {
    out.gross_revenue = toNum(orderRow.total_amount);
    warnings.push('sem_itens_usando_total_amount');
  }

  const rawForAudit = {};
  let cancelledReverted = false;

  if (orderRow.marketplace === 'ml') {
    // 1) /orders/{id} — comissão, cupons, impostos, fees de pagamento
    let mlOrder = opts.mlOrder || null;
    if (!mlOrder) {
      try { mlOrder = await mlApiGet(`/orders/${orderRow.marketplace_order_id}`, orderRow.account_id); }
      catch (e) {
        const st = e.response?.status;
        if (st === 404 || st === 410) warnings.push('order_gone');
        else warnings.push(`order_fetch_error:${(e.message || '').slice(0, 60)}`);
      }
    }
    if (mlOrder) {
      rawForAudit.order = {
        status: mlOrder.status,
        order_items: (mlOrder.order_items || []).map(oi => ({
          sale_fee: oi.sale_fee, listing_type_id: oi.listing_type_id,
          unit_price: oi.unit_price, full_unit_price: oi.full_unit_price,
          base_price: oi.base_price, quantity: oi.quantity,
          item_id: oi.item?.id,
        })),
        payments: (mlOrder.payments || []).map(p => ({
          status: p.status, marketplace_fee: p.marketplace_fee,
          coupon_amount: p.coupon_amount, shipping_cost: p.shipping_cost,
          total_paid_amount: p.total_paid_amount, transaction_amount: p.transaction_amount,
          payment_type: p.payment_type, installments: p.installments,
          fee_details: p.fee_details,
        })),
        coupon: mlOrder.coupon, taxes: mlOrder.taxes, tags: mlOrder.tags,
      };
      let commission = (mlOrder.order_items || []).reduce((acc, oi) => acc + toNum(oi.sale_fee) * (toNum(oi.quantity) || 1), 0);
      // Fallback: pedidos FULL recém-pagos costumam voltar com
      // `order_items[].sale_fee = null` e `payments[].marketplace_fee = 0`
      // (o ML só materializa o valor após liquidação). Nesse caso consultamos
      // /sites/MLB/listing_prices?price=X&listing_type_id=Z para reconstruir
      // a tarifa de venda. Esse endpoint retorna `sale_fee_amount` com a
      // tarifa vigente — mesmo valor que aparece na UI do ML. Se der erro
      // (rede, 404, categoria não reconhecida), seguimos com 0 e emitimos
      // um warning para o usuário investigar.
      const allSaleFeesNull = (mlOrder.order_items || []).every(oi => oi.sale_fee == null);
      if (commission === 0 && allSaleFeesNull && (mlOrder.order_items || []).length > 0) {
        const siteId = (mlOrder.site_id || (String(mlOrder.marketplace_order_id || '').startsWith('MLB') ? 'MLB' : 'MLB')) || 'MLB';
        let estimated = 0;
        let anyEstimated = false;
        for (const oi of (mlOrder.order_items || [])) {
          const qty = toNum(oi.quantity) || 1;
          const unit = toNum(oi.unit_price);
          const listingType = oi.listing_type_id;
          if (!unit || !listingType) continue;
          try {
            const params = new URLSearchParams({
              price: String(unit),
              listing_type_id: String(listingType),
            });
            if (oi.item?.category_id) params.set('category_id', oi.item.category_id);
            const lp = await mlApiGet(`/sites/${siteId}/listing_prices?${params.toString()}`, orderRow.account_id);
            // Resposta pode vir como array (um por listing_type) ou objeto único
            const match = Array.isArray(lp)
              ? (lp.find(x => x.listing_type_id === listingType) || lp[0])
              : lp;
            const feeAmount = toNum(match?.sale_fee_amount ?? match?.sale_fee_details?.fixed_fee)
              + (match?.sale_fee_details?.percentage_fee ? (unit * toNum(match.sale_fee_details.percentage_fee) / 100) : 0);
            if (feeAmount > 0) {
              estimated += feeAmount * qty;
              anyEstimated = true;
              if (!rawForAudit.listing_prices_lookup) rawForAudit.listing_prices_lookup = [];
              rawForAudit.listing_prices_lookup.push({ item_id: oi.item?.id, listing_type_id: listingType, price: unit, fee_amount: feeAmount });
            }
          } catch (e) {
            console.warn(`[OrderCosts] listing_prices fallback falhou (item ${oi.item?.id}):`, e.message);
          }
        }
        if (anyEstimated) {
          commission = estimated;
          warnings.push('commission_from_listing_prices');
        }
      }
      out.marketplace_commission = commission;
      out.currency = mlOrder.currency_id || out.currency;
      // Desconto promocional do anúncio: o ML expõe `full_unit_price` (preço
      // cheio do anúncio antes da promoção) e `unit_price` (o que o comprador
      // pagou). A diferença × qty é o desconto de venda absorvido pelo
      // vendedor. Redefinimos `gross_revenue` para o preço cheio e jogamos o
      // desconto em `discounts_seller` para que o waterfall fique consistente:
      //   full × qty  −  promo_discount  =  unit × qty
      // Nem todo pedido traz `full_unit_price`/`base_price`; quando o payload
      // é omisso, caímos em cascata para:
      //   a) cache local `ml_items.original_price` (preço "de" sincronizado);
      //   b) cache local `ml_items.price` (se for maior que o pago, indica
      //      que o anúncio tinha um preço base maior, ex. DEAL ML);
      //   c) `unit_price` (sem desconto detectado).
      let promoDiscountML = 0;
      let grossFullML = 0;
      const itemPriceCache = new Map();
      for (const oi of (mlOrder.order_items || [])) {
        const qty = toNum(oi.quantity) || 1;
        const unit = toNum(oi.unit_price);
        let full = toNum(oi.full_unit_price) || toNum(oi.base_price);
        if (!full) {
          const itemId = oi.item?.id;
          if (itemId) {
            if (!itemPriceCache.has(itemId)) {
              const cached = await new Promise((rs) => db.get(
                'SELECT price, original_price FROM ml_items WHERE ml_item_id = ? AND ml_account_id = ? LIMIT 1',
                [itemId, orderRow.account_id],
                (e, r) => rs(r || null)
              ));
              itemPriceCache.set(itemId, cached);
            }
            const c = itemPriceCache.get(itemId);
            const orig = toNum(c?.original_price);
            const base = toNum(c?.price);
            if (orig > unit) full = orig;
            else if (base > unit) full = base;
          }
        }
        if (!full) full = unit;
        grossFullML += full * qty;
        if (full > unit) promoDiscountML += (full - unit) * qty;
      }
      if (grossFullML > 0) out.gross_revenue = grossFullML;
      if (promoDiscountML > 0) out.discounts_seller = toNum(out.discounts_seller) + promoDiscountML;
      rawForAudit.promo_discount_ml = promoDiscountML;
      // Pagamentos — somamos fees, cupons e ajustes relevantes
      let couponML = toNum(mlOrder.coupon?.amount);
      let paymentFee = 0;
      let feesBilled = 0;
      let refunded = 0;
      let shippingFromPayment = 0;
      for (const p of (mlOrder.payments || [])) {
        shippingFromPayment += toNum(p.shipping_cost);
        couponML += toNum(p.coupon_amount);
        // fee_details: [{ type: 'mercadopago_fee'|'financing_fee'|..., amount }]
        for (const f of (p.fee_details || [])) {
          if (/financ|installment/i.test(f.type || '')) paymentFee += toNum(f.amount);
          else if (/mercadopago|gateway|card/i.test(f.type || '')) paymentFee += toNum(f.amount);
          else feesBilled += toNum(f.amount);
        }
        if (toNum(p.marketplace_fee) && paymentFee === 0) paymentFee += toNum(p.marketplace_fee);
        if ((p.status || '').toLowerCase() === 'refunded') refunded += toNum(p.transaction_amount);
      }
      out.discounts_marketplace = couponML;
      out.payment_fee = paymentFee;
      out.marketplace_service_fee = feesBilled;
      if (!out.shipping_paid_by_buyer && shippingFromPayment) out.shipping_paid_by_buyer = shippingFromPayment;
      // Impostos (quando presentes)
      out.taxes_withheld = toNum(mlOrder.taxes?.amount) + (Array.isArray(mlOrder.taxes) ? mlOrder.taxes.reduce((a, t) => a + toNum(t.amount), 0) : 0);
      // Nota: NÃO subtraímos `refunded` aqui. Pedido cancelado/estornado é
      // tratado adiante num bloco dedicado que zera comissão, frete e cupom
      // (o ML reverte tudo automaticamente nesses casos).
      if (refunded > 0) warnings.push('pagamento_reembolsado');
    }

    // 2) /shipments/{id}/costs — frete pago pelo vendedor e subsídio ML
    const shipId = orderRow.shipping_id || mlOrder?.shipping?.id;
    if (shipId) {
      const sc = await mlFetchShipmentCosts(shipId, orderRow.account_id);
      if (sc) {
        rawForAudit.shipment_costs = sc.raw;
        out.shipping_cost_seller = sc.senders_cost;
        if (sc.receiver_cost && !out.shipping_paid_by_buyer) out.shipping_paid_by_buyer = sc.receiver_cost;
        out.shipping_subsidy = sc.compensation + sc.discounts;
      } else {
        warnings.push('sem_shipments_costs');
      }
    }

    // 3) Claims — reverse shipping quando existe devolução
    let hasReturnClaim = false;
    try {
      const claims = await mlFetchClaimsForOrder(orderRow.marketplace_order_id, orderRow.account_id);
      if (claims.length > 0) {
        rawForAudit.claims = claims;
        hasReturnClaim = claims.some(c => /return|refund/i.test(`${c.type || ''} ${c.status || ''} ${c.resolution || ''}`));
        if (hasReturnClaim) {
          // Fallback: usa o senders_cost como estimativa do reverso quando a
          // API não expõe um valor explícito. Marcado via warning.
          out.reverse_shipping_fee = toNum(out.shipping_cost_seller);
          warnings.push('reverse_shipping_estimado_pelo_senders_cost');
        }
      }
    } catch (_) { /* best-effort */ }

    // 4) Reversão de pedido cancelado. Quando o pedido é cancelado antes do
    // envio (ou com estorno total dos pagamentos) SEM claim de devolução
    // física, o ML reverte comissão, frete, cupons e impostos — impacto
    // líquido = 0 para o vendedor. Bate com a tela "Detalhe do recebimento"
    // (Tarifa, Envios, Estorno, Cancelamentos → Total R$ 0,00). Mantemos o
    // raw_json com os valores originais para auditoria.
    if (mlOrder) {
      const payments = mlOrder.payments || [];
      const allRefunded = payments.length > 0 && payments.every(p => (p.status || '').toLowerCase() === 'refunded');
      const isCancelled = ['cancelled', 'invalid'].includes((mlOrder.status || '').toLowerCase());
      if ((isCancelled || allRefunded) && !hasReturnClaim) {
        rawForAudit.reversal_applied = {
          reason: isCancelled ? 'status_cancelled' : 'all_payments_refunded',
          before: {
            gross_revenue: out.gross_revenue,
            marketplace_commission: out.marketplace_commission,
            shipping_cost_seller: out.shipping_cost_seller,
            discounts_marketplace: out.discounts_marketplace,
            taxes_withheld: out.taxes_withheld,
          },
        };
        out.gross_revenue = 0;
        out.marketplace_commission = 0;
        out.marketplace_service_fee = 0;
        out.payment_fee = 0;
        out.shipping_cost_seller = 0;
        out.shipping_subsidy = 0;
        out.discounts_seller = 0;
        out.discounts_marketplace = 0;
        out.taxes_withheld = 0;
        out.taxes_seller = 0;
        out.other_adjustments = 0;
        cancelledReverted = true;
        warnings.push('pedido_cancelado_sem_custo');
      }
    }
  } else if (orderRow.marketplace === 'shopee') {
    // Shopee: toda a quebra vem do escrow.
    // Antes de buscar o escrow, detectamos pedidos cancelados. A Shopee cobra
    // CANCELLED / UNPAID / INVOICE_PENDING quando o comprador não paga ou
    // desiste, e nesses casos não há taxa, frete ou COGS (produto não sai).
    // Espelhamos a mesma lógica do ML (`pedido_cancelado_sem_custo`) zerando
    // tudo. Evita o caso de cards/linhas da UI mostrando -R$ xx,yy de
    // imposto/margem sobre um pedido que o vendedor nunca recebeu.
    const shopeeStatus = String(orderRow.status || '').toLowerCase();
    const shopeeIsCancelled = ['cancelled', 'canceled', 'unpaid', 'invoice_pending'].includes(shopeeStatus);
    if (shopeeIsCancelled) {
      rawForAudit.reversal_applied = {
        reason: 'shopee_status_cancelled',
        before: {
          gross_revenue: out.gross_revenue,
          marketplace_commission: out.marketplace_commission,
          shipping_cost_seller: out.shipping_cost_seller,
        },
      };
      out.gross_revenue = 0;
      out.marketplace_commission = 0;
      out.marketplace_service_fee = 0;
      out.payment_fee = 0;
      out.shipping_cost_seller = 0;
      out.shipping_subsidy = 0;
      out.shipping_paid_by_buyer = 0;
      out.discounts_seller = 0;
      out.discounts_marketplace = 0;
      out.reverse_shipping_fee = 0;
      out.taxes_withheld = 0;
      out.other_adjustments = 0;
      out.net_received = 0;
      cancelledReverted = true;
      warnings.push('pedido_cancelado_sem_custo');
    }
    let esc = opts.escrow || null;
    if (!cancelledReverted && !esc) esc = await shopeeFetchEscrowDetail(orderRow.marketplace_order_id, orderRow.account_id);
    // Proteção: se a Shopee estiver indisponível (rate-limit/erro transiente)
    // mas já existe uma linha reconstruída com comissão válida de um recálculo
    // anterior, reusamos esses valores em vez de zerar a comissão na UI.
    if (!esc && !cancelledReverted) {
      const prev = await new Promise((rs) => db.get(
        `SELECT * FROM marketplace_order_costs WHERE order_id = ? AND source = 'reconstructed' LIMIT 1`,
        [orderRow.id], (e, r) => rs(r || null)
      ));
      if (prev && (toNum(prev.marketplace_commission) > 0 || toNum(prev.marketplace_service_fee) > 0)) {
        out.marketplace_commission = toNum(prev.marketplace_commission);
        out.marketplace_service_fee = toNum(prev.marketplace_service_fee);
        out.payment_fee = toNum(prev.payment_fee);
        out.shipping_cost_seller = toNum(prev.shipping_cost_seller);
        out.shipping_subsidy = toNum(prev.shipping_subsidy);
        out.shipping_paid_by_buyer = toNum(prev.shipping_paid_by_buyer);
        out.discounts_marketplace = toNum(prev.discounts_marketplace);
        out.discounts_seller = toNum(prev.discounts_seller);
        out.reverse_shipping_fee = toNum(prev.reverse_shipping_fee);
        out.other_adjustments = toNum(prev.other_adjustments);
        out.net_received = toNum(prev.net_received);
        out.gross_revenue = toNum(prev.gross_revenue);
        out.escrow_status = prev.escrow_status;
        warnings.push('escrow_reusado_cache_local');
      }
    }
    if (esc && !cancelledReverted) {
      rawForAudit.escrow = esc.raw;
      rawForAudit.shopee_payment_method = esc.buyer_payment_method || null;
      out.marketplace_commission = esc.commission_fee;
      out.marketplace_service_fee = esc.service_fee;
      out.payment_fee = esc.seller_transaction_fee + esc.credit_card_transaction_fee;
      // Shopee BR NÃO cobra frete do vendedor. A Shopee assume integralmente
      // (via shopee_shipping_rebate ou direto com a transportadora). Em alguns
      // pedidos aparece `actual_shipping_fee - shopee_shipping_rebate > 0`,
      // mas esse residual é contabilidade interna da Shopee — NÃO é deduzido
      // do escrow do vendedor (conferido no recibo de recebimento da plataforma).
      // Mantemos os dois valores crus em rawForAudit para auditoria, mas o
      // custo exibido pro vendedor é zero.
      out.shipping_cost_seller = 0;
      // Diferente do ML (onde `save` é absorção informativa), na Shopee o
      // rebate já está embutido no líquido. Zeramos `shipping_subsidy` para
      // não confundir a UI (que usa o campo para exibir "ML absorveu...").
      out.shipping_subsidy = 0;
      rawForAudit.shopee_shipping_rebate = toNum(esc.shopee_shipping_rebate);
      rawForAudit.shopee_actual_shipping_fee = toNum(esc.actual_shipping_fee);
      out.shipping_paid_by_buyer = esc.estimated_shipping_fee || out.shipping_paid_by_buyer;
      // `voucher_from_shopee` (cupom bancado pela Shopee) e `coins` (Shopee
      // Coins resgatadas pelo comprador) NÃO saem do bolso do vendedor —
      // reduzem o que o comprador paga mas a Shopee compensa. A prova está
      // no próprio escrow: escrow_amount = order_selling_price − commission
      // − service_fee, sem qualquer dedução por voucher/coins. Exibir essa
      // linha no waterfall dá a falsa impressão que foi descontado do vendedor.
      // Mantemos os valores crus em rawForAudit pra conferência.
      rawForAudit.shopee_coins_buyer = toNum(esc.coins);
      rawForAudit.shopee_voucher_from_shopee = toNum(esc.voucher_from_shopee);
      out.discounts_marketplace = 0;
      out.discounts_seller = esc.voucher_from_seller;
      out.reverse_shipping_fee = esc.reverse_shipping_fee;
      out.other_adjustments = esc.total_adjustment_amount;
      out.net_received = esc.escrow_amount; // Shopee já entrega o líquido
      out.escrow_status = (esc.return_order_sn_list?.length > 0) ? 'with_returns' : 'ok';
      // Receita bruta = order_selling_price (valor autoritativo calculado
      // pela Shopee). Não reconstruímos a partir de `esc.items[]` porque essa
      // lista tem duas armadilhas: (a) pode duplicar linhas quando o pedido é
      // separado em múltiplos pacotes, (b) o campo `original_price` às vezes
      // vem como preço UNITÁRIO e às vezes como TOTAL DA LINHA (sem documentação
      // consistente). Qualquer heurística que multiplica por qty erra em
      // metade dos casos. Confiar no order_selling_price evita toda essa
      // ambiguidade.
      const orderSellingPrice = toNum(esc.order_selling_price);
      if (orderSellingPrice > 0) {
        out.gross_revenue = orderSellingPrice;
      }
      // Desconto promocional (flash sale, seller voucher por item): só contamos
      // se a soma local (sum(unit_price × qty)) for MENOR que order_selling_price.
      // Nesse caso a diferença é o desconto implícito aplicado pela Shopee
      // (anúncio original > preço final). Se for maior ou igual, não há promo.
      if (orderSellingPrice > 0 && Array.isArray(items) && items.length > 0) {
        const localRevenue = items.reduce(
          (acc, li) => acc + toNum(li.unit_price) * (toNum(li.quantity) || 1), 0
        );
        // Nunca usado aqui — unit_price local (= model_discounted_price) já é
        // o valor efetivamente pago pelo cliente por unidade. order_selling_price
        // reflete o total, então a receita bruta para imposto/comissão é mesma.
        // Mantemos voucher_from_seller como única fonte de discounts_seller
        // nesta integração; promo implícito fica dentro do preço unitário.
        rawForAudit.shopee_local_revenue_check = localRevenue;
      }
    } else if (!cancelledReverted) {
      warnings.push('sem_escrow_detail');
    }
  }

  // COGS (custo de mercadoria) — usa inventory.cost_price por SKU vinculado.
  // Para pedidos cancelados sem envio, o produto não saiu do estoque; COGS = 0.
  if (cancelledReverted) {
    out.cogs_estimated = 0;
    out.cogs_status = 'cancelled';
  } else {
    try {
      const cogs = await computeCogs(items || []);
      out.cogs_estimated = cogs.cogs || 0;
      if (cogs.unknown === 0 && cogs.total > 0) out.cogs_status = 'ok';
      else if (cogs.unknown > 0 && cogs.unknown < cogs.total) out.cogs_status = 'partial';
      else if (cogs.total === 0) out.cogs_status = 'no_items';
      else out.cogs_status = 'unknown';
      rawForAudit.cogs_lines = cogs.lines;
    } catch (e) {
      warnings.push(`cogs_error:${(e.message || '').slice(0, 60)}`);
    }
  }

  // Imposto estimado do vendedor (Simples/PIS/COFINS/...): aplica a alíquota
  // configurada na CONTA de marketplace (ml_accounts.tax_pct ou
  // shopee_accounts.tax_pct). Em cancelamento revertido, o imposto também
  // some porque não há receita.
  if (!cancelledReverted) {
    try {
      const accountTable = orderRow.marketplace === 'shopee' ? 'shopee_accounts' : 'ml_accounts';
      const accRow = await new Promise((rs) => db.get(
        `SELECT tax_pct FROM ${accountTable} WHERE id = ? LIMIT 1`, [orderRow.account_id],
        (e, r) => rs(r || null)
      ));
      const accountTaxPct = accRow ? toNum(accRow.tax_pct) : 0;
      // Base de cálculo = receita bruta − desconto promocional. Esse é o
      // valor que aparece na nota fiscal (o que o cliente paga). Se tanto
      // gross_revenue quanto discounts_seller forem zero, caímos na soma
      // dos itens (default do computeSellerTaxes).
      const grossForTax = toNum(out.gross_revenue);
      const promoDiscount = toNum(out.discounts_seller);
      const taxBase = grossForTax > 0 ? Math.max(0, grossForTax - promoDiscount) : null;
      const tx = await computeSellerTaxes(items || [], accountTaxPct, taxBase);
      out.taxes_seller = tx.taxes_seller || 0;
      rawForAudit.tax_lines = tx.lines;
      rawForAudit.tax_account_pct = tx.tax_pct;
      rawForAudit.tax_base = tx.tax_base;
      if (!tx.configured) warnings.push('imposto_conta_nao_configurado');
    } catch (e) {
      warnings.push(`tax_error:${(e.message || '').slice(0, 60)}`);
    }
  }

  // Líquido recebido (quando o marketplace não já devolveu):
  //   receita bruta − comissão − fees − frete vendedor − devolução − impostos
  //   + ajustes.
  // IMPORTANTE: `shipping_subsidy` representa o `save` do endpoint
  // /shipments/{id}/costs — ou seja, quanto o ML absorveu do preço cheio do
  // frete. Esse valor é puramente informativo: o vendedor paga `cost` direto
  // (já líquido do desconto), o `save` NÃO volta pro seu bolso. Por isso não
  // entra no cálculo de líquido. Bate com a tela "Detalhe do recebimento"
  // do ML onde "Envios" = senders[0].cost.
  if (out.net_received == null) {
    out.net_received = (
      toNum(out.gross_revenue)
      - toNum(out.marketplace_commission)
      - toNum(out.marketplace_service_fee)
      - toNum(out.payment_fee)
      - toNum(out.shipping_cost_seller)
      - toNum(out.reverse_shipping_fee)
      - toNum(out.taxes_withheld)
      - toNum(out.taxes_seller)
      + toNum(out.other_adjustments)
    );
  } else {
    // Shopee já devolve o líquido pelo escrow; ainda assim subtraímos o
    // imposto estimado do vendedor, que é um custo externo ao marketplace.
    out.net_received = toNum(out.net_received) - toNum(out.taxes_seller);
  }
  // Margem líquida = líquido − COGS. Se cogs desconhecido, usa 0 mas marca.
  out.gross_margin = toNum(out.net_received) - toNum(out.cogs_estimated || 0);

  out.warnings = warnings.length ? JSON.stringify(warnings) : null;
  out.raw_json = Object.keys(rawForAudit).length ? JSON.stringify(rawForAudit) : null;

  // Upsert
  const columns = [
    'order_id','source','gross_revenue','discounts_seller','discounts_marketplace',
    'marketplace_commission','marketplace_service_fee','payment_fee',
    'shipping_paid_by_buyer','shipping_cost_seller','shipping_subsidy',
    'reverse_shipping_fee','taxes_withheld','taxes_seller','other_adjustments',
    'net_received','cogs_estimated','gross_margin','currency',
    'escrow_status','cogs_status','warnings','raw_json'
  ];
  const placeholders = columns.map(() => '?').join(', ');
  const updates = columns.filter(c => c !== 'order_id' && c !== 'source').map(c => `${c}=excluded.${c}`).join(', ');
  const values = columns.map(c => out[c]);
  await new Promise((rs, rj) => db.run(
    `INSERT INTO marketplace_order_costs (${columns.join(', ')}) VALUES (${placeholders})
     ON CONFLICT(order_id, source) DO UPDATE SET ${updates}, computed_at = CURRENT_TIMESTAMP`,
    values,
    (e) => e ? rj(e) : rs()
  ));
  return out;
}

// Wrapper seguro: nunca propaga erro pro chamador. Usado nos hooks do sync.
async function computeOrderCostsSafe(orderRow, items, opts) {
  try { return await computeOrderCostsReconstructed(orderRow, items, opts); }
  catch (e) { console.warn('[OrderCosts] computeOrderCostsSafe:', e.message); return null; }
}

// Baixa pedido completo da API do ML (detalhe + envio) e normaliza para o
// shape gravado em marketplace_orders + marketplace_order_items. Lança erro
// com `.notFound=true` quando a API devolve 404/410.
async function fetchMlOrderFull(row) {
  const orderId = row.marketplace_order_id;
  const accountId = row.account_id;
  let order;
  try {
    order = await mlApiGet(`/orders/${orderId}`, accountId);
  } catch (e) {
    const status = e.response?.status;
    if (status === 404 || status === 410) { const err = new Error('order_gone'); err.notFound = true; throw err; }
    throw e;
  }
  if (!order) { const err = new Error('order_empty'); err.notFound = true; throw err; }

  const payment = (order.payments && order.payments[0]) || {};
  const buyer = order.buyer || {};
  const shippingRef = order.shipping || order.shipment;
  let shippingAddr = null, shippingTracking = null, shippingStatus = null, shippingSubstatus = null, shippingMethod = null, shippingType = null;
  const shippingId = shippingRef?.id ? String(shippingRef.id) : null;
  if (shippingId) {
    try {
      const ship = await mlApiGet(`/shipments/${shippingId}`, accountId);
      if (ship) {
        const dest = ship.receiver_address || ship.destination?.shipping_address || {};
        shippingAddr = {
          receiver_name: ship.receiver_name || ship.destination?.receiver_name || dest.receiver_name || null,
          street: dest.street_name || dest.address_line || '',
          number: dest.street_number || '',
          complement: dest.comment || '',
          neighborhood: (dest.neighborhood && (dest.neighborhood.name || dest.neighborhood)) || '',
          city: (dest.city && (dest.city.name || dest.city)) || '',
          state: (dest.state && (dest.state.name || dest.state.id || dest.state)) || '',
          zip_code: dest.zip_code || '',
          country: (dest.country && (dest.country.name || dest.country)) || 'Brasil',
        };
        shippingTracking = ship.tracking_number || null;
        shippingStatus = ship.status || null;
        shippingSubstatus = ship.substatus || null;
        shippingMethod = ship.shipping_option?.name || ship.logistic_type || null;
        shippingType = ship.logistic_type || null;
      }
    } catch (_) { /* shipment opcional */ }
  }

  // ML expõe o SKU em vários campos distintos dependendo de quando o anúncio
  // foi criado: `seller_custom_field` (legado), `seller_sku` (novo contrato
  // /orders), ou como atributo `SELLER_SKU` dentro de `attributes`. Tentamos
  // os três no pedido antes de cair para o fallback de cache local
  // (resolveMissingSkusForOrder).
  const extractMlSku = (oi) => {
    const it = oi.item || {};
    if (it.seller_custom_field) return String(it.seller_custom_field).trim();
    if (it.seller_sku) return String(it.seller_sku).trim();
    if (Array.isArray(it.attributes)) {
      const sellerSkuAttr = it.attributes.find(a => a?.id === 'SELLER_SKU');
      const v = sellerSkuAttr?.value_name || sellerSkuAttr?.values?.[0]?.name;
      if (v) return String(v).trim();
    }
    return null;
  };
  const items = (order.order_items || []).map(oi => ({
    marketplace_item_id: oi.item?.id || null,
    variation_id: oi.item?.variation_id ? String(oi.item.variation_id) : null,
    sku: extractMlSku(oi),
    title: oi.item?.title || null,
    quantity: oi.quantity || 1,
    unit_price: oi.unit_price || 0,
    thumbnail: oi.item?.thumbnail || null,
    variation_attributes_json: oi.item?.variation_attributes?.length ? JSON.stringify(oi.item.variation_attributes) : null,
  }));

  return {
    status: order.status || row.status,
    buyer_name: (`${buyer.first_name || ''} ${buyer.last_name || ''}`.trim()) || buyer.nickname || shippingAddr?.receiver_name || '',
    buyer_doc: buyer.billing_info?.doc_number || null,
    buyer_phone: buyer.phone ? `${buyer.phone.area_code || ''}${buyer.phone.number || ''}` : null,
    buyer_email: buyer.email || null,
    buyer_nickname: buyer.nickname || null,
    shipping_address_json: shippingAddr ? JSON.stringify(shippingAddr) : null,
    total_amount: order.total_amount || 0,
    shipping_cost: shippingRef?.cost || payment.shipping_cost || 0,
    order_date: normalizeMarketplaceOrderDate(order.date_created || null),
    payment_method: payment.payment_method_id || null,
    payment_status: payment.status || null,
    payment_id: payment.id ? String(payment.id) : null,
    pack_id: order.pack_id ? String(order.pack_id) : null,
    shipping_id: shippingId,
    shipping_tracking: shippingTracking,
    shipping_status: shippingStatus,
    shipping_substatus: shippingSubstatus,
    shipping_method: shippingMethod,
    shipping_type: shippingType,
    payment_installments: payment.installments || null,
    payment_date: normalizeMarketplaceOrderDate(payment.date_approved || payment.date_created || null),
    payment_total: payment.total_paid_amount || order.total_amount || 0,
    items,
  };
}

// Baixa pedido completo da Shopee (get_order_detail) e normaliza.
async function fetchShopeeOrderFull(row) {
  const orderSn = row.marketplace_order_id;
  const accountId = row.account_id;
  let detail;
  try {
    detail = await shopeeApiGet('/api/v2/order/get_order_detail', {
      order_sn_list: orderSn,
      response_optional_fields: 'buyer_user_id,buyer_username,recipient_address,item_list,total_amount,actual_shipping_fee,create_time,pay_time,invoice_data,package_list,order_status,payment_method,shipping_carrier',
    }, accountId);
  } catch (e) {
    const status = e.response?.status;
    if (status === 404 || status === 410) { const err = new Error('order_gone'); err.notFound = true; throw err; }
    throw e;
  }
  const orders = detail?.response?.order_list || [];
  const o = orders[0];
  if (!o) { const err = new Error('order_empty'); err.notFound = true; throw err; }

  const addr = o.recipient_address || {};
  const pkg = (o.package_list && o.package_list[0]) || {};
  const inv = o.invoice_data || {};
  const shippingAddr = {
    receiver_name: addr.name || '',
    street: addr.full_address || '',
    number: '',
    complement: '',
    neighborhood: addr.district || '',
    city: addr.city || '',
    state: addr.state || '',
    zip_code: addr.zipcode || '',
    country: addr.region || 'Brasil',
    phone: addr.phone || null,
  };
  const items = (o.item_list || []).map(it => ({
    marketplace_item_id: it.item_id ? String(it.item_id) : null,
    variation_id: it.model_id ? String(it.model_id) : null,
    sku: it.model_sku || it.item_sku || null,
    title: it.item_name || '',
    quantity: it.model_quantity_purchased || 1,
    unit_price: parseFloat(it.model_discounted_price || it.model_original_price || 0),
    thumbnail: it.image_info?.image_url || null,
    variation_attributes_json: it.model_name ? JSON.stringify({ model_name: it.model_name }) : null,
  }));
  const orderStatus = o.order_status || 'UNPAID';
  const totalAmount = parseFloat(o.total_amount || 0);
  return {
    status: orderStatus,
    buyer_name: addr.name || o.buyer_username || '',
    buyer_doc: inv.tax_id || inv.number || null,
    buyer_phone: shippingAddr.phone,
    buyer_email: null,
    buyer_nickname: o.buyer_username || null,
    shipping_address_json: JSON.stringify(shippingAddr),
    total_amount: totalAmount,
    shipping_cost: parseFloat(o.actual_shipping_fee || 0),
    order_date: o.create_time ? new Date(o.create_time * 1000).toISOString() : null,
    payment_method: o.payment_method || null,
    payment_status: orderStatus,
    payment_id: null,
    pack_id: null,
    shipping_id: pkg.package_number || null,
    shipping_tracking: pkg.tracking_number || null,
    shipping_status: pkg.shipping_status || pkg.logistics_status || null,
    shipping_substatus: null,
    shipping_method: o.shipping_carrier || null,
    shipping_type: o.shipping_carrier || null,
    payment_installments: null,
    payment_date: o.pay_time ? new Date(o.pay_time * 1000).toISOString() : null,
    payment_total: totalAmount,
    items,
  };
}

// Resolve SKUs faltantes em marketplace_order_items usando três camadas de
// cache locais, em ordem de confiabilidade:
//
//   1) ml_stock_config / ml_variation_stock_config (ou shopee_*):
//      mapeamento MANUAL feito pelo usuário em "Anúncios Ativos". É a fonte
//      canônica — se o anúncio está conectado a um item do estoque pra sync
//      de quantidade, o SKU desse item é o que deve ser usado no COGS.
//   2) ml_item_variations / ml_items (ou shopee_item_models / shopee_items):
//      cache da listagem sincronizada. Tem o `seller_sku` do anúncio, se o
//      vendedor tiver preenchido no portal do marketplace.
//
// Muitos pedidos chegam com `sku=null` porque o vendedor não preencheu o
// campo "SKU" do anúncio no portal do marketplace, mas o Miti costuma ter
// esse mapeamento via stock_config. Recuperar esse SKU é o que permite
// calcular COGS/imposto desses pedidos. Retorna a quantidade de linhas
// resolvidas.
async function resolveMissingSkusForOrder(orderRow) {
  if (!orderRow?.id) return 0;
  const items = await new Promise((rs) => db.all(
    'SELECT id, marketplace_item_id, variation_id, sku, title FROM marketplace_order_items WHERE order_id = ?',
    [orderRow.id],
    (e, r) => rs(r || [])
  ));
  if (items.length === 0) return 0;
  const missing = items.filter(it => {
    const s = (it.sku || '').trim();
    return !s;
  });
  if (missing.length === 0) return 0;

  const isMl = orderRow.marketplace === 'ml' || orderRow.marketplace === 'mercado_livre';
  const isShopee = orderRow.marketplace === 'shopee';
  if (!isMl && !isShopee) return 0;
  const accountId = orderRow.account_id;

  const lookupMl = async (mlItemId, variationId) => {
    // 1) mapping manual (stock_config → inventory.sku)
    if (variationId) {
      const row = await new Promise((rs) => db.get(
        `SELECT inv.sku AS sku FROM ml_variation_stock_config vc
         JOIN inventory inv ON inv.id = vc.inventory_id
         WHERE vc.ml_item_id = ? AND vc.ml_account_id = ? AND vc.variation_id = ?
         LIMIT 1`,
        [mlItemId, accountId, variationId],
        (e, r) => rs(r || null)
      ));
      if (row?.sku) return String(row.sku).trim();
    }
    const cfgRow = await new Promise((rs) => db.get(
      `SELECT inv.sku AS sku FROM ml_stock_config sc
       JOIN inventory inv ON inv.id = sc.inventory_id
       WHERE sc.ml_item_id = ? AND sc.ml_account_id = ?
       LIMIT 1`,
      [mlItemId, accountId],
      (e, r) => rs(r || null)
    ));
    if (cfgRow?.sku) return String(cfgRow.sku).trim();
    // 2) cache da listagem (seller_sku do anúncio)
    if (variationId) {
      const row = await new Promise((rs) => db.get(
        'SELECT sku FROM ml_item_variations WHERE ml_item_id = ? AND ml_account_id = ? AND variation_id = ? LIMIT 1',
        [mlItemId, accountId, variationId],
        (e, r) => rs(r || null)
      ));
      if (row?.sku) return String(row.sku).trim();
    }
    const itemRow = await new Promise((rs) => db.get(
      'SELECT sku FROM ml_items WHERE ml_item_id = ? AND ml_account_id = ? LIMIT 1',
      [mlItemId, accountId],
      (e, r) => rs(r || null)
    ));
    if (itemRow?.sku) return String(itemRow.sku).trim();

    // 3) Fallback online: chama /items/{id}?include_attributes=all direto na
    // API do ML. Cobre o caso onde o cache local nunca foi sincronizado ou
    // está desatualizado (anúncio novo). Extrai SKU de: seller_sku (novo) →
    // seller_custom_field (legado) → attributes[SELLER_SKU]. Para listings
    // com variações, percorre cada variação tentando variationId específico
    // e, se não achar, pega a primeira variação válida.
    try {
      const item = await mlApiGet(`/items/${mlItemId}?include_attributes=all`, accountId);
      if (!item) return null;
      const extractFromAttrs = (attrs) => {
        if (!Array.isArray(attrs)) return null;
        const a = attrs.find(x => x?.id === 'SELLER_SKU');
        const v = a?.value_name || a?.values?.[0]?.name;
        return v ? String(v).trim() : null;
      };
      // variação específica
      if (variationId && Array.isArray(item.variations)) {
        const v = item.variations.find(vv => String(vv.id) === String(variationId));
        if (v) {
          const s = v.seller_sku || v.seller_custom_field || extractFromAttrs(v.attributes);
          if (s) return String(s).trim();
        }
      }
      // item raiz
      const rootSku = item.seller_sku || item.seller_custom_field || extractFromAttrs(item.attributes);
      if (rootSku) return String(rootSku).trim();
      // qualquer variação disponível
      if (Array.isArray(item.variations)) {
        for (const v of item.variations) {
          const s = v.seller_sku || v.seller_custom_field || extractFromAttrs(v.attributes);
          if (s) return String(s).trim();
        }
      }
    } catch (e) {
      console.warn(`[resolveMissingSkusForOrder] /items/${mlItemId} falhou:`, e.message);
    }
    return null;
  };

  const lookupShopee = async (shopeeItemId, modelId) => {
    if (modelId) {
      const row = await new Promise((rs) => db.get(
        `SELECT inv.sku AS sku FROM shopee_variation_stock_config vc
         JOIN inventory inv ON inv.id = vc.inventory_id
         WHERE vc.shopee_item_id = ? AND vc.shopee_account_id = ? AND vc.model_id = ?
         LIMIT 1`,
        [shopeeItemId, accountId, modelId],
        (e, r) => rs(r || null)
      ));
      if (row?.sku) return String(row.sku).trim();
    }
    const cfgRow = await new Promise((rs) => db.get(
      `SELECT inv.sku AS sku FROM shopee_stock_config sc
       JOIN inventory inv ON inv.id = sc.inventory_id
       WHERE sc.shopee_item_id = ? AND sc.shopee_account_id = ?
       LIMIT 1`,
      [shopeeItemId, accountId],
      (e, r) => rs(r || null)
    ));
    if (cfgRow?.sku) return String(cfgRow.sku).trim();
    if (modelId) {
      const row = await new Promise((rs) => db.get(
        'SELECT model_sku FROM shopee_item_models WHERE shopee_item_id = ? AND shopee_account_id = ? AND model_id = ? LIMIT 1',
        [shopeeItemId, accountId, modelId],
        (e, r) => rs(r || null)
      ));
      if (row?.model_sku) return String(row.model_sku).trim();
    }
    const itemRow = await new Promise((rs) => db.get(
      'SELECT sku FROM shopee_items WHERE shopee_item_id = ? AND shopee_account_id = ? LIMIT 1',
      [shopeeItemId, accountId],
      (e, r) => rs(r || null)
    ));
    if (itemRow?.sku) return String(itemRow.sku).trim();
    return null;
  };

  // Tier 3 (último recurso): alguns sellers não cadastram SKU no anúncio, mas
  // colocam o código no título. Ex.: "Luminária Teto Trilho Preludio 3 Spots
  // 80071". Tentamos extrair sequências numéricas do título e validar contra
  // o inventário. Só aceitamos se encontrar exatamente UMA correspondência
  // para evitar falso positivo.
  const lookupFromTitle = async (title) => {
    const t = String(title || '').trim();
    if (!t) return null;
    const candidates = (t.match(/\b\d{3,8}[A-Za-z]?\b/g) || []);
    for (const c of candidates) {
      const inv = await findInventoryBySkuFlex(c);
      if (inv?.sku) return String(inv.sku).trim();
    }
    return null;
  };

  let resolved = 0;
  for (const it of missing) {
    try {
      let sku = null;
      if (it.marketplace_item_id) {
        sku = isMl
          ? await lookupMl(it.marketplace_item_id, it.variation_id)
          : await lookupShopee(it.marketplace_item_id, it.variation_id);
      }
      // Se o SKU encontrado no cache não resolve no inventário nem mesmo com
      // limpeza, tenta fallback pelo título antes de desistir. Isso evita
      // gravar um SKU "morto" que `computeCogs` não conseguiria casar.
      if (sku) {
        const invHit = await findInventoryBySkuFlex(sku);
        if (!invHit) {
          const bySku = await lookupFromTitle(it.title);
          if (bySku) sku = bySku;
        } else if (invHit.sku && String(invHit.sku).trim() !== sku.trim()) {
          // Armazena o SKU canônico do inventário ("80071") em vez do raw
          // ("80071B") para que o match em computeCogs/relatórios seja direto.
          sku = String(invHit.sku).trim();
        }
      } else {
        sku = await lookupFromTitle(it.title);
      }
      if (sku) {
        await new Promise((rs) => db.run(
          'UPDATE marketplace_order_items SET sku = ? WHERE id = ?',
          [sku, it.id],
          () => rs()
        ));
        resolved++;
      }
    } catch (e) {
      console.warn(`[resolveMissingSkusForOrder] item ${it.id}:`, e.message);
    }
  }
  return resolved;
}

// Aplica um objeto `fresh` (do fetchMlOrderFull/fetchShopeeOrderFull) ao banco.
// Respeita `bling_pedido_id` para não sobrescrever o status.
async function applyFreshOrderToDb(orderRow, fresh, source) {
  const keepStatus = !!orderRow.bling_pedido_id;
  const sets = [];
  const vals = [];
  const add = (col, val) => { sets.push(`${col} = ?`); vals.push(val === undefined ? null : val); };
  if (!keepStatus && fresh.status !== undefined) add('status', fresh.status);
  add('buyer_name', fresh.buyer_name);
  add('buyer_doc', fresh.buyer_doc);
  add('buyer_phone', fresh.buyer_phone);
  add('buyer_email', fresh.buyer_email);
  add('buyer_nickname', fresh.buyer_nickname);
  add('shipping_address_json', fresh.shipping_address_json);
  add('total_amount', fresh.total_amount);
  add('shipping_cost', fresh.shipping_cost);
  add('order_date', fresh.order_date);
  add('payment_method', fresh.payment_method);
  add('payment_status', fresh.payment_status);
  add('payment_id', fresh.payment_id);
  add('pack_id', fresh.pack_id);
  add('shipping_id', fresh.shipping_id);
  add('shipping_tracking', fresh.shipping_tracking);
  add('shipping_status', fresh.shipping_status);
  add('shipping_substatus', fresh.shipping_substatus);
  add('shipping_method', fresh.shipping_method);
  add('shipping_type', fresh.shipping_type);
  add('payment_installments', fresh.payment_installments);
  add('payment_date', fresh.payment_date);
  add('payment_total', fresh.payment_total);
  // Deriva status de impressão da etiqueta (nunca sobrescreve carimbo existente).
  try {
    const printed = deriveLabelPrinted(fresh, orderRow.marketplace);
    if (printed?.by === 'full') {
      add('label_printed_by', 'full');
    } else if (printed?.at && !orderRow.label_printed_at) {
      add('label_printed_at', printed.at);
      add('label_printed_by', printed.by);
    }
  } catch (_) { /* best-effort */ }
  sets.push('synced_at = CURRENT_TIMESTAMP');
  vals.push(orderRow.id);
  await new Promise((rs) => db.run(`UPDATE marketplace_orders SET ${sets.join(', ')} WHERE id = ?`, vals, () => rs()));

  if (Array.isArray(fresh.items) && fresh.items.length > 0) {
    await new Promise((rs) => db.run('DELETE FROM marketplace_order_items WHERE order_id = ?', [orderRow.id], () => rs()));
    for (const it of fresh.items) {
      await new Promise((rs) => db.run(
        `INSERT INTO marketplace_order_items (order_id, marketplace_item_id, variation_id, sku, title, quantity, unit_price, thumbnail, variation_attributes_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [orderRow.id, it.marketplace_item_id, it.variation_id, it.sku, it.title, it.quantity, it.unit_price, it.thumbnail, it.variation_attributes_json],
        () => rs()
      ));
    }
    // Fallback para pedidos cujos itens chegam sem `sku` (anúncios sem SKU
    // cadastrado no marketplace). Consultamos o cache local de anúncios.
    try { await resolveMissingSkusForOrder(orderRow); } catch (_) { /* best-effort */ }
  }

  // O recálculo de custos é disparado dentro de hydrateAndRecord (abaixo)
  // quando o snapshot muda, evitando duplicar trabalho. Se o marketplace
  // devolveu os mesmos dados, pulamos — os custos não mudariam de qualquer
  // forma porque dependem da mesma entrada.
  return hydrateAndRecord(orderRow.id, source, orderRow.snapshot_hash);
}

// Congela um pedido: marketplace não devolve mais os dados, miti passa a ser
// fonte da verdade. Grava snapshot final no history.
async function freezeOrder(orderRow, reason) {
  await new Promise((rs) => db.run(
    `UPDATE marketplace_orders SET frozen = 1, marketplace_deleted_at = CURRENT_TIMESTAMP, hydrate_last_error = ? WHERE id = ?`,
    [String(reason || 'marketplace_gone').slice(0, 500), orderRow.id], () => rs()
  ));
  const items = await new Promise((rs) => db.all('SELECT * FROM marketplace_order_items WHERE order_id = ?', [orderRow.id], (e, r) => rs(r || [])));
  const freshRow = await new Promise((rs) => db.get('SELECT * FROM marketplace_orders WHERE id = ?', [orderRow.id], (e, r) => rs(r || null)));
  if (freshRow) await insertOrderHistory(freshRow, items, 'final_freeze', null);
}

// Registra erro transitório (não congela ainda) — incrementa attempts.
function markHydrateError(orderRow, errMsg) {
  db.run(
    `UPDATE marketplace_orders SET hydrate_attempts = COALESCE(hydrate_attempts, 0) + 1, hydrate_last_error = ? WHERE id = ?`,
    [String(errMsg || '').slice(0, 500), orderRow.id]
  );
}

// Atualiza campos de hidratação + (se mudou) insere linha no history.
// row = registro atual do banco (antes do UPDATE). itemsFresh = array já
// gravado na marketplace_order_items. Retorna { inserted, hash }.
// Além disso, quando há mudança real (inserted=true) ou é a primeira vez que
// vemos o pedido (prevHash nulo), dispara o recálculo de custos em background.
// Isso garante que o relatório de Custos de Pedido reflita novos pedidos e
// mudanças de status/escrow sem depender do recálculo manual.
async function hydrateAndRecord(orderId, source, prevHash) {
  const row = await new Promise((rs) => db.get('SELECT * FROM marketplace_orders WHERE id = ?', [orderId], (e, r) => rs(r || null)));
  if (!row) return { inserted: false };
  const items = await new Promise((rs) => db.all('SELECT * FROM marketplace_order_items WHERE order_id = ?', [orderId], (e, r) => rs(r || [])));
  const result = await insertOrderHistory(row, items, source, prevHash);
  if (result.hash) {
    db.run(
      `UPDATE marketplace_orders SET snapshot_hash = ?, last_hydrated_at = CURRENT_TIMESTAMP, hydrate_source = ?, hydrate_attempts = 0, hydrate_last_error = NULL WHERE id = ?`,
      [result.hash, source || 'live_sync', orderId]
    );
  }
  // Dispara recálculo de custos quando o pedido é novo ou quando algo mudou
  // (status, escrow, itens etc.). Em background, nunca bloqueia o sync.
  if (result.inserted || !prevHash) {
    setImmediate(() => {
      computeOrderCostsSafe(row, items).catch(() => { /* best-effort */ });
    });
  }
  return result;
}

// --- Sync orders from ML ---
app.post('/api/marketplace-orders/sync', async (req, res) => {
  const { marketplace, accountId, dateFrom, dateTo, full } = req.body;
  if (!marketplace || !accountId) return res.status(400).json({ error: 'marketplace e accountId obrigatórios' });

  if (marketplace === 'ml') {
    try {
      const creds = await getMLCredentials(accountId);
      if (!creds || !creds.mlUserId) {
        const token = await refreshMLTokenIfNeeded(accountId);
        if (!token) return res.status(400).json({ error: 'Não conectado ao ML' });
        const me = await mlApiGet('/users/me', accountId);
        db.run('UPDATE ml_accounts SET ml_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [String(me.id), accountId]);
        creds.mlUserId = String(me.id);
      }

      // Delta sync: se tivermos last_orders_sync_at salvo e o user não pediu full,
      // busca apenas pedidos ATUALIZADOS (last_updated) desde a última sincronização.
      let incrementalSince = null;
      if (!full && !dateFrom && !dateTo) {
        const row = await new Promise((resolve) => {
          db.get('SELECT last_orders_sync_at FROM ml_accounts WHERE id = ?', [accountId], (e, r) => resolve(r || null));
        });
        if (row?.last_orders_sync_at) {
          // 10 min de overlap para cobrir lags da API
          incrementalSince = new Date(new Date(row.last_orders_sync_at).getTime() - 10 * 60 * 1000).toISOString();
        }
      }

      const limit = 50;
      const baseUrl = `/orders/search?seller=${creds.mlUserId}&sort=date_desc&limit=${limit}`;

      // Limite de segurança: se um filtro não for aplicado pela API por
      // qualquer razão, evita baixar milhares de pedidos do seller todo.
      // Configurável via MKT_ML_SYNC_MAX_RESULTS (default 2000).
      const MAX_RESULTS_PER_FILTER = parseInt(process.env.MKT_ML_SYNC_MAX_RESULTS || '2000', 10);

      // Pré-computa os limites do range (em ms UTC) para validação pós-paginação.
      // Se a API do ML ignorar o filtro (já observado em produção), descartamos
      // aqui os pedidos que caem fora do intervalo por date_created E last_updated.
      const fromTsGuard = dateFrom ? new Date(`${dateFrom}T00:00:00-03:00`).getTime() : null;
      const toTsGuard = dateTo ? new Date(`${dateTo}T23:59:59-03:00`).getTime() : null;
      const hasRange = fromTsGuard != null || toTsGuard != null;
      const withinRange = (r) => {
        if (!hasRange) return true;
        const dc = r.date_created ? new Date(r.date_created).getTime() : NaN;
        const lu = r.last_updated ? new Date(r.last_updated).getTime() : NaN;
        const inRange = (t) => !Number.isNaN(t) && (fromTsGuard == null || t >= fromTsGuard) && (toTsGuard == null || t <= toTsGuard);
        return inRange(dc) || inRange(lu);
      };

      // Pagina um `searchUrl` acumulando em `out`, deduplicando por order_id.
      // `validator` (opcional): decide se o pedido retornado entra no resultado.
      // Se várias páginas seguidas vierem 100% rejeitadas, cortamos a paginação
      // para não consumir o safety limit quando a API ignora o filtro.
      const paginate = async (searchUrl, out, seen, labelForLogs, validator) => {
        let offset = 0;
        let scrollId = null;
        let hasMore = true;
        let pageCount = 0;
        let fetchedInThisFilter = 0;
        let keptInThisFilter = 0;
        let rejectedPagesInARow = 0;
        while (hasMore) {
          try {
            const pageUrl = scrollId ? `${searchUrl}&scroll_id=${encodeURIComponent(scrollId)}` : `${searchUrl}&offset=${offset}`;
            const page = await mlApiGet(pageUrl, accountId);
            pageCount++;
            const results = page.results || [];
            if (pageCount === 1) {
              console.log(`[MktOrders] ${labelForLogs} acct=${accountId} URL=${searchUrl} → paging=${JSON.stringify(page.paging || {})} results=${results.length}`);
            }
            let pageKept = 0;
            for (const r of results) {
              const key = String(r.id || r.pack_id || '');
              if (!key || seen.has(key)) continue;
              if (validator && !validator(r)) continue;
              seen.add(key);
              out.push(r);
              pageKept++;
            }
            fetchedInThisFilter += results.length;
            keptInThisFilter += pageKept;

            if (results.length > 0) {
              console.log(`[MktOrders] ${labelForLogs}: página ${pageCount} aceitos ${pageKept}/${results.length} (acc total ${out.length})`);
            }

            // Early-break: páginas inteiras rejeitadas = filtro ignorado pela API.
            if (validator && results.length > 0 && pageKept === 0) {
              rejectedPagesInARow++;
              if (rejectedPagesInARow >= 2) {
                console.warn(`[MktOrders] ${labelForLogs} — 2 páginas seguidas sem pedidos no intervalo. O ML provavelmente ignorou o filtro. Parando aqui.`);
                hasMore = false;
              }
            } else if (pageKept > 0) {
              rejectedPagesInARow = 0;
            }

            scrollId = page.paging?.scroll_id || null;
            if (hasMore) {
              if (scrollId) {
                offset = 0;
                hasMore = results.length === limit;
              } else {
                offset += limit;
                hasMore = results.length === limit && offset < (page.paging?.total || 0);
              }
            }
            if (fetchedInThisFilter >= MAX_RESULTS_PER_FILTER) {
              console.warn(`[MktOrders] ${labelForLogs} atingiu limite de segurança ${MAX_RESULTS_PER_FILTER} resultados — interrompendo (filtro da API pode não ter sido aplicado). Defina MKT_ML_SYNC_MAX_RESULTS para ajustar.`);
              hasMore = false;
            }
          } catch (pageErr) {
            console.error(`[MktOrders] ${labelForLogs} page fetch error:`, pageErr.response?.status, pageErr.response?.data || pageErr.message);
            hasMore = false;
          }
        }
        console.log(`[MktOrders] ${labelForLogs} — fim. Total baixado=${fetchedInThisFilter} aceitos=${keptInThisFilter}`);
      };

      const allOrders = [];
      const seenIds = new Set();

      if (incrementalSince) {
        // Delta: tudo que foi atualizado desde última sincronização.
        const searchUrl = `${baseUrl}&order.last_updated.from=${encodeURIComponent(incrementalSince)}`;
        console.log(`[MktOrders] Delta sync ML account ${accountId} desde ${incrementalSince}`);
        const sinceTs = new Date(incrementalSince).getTime();
        await paginate(searchUrl, allOrders, seenIds, 'delta/last_updated',
          (r) => {
            const lu = r.last_updated ? new Date(r.last_updated).getTime() : NaN;
            return !Number.isNaN(lu) && lu >= sinceTs;
          });
      } else {
        // Filtro explícito: combina DUAS buscas para capturar pedidos CRIADOS
        // no intervalo E pedidos ANTIGOS que foram ATUALIZADOS no intervalo
        // (pagamento confirmado, envio, NFe emitida etc.).
        // OBS: o ML API NÃO aceita valores de data URL-encoded — precisa dos
        // ':' e '-' crus no timezone (ex.: 2026-04-20T00:00:00.000-03:00).
        const fromIso = dateFrom ? `${dateFrom}T00:00:00.000-03:00` : null;
        const toIso = dateTo ? `${dateTo}T23:59:59.000-03:00` : null;
        const filters = [];
        if (fromIso || toIso) {
          const created = [];
          if (fromIso) created.push(`order.date_created.from=${fromIso}`);
          if (toIso) created.push(`order.date_created.to=${toIso}`);
          filters.push({ label: 'date_created', qs: created.join('&') });
          const updated = [];
          if (fromIso) updated.push(`order.last_updated.from=${fromIso}`);
          if (toIso) updated.push(`order.last_updated.to=${toIso}`);
          filters.push({ label: 'last_updated', qs: updated.join('&') });
        } else {
          filters.push({ label: 'all', qs: '' });
        }
        for (const f of filters) {
          const searchUrl = f.qs ? `${baseUrl}&${f.qs}` : baseUrl;
          // Passamos o validator somente quando temos range — sem range queremos
          // tudo que a API devolver.
          await paginate(searchUrl, allOrders, seenIds, f.label, hasRange ? withinRange : undefined);
        }
      }

      let synced = 0;
      let skipped = 0;

      // Achatar: cada result pode ser um pack com orders[] (vários pedidos) ou um pedido único
      const flatOrders = [];
      for (const r of allOrders) {
        if (r.orders && Array.isArray(r.orders) && r.orders.length > 0) {
          for (const o of r.orders) {
            flatOrders.push({ _parent: r, _inner: o });
          }
        } else {
          flatOrders.push({ _parent: r, _inner: r });
        }
      }
      console.log(`[MktOrders] Processing ${flatOrders.length} orders (from ${allOrders.length} results) from ML account ${accountId}`);

      for (const { _parent: order, _inner: innerOrder } of flatOrders) {
        const oid = innerOrder.id || order.id;
        if (!oid) continue;
        const shippingRef = order.shipping || order.shipment || innerOrder.shipping || innerOrder.shipment;
        const payment = (innerOrder.payments && innerOrder.payments[0]) || (order.payments && order.payments[0]) || {};
        let orderItems = innerOrder.order_items || order.order_items || [];
        const buyer = order.buyer || innerOrder.buyer || {};

        const existing = await new Promise((resolve) => {
          db.get('SELECT id, bling_pedido_id, snapshot_hash FROM marketplace_orders WHERE marketplace = ? AND marketplace_order_id = ? AND account_id = ?',
            ['ml', String(oid), accountId], (e, r) => resolve(r || null));
        });

        // Enriquecer com GET /orders/{id} para obter pack_id e dados completos quando ausentes
        let packId = (order.pack_id || innerOrder.pack_id) ? String(order.pack_id || innerOrder.pack_id) : null;
        if (!packId && !existing) {
          try {
            const fullOrder = await mlApiGet(`/orders/${oid}`, accountId);
            if (fullOrder) {
              packId = fullOrder.pack_id ? String(fullOrder.pack_id) : null;
              if (!orderItems.length && fullOrder.order_items) orderItems = fullOrder.order_items;
            }
          } catch (eoErr) { /* opcional */ }
        }

        let shippingAddr = null;
        let shippingTracking = null;
        let shippingStatus = null;
        let shippingSubstatus = null;
        let shippingMethod = null;
        let shippingType = null;
        const shippingId = shippingRef?.id ? String(shippingRef.id) : null;

        if (shippingRef && shippingRef.id) {
          try {
            const ship = await mlApiGet(`/shipments/${shippingRef.id}`, accountId);
            if (ship) {
              const dest = ship.receiver_address || ship.destination?.shipping_address || {};
              shippingAddr = {
                receiver_name: ship.receiver_name || ship.destination?.receiver_name || dest.receiver_name || null,
                street: dest.street_name || dest.address_line || '',
                number: dest.street_number || '',
                complement: dest.comment || '',
                neighborhood: (dest.neighborhood && (dest.neighborhood.name || dest.neighborhood)) || '',
                city: (dest.city && (dest.city.name || dest.city)) || '',
                state: (dest.state && (dest.state.name || dest.state.id || dest.state)) || '',
                zip_code: dest.zip_code || '',
                country: (dest.country && (dest.country.name || dest.country)) || 'Brasil'
              };
              shippingTracking = ship.tracking_number || null;
              shippingStatus = ship.status || null;
              shippingSubstatus = ship.substatus || null;
              shippingMethod = ship.shipping_option?.name || ship.logistic_type || null;
              shippingType = ship.logistic_type || null;
            }
          } catch (shipErr) { console.log('[MktOrders] Shipping fetch error for order', oid, shipErr.message); }
        }

        const orderStatus = innerOrder.status || order.status;

        const buyerName = (`${buyer.first_name || ''} ${buyer.last_name || ''}`.trim()) || buyer.nickname || (shippingAddr?.receiver_name) || '';
        const buyerDoc = buyer.billing_info?.doc_number || null;
        const buyerPhone = buyer.phone ? `${buyer.phone.area_code || ''}${buyer.phone.number || ''}` : null;
        const orderDate = normalizeMarketplaceOrderDate(innerOrder.date_created || order.date_created || null);
        const totalAmount = innerOrder.total_amount || order.total_amount || 0;
        const shippingCost = shippingRef?.cost || payment.shipping_cost || 0;

        const paymentMethod = payment.payment_type || payment.payment_method_id || null;
        const paymentStatus = payment.status || orderStatus || null;
        const paymentId = payment.id ? String(payment.id) : null;
        const paymentInstallments = payment.installments || null;
        const paymentDate = normalizeMarketplaceOrderDate(payment.date_approved || payment.date_created || null);
        const paymentTotal = payment.total_paid_amount || payment.transaction_amount || null;

        console.log(`[MktOrders] Order ${oid}: buyer="${buyerName}", doc=${buyerDoc}, items=${orderItems.length}, total=${totalAmount}, status=${orderStatus}, shipping_status=${shippingStatus}, tracking=${shippingTracking}, payment_id=${paymentId}, pack_id=${packId}`);
        if (orderItems.length > 0) {
          const firstOi = orderItems[0];
          console.log(`[MktOrders]   Item0: title="${firstOi.item?.title}", sku="${firstOi.item?.seller_custom_field}", item_id=${firstOi.item?.id}, variation_id=${firstOi.item?.variation_id}, thumbnail=${firstOi.item?.thumbnail}`);
        }

        // Fetch thumbnail for each order item from ML item API
        const itemThumbnails = {};
        for (const oi of orderItems) {
          const item = oi.item || {};
          if (item.id && !itemThumbnails[item.id]) {
            try {
              const mlItem = await mlApiGet(`/items/${item.id}?attributes=thumbnail,pictures,title`, accountId);
              itemThumbnails[item.id] = mlItem.thumbnail || (mlItem.pictures?.[0]?.secure_url) || null;
            } catch (thumbErr) {
              console.log(`[MktOrders] Thumbnail fetch error for item ${item.id}:`, thumbErr.message);
            }
          }
        }

        const buildOrderData = () => [
          orderStatus || 'paid', buyerName, buyerDoc,
          buyerPhone, buyer.email || null, buyer.nickname || null,
          shippingAddr ? JSON.stringify(shippingAddr) : null, totalAmount, shippingCost, orderDate,
          paymentMethod, paymentStatus,
          paymentId, packId, shippingId, shippingTracking, shippingStatus, shippingMethod, shippingType,
          paymentInstallments, paymentDate, paymentTotal
        ];

        const insertItems = (parentOrderId) => {
          for (const oi of orderItems) {
            const item = oi.item || {};
            const varAttrs = item.variation_attributes || [];
            const sku = item.seller_custom_field || null;
            const thumb = itemThumbnails[item.id] || item.thumbnail || null;
            db.run(`INSERT INTO marketplace_order_items (order_id, marketplace_item_id, variation_id, sku, title, quantity, unit_price, thumbnail, variation_attributes_json)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [parentOrderId, item.id, item.variation_id ? String(item.variation_id) : null, sku, item.title, oi.quantity || 1, oi.unit_price || 0,
               thumb, varAttrs.length > 0 ? JSON.stringify(varAttrs) : null]);
          }
        };

        const extraFields = `payment_id = ?, pack_id = ?, shipping_id = ?, shipping_tracking = ?, shipping_status = ?, shipping_method = ?, shipping_type = ?,
              payment_installments = ?, payment_date = ?, payment_total = ?`;

        // Carimbos auxiliares de etiqueta (aplicados após o INSERT/UPDATE principal).
        const applyLabelAux = (rowId) => {
          try {
            const printed = deriveLabelPrinted({
              shipping_status: shippingStatus,
              shipping_substatus: shippingSubstatus,
              shipping_type: shippingType,
            }, 'ml');
            db.run(
              `UPDATE marketplace_orders
               SET shipping_substatus = ?,
                   label_printed_at = CASE WHEN label_printed_at IS NULL AND ? IS NOT NULL THEN ? ELSE label_printed_at END,
                   label_printed_by = COALESCE(label_printed_by, ?)
               WHERE id = ?`,
              [shippingSubstatus, printed?.at || null, printed?.at || null, printed?.by || null, rowId]
            );
          } catch (_) { /* best-effort */ }
        };

        if (existing) {
          const data = buildOrderData();
          const keepStatus = existing.bling_pedido_id ? true : false;
          if (keepStatus) {
            db.run(`UPDATE marketplace_orders SET buyer_name = ?, buyer_doc = ?, buyer_phone = ?, buyer_email = ?, buyer_nickname = ?,
              shipping_address_json = ?, total_amount = ?, shipping_cost = ?, order_date = ?, payment_method = ?, payment_status = ?,
              ${extraFields}, synced_at = CURRENT_TIMESTAMP
              WHERE id = ?`, [data[1], data[2], data[3], data[4], data[5], data[6], data[7], data[8], data[9], data[10], data[11],
              data[12], data[13], data[14], data[15], data[16], data[17], data[18], data[19], data[20], data[21], existing.id]);
          } else {
            db.run(`UPDATE marketplace_orders SET status = ?, buyer_name = ?, buyer_doc = ?, buyer_phone = ?, buyer_email = ?, buyer_nickname = ?,
              shipping_address_json = ?, total_amount = ?, shipping_cost = ?, order_date = ?, payment_method = ?, payment_status = ?,
              ${extraFields}, synced_at = CURRENT_TIMESTAMP
              WHERE id = ?`, [...data, existing.id]);
          }
          applyLabelAux(existing.id);
          db.run('DELETE FROM marketplace_order_items WHERE order_id = ?', [existing.id]);
          insertItems(existing.id);
          // Backup: grava no history se o snapshot mudou.
          hydrateAndRecord(existing.id, 'live_sync', existing.snapshot_hash).catch(() => {});
          synced++;
        } else {
          await new Promise((resolve) => {
            const data = buildOrderData();
            db.run(`INSERT INTO marketplace_orders (marketplace, marketplace_order_id, account_id, status, buyer_name, buyer_doc, buyer_phone, buyer_email, buyer_nickname,
              shipping_address_json, total_amount, shipping_cost, order_date, payment_method, payment_status,
              payment_id, pack_id, shipping_id, shipping_tracking, shipping_status, shipping_method, shipping_type,
              payment_installments, payment_date, payment_total)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              ['ml', String(oid), accountId, ...data],
              function(err) {
                if (err) { console.error('[MktOrders] Insert error:', err.message); return resolve(); }
                const newId = this.lastID;
                insertItems(newId);
                applyLabelAux(newId);
                hydrateAndRecord(newId, 'live_sync', null).catch(() => {});
                resolve();
              });
          });
          synced++;
        }
      }

      console.log(`[MktOrders] ML sync done: ${synced} synced, ${skipped} skipped (already sent to Bling)`);
      await recomputePipelineForAccount('ml', accountId);
      db.run('UPDATE ml_accounts SET last_orders_sync_at = CURRENT_TIMESTAMP WHERE id = ?', [accountId]);
      res.json({ success: true, total: allOrders.length, synced, skipped, incremental: !!incrementalSince });
    } catch (err) {
      console.error('[MktOrders] ML sync error:', err.response?.data || err.message);
      res.status(500).json({ error: 'Erro ao sincronizar pedidos ML', details: err.message });
    }
  } else if (marketplace === 'shopee') {
    // ─────────────────────────────────────────────────────────────────────
    // Sync de pedidos Shopee. A API v2 funciona em duas etapas:
    //   1) /api/v2/order/get_order_list devolve order_sn[] paginados pela
    //      janela time_range_field + time_from/to (limite de 15 dias).
    //   2) /api/v2/order/get_order_detail aceita até 50 order_sn por call
    //      e devolve todos os campos ricos (items, endereço, pagamento,
    //      tracking, invoice_data).
    // Quando o cliente não passa dateFrom/dateTo, tomamos janela de 7 dias.
    // ─────────────────────────────────────────────────────────────────────
    try {
      const SHOPEE_ORDER_WINDOW_MAX = 60 * 60 * 24 * 15; // 15 dias
      const now = Math.floor(Date.now() / 1000);
      // Converte 'YYYY-MM-DD' em timestamp unix usando o fuso de Brasília
      // (UTC-3). `new Date('2026-04-22')` sozinho vira UTC midnight, o que
      // em BRT corresponde a 21h do dia anterior e quebra filtros diários.
      // `endOfDay` expande para 23:59:59 BRT, cobrindo o dia inteiro.
      const BRT_OFFSET = '-03:00';
      const toUnix = (s, endOfDay = false) => {
        if (!s) return null;
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
          const t = endOfDay ? '23:59:59' : '00:00:00';
          return Math.floor(new Date(`${s}T${t}${BRT_OFFSET}`).getTime() / 1000);
        }
        return Math.floor(new Date(s).getTime() / 1000);
      };
      let timeFrom;
      let timeTo = dateTo ? toUnix(dateTo, true) : now;
      // Shopee rejeita time_to no futuro; se o usuário escolheu o dia de hoje,
      // o fim do dia BRT pode cair algumas horas à frente do relógio do servidor.
      if (timeTo > now) timeTo = now;
      // Delta sync Shopee: se não veio dateFrom/full, reusa o último sync da conta
      // (com overlap de 10min) como time_from, aproveitando o filtro update_time.
      if (dateFrom) {
        timeFrom = toUnix(dateFrom, false);
      } else if (!full) {
        const row = await new Promise((resolve) => {
          db.get('SELECT last_orders_sync_at FROM shopee_accounts WHERE id = ?', [accountId], (e, r) => resolve(r || null));
        });
        if (row?.last_orders_sync_at) {
          timeFrom = Math.floor(new Date(row.last_orders_sync_at).getTime() / 1000) - 600;
          console.log(`[MktOrders] Shopee delta sync account ${accountId} desde ${new Date(timeFrom * 1000).toISOString()}`);
        } else {
          timeFrom = now - (60 * 60 * 24 * 7);
        }
      } else {
        timeFrom = now - (60 * 60 * 24 * 7);
      }
      if (timeFrom > timeTo) [timeFrom, timeTo] = [timeTo, timeFrom];
      if (timeTo - timeFrom > SHOPEE_ORDER_WINDOW_MAX) timeFrom = timeTo - SHOPEE_ORDER_WINDOW_MAX;

      // Paginação por cursor da Shopee.
      const allSns = [];
      let cursor = '';
      let more = true;
      let loops = 0;
      while (more && loops < 40) {
        loops++;
        const listResp = await shopeeApiGet('/api/v2/order/get_order_list', {
          time_range_field: 'update_time',
          time_from: timeFrom,
          time_to: timeTo,
          page_size: 100,
          cursor: cursor || '',
        }, accountId);
        if (listResp?.error && listResp.error !== '') {
          throw new Error(`${listResp.error}: ${listResp.message || ''}`);
        }
        const resp = listResp?.response || {};
        const list = resp.order_list || [];
        for (const row of list) if (row.order_sn) allSns.push(row.order_sn);
        more = !!resp.more;
        cursor = resp.next_cursor || '';
      }

      let synced = 0;
      let skipped = 0;

      // Busca detalhes em lotes de 50 (limite Shopee).
      const FIELDS = [
        'buyer_user_id', 'buyer_username', 'recipient_address', 'item_list',
        'total_amount', 'payment_method', 'package_list', 'invoice_data',
        'order_status', 'create_time', 'update_time', 'pay_time',
        'currency', 'cod', 'note', 'shipping_carrier', 'actual_shipping_fee',
      ].join(',');

      for (let i = 0; i < allSns.length; i += 50) {
        const batch = allSns.slice(i, i + 50);
        const detailResp = await shopeeApiGet('/api/v2/order/get_order_detail', {
          order_sn_list: batch.join(','),
          response_optional_fields: FIELDS,
        }, accountId);
        if (detailResp?.error && detailResp.error !== '') {
          console.error('[MktOrders] Shopee detail error:', detailResp);
          continue;
        }
        const orders = detailResp?.response?.order_list || [];
        for (const o of orders) {
          const orderSn = o.order_sn;
          if (!orderSn) continue;

          const existing = await new Promise((resolve) => {
            db.get('SELECT id, bling_pedido_id, snapshot_hash FROM marketplace_orders WHERE marketplace = ? AND marketplace_order_id = ? AND account_id = ?',
              ['shopee', orderSn, accountId], (e, r) => resolve(r || null));
          });

          const addr = o.recipient_address || {};
          const shippingAddr = {
            receiver_name: addr.name || '',
            street: addr.full_address || '',
            number: '',
            complement: '',
            neighborhood: addr.district || '',
            city: addr.city || '',
            state: addr.state || '',
            zip_code: addr.zipcode || '',
            country: addr.region || 'Brasil',
            phone: addr.phone || null,
          };
          const pkg = (o.package_list && o.package_list[0]) || {};
          const shippingTracking = pkg.tracking_number || null;
          const shippingStatus = pkg.shipping_status || pkg.logistics_status || null;
          const shippingMethod = o.shipping_carrier || null;
          const shippingId = pkg.package_number || null;
          const orderStatus = o.order_status || 'UNPAID';

          const totalAmount = parseFloat(o.total_amount || 0);
          const shippingCost = parseFloat(o.actual_shipping_fee || 0);

          const orderDate = o.create_time ? new Date(o.create_time * 1000).toISOString() : null;
          const paymentDate = o.pay_time ? new Date(o.pay_time * 1000).toISOString() : null;

          // invoice_data (Shopee pode retornar o CPF/CNPJ do comprador).
          const inv = o.invoice_data || {};
          const buyerDoc = inv.tax_id || inv.number || null;
          const buyerName = addr.name || o.buyer_username || '';

          const orderItems = (o.item_list || []).map(it => ({
            marketplace_item_id: it.item_id ? String(it.item_id) : null,
            variation_id: it.model_id ? String(it.model_id) : null,
            sku: it.model_sku || it.item_sku || null,
            title: it.item_name || '',
            quantity: it.model_quantity_purchased || 1,
            unit_price: parseFloat(it.model_discounted_price || it.model_original_price || 0),
            thumbnail: it.image_info?.image_url || null,
            variation_attributes_json: it.model_name ? JSON.stringify({ model_name: it.model_name }) : null,
          }));

          const dataRow = [
            orderStatus, buyerName, buyerDoc, shippingAddr.phone, null, o.buyer_username || null,
            JSON.stringify(shippingAddr), totalAmount, shippingCost, orderDate,
            o.payment_method || null, orderStatus,
            null /* payment_id */, null /* pack_id */, shippingId, shippingTracking, shippingStatus, shippingMethod, shippingMethod,
            null /* installments */, paymentDate, totalAmount,
          ];

          const extraFields = `payment_id = ?, pack_id = ?, shipping_id = ?, shipping_tracking = ?, shipping_status = ?, shipping_method = ?, shipping_type = ?,
                payment_installments = ?, payment_date = ?, payment_total = ?`;

          const insertItems = (parentOrderId) => {
            for (const it of orderItems) {
              db.run(`INSERT INTO marketplace_order_items (order_id, marketplace_item_id, variation_id, sku, title, quantity, unit_price, thumbnail, variation_attributes_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [parentOrderId, it.marketplace_item_id, it.variation_id, it.sku, it.title, it.quantity, it.unit_price, it.thumbnail, it.variation_attributes_json]);
            }
          };

          const applyLabelAuxShopee = (rowId) => {
            try {
              const printed = deriveLabelPrinted({
                shipping_status: shippingStatus,
                shipping_type: shippingMethod,
              }, 'shopee');
              db.run(
                `UPDATE marketplace_orders
                 SET label_printed_at = CASE WHEN label_printed_at IS NULL AND ? IS NOT NULL THEN ? ELSE label_printed_at END,
                     label_printed_by = COALESCE(label_printed_by, ?)
                 WHERE id = ?`,
                [printed?.at || null, printed?.at || null, printed?.by || null, rowId]
              );
            } catch (_) { /* best-effort */ }
          };

          if (existing) {
            if (existing.bling_pedido_id) {
              // Pedido já em Bling — não sobrescreve status principal, só infos acessórias.
              db.run(`UPDATE marketplace_orders SET buyer_name = ?, buyer_doc = ?, buyer_phone = ?, buyer_nickname = ?,
                shipping_address_json = ?, total_amount = ?, shipping_cost = ?, order_date = ?, payment_method = ?, payment_status = ?,
                ${extraFields}, synced_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [dataRow[1], dataRow[2], dataRow[3], dataRow[5], dataRow[6], dataRow[7], dataRow[8], dataRow[9], dataRow[10], dataRow[11],
                  dataRow[12], dataRow[13], dataRow[14], dataRow[15], dataRow[16], dataRow[17], dataRow[18], dataRow[19], dataRow[20], dataRow[21], existing.id]);
            } else {
              db.run(`UPDATE marketplace_orders SET status = ?, buyer_name = ?, buyer_doc = ?, buyer_phone = ?, buyer_email = ?, buyer_nickname = ?,
                shipping_address_json = ?, total_amount = ?, shipping_cost = ?, order_date = ?, payment_method = ?, payment_status = ?,
                ${extraFields}, synced_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [...dataRow, existing.id]);
            }
            applyLabelAuxShopee(existing.id);
            db.run('DELETE FROM marketplace_order_items WHERE order_id = ?', [existing.id]);
            insertItems(existing.id);
            hydrateAndRecord(existing.id, 'live_sync', existing.snapshot_hash).catch(() => {});
            synced++;
          } else {
            await new Promise((resolve) => {
              db.run(`INSERT INTO marketplace_orders (marketplace, marketplace_order_id, account_id, status, buyer_name, buyer_doc, buyer_phone, buyer_email, buyer_nickname,
                shipping_address_json, total_amount, shipping_cost, order_date, payment_method, payment_status,
                payment_id, pack_id, shipping_id, shipping_tracking, shipping_status, shipping_method, shipping_type,
                payment_installments, payment_date, payment_total)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                ['shopee', orderSn, accountId, ...dataRow],
                function (err) {
                  if (err) { console.error('[MktOrders] Shopee insert error:', err.message); return resolve(); }
                  const newId = this.lastID;
                  insertItems(newId);
                  applyLabelAuxShopee(newId);
                  hydrateAndRecord(newId, 'live_sync', null).catch(() => {});
                  resolve();
                });
            });
            synced++;
          }
        }
      }

      console.log(`[MktOrders] Shopee sync done: ${synced} synced, ${skipped} skipped`);
      await recomputePipelineForAccount('shopee', accountId);
      db.run('UPDATE shopee_accounts SET last_orders_sync_at = CURRENT_TIMESTAMP WHERE id = ?', [accountId]);
      res.json({ success: true, total: allSns.length, synced, skipped });
    } catch (err) {
      console.error('[MktOrders] Shopee sync error:', err.response?.data || err.message);
      res.status(500).json({ error: 'Erro ao sincronizar pedidos Shopee', details: err.message });
    }
  } else {
    res.status(400).json({ error: 'Marketplace não suportado' });
  }
});

// --- Sync unificado: ML + Shopee + fetch NFes em uma chamada só ---
// Corpo: { marketplace?: 'ml'|'shopee'|null, dateFrom?, dateTo?, fetchInvoices?: boolean=true }
// Se `marketplace` vier vazio/null, sincroniza AMBOS os canais. Se vier 'ml' ou
// 'shopee', limita ao canal correspondente (respeita o filtro de canal da UI).
// Após sincronizar, dispara fetch-ml-invoices (ML Faturador) e batch-nfe-check
// (Bling) para que a tela já apresente as NFes recém-emitidas.
app.post('/api/marketplace-orders/sync-all', async (req, res) => {
  const { marketplace = null, dateFrom, dateTo, fetchInvoices = true } = req.body || {};
  const INTERNAL_BASE = `http://localhost:${PORT}`;
  const errors = [];
  const synced = { ml: 0, shopee: 0 };
  const totals = { ml: 0, shopee: 0 }; // total bruto retornado pela API do canal
  const invoices = { found_ml: 0, found_bling: 0 };

  const includeMl = !marketplace || marketplace === 'ml';
  const includeShopee = !marketplace || marketplace === 'shopee';

  console.log(`[SyncAll] INÍCIO marketplace=${marketplace || 'ambos'} dateFrom=${dateFrom} dateTo=${dateTo} fetchInvoices=${fetchInvoices}`);

  try {
    // Tokens ficam em api_tokens (provider='ml'/'shopee', account_id), NÃO
    // nas tabelas de conta. Buscamos contas que tenham token salvo.
    const mlAccts = includeMl
      ? await new Promise((rs) => db.all(
          `SELECT a.id FROM ml_accounts a
             INNER JOIN api_tokens t ON t.account_id = a.id AND t.provider = 'mercado_livre'
             WHERE t.refresh_token IS NOT NULL AND t.refresh_token != ''`,
          (e, r) => rs(e ? [] : (r || []))))
      : [];
    const shopeeAccts = includeShopee
      ? await new Promise((rs) => db.all(
          `SELECT a.id FROM shopee_accounts a
             INNER JOIN api_tokens t ON t.account_id = a.id AND t.provider = 'shopee'
             WHERE t.access_token IS NOT NULL AND t.access_token != ''`,
          (e, r) => rs(e ? [] : (r || []))))
      : [];

    console.log(`[SyncAll] contas ML=${mlAccts.length} (${mlAccts.map(a => a.id).join(',')}) Shopee=${shopeeAccts.length} (${shopeeAccts.map(a => a.id).join(',')})`);

    const internalReq = { headers: internalServiceHeaders() };

    // 1) Sync ML conta a conta (sequencial para não explodir rate-limit).
    for (const acc of mlAccts) {
      try {
        console.log(`[SyncAll] → chamando /sync ML acc=${acc.id}`);
        const r = await axios.post(`${INTERNAL_BASE}/api/marketplace-orders/sync`,
          { marketplace: 'ml', accountId: acc.id, dateFrom, dateTo }, internalReq);
        const s = Number(r.data?.synced || 0);
        const t = Number(r.data?.total || 0);
        synced.ml += s;
        totals.ml += t;
        console.log(`[SyncAll] ← /sync ML acc=${acc.id} total=${t} synced=${s}`);
      } catch (e) {
        const msg = e.response?.data?.error || e.response?.data?.details || e.message;
        errors.push({ marketplace: 'ml', accountId: acc.id, error: msg });
        console.error('[SyncAll ML]', acc.id, msg);
      }
    }

    // 2) Sync Shopee conta a conta.
    for (const acc of shopeeAccts) {
      try {
        const r = await axios.post(`${INTERNAL_BASE}/api/marketplace-orders/sync`,
          { marketplace: 'shopee', accountId: acc.id, dateFrom, dateTo }, internalReq);
        synced.shopee += Number(r.data?.synced || 0);
        totals.shopee += Number(r.data?.total || 0);
      } catch (e) {
        const msg = e.response?.data?.error || e.response?.data?.details || e.message;
        errors.push({ marketplace: 'shopee', accountId: acc.id, error: msg });
        console.error('[SyncAll Shopee]', acc.id, msg);
      }
    }

    if (fetchInvoices) {
      // 3) Fetch NFe do ML Faturador para cada conta ML (pedidos sem chave).
      const nfeWindowFrom = dateFrom
        ? dateFrom
        : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      for (const acc of mlAccts) {
        try {
          const r = await axios.post(`${INTERNAL_BASE}/api/marketplace-orders/fetch-ml-invoices`,
            { accountId: acc.id, dateFrom: nfeWindowFrom, dateTo }, internalReq);
          invoices.found_ml += Number(r.data?.updated || r.data?.found || 0);
        } catch (e) {
          const msg = e.response?.data?.error || e.response?.data?.details || e.message;
          errors.push({ stage: 'fetch-ml-invoices', accountId: acc.id, error: msg });
          console.error('[SyncAll fetch-ml-invoices]', acc.id, msg);
        }
      }

      // 4) Batch NFe-check (Bling) para pedidos sem bling_nfe_numero, janela 30 dias, até 200.
      try {
        const filters = ['(bling_nfe_numero IS NULL OR bling_nfe_numero = "")'];
        const params = [];
        if (marketplace) { filters.push('marketplace = ?'); params.push(marketplace); }
        // Janela: SEMPRE inclui os últimos 30 dias, mesmo quando o usuário
        // filtrou "hoje" na busca. Esse endpoint emite NF depois do pedido ser
        // sincronizado (às vezes dias depois), então seguir o dateFrom do sync
        // deixa pedidos antigos sem NFe pendente sem nunca serem rechecados.
        const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
        const defaultSince = new Date(Date.now() - THIRTY_DAYS).toISOString();
        const dateFromMs = dateFrom ? new Date(dateFrom).getTime() : null;
        const defaultMs = Date.now() - THIRTY_DAYS;
        const since = (dateFromMs && dateFromMs < defaultMs)
          ? dateFrom
          : defaultSince;
        filters.push('(order_date IS NULL OR order_date >= ?)');
        params.push(since);
        const pending = await new Promise((rs) => db.all(
          `SELECT id FROM marketplace_orders WHERE ${filters.join(' AND ')} ORDER BY order_date DESC LIMIT 200`,
          params, (e, r) => rs(e ? [] : (r || []))));
        for (let i = 0; i < pending.length; i += 50) {
          const chunk = pending.slice(i, i + 50).map(r => r.id);
          try {
            // force=true: ignora o cache negativo de 30min. O sync manual é
            // intencional — se o usuário acabou de apertar o botão, ele quer
            // dados frescos, mesmo para pedidos checados minutos atrás.
            const br = await axios.post(`${INTERNAL_BASE}/api/marketplace-orders/batch-nfe-check`,
              { orderIds: chunk, force: true }, internalReq);
            const results = br.data?.results || {};
            for (const k of Object.keys(results)) {
              if (results[k]?.nfe_numero) invoices.found_bling += 1;
            }
          } catch (e) {
            const msg = e.response?.data?.error || e.message;
            errors.push({ stage: 'batch-nfe-check', error: msg });
            console.error('[SyncAll batch-nfe-check]', msg);
          }
        }
      } catch (e) {
        console.error('[SyncAll batch-nfe-check loop]', e.message);
      }
    }

    console.log(`[SyncAll] FIM synced=${JSON.stringify(synced)} totals=${JSON.stringify(totals)} invoices=${JSON.stringify(invoices)} errors=${errors.length}`);
    res.json({ success: true, synced, totals, invoices, errors });
  } catch (err) {
    console.error('[SyncAll] erro geral:', err.message, err.stack);
    res.status(500).json({ error: err.message, synced, totals, invoices, errors });
  }
});

// ----------------------------------------------------------------------------
// Sync delta: alternativa enxuta ao sync-all. Para cada conta com token,
// chama o endpoint interno /sync SEM dateFrom/dateTo, o que liga o modo
// incremental (somente pedidos novos/atualizados desde last_orders_sync_at
// com overlap). NÃO dispara fetch-ml-invoices / batch-nfe-check — isso já é
// responsabilidade do cron NFE_AUTO_INTERVAL_MIN (sempre on).
//
// Consumidores: auto-refresh da UI (polling a cada N min) e cron
// ORDERS_AUTO_INTERVAL_MIN abaixo. Os custos são recalculados automaticamente
// em background via applyFreshOrderToDb → computeOrderCostsSafe para cada
// pedido novo/atualizado.
// ----------------------------------------------------------------------------
const runOrdersSyncDeltaCycle = async ({ marketplace = null } = {}) => {
  const INTERNAL_BASE = `http://localhost:${PORT}`;
  const includeMl = !marketplace || marketplace === 'ml';
  const includeShopee = !marketplace || marketplace === 'shopee';
  const mlAccts = includeMl
    ? await new Promise((rs) => db.all(
        `SELECT a.id FROM ml_accounts a
           INNER JOIN api_tokens t ON t.account_id = a.id AND t.provider = 'mercado_livre'
           WHERE t.refresh_token IS NOT NULL AND t.refresh_token != ''`,
        (e, r) => rs(e ? [] : (r || []))))
    : [];
  const shopeeAccts = includeShopee
    ? await new Promise((rs) => db.all(
        `SELECT a.id FROM shopee_accounts a
           INNER JOIN api_tokens t ON t.account_id = a.id AND t.provider = 'shopee'
           WHERE t.access_token IS NOT NULL AND t.access_token != ''`,
        (e, r) => rs(e ? [] : (r || []))))
    : [];
  const internalReq = { headers: internalServiceHeaders() };
  const results = [];
  let totalSynced = 0;

  for (const acc of mlAccts) {
    try {
      const r = await axios.post(`${INTERNAL_BASE}/api/marketplace-orders/sync`,
        { marketplace: 'ml', accountId: acc.id }, internalReq);
      const s = Number(r.data?.synced || 0);
      totalSynced += s;
      results.push({ marketplace: 'ml', accountId: acc.id, synced: s, total: Number(r.data?.total || 0), incremental: !!r.data?.incremental });
    } catch (e) {
      const msg = e.response?.data?.error || e.response?.data?.details || e.message;
      results.push({ marketplace: 'ml', accountId: acc.id, error: msg });
      console.error('[SyncDelta ML]', acc.id, msg);
    }
  }
  for (const acc of shopeeAccts) {
    try {
      const r = await axios.post(`${INTERNAL_BASE}/api/marketplace-orders/sync`,
        { marketplace: 'shopee', accountId: acc.id }, internalReq);
      const s = Number(r.data?.synced || 0);
      totalSynced += s;
      results.push({ marketplace: 'shopee', accountId: acc.id, synced: s, total: Number(r.data?.total || 0) });
    } catch (e) {
      const msg = e.response?.data?.error || e.response?.data?.details || e.message;
      results.push({ marketplace: 'shopee', accountId: acc.id, error: msg });
      console.error('[SyncDelta Shopee]', acc.id, msg);
    }
  }
  return { totalSynced, results };
};

app.post('/api/marketplace-orders/sync-delta', async (req, res) => {
  const { marketplace = null } = req.body || {};
  try {
    const out = await runOrdersSyncDeltaCycle({ marketplace });
    res.json({ success: true, ...out });
  } catch (err) {
    console.error('[SyncDelta] erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Cron sempre on: sincroniza pedidos novos/atualizados para todas as contas
// conectadas no intervalo ORDERS_AUTO_INTERVAL_MIN (default 5 min). Diferente
// de MARKETPLACE_AUTO_INTERVAL_MIN (pipeline completo de NF, opt-in por conta)
// e AUTO_SYNC_INTERVAL_MIN (sync de itens/catálogo), este foca em pedidos.
// Para desligar, use ORDERS_AUTO_INTERVAL_MIN=0.
const ordersAutoMinutes = parseInt(process.env.ORDERS_AUTO_INTERVAL_MIN || '5', 10);
if (ordersAutoMinutes > 0) {
  const runCycle = async () => {
    try {
      const out = await runOrdersSyncDeltaCycle({});
      if (out.totalSynced > 0) {
        console.log(`[AutoOrders] ciclo: ${out.totalSynced} pedido(s) sincronizado(s) em ${out.results.length} conta(s)`);
      }
    } catch (e) {
      console.error('[AutoOrders] loop error:', e.message);
    }
  };
  // Primeiro ciclo após 45s (dá tempo do boot completar e do NFE_AUTO rodar
  // seu primeiro ciclo em 60s) e depois no intervalo.
  setTimeout(runCycle, 45 * 1000);
  setInterval(runCycle, ordersAutoMinutes * 60 * 1000);
  console.log(`[AutoOrders] Habilitado — intervalo de ${ordersAutoMinutes} min`);
}

// ============================================================================
// Nightly backup — endpoints de status, histórico e trigger manual.
// ============================================================================

// Status agregado do backup (usado pelo badge no cabeçalho).
app.get('/api/marketplace-orders/backup-status', async (req, res) => {
  try {
    const get = (sql, params = []) => new Promise((rs) => db.get(sql, params, (e, r) => rs(r || {})));
    const total = (await get('SELECT COUNT(*) AS n FROM marketplace_orders')).n || 0;
    const frozen = (await get('SELECT COUNT(*) AS n FROM marketplace_orders WHERE frozen = 1')).n || 0;
    const hydrated_last_24h = (await get(`SELECT COUNT(*) AS n FROM marketplace_orders WHERE last_hydrated_at >= datetime('now','-24 hours')`)).n || 0;
    const pending = (await get(`SELECT COUNT(*) AS n FROM marketplace_orders WHERE frozen = 0 AND (last_hydrated_at IS NULL OR last_hydrated_at < datetime('now','-20 hours'))`)).n || 0;
    const history_rows = (await get('SELECT COUNT(*) AS n FROM marketplace_orders_history')).n || 0;
    res.json({
      total,
      frozen,
      hydrated_last_24h,
      pending_hydration: pending,
      history_rows,
      last_run: {
        started_at: nightlyBackupLastRun.started_at,
        finished_at: nightlyBackupLastRun.finished_at,
        running: nightlyBackupLastRun.running,
        stats: nightlyBackupLastRun.stats,
      },
      config: {
        enabled: backupConfig.enabled,
        hour_local: backupConfig.hour,
        pace_ms: backupConfig.paceMs,
        batch: backupConfig.batch,
        max_run_min: backupConfig.maxRunMin,
        freeze_after: backupConfig.freezeAfter,
      },
      next_run_at: nightlyBackupLastRun.next_run_at,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Histórico versionado de um pedido. Por padrão devolve apenas metadados;
// passe ?full=1 para incluir o snapshot_json completo de cada versão.
app.get('/api/marketplace-orders/:id/history', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
  const full = String(req.query.full || '') === '1';
  const cols = full
    ? 'id, snapshot_at, source, changed_fields_json, snapshot_hash, snapshot_json'
    : 'id, snapshot_at, source, changed_fields_json, snapshot_hash';
  db.all(
    `SELECT ${cols} FROM marketplace_orders_history WHERE order_id = ? ORDER BY snapshot_at DESC, id DESC LIMIT 500`,
    [id], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const parsed = (rows || []).map(r => ({
        ...r,
        changed_fields: r.changed_fields_json ? (() => { try { return JSON.parse(r.changed_fields_json); } catch (_) { return []; } })() : [],
        snapshot: full && r.snapshot_json ? (() => { try { return JSON.parse(r.snapshot_json); } catch (_) { return null; } })() : undefined,
      }));
      for (const r of parsed) { delete r.changed_fields_json; delete r.snapshot_json; }
      res.json(parsed);
    }
  );
});

// Trigger manual de hidratação de um pedido específico. Útil como fallback
// no card da tela de Pedidos Marketplace quando se suspeita que uma mudança
// recente ainda não foi capturada.
app.post('/api/marketplace-orders/:id/hydrate', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
  try {
    const row = await new Promise((rs) => db.get('SELECT * FROM marketplace_orders WHERE id = ?', [id], (e, r) => rs(r || null)));
    if (!row) return res.status(404).json({ error: 'pedido não encontrado' });
    if (row.frozen) return res.status(409).json({ error: 'pedido congelado — marketplace não devolve mais dados' });
    const fresh = row.marketplace === 'ml'
      ? await fetchMlOrderFull(row)
      : row.marketplace === 'shopee'
        ? await fetchShopeeOrderFull(row)
        : null;
    if (!fresh) return res.status(400).json({ error: 'marketplace não suportado' });
    const result = await applyFreshOrderToDb(row, fresh, 'manual');
    res.json({ success: true, hydrated: true, recorded: !!result?.inserted, snapshot_hash: result?.hash, changed: result?.changed || [] });
  } catch (e) {
    if (e && e.notFound) {
      const row = await new Promise((rs) => db.get('SELECT * FROM marketplace_orders WHERE id = ?', [id], (e2, r) => rs(r || null)));
      if (row) {
        try { await freezeOrder(row, e.message || 'gone'); } catch (_) {}
        return res.status(410).json({ error: 'marketplace retornou 404 — pedido congelado', frozen: true });
      }
      return res.status(404).json({ error: 'pedido desapareceu' });
    }
    res.status(500).json({ error: e.message || 'Erro ao hidratar pedido' });
  }
});

// Configuração do backup noturno — leitura. Usada pela aba "Backup" da tela
// de Configurações para popular o formulário de agendamento.
app.get('/api/marketplace-orders/backup-config', (req, res) => {
  res.json({
    enabled: backupConfig.enabled,
    hour: backupConfig.hour,
    pace_ms: backupConfig.paceMs,
    batch: backupConfig.batch,
    max_run_min: backupConfig.maxRunMin,
    freeze_after: backupConfig.freezeAfter,
    next_run_at: nightlyBackupLastRun.next_run_at,
    running: nightlyBackupLastRun.running,
  });
});

// Atualiza a configuração do backup e reagenda o próximo run imediatamente.
app.put('/api/marketplace-orders/backup-config', async (req, res) => {
  try {
    const body = req.body || {};
    const updates = [];

    if (body.enabled !== undefined) {
      const v = body.enabled ? '1' : '0';
      await setSetting('nightly_backup_enabled', v);
      updates.push(`enabled=${v}`);
    }
    if (body.hour !== undefined) {
      const h = Math.min(23, Math.max(0, parseInt(body.hour, 10) || 0));
      await setSetting('nightly_backup_hour', String(h));
      updates.push(`hour=${h}`);
    }
    if (body.pace_ms !== undefined) {
      const p = Math.min(10000, Math.max(0, parseInt(body.pace_ms, 10) || 0));
      await setSetting('nightly_backup_pace_ms', String(p));
      updates.push(`pace_ms=${p}`);
    }
    if (body.batch !== undefined) {
      const b = Math.min(20000, Math.max(10, parseInt(body.batch, 10) || 100));
      await setSetting('nightly_backup_batch', String(b));
      updates.push(`batch=${b}`);
    }
    if (body.max_run_min !== undefined) {
      const m = Math.min(720, Math.max(5, parseInt(body.max_run_min, 10) || 60));
      await setSetting('nightly_backup_max_run_min', String(m));
      updates.push(`max_run_min=${m}`);
    }
    if (body.freeze_after !== undefined) {
      const f = Math.min(20, Math.max(1, parseInt(body.freeze_after, 10) || 3));
      await setSetting('nightly_freeze_after', String(f));
      updates.push(`freeze_after=${f}`);
    }

    loadBackupConfig();
    rescheduleNightlyBackup();

    res.json({
      success: true,
      updated: updates,
      config: {
        enabled: backupConfig.enabled,
        hour: backupConfig.hour,
        pace_ms: backupConfig.paceMs,
        batch: backupConfig.batch,
        max_run_min: backupConfig.maxRunMin,
        freeze_after: backupConfig.freezeAfter,
        next_run_at: nightlyBackupLastRun.next_run_at,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Erro ao salvar configuração de backup' });
  }
});

// Trigger manual do ciclo completo (útil para testes; normalmente roda via cron).
app.post('/api/marketplace-orders/backup-run', async (req, res) => {
  if (nightlyBackupLastRun.running) return res.status(409).json({ error: 'backup já em execução' });
  const batchSize = parseInt(req.body?.batchSize, 10) || backupConfig.batch;
  const paceMs = req.body?.paceMs !== undefined ? parseInt(req.body.paceMs, 10) : backupConfig.paceMs;
  nightlyBackupWorker({ batchSize, paceMs }).catch(e => console.error('[NightlyBackup] manual run error:', e.message));
  res.json({ success: true, started: true, batchSize, paceMs });
});

// --- List marketplace orders ---
app.get('/api/marketplace-orders', async (req, res) => {
  const { marketplace, accountId, status, search, dateFrom, dateTo, limit: qLimit, offset: qOffset, pipeline_stage, blingAccountId } = req.query;
  try {
    let sql = `SELECT DISTINCT o.* FROM marketplace_orders o`;
    const params = [];
    let hasItemJoin = false;
    if (search) {
      sql += ` LEFT JOIN marketplace_order_items i ON i.order_id = o.id`;
      hasItemJoin = true;
    }
    sql += ` WHERE 1=1`;
    if (marketplace) { sql += ' AND o.marketplace = ?'; params.push(marketplace); }
    if (accountId) { sql += ' AND o.account_id = ?'; params.push(parseInt(accountId, 10)); }
    if (pipeline_stage) { sql += ' AND o.pipeline_stage = ?'; params.push(pipeline_stage); }
    if (blingAccountId) { sql += ' AND o.bling_account_id = ?'; params.push(parseInt(blingAccountId, 10)); }
    if (status) {
      const shippingStatuses = ['delivered', 'shipped', 'in_transit', 'ready_to_ship', 'handling', 'not_delivered'];
      if (shippingStatuses.includes(status)) {
        sql += ' AND o.shipping_status = ?';
      } else {
        sql += ' AND o.status = ?';
      }
      params.push(status);
    }
    const mktDateBounds = marketplaceOrdersDateRangeBounds(dateFrom, dateTo);
    if (mktDateBounds.from) { sql += ' AND o.order_date >= ?'; params.push(mktDateBounds.from); }
    if (mktDateBounds.to) { sql += ' AND o.order_date <= ?'; params.push(mktDateBounds.to); }
    if (search) {
      sql += ' AND (o.buyer_name LIKE ? OR o.buyer_nickname LIKE ? OR o.marketplace_order_id LIKE ?';
      sql += hasItemJoin ? ' OR i.sku LIKE ? OR i.title LIKE ?)' : ')';
      const s = `%${search}%`;
      params.push(s, s, s);
      if (hasItemJoin) params.push(s, s);
    }
    // Count total before applying limit/offset
    const countSql = sql.replace('SELECT DISTINCT o.*', 'SELECT COUNT(DISTINCT o.id) as total');
    const totalRow = await new Promise((resolve, reject) => {
      db.get(countSql, [...params], (err, r) => err ? reject(err) : resolve(r));
    });
    const total = totalRow?.total || 0;

    sql += ' ORDER BY o.order_date DESC';
    const limitVal = parseInt(qLimit, 10) || 50;
    const offsetVal = parseInt(qOffset, 10) || 0;
    sql += ` LIMIT ? OFFSET ?`;
    params.push(limitVal, offsetVal);

    const rows = await new Promise((resolve, reject) => {
      db.all(sql, params, (err, r) => err ? reject(err) : resolve(r || []));
    });

    const orderIds = rows.map(r => r.id);
    let allItems = [];
    if (orderIds.length > 0) {
      const placeholders = orderIds.map(() => '?').join(',');
      allItems = await new Promise((resolve, reject) => {
        db.all(`SELECT * FROM marketplace_order_items WHERE order_id IN (${placeholders})`, orderIds, (err, r) => err ? reject(err) : resolve(r || []));
      });
    }

    const itemsByOrder = {};
    for (const item of allItems) {
      if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];
      if (item.variation_attributes_json) {
        try { item.variation_attributes = JSON.parse(item.variation_attributes_json); } catch { item.variation_attributes = []; }
      }
      itemsByOrder[item.order_id].push(item);
    }

    // Enrich with account names (ml_accounts / shopee_accounts)
    const mlAccRows = await new Promise((resolve) => { db.all('SELECT id, name FROM ml_accounts', (e, r) => resolve(r || [])); });
    const shopeeAccRows = await new Promise((resolve) => { db.all('SELECT id, name FROM shopee_accounts', (e, r) => resolve(r || [])); });
    const mlNames = {}; for (const a of mlAccRows) mlNames[a.id] = a.name;
    const shopeeNames = {}; for (const a of shopeeAccRows) shopeeNames[a.id] = a.name;

    const orders = rows.map(r => {
      let shipping_address = null;
      if (r.shipping_address_json) {
        try { shipping_address = JSON.parse(r.shipping_address_json); } catch {}
      }
      const { shipping_address_json, ...rest } = r;
      const accountName = r.marketplace === 'ml' ? (mlNames[r.account_id] || `Conta ${r.account_id}`) : r.marketplace === 'shopee' ? (shopeeNames[r.account_id] || `Conta ${r.account_id}`) : null;
      return { ...rest, items: itemsByOrder[r.id] || [], shipping_address, account_name: accountName };
    });

    // Enrich items with ml_items data (thumbnail, sku)
    const uniqueItemIds = new Set();
    for (const item of allItems) {
      if (item.marketplace_item_id) uniqueItemIds.add(String(item.marketplace_item_id));
    }
    const mlItemsMap = {};
    if (uniqueItemIds.size > 0) {
      const idsArr = [...uniqueItemIds];
      const ph = idsArr.map(() => '?').join(',');
      const mlRows = await new Promise((resolve, reject) => {
        db.all(`SELECT ml_item_id, title, sku, thumbnail FROM ml_items WHERE ml_item_id IN (${ph})`, idsArr, (e, r) => e ? reject(e) : resolve(r || []));
      });
      for (const m of mlRows) mlItemsMap[m.ml_item_id] = m;

      const mlVars = await new Promise((resolve, reject) => {
        db.all(`SELECT ml_item_id, variation_id, sku, thumbnail, attribute_combinations FROM ml_item_variations WHERE ml_item_id IN (${ph})`, idsArr, (e, r) => e ? reject(e) : resolve(r || []));
      });
      for (const v of mlVars) {
        mlItemsMap[`${v.ml_item_id}_${v.variation_id}`] = v;
      }
    }

    // Apply enrichment to items
    for (const item of allItems) {
      const varKey = item.variation_id ? `${item.marketplace_item_id}_${item.variation_id}` : null;
      const varData = varKey ? mlItemsMap[varKey] : null;
      const itemData = mlItemsMap[item.marketplace_item_id] || null;

      if (!item.thumbnail) {
        item.thumbnail = varData?.thumbnail || itemData?.thumbnail || null;
      }
      if (!item.sku && (varData?.sku || itemData?.sku)) {
        item.sku = varData?.sku || itemData?.sku;
      }
      if ((!item.title || item.title === 'null') && itemData?.title) {
        item.title = itemData.title;
      }
    }

    res.json({ orders, total, limit: limitVal, offset: offsetVal });
  } catch (err) {
    console.error('[MktOrders] List error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Get single marketplace order ---
app.get('/api/marketplace-orders/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.get('SELECT * FROM marketplace_orders WHERE id = ?', [id], (err, order) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!order) return res.status(404).json({ error: 'Pedido não encontrado' });
    db.all('SELECT * FROM marketplace_order_items WHERE order_id = ?', [id], (err2, items) => {
      if (err2) return res.status(500).json({ error: err2.message });
      let shipping_address = null;
      if (order.shipping_address_json) {
        try { shipping_address = JSON.parse(order.shipping_address_json); } catch {}
      }
      const parsedItems = (items || []).map(it => {
        if (it.variation_attributes_json) {
          try { it.variation_attributes = JSON.parse(it.variation_attributes_json); } catch { it.variation_attributes = []; }
        }
        return it;
      });
      const { shipping_address_json, ...rest } = order;
      res.json({ ...rest, shipping_address, items: parsedItems });
    });
  });
});

// Recomputa pipeline_stage para todos os pedidos de uma conta — usado ao fim
// de cada sync em massa (evita chamar updatePipelineStage linha a linha).
async function recomputePipelineForAccount(marketplace, accountId) {
  const rows = await new Promise((resolve) => {
    db.all('SELECT * FROM marketplace_orders WHERE marketplace = ? AND account_id = ?',
      [marketplace, accountId], (e, r) => resolve(r || []));
  });
  for (const row of rows) {
    const stage = computePipelineStage(row);
    if (stage !== row.pipeline_stage) {
      db.run('UPDATE marketplace_orders SET pipeline_stage = ? WHERE id = ?', [stage, row.id]);
    }
  }
}

// ─── Pipeline unificado do integrador ─────────────────────────────────────
// Calcula o estágio do pedido a partir dos campos persistidos. A ideia é
// centralizar a lógica em um único lugar para que sync, send-to-bling, poll,
// upload e fetch-ml sempre deixem `pipeline_stage` coerente.
function computePipelineStage(order) {
  if (!order) return 'pending';
  const status = String(order.status || '').toLowerCase();
  const shipStatus = String(order.shipping_status || '').toLowerCase();

  if (['cancelled', 'canceled', 'cancelled_by_seller', 'cancelled_by_buyer'].includes(status)) return 'cancelled';
  if (shipStatus === 'delivered') return 'delivered';
  if (['shipped', 'in_transit'].includes(shipStatus)) return 'shipped';

  const marketplace = order.marketplace;
  if (marketplace === 'ml') {
    if (order.ml_invoice_key) return 'invoice_authorized';
    if (order.ml_invoice_status === 'processing') return 'invoice_processing';
    if (['ready_to_ship', 'handling'].includes(shipStatus) || status === 'paid') return 'awaiting_invoice';
    return 'pending';
  }

  // Shopee (ou default)
  if (order.nf_uploaded_at) return 'invoice_uploaded';
  if (order.bling_nfe_chave || order.bling_nfe_status === 'generated' || order.bling_nfe_status === 'authorized') return 'invoice_authorized';
  if (order.bling_pedido_id && (!order.bling_nfe_status || order.bling_nfe_status === 'pending' || order.bling_nfe_status === 'processing')) return 'invoice_processing';
  if (['READY_TO_SHIP', 'PROCESSED'].includes(order.status) || status === 'paid') return 'awaiting_invoice';
  return 'pending';
}

// Persiste o estágio calculado e, opcionalmente, limpa ou grava o último erro.
async function updatePipelineStage(orderId, errorMsg) {
  return new Promise((resolve) => {
    db.get('SELECT * FROM marketplace_orders WHERE id = ?', [orderId], (e, row) => {
      if (e || !row) return resolve();
      const stage = computePipelineStage(row);
      if (errorMsg) {
        db.run('UPDATE marketplace_orders SET pipeline_stage = ?, pipeline_last_error = ?, pipeline_last_error_at = CURRENT_TIMESTAMP WHERE id = ?',
          ['error', String(errorMsg).slice(0, 500), orderId], () => resolve());
      } else {
        db.run('UPDATE marketplace_orders SET pipeline_stage = ?, pipeline_last_error = NULL, pipeline_last_error_at = NULL WHERE id = ?',
          [stage, orderId], () => resolve());
      }
    });
  });
}

// Resolve a conta Bling que deve faturar um pedido. Prioridade:
//   1) blingAccountId explicitamente enviado na requisição (override manual);
//   2) ml_accounts.bling_account_id / shopee_accounts.bling_account_id do pedido;
//   3) null → chamador deve responder erro.
async function resolveBlingAccountForOrder(order, explicitId) {
  if (explicitId) return parseInt(explicitId, 10);
  if (!order || !order.marketplace || !order.account_id) return null;
  const table = order.marketplace === 'ml' ? 'ml_accounts'
              : order.marketplace === 'shopee' ? 'shopee_accounts'
              : null;
  if (!table) return null;
  return await new Promise((resolve) => {
    db.get(`SELECT bling_account_id FROM ${table} WHERE id = ?`, [order.account_id], (e, row) => {
      resolve(row && row.bling_account_id ? parseInt(row.bling_account_id, 10) : null);
    });
  });
}

// --- Send order to Bling (create contact + sales order + generate NF-e) ---
app.post('/api/marketplace-orders/:id/send-to-bling', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  let { blingAccountId } = req.body;

  try {
    const order = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM marketplace_orders WHERE id = ?', [id], (e, r) => e ? reject(e) : resolve(r));
    });
    if (!order) return res.status(404).json({ error: 'Pedido não encontrado' });
    if (order.bling_pedido_id) return res.status(409).json({ error: 'Pedido já enviado ao Bling', bling_pedido_id: order.bling_pedido_id });

    blingAccountId = await resolveBlingAccountForOrder(order, blingAccountId);
    if (!blingAccountId) return res.status(400).json({ error: 'Conta Bling não mapeada para esta conta de marketplace. Defina em "APIs Externas" → Mapeamento de faturamento.' });

    const items = await new Promise((resolve, reject) => {
      db.all('SELECT * FROM marketplace_order_items WHERE order_id = ?', [id], (e, r) => e ? reject(e) : resolve(r || []));
    });

    const tokenObj = await refreshTokenIfNeeded(blingAccountId);
    if (!tokenObj || !tokenObj.access_token) return res.status(401).json({ error: 'Não autenticado no Bling' });

    let shippingAddr = null;
    if (order.shipping_address_json) {
      try { shippingAddr = JSON.parse(order.shipping_address_json); } catch {}
    }

    // 1. Create or find contact in Bling
    let contatoId = null;
    const buyerName = order.buyer_name || order.buyer_nickname || 'Cliente';
    const buyerDoc = order.buyer_doc || null;

    if (buyerDoc) {
      try {
        const searchRes = await blingGet(`/contatos?pesquisa=${encodeURIComponent(buyerDoc)}`, tokenObj, {}, blingAccountId);
        const existing = searchRes.data?.data?.[0];
        if (existing && existing.id) contatoId = existing.id;
      } catch {}
    }

    if (!contatoId) {
      try {
        const contatoBody = {
          nome: buyerName.substring(0, 120),
          ...(buyerDoc ? {
            tipoPessoa: buyerDoc.length > 11 ? 'J' : 'F',
            numeroDocumento: buyerDoc
          } : {}),
          ...(order.buyer_email ? { email: order.buyer_email } : {}),
          ...(order.buyer_phone ? { telefone: order.buyer_phone } : {}),
          ...(shippingAddr ? {
            endereco: {
              endereco: shippingAddr.street || '',
              numero: shippingAddr.number || 'S/N',
              bairro: shippingAddr.neighborhood || '',
              cep: (shippingAddr.zip_code || '').replace(/\D/g, ''),
              municipio: shippingAddr.city || '',
              uf: (shippingAddr.state || '').substring(0, 2).toUpperCase()
            }
          } : {})
        };
        const contatoRes = await blingPost('/contatos', contatoBody, tokenObj, blingAccountId);
        contatoId = contatoRes.data?.data?.id;
      } catch (contErr) {
        console.error('[MktOrders] Create contact error:', contErr.response?.data || contErr.message);
      }
    }

    // 2. Create sales order in Bling
    const blingItems = items.map(it => ({
      descricao: (it.title || 'Produto').substring(0, 120),
      ...(it.sku ? { codigo: it.sku } : {}),
      quantidade: it.quantity || 1,
      valor: it.unit_price || 0,
      unidade: 'UN'
    }));

    const mlCnpj = '03007331000141';
    const shopeeCnpj = '02553218000150';
    const intermediadorCnpj = order.marketplace === 'ml' ? mlCnpj : order.marketplace === 'shopee' ? shopeeCnpj : null;
    const intermediadorNome = order.marketplace === 'ml' ? 'EBAZAR.COM.BR LTDA' : order.marketplace === 'shopee' ? 'SHOPEE' : null;

    const pedidoBody = {
      numeroLoja: order.marketplace_order_id,
      data: order.order_date ? order.order_date.substring(0, 10) : new Date().toISOString().substring(0, 10),
      ...(contatoId ? { contato: { id: contatoId } } : {}),
      itens: blingItems,
      ...(order.shipping_cost > 0 ? {
        transporte: {
          frete: order.shipping_cost,
          ...(shippingAddr ? {
            etiqueta: {
              nome: shippingAddr.receiver_name || buyerName,
              endereco: shippingAddr.street || '',
              numero: shippingAddr.number || 'S/N',
              municipio: shippingAddr.city || '',
              uf: (shippingAddr.state || '').substring(0, 2).toUpperCase(),
              cep: (shippingAddr.zip_code || '').replace(/\D/g, ''),
              bairro: shippingAddr.neighborhood || ''
            }
          } : {})
        }
      } : {}),
      ...(intermediadorCnpj ? {
        intermediador: {
          cnpj: intermediadorCnpj,
          nomeUsuario: order.buyer_nickname || buyerName
        }
      } : {})
    };

    console.log('[MktOrders] Creating Bling order:', JSON.stringify({
      orderId: order.marketplace_order_id,
      items: blingItems.length,
      blingAccountId,
      mlAccountId: order.account_id,
      contatoId,
      buyerName,
      buyerDoc,
      pedidoBody: JSON.stringify(pedidoBody).substring(0, 500)
    }));
    const pedidoRes = await blingPost('/pedidos/vendas', pedidoBody, tokenObj, blingAccountId);
    const blingPedidoId = pedidoRes.data?.data?.id;
    console.log('[MktOrders] Bling response:', JSON.stringify(pedidoRes.data?.data || pedidoRes.data).substring(0, 300));

    if (!blingPedidoId) {
      return res.status(500).json({ error: 'Bling não retornou ID do pedido', details: pedidoRes.data });
    }

    // 3. Generate NF-e from the sales order
    let blingNfeId = null;
    let blingNfeStatus = 'pending';
    try {
      const nfeRes = await blingPost(`/pedidos/vendas/${blingPedidoId}/gerar-nfe`, {}, tokenObj, blingAccountId);
      blingNfeId = nfeRes.data?.data?.id ? String(nfeRes.data.data.id) : null;
      blingNfeStatus = blingNfeId ? 'generated' : 'error';
      console.log('[MktOrders] NF-e generated:', blingNfeId);
    } catch (nfeErr) {
      console.error('[MktOrders] NF-e generation error:', nfeErr.response?.data || nfeErr.message);
      blingNfeStatus = 'error';
    }

    // 4. Update order in database
    await new Promise((resolve) => {
      db.run(`UPDATE marketplace_orders SET bling_pedido_id = ?, bling_nfe_id = ?, bling_nfe_status = ?, bling_account_id = ?, status = 'sent_to_bling' WHERE id = ?`,
        [String(blingPedidoId), blingNfeId, blingNfeStatus, blingAccountId, id], () => resolve());
    });
    await updatePipelineStage(id, null);

    // 5. Polling síncrono: aguarda a NFe ficar autorizada (com XML) para
    // em seguida, no caso Shopee, subir o XML automaticamente. Se estourar
    // o timeout ou faltar XML, o cron de safety net termina mais tarde.
    let finalStatus = blingNfeStatus;
    let finalNumero = null;
    let finalChave = null;
    let finalSerie = null;
    let hasXml = false;
    let uploadedToShopee = false;
    let pendingUpload = false;
    let pollErrorMsg = null;

    if (blingNfeId) {
      const pollDeadline = Date.now() + 60 * 1000;
      const pollStep = 3000;
      while (Date.now() < pollDeadline) {
        const current = await new Promise((resolve) => {
          db.get('SELECT * FROM marketplace_orders WHERE id = ?', [id], (e, r) => resolve(r || null));
        });
        if (!current) break;
        try {
          const r = await pollBlingNfe(current);
          if (r.updated) {
            finalStatus = r.status || finalStatus;
            finalNumero = r.numero || finalNumero;
            finalChave = r.chave || finalChave;
            finalSerie = r.serie || finalSerie;
            hasXml = !!r.hasXml;
          }
        } catch (pe) {
          pollErrorMsg = pe.message;
        }
        if (finalStatus === 'authorized' && hasXml) break;
        await new Promise(r => setTimeout(r, pollStep));
      }

      // 6. Shopee: sobe o XML automaticamente quando tudo estiver pronto.
      const current = await new Promise((resolve) => {
        db.get('SELECT * FROM marketplace_orders WHERE id = ?', [id], (e, r) => resolve(r || null));
      });
      if (current && current.marketplace === 'shopee' && current.bling_nfe_xml && current.bling_nfe_numero && !current.nf_uploaded_at) {
        try {
          const up = await axios.post(
            `http://localhost:${PORT}/api/marketplace-orders/${id}/upload-invoice-shopee`,
            {},
            { headers: internalServiceHeaders(), timeout: 30000 }
          );
          uploadedToShopee = !!up.data?.success;
        } catch (ue) {
          pendingUpload = true;
          console.error('[MktOrders] auto upload Shopee error:', ue.response?.data?.error || ue.message);
        }
      } else if (current && current.marketplace === 'shopee' && !current.nf_uploaded_at) {
        pendingUpload = true;
      }
    }

    res.json({
      success: true,
      bling_pedido_id: blingPedidoId,
      bling_nfe_id: blingNfeId,
      bling_nfe_status: finalStatus,
      bling_nfe_numero: finalNumero,
      bling_nfe_chave: finalChave,
      bling_nfe_serie: finalSerie,
      has_xml: hasXml,
      uploaded_to_shopee: uploadedToShopee,
      pending_upload: pendingUpload,
      poll_error: pollErrorMsg,
    });
  } catch (err) {
    const errData = err.response?.data;
    const errStatus = err.response?.status;
    console.error(`[MktOrders] Send to Bling error (HTTP ${errStatus}):`, JSON.stringify(errData || err.message));
    console.error(`[MktOrders] Order ID: ${id}, Bling Account: ${req.body.blingAccountId}`);
    db.run(`UPDATE marketplace_orders SET bling_nfe_status = 'error', status = 'error' WHERE id = ?`, [id]);
    const errorMsg = errData?.error?.message || errData?.error?.description || errData?.error || err.message;
    await updatePipelineStage(id, errorMsg);
    res.status(500).json({ error: `Erro ao enviar para Bling: ${errorMsg}`, details: errData });
  }
});

// --- Bulk send orders to Bling ---
app.post('/api/marketplace-orders/send-to-bling-bulk', async (req, res) => {
  const { orderIds, blingAccountId } = req.body;
  if (!Array.isArray(orderIds) || !orderIds.length) {
    return res.status(400).json({ error: 'orderIds (array) obrigatório' });
  }

  const results = { sent: 0, errors: [], skipped: 0 };

  for (const orderId of orderIds) {
    try {
      const order = await new Promise((resolve) => {
        db.get('SELECT id, bling_pedido_id FROM marketplace_orders WHERE id = ?', [orderId], (e, r) => resolve(r || null));
      });
      if (!order) { results.errors.push({ id: orderId, error: 'Não encontrado' }); continue; }
      if (order.bling_pedido_id) { results.skipped++; continue; }

      // blingAccountId é opcional: o endpoint singular resolve pela conta-marketplace
      // quando não informado. Enviamos só quando o usuário quer forçar um override.
      const body = blingAccountId ? { blingAccountId } : {};
      // Timeout alto: send-to-bling agora faz polling (até 60s) + upload Shopee (até 30s).
      const resp = await axios.post(`http://localhost:${PORT}/api/marketplace-orders/${orderId}/send-to-bling`, body,
        { headers: internalServiceHeaders(), timeout: 120000 });
      if (resp.data?.success) results.sent++;
      else results.errors.push({ id: orderId, error: resp.data?.error || 'Erro desconhecido' });
    } catch (err) {
      results.errors.push({ id: orderId, error: err.response?.data?.error || err.message });
    }
  }

  res.json(results);
});

// ─── M4: busca NFe do pedido no Mercado Livre ────────────────────────────
// A API do ML tem TRÊS rotas distintas para descobrir a NFe de um pedido:
//
//   A) /shipments/{shipment_id}/invoice_data?siteId=MLB   ← FLUXO ERP (BLING)
//      NFe IMPORTADA pelo seller via API (Bling/Tiny/etc.) para liberar a
//      etiqueta em envios drop_off, xd_drop_off, cross_docking e xd_same_day.
//      Retorna fiscal_key (chave de 44 dígitos), invoice_number, invoice_serie,
//      invoice_amount, invoice_date e status ("approved"). Este é o caminho
//      principal para sellers que emitem NFe fora do ML.
//      Docs: https://developers.mercadolivre.com.br/pt_br/importar-nota-fiscal
//
//   B) /users/{user_id}/invoices/...  → NFe EMITIDA PELO ML (Faturador).
//      Só existe se o seller tiver opted-in no Faturador (Full e outros).
//      Retorna invoice_key (chave da NFe), número, status, xml_location,
//      danfe_location, issuer, receiver.
//      Docs: https://developers.mercadolivre.com.br/pt_br/api-fiscal-faturamento-de-venda
//
//   C) /packs/{pack_id}/fiscal_documents → UPLOAD de NFe pelo seller.
//      Quando o seller carrega o XML da NFe (que emitiu fora do ML) para
//      COMPARTILHAR com o comprador. O GET lista apenas {id, date, file_type,
//      filename}; para obter chave/número precisamos BAIXAR o XML e extrair.
//      Docs: https://developers.mercadolivre.com.br/pt_br/anexar-nota-fiscal
//
// Tentamos A, B e (como último recurso) C nessa ordem.
app.post('/api/marketplace-orders/:id/fetch-ml-invoice', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const order = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM marketplace_orders WHERE id = ?', [id], (e, r) => e ? reject(e) : resolve(r));
    });
    if (!order) return res.status(404).json({ error: 'Pedido não encontrado' });
    if (order.marketplace !== 'ml') return res.status(400).json({ error: 'Só disponível para pedidos Mercado Livre' });

    const accountId = order.account_id;
    if (!accountId) return res.status(400).json({ error: 'Pedido sem account_id, não é possível consultar o ML' });
    if (!order.marketplace_order_id) return res.status(400).json({ error: 'Pedido sem marketplace_order_id' });

    // Precisamos do ml_user_id (seller) para chamar /users/{user_id}/invoices/…
    const creds = await getMLCredentials(accountId);
    let mlUserId = creds?.mlUserId;
    if (!mlUserId) {
      try {
        const me = await mlApiGet('/users/me', accountId);
        mlUserId = String(me.id);
        db.run('UPDATE ml_accounts SET ml_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [mlUserId, accountId]);
      } catch (eMe) {
        return res.status(424).json({ error: 'Não foi possível identificar o seller no ML', details: eMe.message });
      }
    }

    const triedPaths = [];

    // ── Estratégia A: /shipments/{id}/invoice_data ────────────────────────
    // NFe importada via API pelo seller (Bling/Tiny/outros ERPs) no fluxo de
    // envios drop_off, xd_drop_off, cross_docking, xd_same_day. A resposta é
    // um objeto único com {fiscal_key, invoice_number, invoice_serie,
    // invoice_amount, invoice_date, status: 'approved'|...}.
    let importedInvoice = null;
    if (order.shipping_id) {
      const importPath = `/shipments/${encodeURIComponent(order.shipping_id)}/invoice_data?siteId=MLB`;
      triedPaths.push(importPath);
      try {
        const resp = await mlApiGet(importPath, accountId);
        const fiscalKey = resp && (resp.fiscal_key || resp.fiscalKey || resp.access_key);
        if (fiscalKey && String(fiscalKey).replace(/\D/g, '').length >= 40) {
          importedInvoice = resp;
          console.log(`[MktOrders] fetch-ml-invoice: NFe importada via /shipments/${order.shipping_id}/invoice_data (chave=${fiscalKey})`);
        } else if (resp) {
          console.log(`[MktOrders] fetch-ml-invoice: /shipments/${order.shipping_id}/invoice_data respondeu mas sem fiscal_key:`, JSON.stringify(resp).slice(0, 300));
        }
      } catch (err) {
        const status = err.response?.status;
        if (status === 404) {
          console.log(`[MktOrders] fetch-ml-invoice: 404 em shipments/${order.shipping_id}/invoice_data — nenhuma NFe importada para o envio`);
        } else if (status === 403) {
          console.log(`[MktOrders] fetch-ml-invoice: 403 em shipments/${order.shipping_id}/invoice_data — app sem permissão`);
        } else if (status === 400) {
          console.log(`[MktOrders] fetch-ml-invoice: 400 em shipments/${order.shipping_id}/invoice_data — status do envio não suporta invoice_data`);
        } else {
          throw err;
        }
      }
    }

    // ── Estratégia B: Faturador ML (NFe emitida PELO Mercado Livre) ───────
    // Só funciona se o seller tem opt-in no Faturador. Tentamos: 1) por
    // order_id; 2) por shipment_id (comum em Full).
    const attempts = [
      { label: 'invoices/orders', path: `/users/${mlUserId}/invoices/orders/${encodeURIComponent(order.marketplace_order_id)}` },
    ];
    if (order.shipping_id) {
      attempts.push({ label: 'invoices/shipments', path: `/users/${mlUserId}/invoices/shipments/${encodeURIComponent(order.shipping_id)}` });
    }

    let invoice = null;
    if (!importedInvoice) {
      for (const att of attempts) {
        triedPaths.push(att.path);
        try {
          const resp = await mlApiGet(att.path, accountId);
          const arr = Array.isArray(resp) ? resp : (resp?.results || (resp ? [resp] : []));
          const authorized = arr.find(x => x && (x.status === 'authorized' || x.invoice_key || x.access_key));
          if (authorized) {
            invoice = authorized;
            console.log(`[MktOrders] fetch-ml-invoice: NFe encontrada via Faturador ML em ${att.label}`);
            break;
          }
        } catch (err) {
          const status = err.response?.status;
          if (status === 404) {
            console.log(`[MktOrders] fetch-ml-invoice: 404 em ${att.label} — seller não usa Faturador ou nota não emitida pelo ML`);
            continue;
          }
          if (status === 403) {
            console.log(`[MktOrders] fetch-ml-invoice: 403 em ${att.label} — app/seller não tem permissão para invoices`);
            continue;
          }
          throw err;
        }
      }
    }

    // ── Estratégia C: /packs/{pack_id}/fiscal_documents (upload pelo seller)─
    // Se nem A nem B retornaram, pode ser que o seller tenha ANEXADO o XML
    // diretamente para o comprador (sem passar por invoice_data). Listamos
    // os documentos e, se houver XML, baixamos e extraímos a chave.
    let uploadedDocs = null;
    let parsedFromXml = null;
    if (!importedInvoice && !invoice) {
      const packId = order.pack_id || order.marketplace_order_id;
      const packsPath = `/packs/${encodeURIComponent(packId)}/fiscal_documents`;
      triedPaths.push(packsPath);
      try {
        const r = await mlApiGet(packsPath, accountId);
        if (r && Array.isArray(r.fiscal_documents) && r.fiscal_documents.length > 0) {
          uploadedDocs = r.fiscal_documents;
          console.log(`[MktOrders] fetch-ml-invoice: ${uploadedDocs.length} doc(s) carregado(s) via /packs para pack_id=${packId}`);

          const xmlDoc = uploadedDocs.find(d => /xml/i.test(d.file_type || '') || /\.xml$/i.test(d.filename || ''));
          if (xmlDoc?.id) {
            try {
              const xmlBuf = await mlApiGetBinary(`/packs/${encodeURIComponent(packId)}/fiscal_documents/${encodeURIComponent(xmlDoc.id)}`, accountId);
              const xmlStr = xmlBuf.toString('utf8');
              parsedFromXml = parseNfeXmlFields(xmlStr);
              if (parsedFromXml?.key) {
                console.log(`[MktOrders] fetch-ml-invoice: chave extraída do XML carregado em /packs (chave=${parsedFromXml.key})`);
              } else {
                console.log(`[MktOrders] fetch-ml-invoice: XML baixado de /packs mas sem chave parseável`);
              }
            } catch (errDl) {
              console.log(`[MktOrders] fetch-ml-invoice: falha ao baixar XML de /packs/${packId}/fiscal_documents/${xmlDoc.id}:`, errDl.response?.data || errDl.message);
            }
          }
        }
      } catch (err) {
        const st = err.response?.status;
        if (st !== 404 && st !== 400) {
          console.log(`[MktOrders] fetch-ml-invoice: erro em ${packsPath}:`, err.response?.data || err.message);
        }
      }
    }

    // ─── Persistência do resultado ────────────────────────────────────────

    // Caso 1: NFe importada via ERP (fluxo Bling/ERP).
    if (importedInvoice) {
      const key = String(importedInvoice.fiscal_key || importedInvoice.fiscalKey || importedInvoice.access_key || '').replace(/\D/g, '') || null;
      const number = importedInvoice.invoice_number || importedInvoice.number || null;
      const serie = importedInvoice.invoice_serie || importedInvoice.invoice_series || importedInvoice.serie || null;
      const issuedAt = importedInvoice.invoice_date || importedInvoice.date_created || null;
      const invoiceId = importedInvoice.id ? String(importedInvoice.id) : null;
      const statusMap = { approved: 'authorized' };
      const rawStatus = String(importedInvoice.status || '').toLowerCase();
      const dbStatus = statusMap[rawStatus] || rawStatus || 'authorized';

      await new Promise((resolve) => {
        db.run(`UPDATE marketplace_orders SET
            ml_invoice_number = COALESCE(?, ml_invoice_number),
            ml_invoice_key = COALESCE(?, ml_invoice_key),
            ml_invoice_serie = COALESCE(?, ml_invoice_serie),
            ml_invoice_status = ?,
            ml_invoice_issued_at = COALESCE(?, ml_invoice_issued_at),
            ml_invoice_fetched_at = CURRENT_TIMESTAMP
          WHERE id = ?`,
          [number, key, serie, dbStatus, issuedAt, id], () => resolve());
      });
      await updatePipelineStage(id, null);

      return res.json({
        success: true,
        source: 'imported_invoice_data',
        ml_invoice_id: invoiceId,
        ml_invoice_number: number,
        ml_invoice_key: key,
        ml_invoice_serie: serie,
        ml_invoice_amount: importedInvoice.invoice_amount || null,
      });
    }

    // Caso 2: NFe do Faturador ML encontrada.
    if (invoice) {
      const key = invoice.invoice_key || invoice.access_key || null;
      const number = invoice.number || invoice.invoice_number || null;
      const serie = invoice.series || invoice.serie || null;
      const xmlUrl = invoice.xml_location ? `https://api.mercadolibre.com${invoice.xml_location}` : null;
      const pdfUrl = invoice.danfe_location ? `https://api.mercadolibre.com${invoice.danfe_location}` : null;
      const issuedAt = invoice.date_created || invoice.issue_date || null;
      const invoiceId = invoice.id ? String(invoice.id) : null;

      await new Promise((resolve) => {
        db.run(`UPDATE marketplace_orders SET
            ml_invoice_number = COALESCE(?, ml_invoice_number),
            ml_invoice_key = COALESCE(?, ml_invoice_key),
            ml_invoice_serie = COALESCE(?, ml_invoice_serie),
            ml_invoice_xml_url = COALESCE(?, ml_invoice_xml_url),
            ml_invoice_pdf_url = COALESCE(?, ml_invoice_pdf_url),
            ml_invoice_status = 'authorized',
            ml_invoice_issued_at = COALESCE(?, ml_invoice_issued_at),
            ml_invoice_fetched_at = CURRENT_TIMESTAMP
          WHERE id = ?`,
          [number, key, serie, xmlUrl, pdfUrl, issuedAt, id], () => resolve());
      });
      await updatePipelineStage(id, null);

      return res.json({
        success: true,
        source: 'faturador',
        ml_invoice_id: invoiceId,
        ml_invoice_number: number,
        ml_invoice_key: key,
        ml_invoice_serie: serie,
        ml_invoice_xml_url: xmlUrl,
        ml_invoice_pdf_url: pdfUrl,
      });
    }

    // Caso 3: XML do upload foi baixado e parseado com sucesso.
    if (parsedFromXml?.key) {
      await new Promise((resolve) => {
        db.run(`UPDATE marketplace_orders SET
            ml_invoice_number = COALESCE(?, ml_invoice_number),
            ml_invoice_key = COALESCE(?, ml_invoice_key),
            ml_invoice_serie = COALESCE(?, ml_invoice_serie),
            ml_invoice_status = 'uploaded',
            ml_invoice_issued_at = COALESCE(?, ml_invoice_issued_at),
            ml_invoice_fetched_at = CURRENT_TIMESTAMP
          WHERE id = ?`,
          [parsedFromXml.number, parsedFromXml.key, parsedFromXml.serie, parsedFromXml.issuedAt, id], () => resolve());
      });
      await updatePipelineStage(id, null);

      return res.json({
        success: true,
        source: 'packs_uploaded_xml',
        ml_invoice_number: parsedFromXml.number,
        ml_invoice_key: parsedFromXml.key,
        ml_invoice_serie: parsedFromXml.serie,
      });
    }

    // Caso 4: Apenas listagem sem XML parseável (último recurso) — registra sinal.
    if (uploadedDocs) {
      const xmlDoc = uploadedDocs.find(d => /xml/i.test(d.file_type || '') || /xml/i.test(d.filename || ''));
      await new Promise((resolve) => {
        db.run(`UPDATE marketplace_orders SET
            ml_invoice_status = 'uploaded_only',
            ml_invoice_fetched_at = CURRENT_TIMESTAMP
          WHERE id = ?`, [id], () => resolve());
      });
      return res.json({
        success: true,
        source: 'packs_uploaded',
        found: uploadedDocs.length,
        message: 'Documentos carregados pelo seller encontrados, mas o XML não pôde ser parseado para extrair a chave.',
        upload_ids: uploadedDocs.map(d => d.id),
        xml_upload_id: xmlDoc?.id || null,
      });
    }

    // Caso 5: Nada encontrado em nenhuma rota.
    await new Promise((resolve) => {
      db.run('UPDATE marketplace_orders SET ml_invoice_status = ?, ml_invoice_fetched_at = CURRENT_TIMESTAMP WHERE id = ?',
        ['pending', id], () => resolve());
    });
    await updatePipelineStage(id, null);
    return res.status(404).json({
      success: false,
      found: 0,
      error: 'NFe não encontrada na API do Mercado Livre',
      message: 'Nenhuma NFe encontrada em /shipments/{id}/invoice_data, /users/{id}/invoices/... nem /packs/{id}/fiscal_documents. Se a NFe já aparece no painel do ML, ela pode ainda não ter propagado (aguarde alguns minutos) ou foi enviada manualmente pelo seller direto na interface.',
      tried: triedPaths,
    });
  } catch (err) {
    const msg = err.response?.data?.message || err.message || 'Erro desconhecido';
    await updatePipelineStage(id, msg);
    console.error('[MktOrders] fetch-ml-invoice error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Erro ao buscar NFe do Mercado Livre', details: msg });
  }
});

// Busca em massa. Aceita:
//   - { orderIds: [..] } → usa esses IDs;
//   - { accountId, dateFrom?, dateTo? } → busca todos os pedidos ML da conta
//     sem chave de NFe ainda.
app.post('/api/marketplace-orders/fetch-ml-invoices', async (req, res) => {
  const { orderIds, accountId, dateFrom, dateTo } = req.body || {};
  try {
    let ids = Array.isArray(orderIds) && orderIds.length ? orderIds.map(n => parseInt(n, 10)) : null;
    if (!ids) {
      if (!accountId) return res.status(400).json({ error: 'orderIds ou accountId obrigatório' });
      const filters = ['marketplace = ?', 'account_id = ?', '(ml_invoice_key IS NULL OR ml_invoice_key = "")'];
      const params = ['ml', accountId];
      if (dateFrom) { filters.push('order_date >= ?'); params.push(dateFrom); }
      if (dateTo) { filters.push('order_date <= ?'); params.push(dateTo); }
      const rows = await new Promise((resolve) => {
        db.all(`SELECT id FROM marketplace_orders WHERE ${filters.join(' AND ')}`, params, (e, r) => resolve(r || []));
      });
      ids = rows.map(r => r.id);
    }
    if (!ids.length) return res.json({ success: true, processed: 0, updated: 0, errors: [] });

    const results = { processed: 0, updated: 0, empty: 0, errors: [] };
    await mapWithConcurrency(ids, 4, async (orderId) => {
      try {
        const resp = await axios.post(`http://localhost:${PORT}/api/marketplace-orders/${orderId}/fetch-ml-invoice`, {},
          { headers: internalServiceHeaders() });
        results.processed++;
        if (resp.data?.ml_invoice_key) results.updated++;
        else results.empty++;
      } catch (err) {
        results.errors.push({ id: orderId, error: err.response?.data?.error || err.message });
      }
    });
    res.json({ success: true, ...results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── M5: Poll NFe no Bling + upload para Shopee ────────────────────────────
// Helper Bling: devolve o estado atual da NFe e, quando autorizada, materializa
// o XML/PDF localmente (XML fica em marketplace_orders.bling_nfe_xml para ser
// servido via /invoice.xml — Shopee precisa de URL pública).
async function pollBlingNfe(order) {
  if (!order) throw new Error('Pedido não encontrado');
  if (!order.bling_nfe_id || !order.bling_account_id) {
    return { updated: false, reason: 'sem bling_nfe_id' };
  }
  const tokenObj = await refreshTokenIfNeeded(order.bling_account_id);
  if (!tokenObj?.access_token) throw new Error('Não autenticado no Bling');
  const resp = await blingGet(`/nfe/${order.bling_nfe_id}`, tokenObj, {}, order.bling_account_id);
  const nfe = resp.data?.data;
  if (!nfe) throw new Error('NFe não encontrada no Bling');

  // Bling situacao.valor: 1=Pendente 2=Enviada 3=Autorizada 4=Cancelada 5=Denegada ...
  const rawSituacao = nfe.situacao?.valor ?? nfe.situacao ?? null;
  const situacaoLabel = {
    1: 'pending', 2: 'processing', 3: 'authorized', 4: 'cancelled', 5: 'denied', 6: 'denied',
    'pendente': 'pending', 'emitida': 'authorized', 'autorizada': 'authorized',
  }[rawSituacao] || (rawSituacao != null ? String(rawSituacao) : 'processing');

  const numero = nfe.numero ? String(nfe.numero) : null;
  const chave = nfe.chaveAcesso ? String(nfe.chaveAcesso) : null;
  const serie = nfe.serie ? String(nfe.serie) : null;
  const xml = nfe.xml || null;
  const pdfUrl = nfe.linkDanfe || nfe.link || null;

  await new Promise((resolve) => {
    db.run(`UPDATE marketplace_orders SET
        bling_nfe_status = ?,
        bling_nfe_numero = COALESCE(?, bling_nfe_numero),
        bling_nfe_chave = COALESCE(?, bling_nfe_chave),
        bling_nfe_serie = COALESCE(?, bling_nfe_serie),
        bling_nfe_xml = COALESCE(?, bling_nfe_xml),
        bling_nfe_pdf_url = COALESCE(?, bling_nfe_pdf_url)
      WHERE id = ?`,
      [situacaoLabel, numero, chave, serie, xml, pdfUrl, order.id], () => resolve());
  });
  await updatePipelineStage(order.id, null);
  return { updated: true, status: situacaoLabel, numero, chave, serie, pdfUrl, hasXml: !!xml };
}

app.post('/api/marketplace-orders/:id/poll-bling-nfe', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const order = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM marketplace_orders WHERE id = ?', [id], (e, r) => e ? reject(e) : resolve(r));
    });
    if (!order) return res.status(404).json({ error: 'Pedido não encontrado' });
    const result = await pollBlingNfe(order);
    res.json({ success: true, ...result });
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    await updatePipelineStage(id, msg);
    res.status(500).json({ error: 'Erro ao consultar NFe no Bling', details: msg });
  }
});

// Bulk poll: aceita { orderIds } ou { accountId }.
app.post('/api/marketplace-orders/poll-bling-nfes', async (req, res) => {
  const { orderIds, accountId } = req.body || {};
  try {
    let rows;
    if (Array.isArray(orderIds) && orderIds.length) {
      const placeholders = orderIds.map(() => '?').join(',');
      rows = await new Promise((resolve) => {
        db.all(`SELECT * FROM marketplace_orders WHERE id IN (${placeholders}) AND bling_nfe_id IS NOT NULL`, orderIds, (e, r) => resolve(r || []));
      });
    } else if (accountId) {
      rows = await new Promise((resolve) => {
        db.all(`SELECT * FROM marketplace_orders WHERE account_id = ? AND bling_nfe_id IS NOT NULL
                  AND (bling_nfe_status IS NULL OR bling_nfe_status IN ('pending','processing'))`,
          [accountId], (e, r) => resolve(r || []));
      });
    } else {
      return res.status(400).json({ error: 'orderIds ou accountId obrigatório' });
    }

    const results = { processed: 0, authorized: 0, errors: [] };
    await mapWithConcurrency(rows, 4, async (order) => {
      try {
        const r = await pollBlingNfe(order);
        results.processed++;
        if (r.status === 'authorized') results.authorized++;
      } catch (err) {
        results.errors.push({ id: order.id, error: err.message });
      }
    });
    res.json({ success: true, ...results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rota pública autenticada pelo token de uso único — Shopee precisa de uma URL
// pública para baixar o XML da NFe (upload_invoice_doc). Não exige JWT.
app.get('/api/marketplace-orders/:id/invoice.xml', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const token = req.query.token || '';
  if (!token) return res.status(401).send('token obrigatório');
  try {
    const order = await new Promise((resolve) => {
      db.get('SELECT invoice_public_token, bling_nfe_xml FROM marketplace_orders WHERE id = ?', [id], (e, r) => resolve(r || null));
    });
    if (!order) return res.status(404).send('Pedido não encontrado');
    if (!order.invoice_public_token || order.invoice_public_token !== token) return res.status(403).send('token inválido');
    if (!order.bling_nfe_xml) return res.status(404).send('XML não disponível');
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.send(order.bling_nfe_xml);
  } catch (err) {
    res.status(500).send('Erro ao servir XML');
  }
});

// Upload do XML da NFe para a Shopee (upload_invoice_doc). Só faz sentido
// quando já temos bling_nfe_xml salvo (M5) e o pedido é Shopee.
app.post('/api/marketplace-orders/:id/upload-invoice-shopee', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const order = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM marketplace_orders WHERE id = ?', [id], (e, r) => e ? reject(e) : resolve(r));
    });
    if (!order) return res.status(404).json({ error: 'Pedido não encontrado' });
    if (order.marketplace !== 'shopee') return res.status(400).json({ error: 'Só disponível para pedidos Shopee' });
    if (order.nf_uploaded_at) return res.status(409).json({ error: 'NFe já enviada ao Shopee', uploaded_at: order.nf_uploaded_at });
    if (!order.bling_nfe_xml || !order.bling_nfe_numero) {
      return res.status(400).json({ error: 'NFe ainda não disponível. Rode "Atualizar status NFe" antes.' });
    }

    // Gera token público one-time caso ainda não exista.
    let token = order.invoice_public_token;
    if (!token) {
      token = crypto.randomBytes(24).toString('hex');
      await new Promise((resolve) => {
        db.run('UPDATE marketplace_orders SET invoice_public_token = ? WHERE id = ?', [token, id], () => resolve());
      });
    }

    const publicBase = process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || '';
    if (!publicBase) {
      return res.status(400).json({ error: 'PUBLIC_BASE_URL não configurado — Shopee precisa de URL pública para o XML.' });
    }
    const invoiceDocUrl = `${publicBase.replace(/\/$/, '')}/api/marketplace-orders/${id}/invoice.xml?token=${token}`;

    const payload = {
      ordersn: order.marketplace_order_id,
      file_type: 'XML',
      invoice_number: order.bling_nfe_numero,
      invoice_doc_url: invoiceDocUrl,
    };
    const resp = await shopeeApiPost('/api/v2/order/upload_invoice_doc', payload, order.account_id);
    if (resp?.error && resp.error !== '') {
      throw new Error(`${resp.error}: ${resp.message || ''}`);
    }

    await new Promise((resolve) => {
      db.run('UPDATE marketplace_orders SET nf_uploaded_at = CURRENT_TIMESTAMP, nf_uploaded_response = ? WHERE id = ?',
        [JSON.stringify(resp).slice(0, 4000), id], () => resolve());
    });
    await updatePipelineStage(id, null);

    res.json({ success: true, invoice_doc_url: invoiceDocUrl, response: resp });
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    await updatePipelineStage(id, msg);
    console.error('[MktOrders] upload-invoice-shopee error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Erro ao enviar NFe ao Shopee', details: msg });
  }
});

// ─── Etiquetas de envio (ML + Shopee) ────────────────────────────────────
// Retorna um Buffer PDF + filename sugerido para um pedido.
async function buildShippingLabelForOrder(order) {
  if (!order) throw new Error('Pedido não encontrado');
  if (order.marketplace === 'ml') {
    const shipmentId = order.shipping_id;
    if (!shipmentId) throw new Error('Pedido ML sem shipment_id (não elegível para etiqueta — provável Flex/Retirada)');
    if (!order.account_id) throw new Error('Pedido ML sem account_id (não é possível autenticar)');
    // Valida token ANTES para dar erro amigável em vez de "Token ML indisponível" genérico.
    const tokenCheck = await refreshMLTokenIfNeeded(order.account_id);
    if (!tokenCheck) {
      const accErr = new Error(`Conta ML #${order.account_id} sem token válido — reautorize em APIs Externas`);
      accErr.statusCode = 424;
      throw accErr;
    }
    // A rota aceita múltiplos ids separados por vírgula; response_type=pdf retorna PDF.
    // (savePdf=Y removido — está causando 400 em algumas contas/shipments).
    try {
      const pdf = await mlApiGetBinary(`/shipment_labels?shipment_ids=${shipmentId}&response_type=pdf`, order.account_id);
      return { buffer: pdf, filename: `ml-${order.marketplace_order_id}.pdf`, contentType: 'application/pdf' };
    } catch (e) {
      // Se ML recusa response_type=pdf (alguns modos), tenta zpl e deixa o user imprimir depois.
      if (e.response?.status === 400) {
        const detail = e.response?.data ? (typeof e.response.data === 'string' ? e.response.data : JSON.stringify(e.response.data)) : '';
        throw new Error(`ML recusou etiqueta (400) para shipment ${shipmentId}${detail ? ': ' + detail.slice(0, 200) : ''}`);
      }
      throw e;
    }
  }
  if (order.marketplace === 'shopee') {
    // Tenta create → poll (get_result) → download. A Shopee aceita algumas chamadas
    // duplicadas (retorna "already exists"), então o retry é seguro.
    const orderSn = order.marketplace_order_id;
    const packageNumber = order.shipping_id || undefined;
    const docTypes = ['THERMAL_AIR_WAYBILL', 'NORMAL_AIR_WAYBILL'];
    let docType = null;
    let createErr = null;
    for (const t of docTypes) {
      try {
        const body = {
          order_list: [packageNumber ? { order_sn: orderSn, package_number: packageNumber, shipping_document_type: t }
                                     : { order_sn: orderSn, shipping_document_type: t }],
          shipping_document_type: t,
        };
        const r = await shopeeApiPost('/api/v2/logistics/create_shipping_document', body, order.account_id);
        // result_list[0].fail_message === 'already exist' também vale
        const first = r?.response?.result_list?.[0];
        if (first && !first.fail_error && !first.fail_message || /already/i.test(first?.fail_message || '')) {
          docType = t; break;
        }
        createErr = new Error(first?.fail_message || first?.fail_error || 'Falha ao criar documento');
      } catch (e) { createErr = e; }
    }
    if (!docType) throw createErr || new Error('Não foi possível criar etiqueta Shopee');

    // Polling do status até READY (até ~15s).
    const maxTries = 10;
    for (let i = 0; i < maxTries; i++) {
      const rr = await shopeeApiPost('/api/v2/logistics/get_shipping_document_result', {
        order_list: [packageNumber ? { order_sn: orderSn, package_number: packageNumber, shipping_document_type: docType }
                                   : { order_sn: orderSn, shipping_document_type: docType }],
      }, order.account_id);
      const info = rr?.response?.result_list?.[0];
      if (info?.status === 'READY') break;
      if (info?.status === 'FAILED') throw new Error(info.fail_message || 'Shopee retornou FAILED');
      await new Promise(r => setTimeout(r, 1500));
    }

    const pdf = await shopeeApiDownload('POST', '/api/v2/logistics/download_shipping_document', null, {
      shipping_document_type: docType,
      order_list: [packageNumber ? { order_sn: orderSn, package_number: packageNumber } : { order_sn: orderSn }],
    }, order.account_id);
    return { buffer: pdf, filename: `shopee-${orderSn}.pdf`, contentType: 'application/pdf' };
  }
  throw new Error(`Marketplace não suportado para etiqueta: ${order.marketplace}`);
}

app.get('/api/marketplace-orders/:id/shipping-label', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const order = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM marketplace_orders WHERE id = ?', [id], (e, r) => e ? reject(e) : resolve(r));
    });
    const { buffer, filename, contentType } = await buildShippingLabelForOrder(order);
    // Carimba a impressão local (só preenche o primeiro carimbo — releituras
    // posteriores, vindas do próprio marketplace, mantêm o histórico).
    db.run(
      `UPDATE marketplace_orders
       SET label_printed_at = COALESCE(label_printed_at, CURRENT_TIMESTAMP),
           label_printed_by = COALESCE(label_printed_by, 'miti')
       WHERE id = ?`,
      [id]
    );
    res.set('Content-Type', contentType);
    res.set('Content-Disposition', `inline; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    console.error('[MktOrders] shipping-label error:', msg);
    const status = err.statusCode || (err.response?.status === 400 ? 424 : 500);
    res.status(status).json({ error: 'Erro ao gerar etiqueta', details: msg });
  }
});

// Em massa: devolve um PDF único mesclando todas as etiquetas.
// Aceita { orderIds } e processa com concorrência 3. Erros por pedido
// não abortam o merge — contabilizamos e expomos via header X-Label-Errors.
app.post('/api/marketplace-orders/shipping-labels', async (req, res) => {
  const { orderIds } = req.body || {};
  if (!Array.isArray(orderIds) || !orderIds.length) return res.status(400).json({ error: 'orderIds obrigatório' });
  try {
    const { PDFDocument } = require('pdf-lib');
    const placeholders = orderIds.map(() => '?').join(',');
    const orders = await new Promise((resolve) => {
      db.all(`SELECT * FROM marketplace_orders WHERE id IN (${placeholders})`, orderIds, (e, r) => resolve(r || []));
    });

    // Baixa todas as etiquetas em paralelo (moderado) antes de mesclar,
    // assim o merge roda na ordem dos orderIds do cliente.
    const labels = new Array(orders.length);
    const errors = [];
    const printedIds = [];
    await mapWithConcurrency(orders.map((o, i) => ({ o, i })), 3, async ({ o, i }) => {
      try {
        const { buffer } = await buildShippingLabelForOrder(o);
        labels[i] = buffer;
        printedIds.push(o.id);
      } catch (err) {
        const msg = err.response?.data?.message || err.message;
        errors.push(`${o.marketplace_order_id}: ${msg}`);
      }
    });
    if (printedIds.length) {
      const ph = printedIds.map(() => '?').join(',');
      db.run(
        `UPDATE marketplace_orders
         SET label_printed_at = COALESCE(label_printed_at, CURRENT_TIMESTAMP),
             label_printed_by = COALESCE(label_printed_by, 'miti')
         WHERE id IN (${ph})`,
        printedIds
      );
    }

    const merged = await PDFDocument.create();
    for (const buf of labels) {
      if (!buf) continue;
      try {
        const sub = await PDFDocument.load(buf, { ignoreEncryption: true });
        const pages = await merged.copyPages(sub, sub.getPageIndices());
        pages.forEach(p => merged.addPage(p));
      } catch (err) {
        errors.push(`merge: ${err.message}`);
      }
    }

    if (merged.getPageCount() === 0) {
      return res.status(424).json({
        error: 'Nenhuma etiqueta pôde ser gerada',
        details: errors.slice(0, 10),
      });
    }

    const pdfBytes = await merged.save();
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="etiquetas-${Date.now()}.pdf"`);
    if (errors.length) {
      res.set('X-Label-Errors', String(errors.length));
      res.set('Access-Control-Expose-Headers', 'X-Label-Errors');
    }
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error('[MktOrders] shipping-labels bulk error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// Bulk upload Shopee
app.post('/api/marketplace-orders/upload-invoices-shopee', async (req, res) => {
  const { orderIds } = req.body || {};
  if (!Array.isArray(orderIds) || !orderIds.length) return res.status(400).json({ error: 'orderIds obrigatório' });
  const results = { uploaded: 0, errors: [], skipped: 0 };
  await mapWithConcurrency(orderIds, 3, async (orderId) => {
    try {
      const resp = await axios.post(`http://localhost:${PORT}/api/marketplace-orders/${orderId}/upload-invoice-shopee`, {},
        { headers: internalServiceHeaders() });
      if (resp.data?.success) results.uploaded++;
      else results.errors.push({ id: orderId, error: resp.data?.error || 'Erro desconhecido' });
    } catch (err) {
      if (err.response?.status === 409) { results.skipped++; return; }
      results.errors.push({ id: orderId, error: err.response?.data?.error || err.message });
    }
  });
  res.json({ success: true, ...results });
});

// --- Delete marketplace order ---
// Enrich marketplace order items with ml_items data (thumbnail, sku from synced listings)
app.get('/api/marketplace-orders/enrich-items', async (req, res) => {
  try {
    const itemIds = (req.query.itemIds || '').split(',').filter(Boolean);
    if (!itemIds.length) return res.json({ items: {} });

    const result = {};
    for (const mlItemId of itemIds) {
      const item = await new Promise((resolve) => {
        db.get('SELECT ml_item_id, title, sku, thumbnail, price FROM ml_items WHERE ml_item_id = ? LIMIT 1', [mlItemId], (e, r) => resolve(r || null));
      });
      if (item) {
        result[mlItemId] = { title: item.title, sku: item.sku, thumbnail: item.thumbnail, price: item.price };
      }
      const vars = await new Promise((resolve) => {
        db.all('SELECT variation_id, sku, thumbnail, price, attribute_combinations FROM ml_item_variations WHERE ml_item_id = ?', [mlItemId], (e, r) => resolve(r || []));
      });
      for (const v of vars) {
        const key = `${mlItemId}_${v.variation_id}`;
        result[key] = { sku: v.sku, thumbnail: v.thumbnail, price: v.price, attribute_combinations: v.attribute_combinations };
      }
    }
    res.json({ items: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update NF Manual for an order
app.put('/api/marketplace-orders/:id/nf-manual', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { nf_manual_number, nf_manual_key, nf_manual_serie, nf_manual_date } = req.body;
  db.run(`UPDATE marketplace_orders SET nf_manual_number = ?, nf_manual_key = ?, nf_manual_serie = ?, nf_manual_date = ? WHERE id = ?`,
    [nf_manual_number || null, nf_manual_key || null, nf_manual_serie || null, nf_manual_date || null, id],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, changes: this.changes });
    });
});

// Fetch NF-e details from Bling for a marketplace order
app.get('/api/marketplace-orders/:id/nfe-detail', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const order = await new Promise((resolve, reject) => {
      db.get('SELECT bling_nfe_id, bling_pedido_id, bling_nfe_status, bling_account_id, marketplace_order_id FROM marketplace_orders WHERE id = ?', [id], (e, r) => e ? reject(e) : resolve(r));
    });
    if (!order) return res.status(404).json({ error: 'Pedido não encontrado' });

    const situacaoMap = {
      1: 'Pendente', 2: 'Cancelada', 3: 'Aguardando Recibo',
      4: 'Rejeitada', 5: 'Autorizada', 6: 'Emitida', 7: 'Denegada',
      8: 'Inutilizada', 9: 'Devolvida', 10: 'Aguardando Protocolo'
    };

    const safeStr = (v) => v == null ? null : typeof v === 'object' ? (v.descricao || v.valor || v.nome || JSON.stringify(v)) : String(v);
    const safeNum = (v) => v == null ? null : typeof v === 'object' ? (v.id || v.valor || null) : v;

    const formatNfe = (nfe) => {
      const rawSituacao = safeNum(nfe.situacao);
      return {
        id: nfe.id,
        numero: safeStr(nfe.numero),
        serie: safeStr(nfe.serie),
        chaveAcesso: safeStr(nfe.chaveAcesso),
        situacao: typeof rawSituacao === 'number' ? rawSituacao : null,
        situacaoLabel: situacaoMap[rawSituacao] || safeStr(nfe.situacao?.valor) || `Status ${rawSituacao}`,
        dataEmissao: safeStr(nfe.dataEmissao),
        horaEmissao: safeStr(nfe.horaEmissao),
        valorNota: nfe.valorNota != null ? Number(nfe.valorNota) : null,
        xml: safeStr(nfe.xml),
        linkDanfe: safeStr(nfe.linkDanfe || nfe.link),
        contato: nfe.contato ? { nome: safeStr(nfe.contato.nome), cnpj: safeStr(nfe.contato.cnpj || nfe.contato.cpf) } : null,
        naturezaOperacao: safeStr(nfe.naturezaOperacao),
        tipo: nfe.tipo === 0 ? 'Entrada' : 'Saída',
      };
    };

    // Strategy 1: Direct NF-e ID lookup
    if (order.bling_nfe_id && order.bling_account_id) {
      try {
        const tokenObj = await refreshTokenIfNeeded(order.bling_account_id);
        if (tokenObj?.access_token) {
          const nfeRes = await blingGet(`/nfe/${order.bling_nfe_id}`, tokenObj, {}, order.bling_account_id);
          const nfe = nfeRes.data?.data;
          if (nfe) {
            const nfeNumero = safeStr(nfe.numero) || null;
            const nfeChave = safeStr(nfe.chaveAcesso) || null;
            db.run('UPDATE marketplace_orders SET bling_nfe_numero = ?, bling_nfe_chave = ? WHERE id = ? AND (bling_nfe_numero IS NULL OR bling_nfe_numero = "")',
              [nfeNumero, nfeChave, id]);
            return res.json({ nfe: formatNfe(nfe), bling_pedido_id: order.bling_pedido_id, source: 'direct' });
          }
        }
      } catch (e) { console.log('[MktOrders] Direct NF-e lookup failed:', e.message); }
    }

    // Strategy 2: Search Bling sales order by marketplace_order_id, then find linked NF-e
    const blingAccounts = await new Promise((resolve) => {
      db.all('SELECT id FROM bling_accounts', (e, r) => resolve(r || []));
    });

    for (const acc of blingAccounts) {
      try {
        const tokenObj = await refreshTokenIfNeeded(acc.id);
        if (!tokenObj?.access_token) continue;

        // Search for sales order by store number (marketplace_order_id)
        const pedidoUrl = `${BLING_API_BASE}/pedidos/vendas?numerosLojas[]=${encodeURIComponent(order.marketplace_order_id)}`;
        const pedidoRes = await blingGet(pedidoUrl, tokenObj, {}, acc.id);
        const pedidos = pedidoRes.data?.data;

        if (Array.isArray(pedidos) && pedidos.length > 0) {
          const pedido = pedidos[0];
          console.log(`[MktOrders] Found Bling order ${pedido.id} for ML order ${order.marketplace_order_id} in account ${acc.id}`);

          // Get full order details to find NF-e
          const pedidoDetail = await blingGet(`/pedidos/vendas/${pedido.id}`, tokenObj, {}, acc.id);
          const pedidoData = pedidoDetail.data?.data;

          // Look for linked NF-e in nota field
          let nfeId = null;
          if (pedidoData?.nota?.id) {
            nfeId = pedidoData.nota.id;
          } else if (pedidoData?.notaFiscal?.id) {
            nfeId = pedidoData.notaFiscal.id;
          }

          // Also try searching NF-e linked to this order
          if (!nfeId) {
            try {
              const nfeSearchUrl = `${BLING_API_BASE}/nfe?limite=5&pagina=1`;
              const nfeListRes = await blingGet(nfeSearchUrl, tokenObj, {}, acc.id);
              const nfeList = nfeListRes.data?.data || [];
              const matchedNfe = nfeList.find(n =>
                String(n.numeroPedidoLoja) === String(order.marketplace_order_id) ||
                String(n.numeroPedido) === String(pedido.numero)
              );
              if (matchedNfe) nfeId = matchedNfe.id;
            } catch {}
          }

          if (nfeId) {
            const nfeRes = await blingGet(`/nfe/${nfeId}`, tokenObj, {}, acc.id);
            const nfe = nfeRes.data?.data;
            if (nfe) {
              // Save to DB for faster lookup next time
              const nfeNumero = safeStr(nfe.numero) || null;
              const nfeChave = safeStr(nfe.chaveAcesso) || null;
              db.run('UPDATE marketplace_orders SET bling_pedido_id = ?, bling_nfe_id = ?, bling_account_id = ?, bling_nfe_status = ?, bling_nfe_numero = ?, bling_nfe_chave = ? WHERE id = ?',
                [String(pedido.id), String(nfeId), acc.id, nfe.situacao >= 5 ? 'generated' : 'pending', nfeNumero, nfeChave, id]);
              return res.json({ nfe: formatNfe(nfe), bling_pedido_id: String(pedido.id), source: 'search' });
            }
          }

          // Return pedido info even without NF-e
          return res.json({
            nfe: null,
            bling_pedido_id: String(pedido.id),
            bling_account_id: acc.id,
            pedido: { id: pedido.id, numero: pedido.numero, situacao: pedido.situacao, totalProdutos: pedido.totalProdutos, totalVenda: pedido.totalVenda },
            message: 'Pedido encontrado no Bling mas sem NF-e vinculada'
          });
        }
      } catch (e) {
        console.log(`[MktOrders] Bling search in account ${acc.id} failed:`, e.message);
      }
    }

    res.json({ nfe: null, message: 'NF-e não encontrada no Bling' });
  } catch (err) {
    console.error('[MktOrders] NF-e detail error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// Batch check NF-e for multiple marketplace orders at once
app.post('/api/marketplace-orders/batch-nfe-check', async (req, res) => {
  try {
    const { orderIds, force } = req.body;
    if (!Array.isArray(orderIds) || !orderIds.length) return res.json({ results: {} });

    const placeholders = orderIds.map(() => '?').join(',');
    const orders = await new Promise((resolve, reject) => {
      db.all(`SELECT id, marketplace_order_id, bling_pedido_id, bling_nfe_id, bling_nfe_numero, bling_account_id, bling_nfe_checked_at FROM marketplace_orders WHERE id IN (${placeholders})`, orderIds, (e, r) => e ? reject(e) : resolve(r || []));
    });

    // TTL do cache negativo: só reconsulta Bling se passaram mais de 30 min desde a última checagem
    const NEGATIVE_TTL_MS = 30 * 60 * 1000;
    const now = Date.now();

    const results = {};
    const needsCheck = [];
    for (const o of orders) {
      if (o.bling_nfe_numero) {
        results[o.id] = { nfe_numero: o.bling_nfe_numero, bling_pedido_id: o.bling_pedido_id, bling_nfe_id: o.bling_nfe_id, cached: true };
      } else if (!force && o.bling_nfe_checked_at && (now - new Date(o.bling_nfe_checked_at).getTime()) < NEGATIVE_TTL_MS) {
        // Recentemente checado e nada encontrado — pula para evitar 429 no Bling
        results[o.id] = { nfe_numero: null, bling_pedido_id: o.bling_pedido_id, skipped_recent_check: true };
      } else {
        needsCheck.push(o);
      }
    }

    if (!needsCheck.length) return res.json({ results });

    // Get all Bling accounts
    const blingAccounts = await new Promise((resolve) => {
      db.all('SELECT id FROM bling_accounts', (e, r) => resolve(r || []));
    });

    // Batch search: use numerosLojas[] to find Bling orders for all marketplace orders at once
    const mlOrderIds = needsCheck.map(o => o.marketplace_order_id).filter(Boolean);

    for (const acc of blingAccounts) {
      if (!mlOrderIds.length) break;
      try {
        const tokenObj = await refreshTokenIfNeeded(acc.id);
        if (!tokenObj?.access_token) continue;

        // Bling API supports up to ~50 numerosLojas per request
        const batchSize = 20;
        for (let i = 0; i < mlOrderIds.length; i += batchSize) {
          const batch = mlOrderIds.slice(i, i + batchSize);
          const params = new URLSearchParams();
          batch.forEach(num => params.append('numerosLojas[]', num));

          try {
            const pedidosRes = await blingGet(`${BLING_API_BASE}/pedidos/vendas?${params.toString()}`, tokenObj, {}, acc.id);
            const pedidos = pedidosRes.data?.data || [];

            for (const pedido of pedidos) {
              const numLoja = String(pedido.numeroLoja || pedido.numeroPedidoLoja || '');
              const matchedOrder = needsCheck.find(o => String(o.marketplace_order_id) === numLoja);
              if (!matchedOrder) continue;

              // Get pedido detail to find NF-e
              try {
                const pedDetail = await blingGet(`/pedidos/vendas/${pedido.id}`, tokenObj, {}, acc.id);
                const pedData = pedDetail.data?.data;

                let nfeId = pedData?.nota?.id || pedData?.notaFiscal?.id || null;

                if (nfeId) {
                  const nfeRes = await blingGet(`/nfe/${nfeId}`, tokenObj, {}, acc.id);
                  const nfe = nfeRes.data?.data;
                  if (nfe) {
                    const nfeNumero = String(nfe.numero || '');
                    const nfeChave = String(nfe.chaveAcesso || '');
                    const nfeSituacao = typeof nfe.situacao === 'number' ? nfe.situacao : (nfe.situacao?.id || null);

                    db.run('UPDATE marketplace_orders SET bling_pedido_id = ?, bling_nfe_id = ?, bling_nfe_numero = ?, bling_nfe_chave = ?, bling_account_id = ?, bling_nfe_status = ? WHERE id = ?',
                      [String(pedido.id), String(nfeId), nfeNumero, nfeChave, acc.id, nfeSituacao >= 5 ? 'generated' : 'pending', matchedOrder.id]);

                    results[matchedOrder.id] = { nfe_numero: nfeNumero, bling_pedido_id: String(pedido.id), bling_nfe_id: String(nfeId), nfe_chave: nfeChave };

                    // Remove from needsCheck
                    const idx = mlOrderIds.indexOf(numLoja);
                    if (idx >= 0) mlOrderIds.splice(idx, 1);
                    continue;
                  }
                }

                // Pedido found but no NF-e linked
                db.run('UPDATE marketplace_orders SET bling_pedido_id = ?, bling_account_id = ? WHERE id = ? AND bling_pedido_id IS NULL',
                  [String(pedido.id), acc.id, matchedOrder.id]);
                results[matchedOrder.id] = { bling_pedido_id: String(pedido.id), nfe_numero: null };

              } catch (detErr) {
                console.log(`[MktOrders Batch] Detail error for pedido ${pedido.id}:`, detErr.message);
              }
            }
          } catch (batchErr) {
            console.log(`[MktOrders Batch] Search error in account ${acc.id}:`, batchErr.message);
          }
        }
      } catch (accErr) {
        console.log(`[MktOrders Batch] Account ${acc.id} error:`, accErr.message);
      }
    }

    // Marca todos que foram checados (mesmo sem NFe) para evitar reconsulta em 30 min
    const checkedIds = needsCheck.map(o => o.id);
    if (checkedIds.length) {
      const nowIso = new Date().toISOString();
      const ph = checkedIds.map(() => '?').join(',');
      db.run(`UPDATE marketplace_orders SET bling_nfe_checked_at = ? WHERE id IN (${ph})`, [nowIso, ...checkedIds]);
    }

    res.json({ results });
  } catch (err) {
    console.error('[MktOrders Batch] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get full detail of a single marketplace order
app.get('/api/marketplace-orders/:id/detail', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const order = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM marketplace_orders WHERE id = ?', [id], (e, r) => e ? reject(e) : resolve(r));
    });
    if (!order) return res.status(404).json({ error: 'Pedido não encontrado' });

    const items = await new Promise((resolve, reject) => {
      db.all('SELECT * FROM marketplace_order_items WHERE order_id = ?', [id], (e, r) => e ? reject(e) : resolve(r || []));
    });

    let shipping_address = null;
    if (order.shipping_address_json) {
      try { shipping_address = JSON.parse(order.shipping_address_json); } catch {}
    }

    // Enrich items with ml_items data
    for (const item of items) {
      if (item.variation_attributes_json) {
        try { item.variation_attributes = JSON.parse(item.variation_attributes_json); } catch { item.variation_attributes = []; }
      }
      if (item.marketplace_item_id) {
        const mlItem = await new Promise(r => db.get('SELECT title, sku, thumbnail FROM ml_items WHERE ml_item_id = ?', [item.marketplace_item_id], (e, row) => r(row || null)));
        if (mlItem) {
          if (!item.thumbnail) item.thumbnail = mlItem.thumbnail;
          if (!item.sku) item.sku = mlItem.sku;
          if (!item.title || item.title === 'null') item.title = mlItem.title;
        }
        if (item.variation_id) {
          const mlVar = await new Promise(r => db.get('SELECT sku, thumbnail, attribute_combinations FROM ml_item_variations WHERE ml_item_id = ? AND variation_id = ?', [item.marketplace_item_id, item.variation_id], (e, row) => r(row || null)));
          if (mlVar) {
            if (!item.thumbnail) item.thumbnail = mlVar.thumbnail;
            if (!item.sku) item.sku = mlVar.sku;
          }
        }
      }
    }

    const { shipping_address_json, ...rest } = order;
    res.json({ ...rest, items, shipping_address });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/marketplace-orders/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.run('DELETE FROM marketplace_order_items WHERE order_id = ?', [id], () => {
    db.run('DELETE FROM marketplace_orders WHERE id = ?', [id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, deleted: this.changes });
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// ═══  END MARKETPLACE ORDERS  ═════════════════════════════════
// ═══════════════════════════════════════════════════════════════

// Endpoint para buscar notas fiscais eletrônicas (NF-e) do Bling, com filtro opcional de data de emissão e cruzamento com pedidos de venda
app.get('/api/bling/notas-fiscais', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  const accountId = getAccountIdFromReq(req);
  const { dataEmissaoInicial, dataEmissaoFinal, forcarImportacao } = req.query;
  const dataEmissaoInicialParam = normalizeBlingDateParam(dataEmissaoInicial);
  const dataEmissaoFinalParam = normalizeBlingDateParam(dataEmissaoFinal);
  const hasTimeFilter = typeof dataEmissaoInicial === 'string' && dataEmissaoInicial.includes(':');
  const hasDateFilter = Boolean(dataEmissaoInicialParam || dataEmissaoFinalParam);
  const allowFallbackDate = !hasDateFilter && !hasTimeFilter;
  const parseDateForFilter = (value) => {
    if (!value) return null;
    const raw = String(value).trim();
    if (!raw) return null;
    const normalized = normalizeDateWithOffset(raw);
    const d = new Date(normalized);
    if (!Number.isFinite(d.getTime())) return null;
    return d;
  };
  const buildRequestedRange = (startRaw, endRaw) => {
    const s = startRaw ? String(startRaw).trim() : '';
    const e = endRaw ? String(endRaw).trim() : '';
    const startHasTime = s.includes(':');
    const endHasTime = e.includes(':');
    const start = s ? parseDateForFilter(startHasTime ? s : `${s} 00:00:00`) : null;
    const end = e ? parseDateForFilter(endHasTime ? e : `${e} 23:59:59`) : null;
    return { start, end };
  };
  const filterByRequestedRange = (items) => {
    if (!Array.isArray(items) || (!filterStart && !filterEnd)) return items || [];
    console.log('[BACKEND DEBUG] Filtrando itens por range:', {
      filterStart: filterStart ? filterStart.toISOString() : null,
      filterEnd: filterEnd ? filterEnd.toISOString() : null,
      itens: items.length
    });
    return items.filter(item => {
      const d = parseDateForFilter(item?.dataEmissao || item?.data_emissao);
      if (!d) return false;
      if (filterStart && d < filterStart) return false;
      if (filterEnd && d > filterEnd) return false;
      return true;
    });
  };
  const { start: requestedStart, end: requestedEnd } = buildRequestedRange(dataEmissaoInicial, dataEmissaoFinal);
  let filterStart = requestedStart;
  let filterEnd = requestedEnd;
  console.log('[BACKEND DEBUG] Range solicitado:', {
    raw: { dataEmissaoInicial, dataEmissaoFinal },
    requestedStart: requestedStart ? requestedStart.toISOString() : null,
    requestedEnd: requestedEnd ? requestedEnd.toISOString() : null
  });
  const getApiEndDate = (startDate, endDate) => {
    if (startDate && endDate && startDate === endDate) {
      return shiftDateStr(endDate, 1);
    }
    return endDate;
  };
  const blingGetWithRetry = async (url, tokenObjRef, accountIdRef, attempts = 3) => {
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
      try {
        return await blingGet(url, tokenObjRef, {}, accountIdRef);
      } catch (err) {
        lastErr = err;
        const status = err?.response?.status;
        if (status === 429 && i < attempts - 1) {
          await delay(1200);
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  };
  let dataStartToUse = dataEmissaoInicialParam;
  let dataEndToUse = dataEmissaoFinalParam;
  let usedFallbackDate = false;
  const cacheKeyBase = `${dataEmissaoInicial || ''}_${dataEmissaoFinal || ''}`;
  let cacheKey = cacheKeyBase;
  const notasFiscaisCache = getNotasFiscaisCache(accountId);
  const importacaoProgresso = getImportacaoProgresso(accountId);

  console.log('[BACKEND DEBUG] Endpoint /api/bling/notas-fiscais chamado');
  console.log('[BACKEND DEBUG] Parâmetros:', { accountId, dataEmissaoInicial, dataEmissaoFinal, forcarImportacao });
  console.log('[BACKEND DEBUG] Status atual:', importacaoProgresso.status);
  console.log('[BACKEND DEBUG] isNotasFiscaisFetching:', isNotasFiscaisFetching(accountId));

  if (forcarImportacao && importacaoProgresso.status === 'importando') {
    console.log('[BACKEND DEBUG] Bloqueando - já existe importação em andamento');
    return res.status(429).json({ error: 'Já existe uma importação em andamento. Aguarde terminar.' });
  }

  if (
    !forcarImportacao &&
    importacaoProgresso.status === 'concluido' &&
    notasFiscaisCache.data &&
    notasFiscaisCache.key === cacheKeyBase &&
    (Date.now() - (notasFiscaisCache.timestamp || 0)) < CACHE_DURATION_MS
  ) {
    if (Array.isArray(notasFiscaisCache.data) && notasFiscaisCache.data.length > 0) {
      console.log('[BACKEND DEBUG] Retornando dados do cache (cacheKey OK)');
      return res.json({ data: notasFiscaisCache.data });
    }
    console.log('[BACKEND DEBUG] Cache vazio, buscando persistidas');
  }

  if (!forcarImportacao) {
    try {
      const notasRows = await dbAllAsync(
        'SELECT id, account_id, numero, numeroLoja, cliente, valorNota, marketplace, dataEmissao FROM notas_fiscais WHERE account_id = ?',
        [accountId]
      );
      const itensRows = await dbAllAsync(
        'SELECT nota_id, sku, quantidade, title FROM nota_itens_fiscais WHERE account_id = ?',
        [accountId]
      );
    const itensByNota = new Map();
      for (const it of itensRows) {
        const key = String(it.nota_id);
        const arr = itensByNota.get(key) || [];
        arr.push({
          codigo: it.sku,
          descricao: it.title || '',
          quantidade: it.quantidade || 0,
          localizacao: '',
          saldo: undefined
        });
        itensByNota.set(key, arr);
      }
      let notasPersistidas = notasRows.map(n => ({
        accountId: n.account_id,
        id: Number.isFinite(Number(n.id)) ? Number(n.id) : n.id,
        numero: n.numero,
        numeroLoja: n.numeroLoja,
        cliente: n.cliente || 'Cliente não informado',
        valorNota: Number(n.valorNota || 0),
        marketplace: n.marketplace || identificarMarketplace(String(n.numeroLoja || ''), []) || 'Desconhecido',
        dataEmissao: n.dataEmissao,
        situacao: 5,
        itens: itensByNota.get(String(n.id)) || []
      }));
      if (filterStart || filterEnd) {
        notasPersistidas = notasPersistidas.filter(nota => {
          const d = parseDateForFilter(nota?.dataEmissao || nota?.data_emissao);
          if (!d) return false;
          if (filterStart && d < filterStart) return false;
          if (filterEnd && d > filterEnd) return false;
          return true;
        });
      }
      if (notasPersistidas.length > 0) {
        notasFiscaisCache.key = cacheKeyBase;
        notasFiscaisCache.data = notasPersistidas;
        notasFiscaisCache.timestamp = Date.now();
      }
      console.log('[BACKEND DEBUG] Retornando notas persistidas do banco:', notasPersistidas.length);
      return res.json({ data: notasPersistidas, fromDb: true });
    } catch (err) {
      console.log('[BACKEND DEBUG] Erro ao buscar notas persistidas:', err.message);
      return res.json({ data: [] });
    }
  }

  if (isNotasFiscaisFetching(accountId)) {
    console.log('[BACKEND DEBUG] Bloqueando - isNotasFiscaisFetching = true');
    return res.status(429).json({ error: 'Já existe uma busca de notas fiscais em andamento. Aguarde terminar.' });
  }

  console.log('[BACKEND DEBUG] Iniciando nova busca/importação');
  setNotasFiscaisFetching(accountId, true);
  logBling('Iniciando importação de notas fiscais do Bling', { accountId });
  importacaoProgresso.importados = 0;
  importacaoProgresso.status = 'importando';
  // NÃO zere o total aqui!

  const tokenObj = await refreshTokenIfNeeded(accountId);
  if (!tokenObj || !tokenObj.access_token) {
    setNotasFiscaisFetching(accountId, false);
    importacaoProgresso.status = 'erro';
    return res.status(401).json({ error: 'Não autenticado no Bling.' });
  }

  // Primeiro, contar o total de notas se não foi fornecido
  if (!importacaoProgresso.total || importacaoProgresso.total === 0) {
    console.log('[BACKEND DEBUG] Fazendo contagem inicial - total atual:', importacaoProgresso.total);
    try {
      const buildNfeUrl = (start, end, page = 1) => {
        const apiEnd = getApiEndDate(start, end);
        let url = `${BLING_API_BASE}/nfe?limite=100&pagina=${page}`;
        if (start) url += `&dataEmissaoInicial=${encodeURIComponent(start)}`;
        if (apiEnd) url += `&dataEmissaoFinal=${encodeURIComponent(apiEnd)}`;
        return url;
      };
      let contagemUrl = buildNfeUrl(dataStartToUse, dataEndToUse, 1);

      const contagemResponse = await blingGetWithRetry(contagemUrl, tokenObj, accountId);

      // Se a primeira página tem 100 itens, fazer contagem completa
      if (contagemResponse.data?.data?.length === 100) {
        logBling('Fazendo contagem completa de notas fiscais', { accountId });
        let totalNotas = 0;
        let pageContagem = 1;

        while (true) {
          let urlContagem = buildNfeUrl(dataStartToUse, dataEndToUse, pageContagem);

          const responseContagem = await blingGetWithRetry(urlContagem, tokenObj, accountId);

          const dataArrContagem = responseContagem.data?.data;
          if (Array.isArray(dataArrContagem) && dataArrContagem.length > 0) {
            const filtradas = filterByRequestedRange(dataArrContagem);
            totalNotas += filtradas.length;
            if (dataArrContagem.length < 100) break;
            pageContagem++;
          } else {
            break;
          }
        }
        importacaoProgresso.total = totalNotas;
        logBling('Contagem completa concluída', { accountId, total: totalNotas });
      } else {
        // Se a primeira página tem menos de 100, usar o tamanho da primeira página
        const baseArr = contagemResponse.data?.data || [];
        importacaoProgresso.total = filterByRequestedRange(baseArr).length;
        logBling('Usando contagem da primeira página', { total: importacaoProgresso.total });
      }
      if (
        importacaoProgresso.total === 0 &&
        dataEmissaoInicialParam &&
        dataEmissaoFinalParam &&
        allowFallbackDate
      ) {
        const fallbackStart = shiftDateStr(dataEmissaoInicialParam, -1);
        if (fallbackStart && fallbackStart !== dataEmissaoInicialParam) {
          const fallbackUrl = buildNfeUrl(fallbackStart, dataEmissaoFinalParam, 1);
          const fallbackRes = await blingGetWithRetry(fallbackUrl, tokenObj, accountId);
          const fallbackLen = fallbackRes.data?.data?.length || 0;
          if (fallbackLen > 0) {
            dataStartToUse = fallbackStart;
            usedFallbackDate = true;
            filterStart = buildRequestedRange(`${fallbackStart} 00:00:00`, dataEmissaoFinal).start;
            filterEnd = buildRequestedRange(`${fallbackStart} 00:00:00`, dataEmissaoFinal).end;
            if (fallbackLen === 100) {
              let totalNotasFallback = 0;
              let pageFallback = 1;
              while (true) {
                const urlFallback = buildNfeUrl(fallbackStart, dataEmissaoFinalParam, pageFallback);
                const respFallback = await blingGetWithRetry(urlFallback, tokenObj, accountId);
                const dataArrFallback = respFallback.data?.data;
                if (Array.isArray(dataArrFallback) && dataArrFallback.length > 0) {
                  totalNotasFallback += filterByRequestedRange(dataArrFallback).length;
                  if (dataArrFallback.length < 100) break;
                  pageFallback++;
                } else {
                  break;
                }
              }
              importacaoProgresso.total = totalNotasFallback;
            } else {
              importacaoProgresso.total = filterByRequestedRange(fallbackRes.data?.data || []).length || fallbackLen;
            }
            logBling('Fallback de data aplicado para contagem', { accountId, fallbackStart });
          }
        }
      }
    } catch (err) {
      logBling('Erro na contagem inicial, continuando sem total', err.message);
      importacaoProgresso.total = 0; // Continuar sem saber o total
    }
  }
  
  try {
    console.log('[BACKEND DEBUG] Token válido, iniciando busca das notas');
    console.log('[BACKEND DEBUG] Range efetivo antes da busca:', {
      dataStartToUse,
      dataEndToUse,
      filterStart: filterStart ? filterStart.toISOString() : null,
      filterEnd: filterEnd ? filterEnd.toISOString() : null
    });
    const endpoint = '/nfe'; // NF-e
    let allNotas = [];
    let lastError = null;
    let page = 1;
    let totalPaginas = 0;
    
    while (true) {
      const apiEndToUse = getApiEndDate(dataStartToUse, dataEndToUse);
      let url = `${BLING_API_BASE}${endpoint}?limite=100&pagina=${page}`;
      if (dataStartToUse) url += `&dataEmissaoInicial=${encodeURIComponent(dataStartToUse)}`;
      if (apiEndToUse) url += `&dataEmissaoFinal=${encodeURIComponent(apiEndToUse)}`;
      
      try {
        const response = await blingGetWithRetry(url, tokenObj, accountId);
        
        const dataArr = response.data?.data;
        totalPaginas++;
        logBling(`Página ${page} - Notas retornadas: ${dataArr?.length || 0}`, { accountId });
        
        if (Array.isArray(dataArr) && dataArr.length > 0) {
          const notasFormatadas = [];
          for (const nota of dataArr) {
            const notaDetalhada = await montarNotaFiscalDetalhada(nota, tokenObj, accountId);
            notasFormatadas.push(notaDetalhada);
            await delay(500); // 500ms entre requests
            importacaoProgresso.importados++;
            if (importacaoProgresso.total > 0 && importacaoProgresso.importados > importacaoProgresso.total) {
              importacaoProgresso.importados = importacaoProgresso.total;
            }
          }
          allNotas = allNotas.concat(notasFormatadas);
          if (dataArr.length < 100) break; // última página
          page++;
        } else {
          break; // sem mais páginas
        }
      } catch (err) {
        lastError = err.response?.data || err.message;
        importacaoProgresso.status = 'erro';
        console.log('[BACKEND DEBUG] Erro durante busca:', lastError);
        break;
      }
    }
    
    console.log('[BACKEND DEBUG] Busca concluída, processando resultados');
    logBling('Importação de notas fiscais - Total páginas', { accountId, totalPaginas, totalNotas: allNotas.length });
    
    // Remover duplicatas antes de retornar
    const notasUnicas = [];
    const idsSet = new Set();
    for (const nota of allNotas) {
      if (nota.id && !idsSet.has(nota.id)) {
        notasUnicas.push(nota);
        idsSet.add(nota.id);
      }
    }

    if (notasUnicas.length === 0 && !usedFallbackDate && dataEmissaoInicialParam && dataEmissaoFinalParam && allowFallbackDate) {
      const fallbackStart = shiftDateStr(dataEmissaoInicialParam, -1);
      if (fallbackStart && fallbackStart !== dataEmissaoInicialParam) {
        dataStartToUse = fallbackStart;
        usedFallbackDate = true;
        console.log('[BACKEND DEBUG] Fallback aplicado (listagem) - mantendo range solicitado:', {
          dataStartToUse,
          dataEndToUse,
          filterStart: filterStart ? filterStart.toISOString() : null,
          filterEnd: filterEnd ? filterEnd.toISOString() : null
        });
        logBling('Tentando fallback de data na listagem', { accountId, fallbackStart });
        page = 1;
        totalPaginas = 0;
        while (true) {
          const apiEndFallback = getApiEndDate(dataStartToUse, dataEndToUse);
          let url = `${BLING_API_BASE}${endpoint}?limite=100&pagina=${page}`;
          if (dataStartToUse) url += `&dataEmissaoInicial=${encodeURIComponent(dataStartToUse)}`;
          if (apiEndFallback) url += `&dataEmissaoFinal=${encodeURIComponent(apiEndFallback)}`;
          const response = await blingGetWithRetry(url, tokenObj, accountId);
          const dataArr = response.data?.data;
          totalPaginas++;
          logBling(`Página ${page} (fallback) - Notas retornadas: ${dataArr?.length || 0}`, { accountId });
          if (Array.isArray(dataArr) && dataArr.length > 0) {
            const notasFormatadas = [];
            for (const nota of dataArr) {
              const notaDetalhada = await montarNotaFiscalDetalhada(nota, tokenObj, accountId);
              notasFormatadas.push(notaDetalhada);
              await delay(500);
              importacaoProgresso.importados++;
              if (importacaoProgresso.total > 0 && importacaoProgresso.importados > importacaoProgresso.total) {
                importacaoProgresso.importados = importacaoProgresso.total;
              }
            }
            allNotas = allNotas.concat(notasFormatadas);
            if (dataArr.length < 100) break;
            page++;
          } else {
            break;
          }
        }
        const idsSetFallback = new Set(idsSet);
        for (const nota of allNotas) {
          if (nota.id && !idsSetFallback.has(nota.id)) {
            notasUnicas.push(nota);
            idsSetFallback.add(nota.id);
          }
        }
      }
    }

    // Aplicar filtro final por data/hora solicitadas (se houver)
    let notasFiltradas = notasUnicas;
    if (filterStart || filterEnd) {
      notasFiltradas = notasUnicas.filter(nota => {
        const d = parseDateForFilter(nota?.dataEmissao || nota?.data_emissao);
        if (!d) return false;
        if (filterStart && d < filterStart) return false;
        if (filterEnd && d > filterEnd) return false;
        return true;
      });
    }

    if (notasFiltradas.length === 0) {
      console.log('[BACKEND DEBUG] Nenhuma nota encontrada');
      logBling('Nenhuma nota fiscal encontrada', { accountId });
      setNotasFiscaisFetching(accountId, false);
      importacaoProgresso.status = 'concluido';
      if (usedFallbackDate) {
        cacheKey = `${dataStartToUse || ''}_${dataEndToUse || ''}_fallback`;
      }
      notasFiscaisCache.key = cacheKey;
      notasFiscaisCache.data = [];
      notasFiscaisCache.timestamp = Date.now();
      return res.json({ data: [], empty: true });
    }
    
    console.log('[BACKEND DEBUG] Importação concluída com sucesso:', notasFiltradas.length, 'notas');
    logBling('Importação de notas fiscais concluída', { accountId, total: notasFiltradas.length });
    console.log("DEBUG - numeroPedidoLoja brutos:", notasFiltradas.map(n => n.numeroPedidoLoja));
    
    // Reidentificar marketplaces para notas com dados incompletos antes de finalizar
    try {
      await reidentificarMarketplacesAposImportacao(notasFiltradas, tokenObj, accountId);
    } catch (_) {
      // silencioso
    }

    setNotasFiscaisFetching(accountId, false);
    importacaoProgresso.status = 'concluido';
    
    // Salvar no cache
    if (usedFallbackDate) {
      cacheKey = `${dataStartToUse || ''}_${dataEndToUse || ''}_fallback`;
    }
    notasFiscaisCache.key = cacheKey;
    notasFiscaisCache.data = notasFiltradas;
    notasFiscaisCache.timestamp = Date.now();

    // Persistir notas importadas para relatórios
    try {
      db.serialize(() => {
        const stmtNota = db.prepare(`
          INSERT OR REPLACE INTO notas_fiscais
          (id, account_id, numero, numeroLoja, cliente, valorNota, marketplace, dataEmissao)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const stmtDelItens = db.prepare(`DELETE FROM nota_itens_fiscais WHERE nota_id = ? AND account_id = ?`);
        const stmtItem = db.prepare(`
          INSERT INTO nota_itens_fiscais
          (nota_id, account_id, sku, quantidade, title)
          VALUES (?, ?, ?, ?, ?)
        `);
        for (const nota of notasFiltradas) {
          const notaId = String(nota.id || '');
          if (!notaId) continue;
          const dataEmissao = nota.dataEmissao || nota.data_emissao || null;
          stmtNota.run([
            notaId,
            accountId,
            nota.numero || null,
            nota.numeroLoja || null,
            nota.cliente || null,
            Number(nota.valorNota || 0),
            nota.marketplace || null,
            dataEmissao
          ]);
          stmtDelItens.run([notaId, accountId]);
          const itens = Array.isArray(nota.itens) ? nota.itens : [];
          for (const item of itens) {
            const sku = (item && (item.codigo || item.sku || '')).toString();
            const qtd = parseInt(item.quantidade || item.qtd || item.quantity || 0, 10) || 0;
            const title = item.descricao || item.titulo || item.title || null;
            if (!sku || qtd <= 0) continue;
            stmtItem.run([notaId, accountId, sku, qtd, title]);
          }
        }
        stmtNota.finalize();
        stmtDelItens.finalize();
        stmtItem.finalize();
      });
    } catch (_) {}
    
    console.log('[BACKEND DEBUG] Retornando dados para o frontend');
    return res.json({ data: notasFiltradas });
    
  } catch (err) {
    const status = err?.response?.status;
    console.log('[BACKEND DEBUG] Erro fatal na importação:', err.message);
    importacaoProgresso.status = 'erro';
    logBling('Erro ao buscar notas fiscais (fatal)', { accountId, details: err.response?.data || err.message });
    setNotasFiscaisFetching(accountId, false);
    if (status === 429 && notasFiscaisCache.data && notasFiscaisCache.key === cacheKeyBase) {
      return res.json({ data: notasFiscaisCache.data, warning: 'rate_limited' });
    }
    res.status(status === 429 ? 429 : 500).json({ error: 'Erro ao buscar notas fiscais (fatal)', details: err.response?.data || err.message });
  }
});

// ====== Pedidos Manuais (CRUD básico) ======
// Listar pedidos manuais (com itens)
app.get('/api/manual-orders', (req, res) => {
  const { dataInicio, dataFim, search } = req.query;
  let where = [];
  let params = [];
  if (dataInicio && dataFim) {
    where.push('created_at BETWEEN ? AND ?');
    params.push(`${dataInicio} 00:00:00`, `${dataFim} 23:59:59`);
  }
  if (search) {
    where.push('(order_number LIKE ? OR customer_name LIKE ? OR marketplace LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';
  db.all(`SELECT * FROM manual_orders ${whereSql} ORDER BY created_at DESC`, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const ids = rows.map(r => r.id);
    if (ids.length === 0) return res.json({ data: [] });
    const placeholders = ids.map(()=>'?').join(',');
    db.all(`SELECT * FROM manual_order_items WHERE order_id IN (${placeholders})`, ids, (err2, itens) => {
      if (err2) return res.status(500).json({ error: err2.message });
      const byOrder = new Map();
      for (const it of itens) {
        const arr = byOrder.get(it.order_id) || [];
        arr.push(it);
        byOrder.set(it.order_id, arr);
      }
      const result = rows.map(r => ({ ...r, items: byOrder.get(r.id) || [] }));
      res.json({ data: result });
    });
  });
});

// Criar pedido manual
app.post('/api/manual-orders', (req, res) => {
  const { marketplace, order_number, customer_name, invoice_number, order_date, items } = req.body || {};
  db.run(`INSERT INTO manual_orders (marketplace, order_number, customer_name, invoice_number, order_date, created_at)
          VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [marketplace || null, order_number || null, customer_name || null, invoice_number || null, order_date || null], function(err){
      if (err) return res.status(500).json({ error: err.message });
      const orderId = this.lastID;
      if (Array.isArray(items) && items.length > 0) {
        const stmt = db.prepare(`INSERT INTO manual_order_items (order_id, sku, title, quantity, unit_price) VALUES (?, ?, ?, ?, ?)`);
        for (const it of items) {
          const sku = (it.sku || '').toString();
          const title = it.title || null;
          const quantity = parseInt(it.quantity || it.quantidade || 0) || 0;
          const unit_price = 0; // preço unitário não utilizado em pedidos manuais
          if (!sku || quantity <= 0) continue;
          stmt.run([orderId, sku, title, quantity, unit_price]);
        }
        stmt.finalize(() => {
          res.json({ id: orderId });
        });
      } else {
        res.json({ id: orderId });
      }
    });
});

// Atualizar pedido manual (substitui itens)
app.put('/api/manual-orders/:id', (req, res) => {
  const { id } = req.params;
  const { marketplace, order_number, customer_name, invoice_number, order_date, items } = req.body || {};
  db.run(`UPDATE manual_orders SET marketplace = ?, order_number = ?, customer_name = ?, invoice_number = ?, order_date = ? WHERE id = ?`,
    [marketplace || null, order_number || null, customer_name || null, invoice_number || null, order_date || null, id], function(err){
      if (err) return res.status(500).json({ error: err.message });
      db.run(`DELETE FROM manual_order_items WHERE order_id = ?`, [id], (err2) => {
        if (err2) return res.status(500).json({ error: err2.message });
        if (Array.isArray(items) && items.length > 0) {
          const stmt = db.prepare(`INSERT INTO manual_order_items (order_id, sku, title, quantity, unit_price) VALUES (?, ?, ?, ?, ?)`);
          for (const it of items) {
            const sku = (it.sku || '').toString();
            const title = it.title || null;
            const quantity = parseInt(it.quantity || it.quantidade || 0) || 0;
            const unit_price = 0;
            if (!sku || quantity <= 0) continue;
            stmt.run([id, sku, title, quantity, unit_price]);
          }
          stmt.finalize(() => res.json({ id: Number(id) }));
        } else {
          res.json({ id: Number(id) });
        }
      });
    });
});

// Excluir pedido manual
app.delete('/api/manual-orders/:id', (req, res) => {
  const { id } = req.params;
  db.run(`DELETE FROM manual_order_items WHERE order_id = ?`, [id], () => {
    db.run(`DELETE FROM manual_orders WHERE id = ?`, [id], function(err){
      if (err) return res.status(500).json({ error: err.message });
      res.json({ deleted: this.changes || 0 });
    });
  });
});

// Endpoint de teste para obter todos os dados brutos de pedidos de venda do Bling por numerosLojas[]
app.get('/api/bling/teste-pedidos-vendas', async (req, res) => {
  try {
    const accountId = getAccountIdFromReq(req);
    const tokenObj = await refreshTokenIfNeeded(accountId);
    if (!tokenObj || !tokenObj.access_token) {
      return res.status(401).json({ error: 'Não autenticado no Bling.' });
    }
    let numerosLojas = req.query.numerosLojas;
    if (!numerosLojas) {
      return res.status(400).json({ error: 'Informe pelo menos um numerosLojas[] na query.' });
    }
    if (!Array.isArray(numerosLojas)) {
      numerosLojas = [numerosLojas];
    }
    const params = new URLSearchParams();
    numerosLojas.forEach(num => params.append('numerosLojas[]', num));
    const pedidosUrl = `${BLING_API_BASE}/pedidos/vendas?${params.toString()}`;
    const pedidosRes = await blingGet(pedidosUrl, tokenObj, {}, accountId);
    return res.json({ data: pedidosRes.data });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar pedidos de venda', details: err.response?.data || err.message });
  }
});

// Endpoint temporário para listar todos os numeroPedidoLoja das notas fiscais
app.get('/api/bling/notas-fiscais/numero-pedido-loja', async (req, res) => {
  try {
    const accountId = getAccountIdFromReq(req);
    const tokenObj = await refreshTokenIfNeeded(accountId);
    if (!tokenObj || !tokenObj.access_token) {
      return res.status(401).json({ error: 'Não autenticado no Bling.' });
    }
    const endpoint = '/nfe';
    let allNumeros = [];
    let page = 1;
    const { dataEmissaoInicial, dataEmissaoFinal } = req.query;
    const dataEmissaoInicialParam = normalizeBlingDateParam(dataEmissaoInicial);
    const dataEmissaoFinalParam = normalizeBlingDateParam(dataEmissaoFinal);
    const getApiEndDate = (startDate, endDate) => {
      if (startDate && endDate && startDate === endDate) {
        return shiftDateStr(endDate, 1);
      }
      return endDate;
    };
    let dataStartToUse = dataEmissaoInicialParam;
    let dataEndToUse = dataEmissaoFinalParam;
    while (true) {
      const apiEndToUse = getApiEndDate(dataStartToUse, dataEndToUse);
      let url = `${BLING_API_BASE}${endpoint}?limite=100&pagina=${page}`;
      if (dataStartToUse) url += `&dataEmissaoInicial=${encodeURIComponent(dataStartToUse)}`;
      if (apiEndToUse) url += `&dataEmissaoFinal=${encodeURIComponent(apiEndToUse)}`;
      const response = await blingGet(url, tokenObj, {}, accountId);
      const dataArr = response.data?.data;
      if (Array.isArray(dataArr) && dataArr.length > 0) {
        allNumeros = allNumeros.concat(dataArr.map(nota => nota.numeroPedidoLoja).filter(Boolean));
        if (dataArr.length < 100) break;
        page++;
      } else {
        break;
      }
    }
    res.json({ numerosPedidoLoja: allNumeros });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar numeroPedidoLoja', details: err.response?.data || err.message });
  }
});

// Endpoint para obter todos os dados brutos de uma nota fiscal específica (NF-e)
app.get('/api/bling/nota-fiscal/:idNotaFiscal', async (req, res) => {
  try {
    const accountId = getAccountIdFromReq(req);
    const tokenObj = await refreshTokenIfNeeded(accountId);
    if (!tokenObj || !tokenObj.access_token) {
      return res.status(401).json({ error: 'Não autenticado no Bling.' });
    }
    const { idNotaFiscal } = req.params;
    const url = `${BLING_API_BASE}/nfe/${idNotaFiscal}`;
    const response = await blingGet(url, tokenObj, {}, accountId);
    return res.json({ data: response.data });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar nota fiscal', details: err.response?.data || err.message });
  }
});

// Endpoint para salvar nota expedida
app.post('/api/notas-expedidas', (req, res) => {
  const { id, numero, codigo, numeroLoja, cliente, valorNota, itens, marketplace, desconto } = req.body;
  const accountId = getAccountIdFromReq(req);
  if (!id || !numero) {
    return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
  }
  addLog('INFO', 'EXPEDIÇÃO', `Nota expedida: nº${numero} cliente="${cliente || 'N/A'}" valor=R$${valorNota || 0} itens=${Array.isArray(itens) ? itens.length : 0}`);
  db.serialize(() => {
    // Garante existência do registro e atualiza dados (idempotente)
    db.run(`INSERT OR IGNORE INTO notas_expedidas (id, account_id, dataExpedicao) VALUES (?, ?, CURRENT_TIMESTAMP)`, [id, accountId], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      const mk = marketplace || identificarMarketplace(numeroLoja, Array.isArray(itens) ? itens : []);
      db.run(`UPDATE notas_expedidas SET numero = ?, codigo = ?, numeroLoja = ?, cliente = ?, valorNota = ?, marketplace = ?, desconto = COALESCE(?, desconto), account_id = ?` + ` WHERE id = ?`,
        [numero, codigo || null, numeroLoja || null, cliente || null, valorNota || 0, mk || null, desconto || 0, accountId, id], function(err2) {
          if (err2) return res.status(500).json({ error: err2.message });
          // Se vierem itens, salvar SKUs e quantidades
          if (Array.isArray(itens) && itens.length > 0) {
            const stmt = db.prepare(`INSERT INTO nota_itens_expedidos (nota_id, account_id, sku, quantidade, title) VALUES (?, ?, ?, ?, ?)`);
            for (const item of itens) {
              const sku = (item && (item.codigo || item.sku || '')).toString();
              const qtd = parseInt(item.quantidade || item.qtd || item.quantity || 0) || 0;
              const title = item.title || item.titulo || null;
              if (!sku || qtd <= 0) continue;
              stmt.run([id, accountId, sku, qtd, title]);
            }
            stmt.finalize();
          }
          res.json({ success: true });
        });
    });
  });
});

// Endpoint para "claim" de expedição (evita dupla movimentação)
// Tenta reservar a nota antes de iniciar qualquer movimentação; idempotente e atômico
// TTL de locks em minutos
const LOCK_TTL_MINUTES = 10;

// --- SSE para broadcast de locks de notas ---
const sseLockClients = new Set(); // { res, accountId }

function broadcastLocksSnapshot(accountId) {
  // Limpar expirados e enviar snapshot atual para clientes da mesma conta
  db.run(`DELETE FROM notas_exp_locks WHERE account_id = ? AND created_at < datetime('now', ? || ' minutes')`, [
    accountId,
    `-${LOCK_TTL_MINUTES}`
  ], function () {
    db.all(`SELECT nota_id FROM notas_exp_locks WHERE account_id = ?`, [accountId], (err, rows) => {
      const ids = (!err && Array.isArray(rows)) ? rows.map(r => r.nota_id) : [];
      const payload = `data: ${JSON.stringify({ accountId, locks: ids })}\n\n`;
      for (const client of sseLockClients) {
        if (client.accountId !== accountId) continue;
        try { client.res.write(payload); } catch (_) {}
      }
    });
  });
}

app.get('/api/notas-expedidas/locks/stream', (req, res) => {
  const accountId = getAccountIdFromReq(req);
  // Para compatibilidade com HTTP/2 (Fly.io), não envie o header 'Connection'
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, max-age=0, must-revalidate, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.flushHeaders) res.flushHeaders();
  const client = { res, accountId };
  sseLockClients.add(client);
  // Enviar snapshot inicial
  db.all(`SELECT nota_id FROM notas_exp_locks WHERE account_id = ?`, [accountId], (err, rows) => {
    const ids = (!err && Array.isArray(rows)) ? rows.map(r => r.nota_id) : [];
    res.write(`data: ${JSON.stringify({ accountId, locks: ids })}\n\n`);
  });
  const keep = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch(_) {} }, 25000);
  req.on('close', () => { clearInterval(keep); sseLockClients.delete(client); try { res.end(); } catch(_) {} });
});

app.post('/api/notas-expedidas/claim', (req, res) => {
  const { id } = req.body;
  const owner = (req.body && req.body.owner) ? String(req.body.owner) : null;
  const accountId = getAccountIdFromReq(req);
  if (!id) return res.status(400).json({ error: 'id é obrigatório' });
  // 1) Se já estiver expedida, não permite claim
  const includeNull = Number(accountId) === defaultBlingAccountId;
  const checkSql = includeNull
    ? `SELECT 1 FROM notas_expedidas WHERE id = ? AND (account_id = ? OR account_id IS NULL) LIMIT 1`
    : `SELECT 1 FROM notas_expedidas WHERE id = ? AND account_id = ? LIMIT 1`;
  db.get(checkSql, [id, accountId], (errCheck, row) => {
    if (errCheck) return res.status(500).json({ error: errCheck.message });
    if (row) return res.json({ claimed: false, alreadyExpedited: true });
    // 2) Limpar locks antigos (TTL)
    db.run(`DELETE FROM notas_exp_locks WHERE account_id = ? AND created_at < datetime('now', ? || ' minutes')`, [
      accountId,
      `-${LOCK_TTL_MINUTES}`
    ], function(cleanErr) {
      if (cleanErr && !String(cleanErr.message || '').includes('no such table')) {
        return res.status(500).json({ error: cleanErr.message });
      }
      // 3) Garantir tabela/coluna owner (ignorar erro se já existir)
      db.run(`CREATE TABLE IF NOT EXISTS notas_exp_locks (nota_id INTEGER PRIMARY KEY, account_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`, () => {});
      db.all(`PRAGMA table_info(notas_exp_locks)`, (tiErr, cols) => {
        if (!tiErr && Array.isArray(cols)) {
          if (!cols.some(c => c.name === 'owner')) {
            db.run(`ALTER TABLE notas_exp_locks ADD COLUMN owner TEXT`, (alterErr) => {
              if (alterErr) console.warn('[LOCKS] Falha ao adicionar coluna owner (ok se já existir):', alterErr.message);
            });
          }
          if (!cols.some(c => c.name === 'account_id')) {
            db.run(`ALTER TABLE notas_exp_locks ADD COLUMN account_id INTEGER`, (alterErr) => {
              if (alterErr) console.warn('[LOCKS] Falha ao adicionar coluna account_id (ok se já existir):', alterErr.message);
            });
          }
        }
      });
      // 4) Se já houver lock da mesma owner, renovar TTL (idempotente)
      if (owner) {
        db.get(`SELECT owner FROM notas_exp_locks WHERE nota_id = ? AND account_id = ?`, [id, accountId], (selErr, lockRow) => {
          if (!selErr && lockRow && lockRow.owner === owner) {
            return db.run(`UPDATE notas_exp_locks SET created_at = CURRENT_TIMESTAMP WHERE nota_id = ? AND account_id = ?`, [id, accountId], function(updErr){
              if (updErr) return res.status(500).json({ error: updErr.message });
              return res.json({ claimed: true, alreadyOwned: true });
            });
          }
          // declarar a função antes de chamar para evitar hoisting issues
          const doInsert = () => db.run(`INSERT OR IGNORE INTO notas_exp_locks (nota_id, account_id, created_at, owner) VALUES (?, ?, CURRENT_TIMESTAMP, ?)`, [id, accountId, owner], function(err) {
            if (err && err.message.includes('no such table: notas_exp_locks')) {
              db.run(`CREATE TABLE IF NOT EXISTS notas_exp_locks (nota_id INTEGER PRIMARY KEY, account_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, owner TEXT)`, (e2) => {
                if (e2) return res.status(500).json({ error: e2.message });
                db.run(`INSERT OR IGNORE INTO notas_exp_locks (nota_id, account_id, created_at, owner) VALUES (?, ?, CURRENT_TIMESTAMP, ?)`, [id, accountId, owner], function(e3) {
                  if (e3) return res.status(500).json({ error: e3.message });
                  return res.json({ claimed: this.changes === 1 });
                });
              });
              return;
            }
            if (err) return res.status(500).json({ error: err.message });
            res.json({ claimed: this.changes === 1 });
          });
          return doInsert();
        });
        return;
      }
      // 5) Tentar criar tabela de locks se não existir e adquirir o lock
      db.run(`INSERT OR IGNORE INTO notas_exp_locks (nota_id, account_id, created_at, owner) VALUES (?, ?, CURRENT_TIMESTAMP, ?)`, [id, accountId, owner], function(err) {
      if (err && err.message.includes('no such table: notas_exp_locks')) {
      // Criar tabela de locks na primeira execução
        db.run(`CREATE TABLE IF NOT EXISTS notas_exp_locks (nota_id INTEGER PRIMARY KEY, account_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, owner TEXT)`, (e2) => {
        if (e2) return res.status(500).json({ error: e2.message });
        // Tentar novamente
          db.run(`INSERT OR IGNORE INTO notas_exp_locks (nota_id, account_id, created_at, owner) VALUES (?, ?, CURRENT_TIMESTAMP, ?)`, [id, accountId, owner], function(e3) {
          if (e3) return res.status(500).json({ error: e3.message });
          return res.json({ claimed: this.changes === 1 });
        });
      });
        return;
      }
      if (err) return res.status(500).json({ error: err.message });
      const ok = this.changes === 1;
      if (ok) broadcastLocksSnapshot(accountId);
      res.json({ claimed: ok });
      });
    });
  });
});

// Endpoint em lote para claim (reduz latência no "selecionar todos")
app.post('/api/notas-expedidas/claim/batch', (req, res) => {
  const { ids, owner } = req.body || {};
  const accountId = getAccountIdFromReq(req);
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids é obrigatório' });
  }
  const results = {};

  // Limpa expirados e garante tabela/coluna antes de iniciar o loop
  db.run(`DELETE FROM notas_exp_locks WHERE account_id = ? AND created_at < datetime('now', ? || ' minutes')`, [
    accountId,
    `-${LOCK_TTL_MINUTES}`
  ], function () {
    db.run(`CREATE TABLE IF NOT EXISTS notas_exp_locks (nota_id INTEGER PRIMARY KEY, account_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`, () => {
      db.all(`PRAGMA table_info(notas_exp_locks)`, (tiErr, cols) => {
        if (!tiErr && Array.isArray(cols)) {
          if (!cols.some(c => c.name === 'owner')) {
            db.run(`ALTER TABLE notas_exp_locks ADD COLUMN owner TEXT`, () => {});
          }
          if (!cols.some(c => c.name === 'account_id')) {
            db.run(`ALTER TABLE notas_exp_locks ADD COLUMN account_id INTEGER`, () => {});
          }
        }

        const processNext = (index) => {
          if (index >= ids.length) {
            // terminar
            broadcastLocksSnapshot(accountId);
            const claimed = [], alreadyExpedited = [], locked = [];
            Object.entries(results).forEach(([k, v]) => {
              if (v.alreadyExpedited) alreadyExpedited.push(Number(k));
              else if (v.claimed) claimed.push(Number(k));
              else locked.push(Number(k));
            });
            return res.json({ results, claimed, alreadyExpedited, locked });
          }
          const id = ids[index];
          // 1) Se já estiver expedida, marca e segue
          db.get(`SELECT 1 FROM notas_expedidas WHERE id = ? AND account_id = ? LIMIT 1`, [id, accountId], (errCheck, row) => {
            if (errCheck) {
              results[id] = { claimed: false, error: errCheck.message };
              return processNext(index + 1);
            }
            if (row) {
              results[id] = { claimed: false, alreadyExpedited: true };
              return processNext(index + 1);
            }
            // 2) Se já houver lock da mesma owner, renovar TTL
            if (owner) {
              db.get(`SELECT owner FROM notas_exp_locks WHERE nota_id = ? AND account_id = ?`, [id, accountId], (selErr, lockRow) => {
                if (!selErr && lockRow && lockRow.owner === String(owner)) {
                  return db.run(`UPDATE notas_exp_locks SET created_at = CURRENT_TIMESTAMP WHERE nota_id = ? AND account_id = ?`, [id, accountId], function(updErr){
                    if (updErr) {
                      results[id] = { claimed: false, error: updErr.message };
                    } else {
                      results[id] = { claimed: true, alreadyOwned: true };
                    }
                    return processNext(index + 1);
                  });
                }
                // 3) Tenta inserir lock (irá falhar se já houver de outro owner)
                db.run(`INSERT OR IGNORE INTO notas_exp_locks (nota_id, account_id, created_at, owner) VALUES (?, ?, CURRENT_TIMESTAMP, ?)`, [id, accountId, String(owner || '')], function (insErr) {
                  if (insErr) {
                    results[id] = { claimed: false, error: insErr.message };
                  } else {
                    results[id] = { claimed: this.changes === 1 };
                  }
                  return processNext(index + 1);
                });
              });
            } else {
              db.run(`INSERT OR IGNORE INTO notas_exp_locks (nota_id, account_id, created_at, owner) VALUES (?, ?, CURRENT_TIMESTAMP, ?)`, [id, accountId, null], function (insErr) {
                if (insErr) {
                  results[id] = { claimed: false, error: insErr.message };
                } else {
                  results[id] = { claimed: this.changes === 1 };
                }
                return processNext(index + 1);
              });
            }
          });
        };
        processNext(0);
      });
    });
  });
});

// Endpoint para liberar lock (após sucesso ou cancelamento)
app.post('/api/notas-expedidas/release', (req, res) => {
  const { id } = req.body;
  const owner = (req.body && req.body.owner) ? String(req.body.owner) : null;
  const accountId = getAccountIdFromReq(req);
  if (!id) return res.status(400).json({ error: 'id é obrigatório' });
  // Compat: permitir liberar locks antigos sem owner (owner IS NULL)
  const query = owner
    ? `DELETE FROM notas_exp_locks WHERE nota_id = ? AND account_id = ? AND (owner = ? OR owner IS NULL)`
    : `DELETE FROM notas_exp_locks WHERE nota_id = ? AND account_id = ?`;
  const params = owner ? [id, accountId, owner] : [id, accountId];
  db.run(query, params, function(err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes > 0) broadcastLocksSnapshot(accountId);
    res.json({ released: this.changes >= 0 });
  });
});

// Endpoint em lote para release
app.post('/api/notas-expedidas/release/batch', (req, res) => {
  const { ids, owner } = req.body || {};
  const accountId = getAccountIdFromReq(req);
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids é obrigatório' });
  }
  const results = {};
  const query = owner
    ? `DELETE FROM notas_exp_locks WHERE nota_id = ? AND account_id = ? AND (owner = ? OR owner IS NULL)`
    : `DELETE FROM notas_exp_locks WHERE nota_id = ? AND account_id = ?`;
  const processNext = (index) => {
    if (index >= ids.length) {
      broadcastLocksSnapshot(accountId);
      return res.json({ results });
    }
    const id = ids[index];
    const params = owner ? [id, accountId, String(owner)] : [id, accountId];
    db.run(query, params, function(err) {
      if (err) {
        results[id] = { released: false, error: err.message };
      } else {
        results[id] = { released: this.changes >= 0 };
      }
      processNext(index + 1);
    });
  };
  processNext(0);
});

// Endpoint para listar locks ativos (para feedback no frontend)
app.get('/api/notas-expedidas/locks', (req, res) => {
  const accountId = getAccountIdFromReq(req);
  // também limpa locks antigos ao consultar
  db.run(`DELETE FROM notas_exp_locks WHERE account_id = ? AND created_at < datetime('now', ? || ' minutes')`, [
    accountId,
    `-${LOCK_TTL_MINUTES}`
  ], function(cleanErr) {
    if (cleanErr && !String(cleanErr.message || '').includes('no such table')) {
      return res.status(500).json({ error: cleanErr.message });
    }
    db.all(`SELECT nota_id FROM notas_exp_locks WHERE account_id = ?`, [accountId], (err, rows) => {
      if (err && !String(err.message || '').includes('no such table')) {
        return res.status(500).json({ error: err.message });
      }
      const ids = Array.isArray(rows) ? rows.map(r => r.nota_id) : [];
      res.json({ accountId, locks: ids });
    });
  });
});

// Endpoint para manter vivo um lock do mesmo owner (heartbeat)
app.post('/api/notas-expedidas/touch', (req, res) => {
  const { id, owner } = req.body || {};
  const accountId = getAccountIdFromReq(req);
  if (!id || !owner) return res.status(400).json({ error: 'id e owner são obrigatórios' });
  db.run(`UPDATE notas_exp_locks SET created_at = CURRENT_TIMESTAMP WHERE nota_id = ? AND account_id = ? AND owner = ?`, [id, accountId, String(owner)], function(err){
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes > 0) broadcastLocksSnapshot(accountId);
    res.json({ touched: this.changes === 1 });
  });
});

// CRUD simples de fotos dos SKUs
app.post('/api/inventory/:sku/image', (req, res) => {
  const sku = String(req.params.sku || '').trim();
  const { mime, image_base64 } = req.body || {};
  if (!sku || !mime || !image_base64) return res.status(400).json({ error: 'sku, mime e image_base64 são obrigatórios' });
  db.run(`INSERT INTO inventory_images (sku, mime, image_base64, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(sku) DO UPDATE SET mime = excluded.mime, image_base64 = excluded.image_base64, updated_at = CURRENT_TIMESTAMP`,
    [sku, mime, image_base64], function(err){
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
});

app.get('/api/inventory/:sku/image', (req, res) => {
  const sku = String(req.params.sku || '').trim();
  db.get(`SELECT mime, image_base64 FROM inventory_images WHERE sku = ?`, [sku], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Imagem não encontrada' });
    res.json(row);
  });
});

// Exportar todas as imagens em CSV (sku,mime,base64)
app.get('/api/inventory/images/export-csv', (req, res) => {
  db.all(`SELECT sku, mime, image_base64 FROM inventory_images`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const header = 'SKU,MIME,BASE64\n';
    const csv = header + (rows || []).map(r => {
      const sku = (r.sku || '').replace(/"/g, '""');
      const mime = (r.mime || '').replace(/"/g, '""');
      const b64 = (r.image_base64 || '').replace(/\n/g, '');
      return `"${sku}","${mime}","${b64}"`;
    }).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="inventory_images.csv"');
    res.send(csv);
  });
});

// Importar imagens em lote (JSON array [{sku,mime,image_base64}])
app.post('/api/inventory/images/bulk', (req, res) => {
  const items = Array.isArray(req.body) ? req.body : (Array.isArray(req.body?.items) ? req.body.items : []);
  if (!items || items.length === 0) return res.status(400).json({ error: 'Lista de imagens vazia' });
  const stmt = db.prepare(`INSERT INTO inventory_images (sku, mime, image_base64, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(sku) DO UPDATE SET mime = excluded.mime, image_base64 = excluded.image_base64, updated_at = CURRENT_TIMESTAMP`);
  let ok = 0, fail = 0;
  for (const it of items) {
    const sku = String(it?.sku || '').trim();
    const mime = String(it?.mime || '').trim();
    const image_base64 = String(it?.image_base64 || '').trim();
    if (!sku || !mime || !image_base64) { fail++; continue; }
    try { stmt.run([sku, mime, image_base64]); ok++; } catch { fail++; }
  }
  try { stmt.finalize(); } catch {}
  res.json({ imported: ok, failed: fail });
});

// Endpoint para listar ids das notas expedidas
app.get('/api/notas-expedidas', (req, res) => {
  const accountId = getAccountIdFromReq(req);
  const includeNull = Number(accountId) === defaultBlingAccountId;
  const sql = includeNull
    ? 'SELECT id FROM notas_expedidas WHERE account_id = ? OR account_id IS NULL'
    : 'SELECT id FROM notas_expedidas WHERE account_id = ?';
  db.all(sql, [accountId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    // Retornar IDs como strings para comparação consistente (notas_fiscais usa TEXT, notas_expedidas usa INTEGER)
    res.json({ expedidas: rows.map(r => String(r.id)) });
  });
});

// Consulta de nota por numero ou numeroLoja (para uso em Expedição)
app.get('/api/notas-expedidas/consulta', (req, res) => {
  const termo = String(req.query.termo || '').trim();
  const accountId = getOptionalAccountIdFromReq(req);
  if (!termo) return res.status(400).json({ error: 'Parâmetro termo é obrigatório' });
  let whereSql = '';
  let params = [termo, termo];
  if (accountId) {
    const includeNull = Number(accountId) === defaultBlingAccountId;
    whereSql = includeNull ? `(account_id = ? OR account_id IS NULL) AND` : `account_id = ? AND`;
    params = [accountId, termo, termo];
  }
  db.get(`SELECT * FROM notas_expedidas WHERE ${whereSql} (numero = ? OR numeroLoja = ?) ORDER BY datetime(dataExpedicao) DESC LIMIT 1`, params, (err, nota) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!nota) return res.status(404).json({ error: 'Nota não encontrada' });
    const itensWhere = accountId ? (Number(accountId) === defaultBlingAccountId ? `AND (account_id = ? OR account_id IS NULL)` : `AND account_id = ?`) : '';
    const itensParams = accountId ? [nota.id, accountId] : [nota.id];
    db.all(`SELECT sku, quantidade, title FROM nota_itens_expedidos WHERE nota_id = ? ${itensWhere}`, itensParams, (e2, itens) => {
      if (e2) return res.status(500).json({ error: e2.message });
      res.json({ nota, itens: itens || [] });
    });
  });
});

// Lista de pedidos expedidos recentes com itens (para tela de Expedição)
app.get('/api/notas-expedidas/recentes', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 500);
  const date = (req.query.date || '').toString().slice(0, 10);
  const hasDate = /^\d{4}-\d{2}-\d{2}$/.test(date);
  const accountId = getOptionalAccountIdFromReq(req);
  const params = [];
  let sql = `
    SELECT n.id as nota_id, n.numero, n.numeroLoja, n.cliente, n.valorNota, n.dataExpedicao, n.account_id,
           i.sku, i.quantidade, i.title
    FROM notas_expedidas n
    LEFT JOIN nota_itens_expedidos i ON i.nota_id = n.id
  `;
  if (accountId) {
    if (Number(accountId) === defaultBlingAccountId) {
      sql += `WHERE (n.account_id = ? OR n.account_id IS NULL) `;
    } else {
      sql += `WHERE n.account_id = ? `;
    }
    params.push(accountId);
  } else {
    sql += `WHERE 1=1 `;
  }
  if (hasDate) {
    sql += `AND date(n.dataExpedicao) = ? `;
    params.push(date);
  }
  sql += `ORDER BY datetime(n.dataExpedicao) DESC `;
  if (!hasDate) {
    sql += `LIMIT ?`;
    params.push(limit);
  }
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!hasDate) return res.json({ data: rows || [], daily_total: null });
    let totalSql = `SELECT SUM(valorNota) as total FROM notas_expedidas WHERE date(dataExpedicao) = ? AND UPPER(REPLACE(COALESCE(cliente,''), '.', '')) NOT LIKE '%EBAZARCOMBR LTDA%'`;
    const totalParams = [date];
    if (accountId) {
      totalSql += Number(accountId) === defaultBlingAccountId
        ? ` AND (account_id = ? OR account_id IS NULL)`
        : ` AND account_id = ?`;
      totalParams.push(accountId);
    }
    db.get(totalSql, totalParams, (e2, r2) => {
      if (e2) return res.status(500).json({ error: e2.message });
      res.json({ data: rows || [], daily_total: r2?.total || 0 });
    });
  });
});

// Endpoint para dashboard: faturamento, vendas e gráfico do mês
app.get('/api/dashboard/faturamento', async (req, res) => {
  const accountId = getOptionalAccountIdFromReq(req);
  // Datas para filtro (aceita ano/mes via query; senão usa atual)
  const now = new Date();
  const anoSel = parseInt(req.query.ano, 10) || now.getFullYear();
  const mesSelNum = parseInt(req.query.mes, 10) || (now.getMonth() + 1);
  const mesSel = String(mesSelNum).padStart(2, '0');
  // Início do mês selecionado e início do mês seguinte
  const nextMonthDate = new Date(anoSel, mesSelNum, 1); // first day of next month (Date month is 0-indexed; passing mesSelNum gives next month)
  const inicioMes = `${anoSel}-${mesSel}-01 00:00:00`;
  const nextYear = nextMonthDate.getFullYear();
  const nextMonthStr = String(nextMonthDate.getMonth() + 1).padStart(2, '0');
  const inicioMesSeguinte = `${nextYear}-${nextMonthStr}-01 00:00:00`;
  const hojeAno = now.getFullYear();
  const hojeMes = String(now.getMonth() + 1).padStart(2, '0');
  const hojeDia = now.getDate().toString().padStart(2, '0');
  const inicioHoje = `${hojeAno}-${hojeMes}-${hojeDia} 00:00:00`;

  const baseSql = `SELECT * FROM notas_expedidas WHERE dataExpedicao >= ? AND dataExpedicao < ? AND UPPER(REPLACE(COALESCE(cliente,''), '.', '')) NOT LIKE '%EBAZARCOMBR LTDA%'`;
  const accountFilter = buildAccountFilter(accountId);
  const sql = baseSql + accountFilter.sql;
  const params = [inicioMes, inicioMesSeguinte, ...accountFilter.params];
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    let faturamentoMes = 0;
    let vendasMes = 0;
    let faturamentoDia = 0;
    let vendasPorDia = {};
    rows.forEach(row => {
      const valor = parseFloat(row.valorNota) || 0;
      const data = row.dataExpedicao ? row.dataExpedicao.slice(0, 10) : '';
      faturamentoMes += valor;
      vendasMes++;
      // só soma faturamento do dia se o mês/ano selecionados forem o mês/ano atual
      if (data === `${hojeAno}-${hojeMes}-${hojeDia}` && anoSel === hojeAno && mesSel === hojeMes) faturamentoDia += valor;
      if (!vendasPorDia[data]) vendasPorDia[data] = { valor: 0, quantidade: 0 };
      vendasPorDia[data].valor += valor;
      vendasPorDia[data].quantidade++;
    });
    const vendasPorDiaMes = Object.entries(vendasPorDia).map(([dia, obj]) => ({ dia, ...obj }));
    res.json({ faturamentoMes, vendasMes, faturamentoDia, vendasPorDiaMes });
  });
});

// Endpoint: Itens mais vendidos por período
// period: 'mes' (padrão), '3m'
app.get('/api/dashboard/itens-mais-vendidos', (req, res) => {
  const { period, sort, dataInicio, dataFim } = req.query;
  const accountId = getOptionalAccountIdFromReq(req);
  let inicioPeriodoSql;
  if (dataInicio && dataFim) {
    inicioPeriodoSql = `'${dataInicio} 00:00:00'`;
  } else if (period === '3m') {
    inicioPeriodoSql = `datetime('now','-3 months')`;
  } else {
    // início do mês atual
    const now = new Date();
    const ano = now.getFullYear();
    const mes = String(now.getMonth() + 1).padStart(2, '0');
    inicioPeriodoSql = `'${ano}-${mes}-01 00:00:00'`;
  }
  const fimPeriodoSql = dataInicio && dataFim ? `'${dataFim} 23:59:59'` : `datetime('now','localtime')`;
  const orderSql = sort === 'pedidos' || sort === 'quantidade'
    ? 'total_quantidade DESC, faturamento DESC'
    : 'faturamento DESC, total_quantidade DESC';

  // Normalização: agrupar por SKU limpo (sem letras finais) e converter kits simples para seu componente
  (async () => {
    try {
      const accountFilter = buildAccountFilter(accountId, 'n.account_id');
      const accountFilterSql = accountFilter.sql;
      const accountParams = accountFilter.params;
      const rows = await dbAllAsync(
        `SELECT ni.nota_id, ni.sku AS sku_original, ni.quantidade,
                n.valorNota, n.dataExpedicao
         FROM nota_itens_expedidos ni
         JOIN notas_expedidas n ON n.id = ni.nota_id
         WHERE n.dataExpedicao >= ${inicioPeriodoSql} AND n.dataExpedicao <= ${fimPeriodoSql}
          AND UPPER(REPLACE(COALESCE(n.cliente,''), '.', '')) NOT LIKE '%EBAZARCOMBR LTDA%'${accountFilterSql}`,
        accountParams
      );

      // Pré-carregar inventário e relações de kits/compostos
      const inventory = await dbAllAsync('SELECT id, sku, title, is_composite FROM inventory');
      const skuToItem = {};
      for (const p of inventory) skuToItem[p.sku] = p;
      const relations = await dbAllAsync('SELECT main_sku_id, component_sku_id, quantity FROM composite_skus');
      const idToSku = {};
      for (const p of inventory) idToSku[p.id] = p.sku;
      const kitMap = new Map(); // mainSku -> {compSku, qty}
      for (const r of relations) {
        const mainSku = idToSku[r.main_sku_id];
        const compSku = idToSku[r.component_sku_id];
        if (!mainSku || !compSku) continue;
        const key = mainSku;
        if (!kitMap.has(key)) kitMap.set(key, []);
        kitMap.get(key).push({ compSku, qty: r.quantity });
      }

      // Primeiro, calcular quantidades convertidas por nota para rateio do valorNota
      const itensConvertidos = []; // {nota_id, normalizedSku, convertedQty, valorNota}
      const somaPorNota = new Map(); // nota_id -> total converted qty
      for (const row of rows) {
        const skuOriginal = String(row.sku_original || '');
        const skuLimpo = limparSkuFinal(skuOriginal);
        let normalizedSku = skuLimpo;
        let title = skuToItem[skuLimpo]?.title || '';
        let quantidade = Number(row.quantidade) || 0;
        let fator = 1;
        const compList = kitMap.get(skuLimpo);
        if (skuToItem[skuLimpo]?.is_composite && Array.isArray(compList) && compList.length === 1) {
          // kit simples: converter
          normalizedSku = compList[0].compSku;
          fator = Number(compList[0].qty) || 1;
          title = skuToItem[normalizedSku]?.title || title;
        }
        const convertedQty = quantidade * fator;
        itensConvertidos.push({ nota_id: row.nota_id, sku: normalizedSku, title, convertedQty, valorNota: Number(row.valorNota) || 0 });
        const soma = somaPorNota.get(row.nota_id) || 0;
        somaPorNota.set(row.nota_id, soma + convertedQty);
      }

      // Agregar com rateio do faturamento proporcional à quantidade convertida da nota
      const agg = new Map(); // normalizedSku -> {sku,title,total_quantidade,faturamento}
      for (const it of itensConvertidos) {
        const denominador = somaPorNota.get(it.nota_id) || 0;
        const parcela = denominador > 0 ? (it.valorNota * (it.convertedQty / denominador)) : 0;
        const atual = agg.get(it.sku) || { sku: it.sku, title: it.title || '', total_quantidade: 0, faturamento: 0 };
        atual.total_quantidade += it.convertedQty;
        atual.faturamento += parcela;
        if (!atual.title && it.title) atual.title = it.title;
        agg.set(it.sku, atual);
      }

      const result = Array.from(agg.values())
        .sort((a, b) => {
          if (orderSql.startsWith('faturamento')) return b.faturamento - a.faturamento || b.total_quantidade - a.total_quantidade;
          return b.total_quantidade - a.total_quantidade || b.faturamento - a.faturamento;
        })
        .slice(0, 10);
      res.json({ items: result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  })();
});

// Endpoint: Marketplaces com mais vendas (por quantidade de itens expedidos)
// period: 'mes' (padrão), '3m'
app.get('/api/dashboard/marketplaces-mais-vendas', (req, res) => {
  const { period, sort, dataInicio, dataFim } = req.query;
  const accountId = getOptionalAccountIdFromReq(req);
  let inicioPeriodoSql;
  if (dataInicio && dataFim) {
    inicioPeriodoSql = `'${dataInicio} 00:00:00'`;
  } else if (period === '3m') {
    inicioPeriodoSql = `datetime('now','-3 months')`;
  } else {
    const now = new Date();
    const ano = now.getFullYear();
    const mes = String(now.getMonth() + 1).padStart(2, '0');
    inicioPeriodoSql = `'${ano}-${mes}-01 00:00:00'`;
  }
  const fimPeriodoSql = dataInicio && dataFim ? `'${dataFim} 23:59:59'` : `datetime('now','localtime')`;
  const orderSql = sort === 'pedidos'
    ? 'pedidos DESC, faturamento DESC, itens DESC'
    : 'faturamento DESC, itens DESC, pedidos DESC';
  // Busca por nota para reclassificar marketplace com a regra mais atual
  const accountFilter = buildAccountFilter(accountId, 'n.account_id');
  const accountFilterSql = accountFilter.sql;
  const sql = `
    SELECT n.id, n.marketplace AS mk_raw, n.numeroLoja, COALESCE(n.valorNota, 0) AS faturamento,
           COALESCE(SUM(ni.quantidade), 0) AS itens
    FROM notas_expedidas n
    LEFT JOIN nota_itens_expedidos ni ON ni.nota_id = n.id
    WHERE n.dataExpedicao >= ${inicioPeriodoSql} AND n.dataExpedicao <= ${fimPeriodoSql}
      AND UPPER(REPLACE(COALESCE(n.cliente,''), '.', '')) NOT LIKE '%EBAZARCOMBR LTDA%'${accountFilterSql}
    GROUP BY n.id
  `;
  db.all(sql, accountFilter.params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const agg = new Map();
    for (const r of rows || []) {
      const mk = r.mk_raw || identificarMarketplace(String(r.numeroLoja || ''), []);
      const key = mk || 'Desconhecido';
      if (!agg.has(key)) agg.set(key, { marketplace: key, pedidos: 0, itens: 0, faturamento: 0 });
      const at = agg.get(key);
      at.pedidos += 1;
      at.itens += Number(r.itens || 0);
      at.faturamento += Number(r.faturamento || 0);
    }
    const result = Array.from(agg.values()).sort((a, b) => {
      if (orderSql.startsWith('pedidos')) return b.pedidos - a.pedidos || b.faturamento - a.faturamento || b.itens - a.itens;
      return b.faturamento - a.faturamento || b.itens - a.itens || b.pedidos - a.pedidos;
    });
    res.json({ marketplaces: result });
  });
});

// Export XLSX: Itens mais vendidos com período customizável
app.get('/api/export/itens-mais-vendidos.xlsx', async (req, res) => {
  try {
    const { period, sort, dataInicio, dataFim } = req.query;
    // Reutiliza a lógica do endpoint JSON chamando internamente via função
    req.query.period = period;
    req.query.sort = sort;
    req.query.dataInicio = dataInicio;
    req.query.dataFim = dataFim;
    // Montar os dados a partir da consulta
    const buildData = async () => new Promise((resolve, reject) => {
      // Chamar a mesma query montada acima, porém copiando o trecho essencial
      const build = (async () => {
        const { period, sort, dataInicio, dataFim } = req.query;
        let inicioPeriodoSql;
        if (dataInicio && dataFim) {
          inicioPeriodoSql = `'${dataInicio} 00:00:00'`;
        } else if (period === '3m') {
          inicioPeriodoSql = `datetime('now','-3 months')`;
        } else {
          const now = new Date();
          const ano = now.getFullYear();
          const mes = String(now.getMonth() + 1).padStart(2, '0');
          inicioPeriodoSql = `'${ano}-${mes}-01 00:00:00'`;
        }
        const fimPeriodoSql = dataInicio && dataFim ? `'${dataFim} 23:59:59'` : `datetime('now','localtime')`;

        const inventory = await dbAllAsync('SELECT id, sku, title, is_composite FROM inventory');
        const skuToItem = {};
        for (const p of inventory) skuToItem[p.sku] = p;
        const relations = await dbAllAsync('SELECT main_sku_id, component_sku_id, quantity FROM composite_skus');
        const idToSku = {};
        for (const p of inventory) idToSku[p.id] = p.sku;
        const kitMap = new Map();
        for (const r of relations) {
          const mainSku = idToSku[r.main_sku_id];
          const compSku = idToSku[r.component_sku_id];
          if (!mainSku || !compSku) continue;
          if (!kitMap.has(mainSku)) kitMap.set(mainSku, []);
          kitMap.get(mainSku).push({ compSku, qty: r.quantity });
        }

        const rows = await dbAllAsync(
          `SELECT ni.nota_id, ni.sku AS sku_original, ni.quantidade, n.valorNota, n.dataExpedicao
           FROM nota_itens_expedidos ni
           JOIN notas_expedidas n ON n.id = ni.nota_id
           WHERE n.dataExpedicao >= ${inicioPeriodoSql} AND n.dataExpedicao <= ${fimPeriodoSql}
             AND UPPER(REPLACE(COALESCE(n.cliente,''), '.', '')) NOT LIKE '%EBAZARCOMBR LTDA%'`
        );

        const itensConvertidos = [];
        const somaPorNota = new Map();
        for (const row of rows) {
          const skuOriginal = String(row.sku_original || '');
          const skuLimpo = limparSkuFinal(skuOriginal);
          let normalizedSku = skuLimpo;
          let quantidade = Number(row.quantidade) || 0;
          let fator = 1;
          const compList = kitMap.get(skuLimpo);
          if (skuToItem[skuLimpo]?.is_composite && Array.isArray(compList) && compList.length === 1) {
            normalizedSku = compList[0].compSku;
            fator = Number(compList[0].qty) || 1;
          }
          const convertedQty = quantidade * fator;
          itensConvertidos.push({ nota_id: row.nota_id, sku: normalizedSku, title: skuToItem[normalizedSku]?.title || '', convertedQty, valorNota: Number(row.valorNota) || 0 });
          const soma = somaPorNota.get(row.nota_id) || 0;
          somaPorNota.set(row.nota_id, soma + convertedQty);
        }

        const agg = new Map();
        for (const it of itensConvertidos) {
          const denominador = somaPorNota.get(it.nota_id) || 0;
          const parcela = denominador > 0 ? (it.valorNota * (it.convertedQty / denominador)) : 0;
          const atual = agg.get(it.sku) || { sku: it.sku, title: it.title || '', total_quantidade: 0, faturamento: 0 };
          atual.total_quantidade += it.convertedQty;
          atual.faturamento += parcela;
          if (!atual.title && it.title) atual.title = it.title;
          agg.set(it.sku, atual);
        }

        let result = Array.from(agg.values());
        result.sort((a, b) => (sort === 'pedidos' ? (b.total_quantidade - a.total_quantidade) : (b.faturamento - a.faturamento)) || (b.faturamento - a.faturamento));
        result = result.slice(0, 200); // exporta mais linhas no XLSX se necessário
        resolve(result);
      })().catch(reject);
    });

    const data = await buildData();
    const ws = xlsx.utils.json_to_sheet(data.map(d => ({ SKU: d.sku, Título: d.title, Quantidade: d.total_quantidade, Faturamento: Number(d.faturamento || 0).toFixed(2) })));
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'ItensMaisVendidos');
    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="itens-mais-vendidos.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: 'Falha ao exportar XLSX', details: err.message });
  }
});

// ENDPOINTS DE AGLUTINADOS
// Salvar novo aglutinado
app.post('/api/aglutinados', (req, res) => {
  const { marketplaces, conteudo_html, conteudo_json } = req.body;
  db.run(
    `INSERT INTO aglutinados (marketplaces, conteudo_html, conteudo_json) VALUES (?, ?, ?)`,
    [marketplaces, conteudo_html, conteudo_json || null],
    function (err) {
      if (err) {
        return res.status(500).json({ error: 'Erro ao salvar aglutinado.' });
      }
      res.json({ id: this.lastID });
    }
  );
});
// Listar aglutinados (data_criacao em UTC no SQLite; converter para Brasil GMT-3)
const AGLUT_TZ = process.env.REPORT_TZ_OFFSET_HOURS || '-3';
const AGLUT_MOD = `${parseInt(AGLUT_TZ, 10)} hours`;
app.get('/api/aglutinados', (req, res) => {
  db.all(
    `SELECT id, data_criacao, datetime(data_criacao, '${AGLUT_MOD}') as data_criacao_br, marketplaces FROM aglutinados ORDER BY data_criacao DESC`,
    [],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: 'Erro ao buscar aglutinados.' });
      }
      res.json(rows);
    }
  );
});
// Buscar aglutinado por id
app.get('/api/aglutinados/:id', (req, res) => {
  db.get(
    `SELECT * FROM aglutinados WHERE id = ?`,
    [req.params.id],
    (err, row) => {
      if (err || !row) {
        return res.status(404).json({ error: 'Aglutinado não encontrado.' });
      }
      res.json(row);
    }
  );
});

// ====== CRUD: Marketplace Cost Config ======
app.get('/api/reports/marketplace-cost-config', (req, res) => {
  db.all('SELECT * FROM marketplace_cost_config', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});
app.post('/api/reports/marketplace-cost-config', (req, res) => {
  const { marketplace, commission_percent, commission_fixed_per_order, commission_fixed_per_item, freight_mode, freight_fixed_per_order, freight_fixed_per_item, default_shipping_table_id, extra_fixed_per_order, commission_base } = req.body || {};
  db.run(`INSERT INTO marketplace_cost_config (marketplace, commission_percent, commission_fixed_per_order, commission_fixed_per_item, freight_mode, freight_fixed_per_order, freight_fixed_per_item, default_shipping_table_id, extra_fixed_per_order, commission_base, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [marketplace, commission_percent||0, commission_fixed_per_order||0, commission_fixed_per_item||0, freight_mode||'fixed_per_order', freight_fixed_per_order||0, freight_fixed_per_item||0, default_shipping_table_id||null, extra_fixed_per_order||0, commission_base || 'gross'], function(err){
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID });
    });
});
app.put('/api/reports/marketplace-cost-config/:id', (req, res) => {
  const id = req.params.id;
  const { marketplace, commission_percent, commission_fixed_per_order, commission_fixed_per_item, freight_mode, freight_fixed_per_order, freight_fixed_per_item, default_shipping_table_id, extra_fixed_per_order, commission_base } = req.body || {};
  db.run(`UPDATE marketplace_cost_config SET marketplace = ?, commission_percent = ?, commission_fixed_per_order = ?, commission_fixed_per_item = ?, freight_mode = ?, freight_fixed_per_order = ?, freight_fixed_per_item = ?, default_shipping_table_id = ?, extra_fixed_per_order = ?, commission_base = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [marketplace, commission_percent||0, commission_fixed_per_order||0, commission_fixed_per_item||0, freight_mode||'fixed_per_order', freight_fixed_per_order||0, freight_fixed_per_item||0, default_shipping_table_id||null, extra_fixed_per_order||0, commission_base || 'gross', id], function(err){
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
});
app.delete('/api/reports/marketplace-cost-config/:id', (req, res) => {
  db.run('DELETE FROM marketplace_cost_config WHERE id = ?', [req.params.id], function(err){
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// ====== CRUD: Shipping Tables ======
app.get('/api/reports/shipping-tables', (req, res) => {
  db.all('SELECT * FROM shipping_tables', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});
app.post('/api/reports/shipping-tables', (req, res) => {
  const { marketplace, name, rule_type, rules_json, effective_from, effective_to } = req.body || {};
  db.run(`INSERT INTO shipping_tables (marketplace, name, rule_type, rules_json, effective_from, effective_to, updated_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [marketplace, name, rule_type, JSON.stringify(rules_json || {}), effective_from || null, effective_to || null], function(err){
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID });
    });
});
app.put('/api/reports/shipping-tables/:id', (req, res) => {
  const id = req.params.id;
  const { marketplace, name, rule_type, rules_json, effective_from, effective_to } = req.body || {};
  db.run(`UPDATE shipping_tables SET marketplace = ?, name = ?, rule_type = ?, rules_json = ?, effective_from = ?, effective_to = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [marketplace, name, rule_type, JSON.stringify(rules_json || {}), effective_from || null, effective_to || null, id], function(err){
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
});
app.delete('/api/reports/shipping-tables/:id', (req, res) => {
  db.run('DELETE FROM shipping_tables WHERE id = ?', [req.params.id], function(err){
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// ====== CRUD: Item Cost Overrides ======
app.get('/api/reports/item-cost-overrides', (req, res) => {
  db.all('SELECT * FROM item_cost_overrides', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});
app.post('/api/reports/item-cost-overrides', (req, res) => {
  const { sku_id, commission_percent_override, commission_fixed_override, extra_fixed_per_item, shipping_table_id_override } = req.body || {};
  db.run(`INSERT INTO item_cost_overrides (sku_id, commission_percent_override, commission_fixed_override, extra_fixed_per_item, shipping_table_id_override, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [sku_id, commission_percent_override || null, commission_fixed_override || null, extra_fixed_per_item || null, shipping_table_id_override || null], function(err){
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID });
    });
});
app.put('/api/reports/item-cost-overrides/:id', (req, res) => {
  const id = req.params.id;
  const { sku_id, commission_percent_override, commission_fixed_override, extra_fixed_per_item, shipping_table_id_override } = req.body || {};
  db.run(`UPDATE item_cost_overrides SET sku_id = ?, commission_percent_override = ?, commission_fixed_override = ?, extra_fixed_per_item = ?, shipping_table_id_override = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [sku_id, commission_percent_override || null, commission_fixed_override || null, extra_fixed_per_item || null, shipping_table_id_override || null, id], function(err){
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
});
app.delete('/api/reports/item-cost-overrides/:id', (req, res) => {
  db.run('DELETE FROM item_cost_overrides WHERE id = ?', [req.params.id], function(err){
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// ====== Cálculo de custos (compute) ======
function getMarketplaceConfig(marketplace) {
  return new Promise((resolve) => {
    db.get('SELECT * FROM marketplace_cost_config WHERE marketplace = ? LIMIT 1', [marketplace], (err, row) => {
      if (err || !row) return resolve(null);
      resolve(row);
    });
  });
}

function getItemOverrideBySkuId(skuId) {
  return new Promise((resolve) => {
    db.get('SELECT * FROM item_cost_overrides WHERE sku_id = ? LIMIT 1', [skuId], (err, row) => {
      if (err || !row) return resolve(null);
      resolve(row);
    });
  });
}

function getShippingTableById(id) {
  return new Promise((resolve) => {
    db.get('SELECT * FROM shipping_tables WHERE id = ? LIMIT 1', [id], (err, row) => {
      if (err || !row) return resolve(null);
      resolve(row);
    });
  });
}

function parseRules(jsonStr) {
  try { return typeof jsonStr === 'string' ? JSON.parse(jsonStr) : (jsonStr || {}); } catch { return {}; }
}

async function chooseShippingTableByPrice(marketplace, faturamentoBase) {
  // Heurística: procurar em shipping_tables do marketplace nomes que contenham faixas em R$
  const rows = await dbAllAsync(`SELECT * FROM shipping_tables WHERE marketplace = ? AND rule_type = 'weight_band'`, [marketplace]);
  if (!rows || rows.length === 0) return null;
  const price = Number(faturamentoBase || 0);
  let candidate = null;
  for (const r of rows) {
    const name = (r.name || '').toLowerCase();
    // Padrões: "R$79-99", "79 a 99", "maior que 200"
    const range = name.match(/r?\$?\s*(\d+[\,\.]?\d*)\s*(?:-|a|até)\s*(\d+[\,\.]?\d*)/i);
    const maior = name.match(/maior.*(\d+[\,\.]?\d*)/i);
    if (range) {
      const min = Number(range[1].replace(',', '.'));
      const max = Number(range[2].replace(',', '.'));
      if (!isNaN(min) && !isNaN(max) && price >= min && price <= max) { candidate = r; break; }
    } else if (maior) {
      const min = Number(maior[1].replace(',', '.'));
      if (!isNaN(min) && price > min) { candidate = r; break; }
    }
  }
  return candidate || rows[0];
}

async function computeFreight({ config, tableId, marketplace, totalQty, totalWeight, faturamentoBase }) {
  if (!config) return 0;
  const mode = config.freight_mode || 'fixed_per_order';
  if (mode === 'fixed_per_order') return Number(config.freight_fixed_per_order || 0);
  if (mode === 'fixed_per_item') return Number(config.freight_fixed_per_item || 0) * (totalQty || 0);
  if (mode === 'table') {
    let table = null;
    if (tableId) table = await getShippingTableById(tableId);
    if (!table && marketplace) {
      // Se houver múltiplas tabelas por preço, escolher pela faixa
      table = await chooseShippingTableByPrice(marketplace, faturamentoBase);
    }
    if (!table) table = await getShippingTableById(config.default_shipping_table_id);
    if (!table) return 0;
    const rules = parseRules(table.rules_json);
    if (table.rule_type === 'per_item') {
      const price = Number(rules.pricePerItem || 0);
      return price * (totalQty || 0);
    }
    if (table.rule_type === 'quantity_band') {
      const bands = Array.isArray(rules) ? rules : (rules.bands || []);
      const qty = totalQty || 0;
      const band = bands.find(b => qty >= Number(b.min || 0) && qty <= Number(b.max || Infinity));
      return Number(band?.price || 0);
    }
    if (table.rule_type === 'weight_band') {
      const bands = Array.isArray(rules) ? rules : (rules.bands || []);
      const w = totalWeight || 0;
      const band = bands.find(b => w >= Number(b.min || 0) && w <= Number(b.max || Infinity));
      return Number(band?.price || 0);
    }
    if (table.rule_type === 'volume_band') {
      const bands = Array.isArray(rules) ? rules : (rules.bands || []);
      const v = (totalWeight || 0); // aqui reaproveitamos o acumulador; será calculado como volume em m³ no compute
      const band = bands.find(b => v >= Number(b.min || 0) && v <= Number(b.max || Infinity));
      return Number(band?.price || 0);
    }
  }
  return 0;
}

app.post('/api/reports/costs/compute', async (req, res) => {
  const { dataInicio, dataFim, marketplace } = req.body || {};
  try {
    const where = [];
    const params = [];
    if (dataInicio) { where.push('dataExpedicao >= ?'); params.push(dataInicio); }
    if (dataFim) { where.push('dataExpedicao <= ?'); params.push(dataFim); }
    if (marketplace) { where.push('marketplace = ?'); params.push(marketplace); }
    const sqlNotas = `SELECT * FROM notas_expedidas ${where.length? 'WHERE ' + where.join(' AND ') : ''} ${where.length? ' AND ' : 'WHERE '} UPPER(REPLACE(COALESCE(cliente,''), '.', '')) NOT LIKE '%EBAZARCOMBR LTDA%'`;
    const notas = await dbAllAsync(sqlNotas, params);

    // Limpar caches do período (simples)
    for (const n of notas) {
      await new Promise(r => db.run('DELETE FROM order_costs WHERE nota_id = ?', [n.id], () => r()));
      await new Promise(r => db.run('DELETE FROM order_item_costs WHERE nota_id = ?', [n.id], () => r()));
    }

    for (const n of notas) {
      const marketplace = n.marketplace || 'Desconhecido';
      const cfg = await getMarketplaceConfig(marketplace);
      // Configs específicas para ML x ML Clássico (sufixo B no SKU)
      const isMlFamily = /^mercado livre/i.test(String(marketplace || ''));
      let cfgMl = null;
      let cfgMlClassico = null;
      if (isMlFamily) {
        try { cfgMl = await getMarketplaceConfig('Mercado Livre'); } catch {}
        try { cfgMlClassico = await getMarketplaceConfig('Mercado Livre Clássico'); } catch {}
      }
      const itens = await dbAllAsync('SELECT * FROM nota_itens_expedidos WHERE nota_id = ?', [n.id]);
      const totalQty = itens.reduce((a, i) => a + Number(i.quantidade || 0), 0);
      const faturamento = Number(n.valorNota || 0);
      const desconto = Number(n.desconto || 0);
      const faturamentoBase = Math.max(0, faturamento - desconto);
      const commissionPercentGlobal = Number(cfg?.commission_percent || 0) / 100;
      const commissionFixedOrder = Number(cfg?.commission_fixed_per_order || 0);
      const commissionFixedPerItemGlobal = Number(cfg?.commission_fixed_per_item || 0);
      const extraFixedOrder = Number(cfg?.extra_fixed_per_order || 0);

      // Receita por item por rateio de quantidade
      const receitaPorItem = itens.map(i => ({ nota_id: n.id, sku: i.sku, quantidade: Number(i.quantidade||0), receita_item: totalQty>0 ? faturamentoBase * (Number(i.quantidade||0)/totalQty) : 0 }));

      // Cálculo de frete: parte por-item explícita e parte rateada
      // totalWeight: soma de peso real (kg) OU volume (m³) conforme tabela; aqui calculamos ambos
      let totalWeight = 0; // kg
      let totalVolume = 0; // m³
      for (const i of itens) {
        const inv = await dbAllAsync('SELECT cubic_weight, weight_kg, height_cm, width_cm, length_cm FROM inventory WHERE sku = ? LIMIT 1', [i.sku]);
        const row = inv[0] || {};
        const qtd = Number(i.quantidade || 0);
        const weight = Number(row.weight_kg || 0);
        const h = Number(row.height_cm || 0) / 100;
        const w = Number(row.width_cm || 0) / 100;
        const l = Number(row.length_cm || 0) / 100;
        const volume = (h > 0 && w > 0 && l > 0) ? (h * w * l) : 0;
        totalWeight += weight * qtd;
        totalVolume += volume * qtd;
        // fallback: se não houver medidas, usa cubic_weight como proxy de kg
        if ((weight || 0) === 0 && Number(row.cubic_weight || 0) > 0) {
          totalWeight += Number(row.cubic_weight || 0) * qtd;
        }
      }
      let freightTotalBase = await computeFreight({ config: cfg, tableId: null, marketplace, totalQty, totalWeight, faturamentoBase });
      let freightExplicitSum = 0;

      // Cálculo por item (overrides)
      const itemsDetail = [];
      for (const rItem of receitaPorItem) {
        // Buscar inventory para sku_id e cost_price
        const invRow = await dbAllAsync('SELECT id, cost_price FROM inventory WHERE sku = ? LIMIT 1', [rItem.sku]);
        const invId = invRow[0]?.id || null;
        const costPrice = Number(invRow[0]?.cost_price || 0);
        const override = invId ? await getItemOverrideBySkuId(invId) : null;

        // Comissão: escolher config por SKU para ML/ML Clássico
        let cfgForItem = cfg;
        if (isMlFamily) {
          const isClassic = /b$/i.test(String(rItem.sku || '').trim());
          cfgForItem = isClassic ? (cfgMlClassico || cfg) : (cfgMl || cfg);
        }
        const commissionPercentBase = Number(cfgForItem?.commission_percent ?? commissionPercentGlobal ?? 0) / 100;
        const p = (override?.commission_percent_override != null)
          ? (Number(override.commission_percent_override) / 100)
          : commissionPercentBase;
        const commissionBase = (cfg?.commission_base || 'gross');
        const baseValue = (commissionBase === 'gross') ? rItem.receita_item : rItem.receita_item; // extensível para outras bases
        const commissionPercentValueItem = baseValue * p;
        const commissionFixedPerItemCfg = Number(cfgForItem?.commission_fixed_per_item ?? commissionFixedPerItemGlobal ?? 0);
        const commissionFixedItem = (commissionFixedPerItemCfg * rItem.quantidade) + (override?.commission_fixed_override ? Number(override.commission_fixed_override) * rItem.quantidade : 0);

        // Frete por item explícito
        let freightItemExplicit = 0;
        const tableOverrideId = override?.shipping_table_id_override || null;
        if ((cfg?.freight_mode === 'fixed_per_item') || (cfg?.freight_mode === 'table')) {
          // Se tabela do marketplace for per_item ou override por item, tentar avaliar preço por item
          let tableToUse = null;
          if (tableOverrideId) {
            tableToUse = await getShippingTableById(tableOverrideId);
          } else if (cfg?.freight_mode === 'table') {
            tableToUse = await getShippingTableById(cfg.default_shipping_table_id);
          }
          if (cfg?.freight_mode === 'fixed_per_item') {
            freightItemExplicit = Number(cfg?.freight_fixed_per_item || 0) * rItem.quantidade;
          } else if (tableToUse && tableToUse.rule_type === 'per_item') {
            const rules = parseRules(tableToUse.rules_json);
            const price = Number(rules.pricePerItem || 0);
            freightItemExplicit = price * rItem.quantidade;
          }
        }
        freightExplicitSum += freightItemExplicit;

        itemsDetail.push({
          ...rItem,
          invId,
          costPrice,
          override,
          commissionPercentValueItem,
          commissionFixedItem,
          freightItemExplicit
        });
      }

      // Comissão fixa por pedido e parte do frete/extra por pedido serão rateados
      const commissionPercentValue = faturamentoBase * commissionPercent; // base global (fallback)
      const commissionFixedOrderTotal = commissionFixedOrder;

      // COGS (inventory.cost_price)
      const cogsTotal = itemsDetail.reduce((a, it) => a + (it.costPrice * it.quantidade), 0);

      const extraFixedTotal = extraFixedOrder; // por pedido
      // Total de comissão: soma das comissões item (percent + fixo por item) + fixo por pedido proporcional
      const commissionItemsSum = itemsDetail.reduce((a, it) => a + it.commissionPercentValueItem + it.commissionFixedItem, 0);
      const commissionTotal = commissionItemsSum + commissionFixedOrderTotal;

      // Frete total já inclui parte por item explícita e/ou por pedido
      const freightTotal = freightTotalBase; // pode ser per_order, per_item (já depende do modo)
      const gross = faturamentoBase - (commissionTotal + freightTotal + extraFixedTotal + cogsTotal);
      const grossPct = faturamentoBase > 0 ? (gross / faturamentoBase) * 100 : 0;

      await new Promise(r => db.run(
        `INSERT INTO order_costs (nota_id, marketplace, total_itens, faturamento, commission, freight, extra_fixed, cogs, gross_margin, gross_margin_percent, computed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [n.id, marketplace, totalQty, faturamentoBase, commissionTotal, freightTotal, extraFixedTotal, cogsTotal, gross, grossPct], () => r()));

      // Gravar itens: usar comissões explícitas e ratear os componentes por pedido
      const freightToRate = Math.max(0, freightTotal - freightExplicitSum);
      for (const it of itemsDetail) {
        const share = faturamentoBase > 0 ? (it.receita_item / faturamentoBase) : 0;
        const commissionItem = it.commissionPercentValueItem + it.commissionFixedItem + (commissionFixedOrderTotal * share);
        const freightItem = it.freightItemExplicit + (freightToRate * share);
        const extraItem = extraFixedTotal * share;
        const cp = it.costPrice * it.quantidade;
        const gm = it.receita_item - (commissionItem + freightItem + extraItem + cp);
        const gmPct = it.receita_item > 0 ? (gm / it.receita_item) * 100 : 0;
        await new Promise(r => db.run(
          `INSERT INTO order_item_costs (nota_id, sku, quantidade, receita_item, commission_item, freight_item, extra_fixed_item, cogs_item, gross_margin_item, gross_margin_item_percent)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [it.nota_id, it.sku, it.quantidade, it.receita_item, commissionItem, freightItem, extraItem, cp, gm, gmPct], () => r()));
      }
    }

    res.json({ success: true, processed: notas.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Consulta de custos
app.get('/api/reports/costs', async (req, res) => {
  const { dataInicio, dataFim, marketplace, formato } = req.query || {};
  try {
    const where = [];
    const params = [];
    if (dataInicio) { where.push('n.dataExpedicao >= ?'); params.push(dataInicio); }
    if (dataFim) { where.push('n.dataExpedicao <= ?'); params.push(dataFim); }
    if (marketplace) { where.push('n.marketplace = ?'); params.push(marketplace); }
    let whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';
    whereSql = whereSql ? whereSql + ` AND UPPER(REPLACE(COALESCE(n.cliente,''), '.', '')) NOT LIKE '%EBAZARCOMBR LTDA%'` : `WHERE UPPER(REPLACE(COALESCE(n.cliente,''), '.', '')) NOT LIKE '%EBAZARCOMBR LTDA%'`;
    if ((formato || 'consolidado') === 'por-item') {
      const rows = await dbAllAsync(
        `SELECT oi.*
         FROM order_item_costs oi
         JOIN notas_expedidas n ON n.id = oi.nota_id
         ${whereSql ? whereSql + ' AND ' : 'WHERE '} UPPER(REPLACE(COALESCE(n.cliente,''), '.', '')) NOT LIKE '%EBAZARCOMBR LTDA%'`,
        params
      );
      res.json({ items: rows });
    } else {
      const rows = await dbAllAsync(
        `SELECT oc.*
         FROM order_costs oc
         JOIN notas_expedidas n ON n.id = oc.nota_id
         ${whereSql ? whereSql + ' AND ' : 'WHERE '} UPPER(REPLACE(COALESCE(n.cliente,''), '.', '')) NOT LIKE '%EBAZARCOMBR LTDA%'`,
        params
      );
      res.json({ orders: rows });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ====== Integração básica: fontes remotas de fees ======
app.post('/api/reports/fees/sources', (req, res) => {
  const { marketplace, url, format, notes } = req.body || {};
  if (!marketplace || !url) return res.status(400).json({ error: 'marketplace e url são obrigatórios' });
  db.run(`INSERT INTO fee_remote_sources (marketplace, url, format, notes, last_synced) VALUES (?, ?, ?, ?, NULL)`, [marketplace, url, format || 'csv', notes || null], function(err){
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID });
  });
});

app.get('/api/reports/fees/sources', (req, res) => {
  db.all('SELECT * FROM fee_remote_sources WHERE active = 1', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Sincronizar uma fonte
app.post('/api/reports/fees/sources/:id/sync', async (req, res) => {
  const id = req.params.id;
  db.get('SELECT * FROM fee_remote_sources WHERE id = ?', [id], async (err, src) => {
    if (err || !src) return res.status(404).json({ error: 'Fonte não encontrada' });
    try {
      const response = await axios.get(src.url, { responseType: src.format === 'csv' ? 'text' : 'json' });
      let entries = [];
      if (src.format === 'json') {
        const data = Array.isArray(response.data) ? response.data : (response.data.items || []);
        entries = data.map(r => ({ category: r.category || r.nome || '-', percent: Number(r.percent || r.commission || 0) }));
      } else if (src.format === 'csv') {
        // CSV simples: categoria,percent
        const text = typeof response.data === 'string' ? response.data : response.data.toString();
        const lines = text.split(/\r?\n/).filter(l => l.trim());
        let start = 0;
        if (lines[0] && lines[0].toLowerCase().includes('categoria')) start = 1;
        for (let i = start; i < lines.length; i++) {
          const cols = lines[i].split(';');
          const cat = (cols[0] || '').trim();
          const pct = Number((cols[1] || '').replace(',', '.'));
          if (!cat || isNaN(pct)) continue;
          entries.push({ category: cat, percent: pct });
        }
      } else if (src.format === 'html') {
        // Exemplo de scraping da página pública (Mercado Livre ajuda 40538) para bandas de frete
        const html = typeof response.data === 'string' ? response.data : response.data.toString();
        const $ = cheerio.load(html);
        // Procurar tabelas com cabeçalho que contenha 'Peso'
        $('table').each((_, table) => {
          const headers = [];
          $(table).find('thead tr th').each((__, th) => headers.push($(th).text().trim().toLowerCase()));
          if (headers.join(' ').includes('peso')) {
            // Aqui, como é frete por peso (não comissão), salvamos em shipping_tables
            const rows = [];
            $(table).find('tbody tr').each((__, tr) => {
              const tds = $(tr).find('td');
              const faixa = $(tds[0]).text().trim();
              const valorTxt = $(tds[1]).text().trim().replace(/[^0-9,\.]/g,'');
              const price = Number(valorTxt.replace(',', '.'));
              // Parse de "Até 300 g", "De 300 g a 500 g" -> min/max em kg
              let min = 0, max = 0.3; // default para "Até 300 g"
              const lower = faixa.toLowerCase();
              const nums = (lower.match(/([0-9]+[\,\.]?[0-9]*)/g) || []).map(x=>Number(x.replace(',', '.')));
              if (lower.startsWith('até') && nums[0]) { min = 0; max = nums[0] / 1000; }
              else if (lower.startsWith('de') && nums.length >= 2) { min = nums[0] / 1000; max = nums[1] / 1000; }
              else if (lower.includes('maior')) { min = nums[0] ? (nums[0]/1000) : 150; max = 9999; }
              if (!isNaN(price)) rows.push({ min, max, price });
            });
            if (rows.length > 0) {
              // Salvar como shipping_table (rule_type weight_band) para o marketplace
              const name = `Auto: ${src.marketplace} frete peso (${new Date().toISOString().slice(0,10)})`;
              db.run(`INSERT INTO shipping_tables (marketplace, name, rule_type, rules_json, updated_at) VALUES (?, ?, 'weight_band', ?, CURRENT_TIMESTAMP)`, [src.marketplace, name, JSON.stringify(rows)], () => {});
            }
          }
        });
      }
      // Persistir
      const stmtDel = db.prepare('DELETE FROM marketplace_category_fees WHERE marketplace = ?');
      stmtDel.run([src.marketplace]);
      stmtDel.finalize();
      const stmt = db.prepare('INSERT INTO marketplace_category_fees (marketplace, category, commission_percent) VALUES (?, ?, ?)');
      for (const e of entries) stmt.run([src.marketplace, e.category, e.percent]);
      stmt.finalize();
      db.run('UPDATE fee_remote_sources SET last_synced = CURRENT_TIMESTAMP WHERE id = ?', [id]);
      res.json({ synced: entries.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

// Relatório de vendas por marketplace e SKU
// Query params: dataInicio=YYYY-MM-DD, dataFim=YYYY-MM-DD, marketplace=opcional
app.get('/api/reports/sales', async (req, res) => {
  try {
    const { dataInicio, dataFim, marketplace } = req.query || {};
    const accountId = getOptionalAccountIdFromReq(req);
    // Montar filtros de data (>= inicio 00:00:00, <= fim 23:59:59)
    const where = [];
    const params = [];
    const dateExpr = reportDateExpr('n');
    if (dataInicio) { where.push(`${dateExpr} >= date(?)`); params.push(`${dataInicio}`); }
    if (dataFim) { where.push(`${dateExpr} <= date(?)`); params.push(`${dataFim}`); }
    if (accountId) { where.push('n.account_id = ?'); params.push(accountId); }
    let whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';
    whereSql = whereSql
      ? whereSql + ` AND UPPER(REPLACE(COALESCE(n.cliente,''), '.', '')) NOT LIKE '%EBAZARCOMBR LTDA%'`
      : `WHERE UPPER(REPLACE(COALESCE(n.cliente,''), '.', '')) NOT LIKE '%EBAZARCOMBR LTDA%'`;

    // Buscar notas + itens para permitir rateio do faturamento por SKU
    const rows = await dbAllAsync(
      `SELECT n.id AS nota_id, n.valorNota, n.marketplace AS mk_raw, n.numeroLoja,
              ni.sku AS sku_original, ni.quantidade
       FROM notas_expedidas n
       JOIN nota_itens_expedidos ni ON ni.nota_id = n.id AND (ni.account_id = n.account_id OR ni.account_id IS NULL)
       ${whereSql}`,
      params
    );

    const notasResumo = await dbAllAsync(
      `SELECT n.id AS nota_id, n.valorNota, n.marketplace AS mk_raw, n.numeroLoja
       FROM notas_expedidas n
       ${whereSql}`,
      params
    );
    const totalsByMarketplace = new Map();
    for (const n of notasResumo) {
      const mk = n.mk_raw || identificarMarketplace(String(n.numeroLoja || ''), []) || 'Desconhecido';
      if (!totalsByMarketplace.has(mk)) {
        totalsByMarketplace.set(mk, { marketplace: mk, pedidosSet: new Set(), faturamento: 0 });
      }
      const bucket = totalsByMarketplace.get(mk);
      bucket.pedidosSet.add(n.nota_id);
      bucket.faturamento += Number(n.valorNota || 0);
    }

    // Pré-carregar inventário e relações de kits/compostos para conversões
    const inventory = await dbAllAsync('SELECT id, sku, title, is_composite FROM inventory');
    const skuToItem = {};
    for (const p of inventory) skuToItem[p.sku] = p;
    const relations = await dbAllAsync('SELECT main_sku_id, component_sku_id, quantity FROM composite_skus');
    const idToSku = {};
    for (const p of inventory) idToSku[p.id] = p.sku;
    const kitMap = new Map();
    for (const r of relations) {
      const mainSku = idToSku[r.main_sku_id];
      const compSku = idToSku[r.component_sku_id];
      if (!mainSku || !compSku) continue;
      if (!kitMap.has(mainSku)) kitMap.set(mainSku, []);
      kitMap.get(mainSku).push({ compSku, qty: r.quantity });
    }

    // Calcular soma de quantidade convertida por nota para rateio de valorNota
    const itensConvertidos = []; // {nota_id, marketplace, sku, title, convertedQty, valorNota}
    const somaPorNota = new Map(); // nota_id -> total converted qty
    for (const row of rows) {
      const skuOriginal = String(row.sku_original || '');
      const skuLimpo = limparSkuFinal(skuOriginal);
      let normalizedSku = skuLimpo;
      let title = skuToItem[skuLimpo]?.title || '';
      let quantidade = Number(row.quantidade) || 0;
      let fator = 1;
      const compList = kitMap.get(skuLimpo);
      if (skuToItem[skuLimpo]?.is_composite && Array.isArray(compList) && compList.length === 1) {
        normalizedSku = compList[0].compSku;
        fator = Number(compList[0].qty) || 1;
        title = skuToItem[normalizedSku]?.title || title;
      }
      const convertedQty = quantidade * fator;
      const mk = row.mk_raw || identificarMarketplace(String(row.numeroLoja || ''), []);
      itensConvertidos.push({ nota_id: row.nota_id, marketplace: mk || 'Desconhecido', sku: normalizedSku, title, convertedQty, valorNota: Number(row.valorNota) || 0 });
      const soma = somaPorNota.get(row.nota_id) || 0;
      somaPorNota.set(row.nota_id, soma + convertedQty);
    }

    // Agregar por marketplace e SKU, rateando o faturamento proporcionalmente
    const agg = new Map(); // key mk|sku -> {marketplace, sku, title, quantidade, faturamento}
    const pedidosPorMarketplace = new Map(); // mk -> Set de notas (fallback quando nao ha totais)
    for (const it of itensConvertidos) {
      const denominador = somaPorNota.get(it.nota_id) || 0;
      const parcela = denominador > 0 ? (it.valorNota * (it.convertedQty / denominador)) : 0;
      const key = `${it.marketplace}|${it.sku}`;
      const atual = agg.get(key) || { marketplace: it.marketplace, sku: it.sku, title: it.title || '', quantidade: 0, faturamento: 0 };
      atual.quantidade += it.convertedQty;
      atual.faturamento += parcela;
      if (!atual.title && it.title) atual.title = it.title;
      agg.set(key, atual);
      if (!pedidosPorMarketplace.has(it.marketplace)) pedidosPorMarketplace.set(it.marketplace, new Set());
      pedidosPorMarketplace.get(it.marketplace).add(it.nota_id);
    }

    // Reorganizar por marketplace
    const porMarketplace = new Map();
    for (const [mk, total] of totalsByMarketplace.entries()) {
      porMarketplace.set(mk, {
        marketplace: mk,
        pedidos: total.pedidosSet.size,
        faturamento: total.faturamento,
        itens: 0,
        skus: []
      });
    }
    for (const row of agg.values()) {
      if (!porMarketplace.has(row.marketplace)) {
        porMarketplace.set(row.marketplace, { marketplace: row.marketplace, pedidos: 0, faturamento: 0, itens: 0, skus: [] });
      }
      const bucket = porMarketplace.get(row.marketplace);
      bucket.skus.push({ sku: row.sku, title: row.title, quantidade: row.quantidade, faturamento: row.faturamento });
      bucket.itens += row.quantidade;
      if (!totalsByMarketplace.has(row.marketplace)) {
        bucket.faturamento += row.faturamento;
      }
    }
    for (const [mk, setNotas] of pedidosPorMarketplace.entries()) {
      const bucket = porMarketplace.get(mk);
      if (bucket && bucket.pedidos === 0) bucket.pedidos = setNotas.size;
    }

    // Ordenar e aplicar filtro de marketplace (case-insensitive, substring)
    let result = Array.from(porMarketplace.values()).map(mk => ({
      ...mk,
      skus: mk.skus.sort((a, b) => (b.faturamento - a.faturamento) || (b.quantidade - a.quantidade))
    })).sort((a, b) => (b.faturamento - a.faturamento) || (b.pedidos - a.pedidos));
    if (marketplace && marketplace.trim()) {
      const q = marketplace.trim().toLowerCase();
      result = result.filter(m => (m.marketplace || '').toLowerCase().includes(q));
    }

    res.json({ marketplaces: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Relatório JSON: pedidos (notas) por marketplace no período
app.get('/api/reports/sales/orders', async (req, res) => {
  try {
    const { dataInicio, dataFim, marketplace } = req.query || {};
    const accountId = getOptionalAccountIdFromReq(req);
    const where = [];
    const params = [];
    const dateExpr = reportDateExpr('n');
    if (dataInicio) { where.push(`${dateExpr} >= date(?)`); params.push(`${dataInicio}`); }
    if (dataFim) { where.push(`${dateExpr} <= date(?)`); params.push(`${dataFim}`); }
    if (accountId) { where.push('n.account_id = ?'); params.push(accountId); }
    let whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';
    whereSql = whereSql ? whereSql + ` AND UPPER(REPLACE(COALESCE(n.cliente,''), '.', '')) NOT LIKE '%EBAZARCOMBR LTDA%'` : `WHERE UPPER(REPLACE(COALESCE(n.cliente,''), '.', '')) NOT LIKE '%EBAZARCOMBR LTDA%'`;
    const sql = `
      SELECT n.id AS nota_id, n.numero AS numero, n.marketplace AS mk_raw, n.numeroLoja, n.valorNota AS faturamento,
             n.dataExpedicao AS data, COALESCE(SUM(ni.quantidade), 0) AS itens
      FROM notas_expedidas n
      LEFT JOIN nota_itens_expedidos ni ON ni.nota_id = n.id AND (ni.account_id = n.account_id OR ni.account_id IS NULL)
      ${whereSql}
      GROUP BY n.id
      ORDER BY n.dataExpedicao DESC
    `;
    const rows = await dbAllAsync(sql, params);
    let orders = rows.map(r => ({
      marketplace: r.mk_raw || identificarMarketplace(String(r.numeroLoja || ''), []) || 'Desconhecido',
      nota_id: r.nota_id,
      numero: r.numero || null,
      data: r.data,
      itens: Number(r.itens || 0),
      faturamento: Number(r.faturamento || 0)
    }));
    if (marketplace && marketplace.trim()) {
      const q = marketplace.trim().toLowerCase();
      orders = orders.filter(o => (o.marketplace || '').toLowerCase().includes(q));
    }
    res.json({ orders });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ANÁLISE DE CUSTOS DE PEDIDO — endpoints
// Relatório que destrincha comissões, fretes, descontos, impostos e COGS
// por pedido vindo de ML e Shopee. Fonte primária: marketplace_order_costs
// populada no sync via computeOrderCostsReconstructed.
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/reports/order-costs
// Query: from, to (YYYY-MM-DD), marketplace (ml|shopee|all), accountId,
//        status, missingCogs (yes), negativeMargin (yes), search, page, pageSize.
app.get('/api/reports/order-costs', authenticateToken, requireRoleAtLeast(3), async (req, res) => {
  try {
    const { from, to, marketplace, accountId, status, missingCogs, negativeMargin, search } = req.query || {};
    // Custo de fabricação (COGS) e margem líquida são restritos a role=4.
    // role<4 continua vendo comissão/frete/líquido; só os campos sensíveis
    // são omitidos do response.
    const canSeeCogs = Number(req.user?.role) === 4;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(10, parseInt(req.query.pageSize, 10) || 50));
    const where = ['1=1'];
    const params = [];
    if (from) { where.push('date(o.order_date) >= date(?)'); params.push(from); }
    if (to) { where.push('date(o.order_date) <= date(?)'); params.push(to); }
    if (marketplace && marketplace !== 'all') { where.push('o.marketplace = ?'); params.push(marketplace); }
    if (accountId && accountId !== 'all') { where.push('o.account_id = ?'); params.push(Number(accountId)); }
    if (status && status !== 'all') { where.push('o.status = ?'); params.push(status); }
    // Filtros de COGS/margem só entram no WHERE quando o usuário tem permissão.
    if (canSeeCogs && missingCogs === 'yes') { where.push("(c.cogs_status IS NULL OR c.cogs_status IN ('unknown','partial','no_items'))"); }
    if (canSeeCogs && negativeMargin === 'yes') { where.push('c.gross_margin < 0'); }
    if (search && search.trim()) {
      where.push('(o.marketplace_order_id LIKE ? OR o.buyer_name LIKE ? OR o.pack_id LIKE ?)');
      const s = `%${search.trim()}%`;
      params.push(s, s, s);
    }
    const whereSql = where.join(' AND ');
    const baseJoin = `
      FROM marketplace_orders o
      LEFT JOIN marketplace_order_costs c ON c.order_id = o.id AND c.source = 'reconstructed'
      WHERE ${whereSql}
    `;
    const totalRow = await dbGetAsync(`SELECT COUNT(*) AS total ${baseJoin}`, params);
    const total = Number(totalRow?.total || 0);
    const agg = await dbGetAsync(`
      SELECT
        COALESCE(SUM(c.gross_revenue), 0) AS gross_revenue,
        COALESCE(SUM(c.marketplace_commission), 0) AS commission,
        COALESCE(SUM(c.marketplace_service_fee), 0) AS service_fee,
        COALESCE(SUM(c.payment_fee), 0) AS payment_fee,
        COALESCE(SUM(c.shipping_cost_seller), 0) AS shipping_cost_seller,
        COALESCE(SUM(c.shipping_subsidy), 0) AS shipping_subsidy,
        COALESCE(SUM(c.discounts_seller), 0) AS discounts_seller,
        COALESCE(SUM(c.discounts_marketplace), 0) AS discounts_marketplace,
        COALESCE(SUM(c.reverse_shipping_fee), 0) AS reverse_shipping_fee,
        COALESCE(SUM(c.taxes_withheld), 0) AS taxes_withheld,
        COALESCE(SUM(c.taxes_seller), 0) AS taxes_seller,
        COALESCE(SUM(c.other_adjustments), 0) AS other_adjustments,
        COALESCE(SUM(c.net_received), 0) AS net_received,
        COALESCE(SUM(c.cogs_estimated), 0) AS cogs,
        COALESCE(SUM(c.gross_margin), 0) AS margin,
        SUM(CASE WHEN c.cogs_status IN ('unknown','partial','no_items') THEN 1 ELSE 0 END) AS orders_missing_cogs,
        SUM(CASE WHEN c.id IS NULL THEN 1 ELSE 0 END) AS orders_without_costs,
        COUNT(*) AS orders_total
      ${baseJoin}
    `, params);
    const offset = (page - 1) * pageSize;
    const rows = await dbAllAsync(`
      SELECT o.id, o.marketplace, o.marketplace_order_id, o.account_id, o.status,
             o.buyer_name, o.order_date, o.total_amount, o.pack_id, o.shipping_id,
             c.gross_revenue, c.marketplace_commission, c.marketplace_service_fee,
             c.payment_fee, c.shipping_cost_seller, c.shipping_subsidy,
             c.shipping_paid_by_buyer, c.discounts_seller, c.discounts_marketplace,
             c.reverse_shipping_fee, c.taxes_withheld, c.taxes_seller, c.other_adjustments,
             c.net_received, c.cogs_estimated, c.gross_margin, c.cogs_status,
             c.escrow_status, c.warnings, c.computed_at,
             CASE WHEN c.id IS NULL THEN 0 ELSE 1 END AS has_costs,
             (SELECT GROUP_CONCAT(
                CASE WHEN oi.quantity > 1 THEN oi.sku || ' x' || oi.quantity ELSE oi.sku END,
                ', '
              ) FROM marketplace_order_items oi
              WHERE oi.order_id = o.id AND oi.sku IS NOT NULL AND TRIM(oi.sku) != ''
             ) AS skus_summary
      ${baseJoin}
      ORDER BY o.order_date DESC
      LIMIT ? OFFSET ?
    `, [...params, pageSize, offset]);
    res.json({
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      aggregates: {
        gross_revenue: Number(agg?.gross_revenue || 0),
        commission: Number(agg?.commission || 0),
        service_fee: Number(agg?.service_fee || 0),
        payment_fee: Number(agg?.payment_fee || 0),
        shipping_cost_seller: Number(agg?.shipping_cost_seller || 0),
        shipping_subsidy: Number(agg?.shipping_subsidy || 0),
        discounts_seller: Number(agg?.discounts_seller || 0),
        discounts_marketplace: Number(agg?.discounts_marketplace || 0),
        reverse_shipping_fee: Number(agg?.reverse_shipping_fee || 0),
        taxes_withheld: Number(agg?.taxes_withheld || 0),
        // Imposto estimado do vendedor (alíquota da conta de marketplace).
        // Restrito a role=4.
        taxes_seller: canSeeCogs ? Number(agg?.taxes_seller || 0) : null,
        other_adjustments: Number(agg?.other_adjustments || 0),
        net_received: Number(agg?.net_received || 0),
        // COGS e margem só para role=4 (custo de fabricação).
        cogs: canSeeCogs ? Number(agg?.cogs || 0) : null,
        margin: canSeeCogs ? Number(agg?.margin || 0) : null,
        orders_total: Number(agg?.orders_total || 0),
        orders_missing_cogs: canSeeCogs ? Number(agg?.orders_missing_cogs || 0) : null,
        orders_without_costs: Number(agg?.orders_without_costs || 0),
      },
      orders: rows.map(r => ({
        id: r.id,
        marketplace: r.marketplace,
        marketplace_order_id: r.marketplace_order_id,
        account_id: r.account_id,
        status: r.status,
        buyer_name: r.buyer_name,
        order_date: r.order_date,
        total_amount: Number(r.total_amount || 0),
        pack_id: r.pack_id || null,
        skus_summary: r.skus_summary || '',
        has_costs: !!r.has_costs,
        costs: r.has_costs ? {
          gross_revenue: Number(r.gross_revenue || 0),
          marketplace_commission: Number(r.marketplace_commission || 0),
          marketplace_service_fee: Number(r.marketplace_service_fee || 0),
          payment_fee: Number(r.payment_fee || 0),
          shipping_cost_seller: Number(r.shipping_cost_seller || 0),
          shipping_subsidy: Number(r.shipping_subsidy || 0),
          shipping_paid_by_buyer: Number(r.shipping_paid_by_buyer || 0),
          discounts_seller: Number(r.discounts_seller || 0),
          discounts_marketplace: Number(r.discounts_marketplace || 0),
          reverse_shipping_fee: Number(r.reverse_shipping_fee || 0),
          taxes_withheld: Number(r.taxes_withheld || 0),
          taxes_seller: canSeeCogs ? Number(r.taxes_seller || 0) : null,
          other_adjustments: Number(r.other_adjustments || 0),
          net_received: Number(r.net_received || 0),
          cogs_estimated: canSeeCogs ? (r.cogs_estimated == null ? null : Number(r.cogs_estimated)) : null,
          gross_margin: canSeeCogs ? (r.gross_margin == null ? null : Number(r.gross_margin)) : null,
          cogs_status: canSeeCogs ? r.cogs_status : null,
          escrow_status: r.escrow_status,
          warnings: r.warnings ? (() => { try { return JSON.parse(r.warnings); } catch (_) { return []; } })() : [],
          computed_at: r.computed_at,
        } : null,
      })),
    });
  } catch (e) {
    console.error('[OrderCosts] GET list error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/reports/order-costs/:orderId
// Detalhe rico: todas as linhas de marketplace_order_costs daquele pedido
// (reconstructed + ml_billing_report quando existir), itens com COGS
// individual, e divergências destacadas.
app.get('/api/reports/order-costs/:orderId', authenticateToken, requireRoleAtLeast(3), async (req, res) => {
  try {
    const orderId = Number(req.params.orderId);
    if (!Number.isFinite(orderId) || orderId <= 0) return res.status(400).json({ error: 'orderId inválido' });
    // COGS/margem e cost_price por SKU são restritos a role=4. role<4 recebe
    // o detalhe completo de comissão/frete/líquido sem esses campos.
    const canSeeCogs = Number(req.user?.role) === 4;
    const order = await dbGetAsync('SELECT * FROM marketplace_orders WHERE id = ?', [orderId]);
    if (!order) return res.status(404).json({ error: 'pedido não encontrado' });
    const items = await dbAllAsync('SELECT * FROM marketplace_order_items WHERE order_id = ? ORDER BY id', [orderId]);
    const costRows = await dbAllAsync('SELECT * FROM marketplace_order_costs WHERE order_id = ? ORDER BY source', [orderId]);
    // Alíquota de imposto vem da CONTA de marketplace do pedido.
    const accountTable = order.marketplace === 'shopee' ? 'shopee_accounts' : 'ml_accounts';
    const accRow = await dbGetAsync(`SELECT tax_pct FROM ${accountTable} WHERE id = ? LIMIT 1`, [order.account_id]);
    const accountTaxPct = accRow && accRow.tax_pct != null ? Number(accRow.tax_pct) : null;
    // Enriquece itens com COGS por SKU (cost_price do inventário) e o imposto
    // por linha (rateado pela alíquota da conta). cost_price/COGS/margem são
    // restritos a role=4; a alíquota da conta é financeira mas não sensível
    // como cost_price, então também gatea por role=4 por consistência.
    //
    // Imposto por linha: base = (gross_revenue − discounts_seller) da linha
    // reconstructed (o valor efetivamente faturado). Rateia proporcional à
    // receita de cada item. Quando não temos a linha de custo reconstruída
    // ainda, cai para `line_revenue × pct` (comportamento legado).
    const reconCostRow = costRows.find(r => r.source === 'reconstructed');
    const orderGross = reconCostRow ? Number(reconCostRow.gross_revenue || 0) : 0;
    const orderPromo = reconCostRow ? Number(reconCostRow.discounts_seller || 0) : 0;
    const orderTaxBase = Math.max(0, orderGross - orderPromo);
    const sumItemsRevenue = items.reduce((a, it) => a + Number(it.unit_price || 0) * Number(it.quantity || 1), 0);
    const itemsWithCogs = [];
    for (const it of items) {
      const sku = (it.sku || '').trim();
      let inv = null;
      if (sku && canSeeCogs) inv = await dbGetAsync('SELECT id, cost_price, is_composite FROM inventory WHERE TRIM(LOWER(sku)) = TRIM(LOWER(?)) LIMIT 1', [sku]);
      else if (sku) inv = await dbGetAsync('SELECT id, is_composite FROM inventory WHERE TRIM(LOWER(sku)) = TRIM(LOWER(?)) LIMIT 1', [sku]);
      const qty = Number(it.quantity || 1);
      const unit = Number(it.unit_price || 0);
      const lineRevenue = unit * qty;
      const cost = (canSeeCogs && inv?.cost_price != null) ? Number(inv.cost_price) : null;
      let lineTax = null;
      if (canSeeCogs && accountTaxPct != null) {
        if (orderTaxBase > 0 && sumItemsRevenue > 0) {
          // rateia o imposto total da base de cálculo pelos itens
          const share = lineRevenue / sumItemsRevenue;
          lineTax = orderTaxBase * (accountTaxPct / 100) * share;
        } else {
          // fallback: sem linha reconstructed, usa line_revenue direto
          lineTax = lineRevenue * (accountTaxPct / 100);
        }
      }
      itemsWithCogs.push({
        id: it.id,
        sku,
        title: it.title,
        quantity: qty,
        unit_price: unit,
        line_revenue: lineRevenue,
        cost_price: canSeeCogs ? cost : null,
        line_cogs: canSeeCogs && cost != null ? cost * qty : null,
        line_margin: canSeeCogs && cost != null ? (unit - cost) * qty : null,
        tax_pct: canSeeCogs ? accountTaxPct : null,
        line_tax: lineTax,
        inventory_id: inv?.id || null,
        is_composite: !!inv?.is_composite,
      });
    }
    // Parse warnings/raw_json. Para role<4: zerar cogs_estimated/gross_margin,
    // remover campos sensíveis do raw_json (cogs_lines, reversal_applied.before
    // contém cost_price) e do cost row.
    const sanitizeRaw = (raw) => {
      if (!raw || typeof raw !== 'object') return raw;
      const { cogs_lines, reversal_applied, ...rest } = raw;
      return rest;
    };
    const costs = costRows.map(r => {
      const warnings = r.warnings ? (() => { try { return JSON.parse(r.warnings); } catch (_) { return []; } })() : [];
      const raw_json = r.raw_json ? (() => { try { return JSON.parse(r.raw_json); } catch (_) { return null; } })() : null;
      const base = { ...r, warnings, raw_json };
      if (!canSeeCogs) {
        base.cogs_estimated = null;
        base.gross_margin = null;
        base.cogs_status = null;
        base.taxes_seller = null;
        base.raw_json = sanitizeRaw(raw_json);
      }
      return base;
    });
    // Divergência entre reconstructed e ml_billing_report (quando ambos existem)
    let divergence = null;
    const rec = costs.find(c => c.source === 'reconstructed');
    const bill = costs.find(c => c.source === 'ml_billing_report');
    if (rec && bill) {
      const keys = ['marketplace_commission','shipping_cost_seller','payment_fee','discounts_marketplace','taxes_withheld','net_received'];
      divergence = keys.map(k => ({
        metric: k,
        reconstructed: Number(rec[k] || 0),
        billing_report: Number(bill[k] || 0),
        diff: Number(rec[k] || 0) - Number(bill[k] || 0),
      })).filter(d => Math.abs(d.diff) > 0.01);
    }
    res.json({ order, items: itemsWithCogs, costs, divergence });
  } catch (e) {
    console.error('[OrderCosts] GET detail error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/reports/order-costs/recalc
// Body: { orderIds?: number[], from?: YYYY-MM-DD, to?: YYYY-MM-DD, marketplace?: 'ml'|'shopee', limit?: number }
// Roda computeOrderCostsReconstructed em massa. Útil depois de atualizar
// cost_price no inventário ou para hidratar histórico.
app.post('/api/reports/order-costs/recalc', authenticateToken, requireRoleAtLeast(3), async (req, res) => {
  try {
    const { orderIds, from, to, marketplace, limit } = req.body || {};
    let targets = [];
    if (Array.isArray(orderIds) && orderIds.length > 0) {
      const q = `SELECT * FROM marketplace_orders WHERE id IN (${orderIds.map(() => '?').join(',')})`;
      targets = await dbAllAsync(q, orderIds.map(Number));
    } else {
      const where = ['1=1'];
      const params = [];
      if (from) { where.push('date(order_date) >= date(?)'); params.push(from); }
      if (to) { where.push('date(order_date) <= date(?)'); params.push(to); }
      if (marketplace && marketplace !== 'all') { where.push('marketplace = ?'); params.push(marketplace); }
      // Cap de segurança: 10000 pedidos por rodada evita timeouts em períodos
      // muito longos. Se `limit` não for enviado ou vier 0, processamos todos
      // os pedidos do período (até o cap).
      const parsedLimit = parseInt(limit, 10);
      const cap = Math.min(10000, Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 10000);
      targets = await dbAllAsync(`SELECT * FROM marketplace_orders WHERE ${where.join(' AND ')} ORDER BY order_date DESC LIMIT ?`, [...params, cap]);
    }
    if (targets.length === 0) return res.json({ ok: true, processed: 0 });
    let ok = 0, fail = 0, rehydrated = 0, skusResolved = 0;
    // Concorrência moderada para paralelizar chamadas de API sem estourar
    // rate limit do ML/Shopee. Cada pedido faz 2-4 chamadas externas
    // (/orders/{id}, /shipments/{id}/costs, get_escrow_detail etc.). O
    // endpoint `get_escrow_detail` da Shopee tem limite bem estreito
    // (~10 req/s por shop) e quebra em lotes grandes — se a carga for
    // majoritariamente Shopee, caímos pra 2 pra reduzir 429/error_server.
    const shopeeShare = targets.filter(t => t.marketplace === 'shopee').length / Math.max(1, targets.length);
    const concurrency = shopeeShare > 0.5 ? 2 : 3;
    await mapWithConcurrency(targets, concurrency, async (o) => {
      try {
        let items = await dbAllAsync('SELECT * FROM marketplace_order_items WHERE order_id = ?', [o.id]);
        // Pedidos antigos que chegaram via listagem enxuta podem não ter tido
        // seus itens gravados em marketplace_order_items. Sem itens o COGS/
        // imposto cai pro estado "Sem itens". Antes de calcular, tenta hidratar.
        if (items.length === 0 && (o.marketplace === 'ml' || o.marketplace === 'shopee')) {
          try {
            const fresh = o.marketplace === 'ml'
              ? await fetchMlOrderFull(o)
              : await fetchShopeeOrderFull(o);
            if (fresh) {
              await applyFreshOrderToDb(o, fresh, 'recalc-rehydrate');
              items = await dbAllAsync('SELECT * FROM marketplace_order_items WHERE order_id = ?', [o.id]);
              if (items.length > 0) rehydrated++;
            }
          } catch (rehyErr) {
            // best-effort: segue o baile usando o conjunto de itens vazio,
            // computeOrderCostsReconstructed sabe lidar com isso (fallback
            // para total_amount + warning sem_itens_usando_total_amount).
            console.warn('[OrderCosts] rehydrate falhou para', o.id, rehyErr.message);
          }
        }
        // Mesmo com itens gravados, pedidos podem estar com `sku=null` porque
        // o vendedor não cadastrou SKU no anúncio. Resolvemos via cache local
        // (stock_config + ml_items/shopee_items) antes de calcular COGS —
        // assim "sem NF" deixa de ser sinônimo de "sem custo" no relatório.
        const needsSkuResolve = items.some(it => !(it.sku || '').trim());
        if (needsSkuResolve) {
          const n = await resolveMissingSkusForOrder(o).catch(() => 0);
          if (n > 0) {
            skusResolved += n;
            items = await dbAllAsync('SELECT * FROM marketplace_order_items WHERE order_id = ?', [o.id]);
          }
        }
        const result = await computeOrderCostsReconstructed(o, items);
        if (result) ok++; else fail++;
      } catch (e) {
        console.warn('[OrderCosts] recalc falhou para', o.id, e.message);
        fail++;
      }
    });
    res.json({ ok: true, processed: targets.length, success: ok, failed: fail, rehydrated, skus_resolved: skusResolved });
  } catch (e) {
    console.error('[OrderCosts] POST recalc error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/reports/order-costs/sync-billing-reports (stub)
// Ingestão do Billing Reports API oficial do ML (/billing/integration/group/
// ML/order/details). Endpoint público do ML está temporariamente fora do ar
// desde 10/04/2026 (bug confirmado pela Mercado Livre). Mantemos o stub
// para o ingestion já estar pronto quando voltar — basta trocar o retorno
// precoce por uma chamada real e gravar em marketplace_order_costs com
// source='ml_billing_report'.
app.post('/api/reports/order-costs/sync-billing-reports', authenticateToken, requireRoleAtLeast(3), async (req, res) => {
  try {
    const { accountId, orderIds } = req.body || {};
    if (!accountId) return res.status(400).json({ error: 'accountId obrigatório' });
    // TODO: quando o endpoint voltar, montar GET /billing/integration/group/ML/order/details?order_ids=...
    // e popular marketplace_order_costs com source='ml_billing_report'.
    return res.status(503).json({
      ok: false,
      reason: 'billing_reports_api_unavailable',
      message: 'O endpoint /billing/integration/group/ML/order/details está temporariamente fora do ar no Mercado Livre (bug reportado em 10/04/2026). O relatório continua operando via reconstructed.',
      accountId,
      requestedOrderIds: Array.isArray(orderIds) ? orderIds.length : 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Relatório de Reposição de Estoque
// Retorna: inventário + vendas 7d/30d, cobertura, qtd sugerida, alertas
// Aceita dataInicio e dataFim (YYYY-MM-DD) para período personalizado de vendas
app.get('/api/reports/replenishment', authenticateToken, requireRoleAtLeast(2), async (req, res) => {
  try {
    const raw = parseInt(req.query.semanasCobertura, 10);
    const SEMANAS_COBERTURA = Number.isFinite(raw) && raw >= 1 && raw <= 12 ? raw : 2;

    const dataInicio = String(req.query.dataInicio || '').trim();
    const dataFim = String(req.query.dataFim || '').trim();
    const useCustomRange = /^\d{4}-\d{2}-\d{2}$/.test(dataInicio) && /^\d{4}-\d{2}-\d{2}$/.test(dataFim) && dataInicio <= dataFim;

    const inventoryRaw = await dbAllAsync('SELECT id, sku, title, quantity, min_quantity, is_composite, category FROM inventory');
    const relations = await dbAllAsync('SELECT main_sku_id, component_sku_id, quantity FROM composite_skus');
    const mainSkuIds = new Set((relations || []).map(r => r.main_sku_id));
    const inventory = inventoryRaw.filter(inv => {
      if (inv.is_composite) return false;
      if (mainSkuIds.has(inv.id)) return false;
      const cat = String(inv.category || '').toLowerCase();
      if (cat.includes('ventilador')) return false;
      if (cat.includes('kit') || cat.includes('composto')) return false;
      return true;
    });
    const idToSku = {};
    const skuToItem = {};
    for (const p of inventoryRaw) { idToSku[p.id] = p.sku; skuToItem[p.sku] = p; }
    const kitMap = new Map();
    for (const r of relations) {
      const mainSku = idToSku[r.main_sku_id];
      const compSku = idToSku[r.component_sku_id];
      if (!mainSku || !compSku) continue;
      if (!kitMap.has(mainSku)) kitMap.set(mainSku, []);
      kitMap.get(mainSku).push({ compSku, qty: Number(r.quantity) || 0 });
    }

    // Explode um SKU composto até seus componentes simples, agregando os multiplicadores.
    // Ex: "Trilho Spot Completo" = 2 copos + 1 trilho → Map{'COPO' => 2, 'TRILHO' => 1}.
    // Cobre composto-de-composto e protege contra ciclos.
    const explodeCache = new Map();
    const explodeToSimples = (sku, visited = new Set()) => {
      if (!sku) return new Map();
      if (explodeCache.has(sku)) return explodeCache.get(sku);
      if (visited.has(sku)) return new Map(); // ciclo: aborta este ramo
      const next = new Set(visited); next.add(sku);
      const comps = kitMap.get(sku);
      const result = new Map();
      if (!comps || comps.length === 0) {
        // SKU simples: ele mesmo com multiplicador 1
        result.set(sku, 1);
      } else {
        for (const c of comps) {
          const sub = explodeToSimples(c.compSku, next);
          for (const [s, m] of sub.entries()) {
            result.set(s, (result.get(s) || 0) + m * c.qty);
          }
        }
      }
      explodeCache.set(sku, result);
      return result;
    };

    const today = new Date().toISOString().slice(0, 10);
    const d7 = new Date();
    d7.setDate(d7.getDate() - 7);
    const date7 = d7.toISOString().slice(0, 10);
    const d30 = new Date();
    d30.setDate(d30.getDate() - 30);
    const date30 = d30.toISOString().slice(0, 10);

    const dateExpr = reportDateExpr('n');
    const whereBase = ` AND UPPER(REPLACE(COALESCE(n.cliente,''), '.', '')) NOT LIKE '%EBAZARCOMBR LTDA%'`;

    let vendas7BySku = new Map();
    let vendas30BySku = new Map();
    let vendasPeriodoBySku = null;
    let diasPeriodo = 0;

    if (useCustomRange) {
      const [y1, m1, d1] = dataInicio.split('-').map(Number);
      const [y2, m2, d2] = dataFim.split('-').map(Number);
      const start = new Date(y1, m1 - 1, d1);
      const end = new Date(y2, m2 - 1, d2);
      diasPeriodo = Math.max(1, Math.ceil((end - start) / (24 * 60 * 60 * 1000)) + 1);

      const rowsPeriodo = await dbAllAsync(
        `SELECT ni.sku AS sku_original, SUM(ni.quantidade) AS qtd
         FROM nota_itens_expedidos ni
         JOIN notas_expedidas n ON n.id = ni.nota_id AND (ni.account_id = n.account_id OR ni.account_id IS NULL)
         WHERE ${dateExpr} >= date(?) AND ${dateExpr} <= date(?) ${whereBase}
         GROUP BY ni.sku`,
        [dataInicio, dataFim]
      );
      vendasPeriodoBySku = new Map();
      for (const r of rowsPeriodo || []) {
        const skuOrig = String(r.sku_original || '');
        const skuLimpo = limparSkuFinal(skuOrig);
        const qtd = Number(r.qtd) || 0;
        if (qtd <= 0) continue;
        const exploded = explodeToSimples(skuLimpo);
        if (exploded.size === 0) {
          vendasPeriodoBySku.set(skuLimpo, (vendasPeriodoBySku.get(skuLimpo) || 0) + qtd);
          continue;
        }
        for (const [skuComp, fator] of exploded.entries()) {
          vendasPeriodoBySku.set(skuComp, (vendasPeriodoBySku.get(skuComp) || 0) + qtd * fator);
        }
      }
    } else {
      const rows7 = await dbAllAsync(
        `SELECT ni.sku AS sku_original, SUM(ni.quantidade) AS qtd
         FROM nota_itens_expedidos ni
         JOIN notas_expedidas n ON n.id = ni.nota_id AND (ni.account_id = n.account_id OR ni.account_id IS NULL)
         WHERE ${dateExpr} >= date(?) AND ${dateExpr} <= date(?) ${whereBase}
         GROUP BY ni.sku`,
        [date7, today]
      );
      const rows30 = await dbAllAsync(
        `SELECT ni.sku AS sku_original, SUM(ni.quantidade) AS qtd
         FROM nota_itens_expedidos ni
         JOIN notas_expedidas n ON n.id = ni.nota_id AND (ni.account_id = n.account_id OR ni.account_id IS NULL)
         WHERE ${dateExpr} >= date(?) AND ${dateExpr} <= date(?) ${whereBase}
         GROUP BY ni.sku`,
        [date30, today]
      );
      const normalizeAndAgg = (rows, map) => {
        for (const r of rows) {
          const skuOrig = String(r.sku_original || '');
          const skuLimpo = limparSkuFinal(skuOrig);
          const qtd = Number(r.qtd) || 0;
          if (qtd <= 0) continue;
          const exploded = explodeToSimples(skuLimpo);
          if (exploded.size === 0) {
            map.set(skuLimpo, (map.get(skuLimpo) || 0) + qtd);
            continue;
          }
          for (const [skuComp, fator] of exploded.entries()) {
            map.set(skuComp, (map.get(skuComp) || 0) + qtd * fator);
          }
        }
      };
      normalizeAndAgg(rows7, vendas7BySku);
      normalizeAndAgg(rows30, vendas30BySku);
    }

    // Pendente = soma de (quantity_ordered - quantity_received) nos itens de lotes abertos/parciais.
    // Mantém leitura da tabela legada supplier_order_items por compatibilidade com dados antigos.
    const pendingFactory = await dbAllAsync(
      `SELECT foi.inventory_id, SUM(foi.quantity_ordered - foi.quantity_received) AS qtd
       FROM factory_order_items foi
       JOIN factory_orders fo ON fo.id = foi.factory_order_id
       WHERE fo.status IN ('open', 'partially_received')
       GROUP BY foi.inventory_id`
    );
    const pendingLegacy = await dbAllAsync(
      `SELECT inventory_id, SUM(quantity) AS qtd FROM supplier_order_items WHERE status = 'pending' GROUP BY inventory_id`
    );
    const pendingByInvId = new Map();
    for (const r of pendingFactory || []) {
      pendingByInvId.set(r.inventory_id, Number(r.qtd || 0));
    }
    for (const r of pendingLegacy || []) {
      pendingByInvId.set(r.inventory_id, (pendingByInvId.get(r.inventory_id) || 0) + Number(r.qtd || 0));
    }

    // Mapa reverso: para cada SKU simples, lista os compostos (e fator) que o utilizam
    // — permite mostrar no UI "componente de: X (×2), Y (×1)".
    const usedInBySku = new Map();
    for (const mainSku of kitMap.keys()) {
      const exploded = explodeToSimples(mainSku);
      for (const [skuComp, fator] of exploded.entries()) {
        if (skuComp === mainSku) continue;
        if (!usedInBySku.has(skuComp)) usedInBySku.set(skuComp, []);
        usedInBySku.get(skuComp).push({ sku: mainSku, title: skuToItem[mainSku]?.title || null, qty: fator });
      }
    }

    const items = [];
    for (const inv of inventory) {
      if (inv.is_composite) continue;
      let vendas7, vendas30, mediaDiaria;
      if (useCustomRange && vendasPeriodoBySku) {
        const vendasPeriodo = vendasPeriodoBySku.get(inv.sku) || 0;
        vendas7 = vendas30 = vendasPeriodo;
        mediaDiaria = diasPeriodo > 0 ? vendasPeriodo / diasPeriodo : 0;
      } else {
        vendas7 = vendas7BySku.get(inv.sku) || 0;
        vendas30 = vendas30BySku.get(inv.sku) || 0;
        const mediaDiaria7 = vendas7 / 7;
        const mediaDiaria30 = vendas30 / 30;
        mediaDiaria = (mediaDiaria7 + mediaDiaria30) / 2;
      }
      const saldo = Number(inv.quantity) || 0;
      const pedidosFornecedor = pendingByInvId.get(inv.id) || 0;
      const disponivel = saldo + pedidosFornecedor;
      const coberturaDias = mediaDiaria > 0 ? disponivel / mediaDiaria : 999;
      const qtdSugerida = Math.max(0, Math.ceil((SEMANAS_COBERTURA * 7 * mediaDiaria) - disponivel));
      // Em modo período customizado, vendas30 foi sobrescrito pelo total do período; usamos mediaDiaria*30
      // como proxy comparável ("projeção de 30 dias") para os limiares de alerta.
      const vendas30Eq = useCustomRange ? mediaDiaria * 30 : vendas30;
      let alerta = null;
      if (saldo <= 0 && (vendas7 > 0 || vendas30 > 0)) alerta = 'zerado';
      else if (coberturaDias < 7 && mediaDiaria > 0) alerta = 'critico';
      else if (coberturaDias < 14 && mediaDiaria > 0) alerta = 'atencao';
      else if (vendas30Eq >= 10 && coberturaDias < 21) alerta = 'alto_giro';
      items.push({
        id: inv.id,
        sku: inv.sku,
        title: inv.title,
        saldo,
        pedidosFornecedor,
        vendas7,
        vendas30,
        mediaDiaria: Math.round(mediaDiaria * 100) / 100,
        coberturaDias: Math.round(coberturaDias * 1) / 1,
        qtdSugerida,
        alerta,
        min_quantity: inv.min_quantity || 0,
        category: inv.category || null,
        usadoEm: usedInBySku.get(inv.sku) || [],
      });
    }

    // Percentil 80 sobre média diária (comparável entre modos — corrige bug em período customizado).
    const withSales = items.filter(i => i.mediaDiaria > 0);
    const p80Media = withSales.length > 0
      ? [...withSales].sort((a, b) => b.mediaDiaria - a.mediaDiaria)[Math.floor(withSales.length * 0.2)]?.mediaDiaria || 0
      : 0;
    for (const i of items) {
      if (!i.alerta && i.mediaDiaria >= p80Media && i.mediaDiaria > 0 && i.coberturaDias < 21) i.alerta = 'alto_giro';
    }

    const alertas = items.filter(i => i.alerta);
    const config = { semanasCobertura: SEMANAS_COBERTURA };
    if (useCustomRange) {
      config.dataInicio = dataInicio;
      config.dataFim = dataFim;
      config.diasPeriodo = diasPeriodo;
    }
    res.json({ items, alertas, config });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// @deprecated — preferir /api/factory-orders. Mantido para compatibilidade retroativa.
app.post('/api/reports/replenishment/orders', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { inventory_id, quantity } = req.body || {};
    if (!inventory_id || !Number.isFinite(Number(quantity)) || Number(quantity) <= 0) {
      return res.status(400).json({ error: 'inventory_id e quantity (positivo) são obrigatórios' });
    }
    await dbRunAsync(
      'INSERT INTO supplier_order_items (inventory_id, quantity, status) VALUES (?, ?, ?)',
      [Number(inventory_id), Math.floor(Number(quantity)), 'pending']
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// @deprecated
app.delete('/api/reports/replenishment/orders/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await dbRunAsync('DELETE FROM supplier_order_items WHERE id = ?', [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// @deprecated
app.get('/api/reports/replenishment/orders', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const rows = await dbAllAsync(
      `SELECT so.id, so.inventory_id, so.quantity, so.status, so.created_at, i.sku, i.title
       FROM supplier_order_items so
       JOIN inventory i ON i.id = so.inventory_id
       WHERE so.status = 'pending'
       ORDER BY so.created_at DESC`
    );
    res.json({ orders: rows || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== Factory Orders (lotes pedidos à fábrica) =====

/** Gera próximo código de lote LOTE-AAAA-NNNN no formato do ano corrente. Sequência reiniciada por ano. */
async function generateFactoryOrderCode() {
  const year = new Date().getFullYear();
  const prefix = `LOTE-${year}-`;
  const row = await dbGetAsync(
    `SELECT code FROM factory_orders WHERE code LIKE ? ORDER BY id DESC LIMIT 1`,
    [`${prefix}%`]
  );
  let next = 1;
  if (row && row.code) {
    const m = String(row.code).match(/LOTE-\d{4}-(\d+)/);
    if (m) next = parseInt(m[1], 10) + 1;
  }
  return `${prefix}${String(next).padStart(4, '0')}`;
}

/** Recalcula status do cabeçalho baseado nos itens. */
async function recalcFactoryOrderStatus(factoryOrderId) {
  const items = await dbAllAsync(
    `SELECT quantity_ordered, quantity_received FROM factory_order_items WHERE factory_order_id = ?`,
    [factoryOrderId]
  );
  if (!items.length) return;
  const totalOrdered = items.reduce((a, i) => a + Number(i.quantity_ordered || 0), 0);
  const totalReceived = items.reduce((a, i) => a + Number(i.quantity_received || 0), 0);
  let status = 'open';
  let closedAt = null;
  if (totalReceived >= totalOrdered && totalOrdered > 0) {
    status = 'received';
    closedAt = new Date().toISOString();
  } else if (totalReceived > 0) {
    status = 'partially_received';
  }
  await dbRunAsync(
    `UPDATE factory_orders SET status = ?, closed_at = ? WHERE id = ? AND status != 'cancelled'`,
    [status, closedAt, factoryOrderId]
  );
  return status;
}

// POST /api/factory-orders — cria lote (role >= 3)
app.post('/api/factory-orders', authenticateToken, requireRoleAtLeast(3), async (req, res) => {
  try {
    const { supplier_name, expected_date, notes, items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items[] é obrigatório com pelo menos 1 item' });
    }
    const cleanItems = items
      .map(it => ({
        inventory_id: Number(it.inventory_id),
        quantity: Math.floor(Number(it.quantity || 0)),
        notes: it.notes ? String(it.notes) : null,
      }))
      .filter(it => Number.isFinite(it.inventory_id) && it.inventory_id > 0 && Number.isFinite(it.quantity) && it.quantity > 0);
    if (cleanItems.length === 0) {
      return res.status(400).json({ error: 'Nenhum item válido' });
    }
    const ids = cleanItems.map(i => i.inventory_id);
    const placeholders = ids.map(() => '?').join(',');
    const invRows = await dbAllAsync(`SELECT id, sku, title FROM inventory WHERE id IN (${placeholders})`, ids);
    const invById = new Map((invRows || []).map(r => [r.id, r]));
    const missing = ids.filter(id => !invById.has(id));
    if (missing.length > 0) {
      return res.status(400).json({ error: `Itens de inventário não encontrados: ${missing.join(', ')}` });
    }
    const code = await generateFactoryOrderCode();
    const expDate = /^\d{4}-\d{2}-\d{2}$/.test(String(expected_date || '').trim()) ? String(expected_date).trim() : null;
    const result = await dbRunAsync(
      `INSERT INTO factory_orders (code, supplier_name, expected_date, status, notes, created_by)
       VALUES (?, ?, ?, 'open', ?, ?)`,
      [code, supplier_name ? String(supplier_name).trim() : null, expDate, notes ? String(notes).trim() : null, req.user.id || null]
    );
    const factoryOrderId = result.lastID;
    for (const it of cleanItems) {
      const inv = invById.get(it.inventory_id);
      await dbRunAsync(
        `INSERT INTO factory_order_items (factory_order_id, inventory_id, sku, title, quantity_ordered, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [factoryOrderId, it.inventory_id, inv.sku, inv.title, it.quantity, it.notes]
      );
    }
    addLog('INFO', 'FABRICA', `Lote ${code} criado por ${req.user.name || req.user.id} com ${cleanItems.length} item(ns).`);
    res.json({ id: factoryOrderId, code });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/factory-orders — lista (role >= 2 ou role=5)
app.get('/api/factory-orders', authenticateToken, requireFactoryOrStaff, async (req, res) => {
  try {
    const { status, q, dateFrom, dateTo } = req.query || {};
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const where = [];
    const params = [];
    // Fábrica só vê lotes abertos/parciais (operação do dia a dia)
    if (Number(req.user.role) === 5) {
      where.push(`status IN ('open', 'partially_received')`);
    } else if (status && typeof status === 'string') {
      const allowed = ['open', 'partially_received', 'received', 'cancelled'];
      const parts = status.split(',').map(s => s.trim()).filter(s => allowed.includes(s));
      if (parts.length) {
        where.push(`status IN (${parts.map(() => '?').join(',')})`);
        params.push(...parts);
      }
    }
    if (q && String(q).trim()) {
      where.push(`(code LIKE ? OR supplier_name LIKE ?)`);
      const like = `%${String(q).trim()}%`;
      params.push(like, like);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(dateFrom || '').trim())) {
      where.push(`date(created_at) >= date(?)`);
      params.push(String(dateFrom).trim());
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(dateTo || '').trim())) {
      where.push(`date(created_at) <= date(?)`);
      params.push(String(dateTo).trim());
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sql = `
      SELECT fo.id, fo.code, fo.supplier_name, fo.expected_date, fo.status, fo.notes,
             fo.created_by, fo.created_at, fo.closed_at,
             u.name AS created_by_name,
             (SELECT COUNT(*) FROM factory_order_items WHERE factory_order_id = fo.id) AS items_count,
             (SELECT COALESCE(SUM(quantity_ordered), 0) FROM factory_order_items WHERE factory_order_id = fo.id) AS total_ordered,
             (SELECT COALESCE(SUM(quantity_received), 0) FROM factory_order_items WHERE factory_order_id = fo.id) AS total_received,
             (SELECT COALESCE(SUM(r.quantity), 0)
                FROM factory_order_receipts r
                JOIN factory_order_items foi ON foi.id = r.factory_order_item_id
                WHERE foi.factory_order_id = fo.id AND r.status = 'pending') AS total_awaiting
      FROM factory_orders fo
      LEFT JOIN users u ON u.id = fo.created_by
      ${whereSql}
      ORDER BY fo.created_at DESC
      LIMIT ? OFFSET ?
    `;
    const rows = await dbAllAsync(sql, [...params, limit, offset]);
    const totalRow = await dbGetAsync(`SELECT COUNT(*) AS total FROM factory_orders ${whereSql}`, params);
    res.json({ orders: rows || [], total: totalRow?.total || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/factory-orders/:id — detalhe (role >= 2 ou role=5)
app.get('/api/factory-orders/:id', authenticateToken, requireFactoryOrStaff, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const order = await dbGetAsync(
      `SELECT fo.*, u.name AS created_by_name
       FROM factory_orders fo
       LEFT JOIN users u ON u.id = fo.created_by
       WHERE fo.id = ?`,
      [id]
    );
    if (!order) return res.status(404).json({ error: 'Lote não encontrado' });
    const items = await dbAllAsync(
      `SELECT foi.*, i.sku AS inventory_sku, i.title AS inventory_title, i.quantity AS stock_current
       FROM factory_order_items foi
       LEFT JOIN inventory i ON i.id = foi.inventory_id
       WHERE foi.factory_order_id = ?
       ORDER BY foi.id ASC`,
      [id]
    );
    const itemIds = items.map(it => it.id);
    let receipts = [];
    if (itemIds.length) {
      const ph = itemIds.map(() => '?').join(',');
      receipts = await dbAllAsync(
        `SELECT r.*, u.name AS received_by_name, c.name AS confirmed_by_name,
                foi.sku AS item_sku, foi.title AS item_title
         FROM factory_order_receipts r
         LEFT JOIN users u ON u.id = r.received_by
         LEFT JOIN users c ON c.id = r.confirmed_by
         LEFT JOIN factory_order_items foi ON foi.id = r.factory_order_item_id
         WHERE r.factory_order_item_id IN (${ph})
         ORDER BY r.received_at DESC`,
        itemIds
      );
    }
    res.json({ order, items, receipts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/factory-orders/:id — editar cabeçalho/itens enquanto 'open' (role >= 3)
app.patch('/api/factory-orders/:id', authenticateToken, requireRoleAtLeast(3), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const order = await dbGetAsync('SELECT * FROM factory_orders WHERE id = ?', [id]);
    if (!order) return res.status(404).json({ error: 'Lote não encontrado' });
    if (order.status !== 'open') {
      return res.status(400).json({ error: 'Apenas lotes em aberto podem ser editados' });
    }
    const { supplier_name, expected_date, notes, items } = req.body || {};
    const fields = [];
    const params = [];
    if (supplier_name !== undefined) { fields.push('supplier_name = ?'); params.push(supplier_name ? String(supplier_name).trim() : null); }
    if (expected_date !== undefined) {
      const ed = /^\d{4}-\d{2}-\d{2}$/.test(String(expected_date || '').trim()) ? String(expected_date).trim() : null;
      fields.push('expected_date = ?'); params.push(ed);
    }
    if (notes !== undefined) { fields.push('notes = ?'); params.push(notes ? String(notes).trim() : null); }
    if (fields.length) {
      params.push(id);
      await dbRunAsync(`UPDATE factory_orders SET ${fields.join(', ')} WHERE id = ?`, params);
    }
    if (Array.isArray(items)) {
      // Estratégia simples: substitui todos os itens (seguro porque o lote ainda está 'open' — sem recebimentos)
      await dbRunAsync('DELETE FROM factory_order_items WHERE factory_order_id = ?', [id]);
      const cleanItems = items
        .map(it => ({ inventory_id: Number(it.inventory_id), quantity: Math.floor(Number(it.quantity || 0)), notes: it.notes ? String(it.notes) : null }))
        .filter(it => Number.isFinite(it.inventory_id) && it.inventory_id > 0 && it.quantity > 0);
      if (cleanItems.length === 0) {
        return res.status(400).json({ error: 'items[] não pode ficar vazio' });
      }
      const ids = cleanItems.map(i => i.inventory_id);
      const ph = ids.map(() => '?').join(',');
      const invRows = await dbAllAsync(`SELECT id, sku, title FROM inventory WHERE id IN (${ph})`, ids);
      const invById = new Map((invRows || []).map(r => [r.id, r]));
      for (const it of cleanItems) {
        const inv = invById.get(it.inventory_id);
        if (!inv) return res.status(400).json({ error: `Inventário ${it.inventory_id} não encontrado` });
        await dbRunAsync(
          `INSERT INTO factory_order_items (factory_order_id, inventory_id, sku, title, quantity_ordered, notes)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [id, it.inventory_id, inv.sku, inv.title, it.quantity, it.notes]
        );
      }
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/factory-orders/:id/cancel — cancelar (role >= 4)
app.post('/api/factory-orders/:id/cancel', authenticateToken, requireRoleAtLeast(4), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const order = await dbGetAsync('SELECT * FROM factory_orders WHERE id = ?', [id]);
    if (!order) return res.status(404).json({ error: 'Lote não encontrado' });
    if (order.status === 'received' || order.status === 'cancelled') {
      return res.status(400).json({ error: `Não é possível cancelar lote com status "${order.status}"` });
    }
    await dbRunAsync(
      `UPDATE factory_orders SET status = 'cancelled', closed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [id]
    );
    addLog('INFO', 'FABRICA', `Lote ${order.code} cancelado por ${req.user.name || req.user.id}.`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/factory-orders/:id/receipts — histórico do lote (role >= 2 ou role=5)
app.get('/api/factory-orders/:id/receipts', authenticateToken, requireFactoryOrStaff, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const rows = await dbAllAsync(
      `SELECT r.*, u.name AS received_by_name, c.name AS confirmed_by_name,
              foi.sku AS item_sku, foi.title AS item_title
       FROM factory_order_receipts r
       LEFT JOIN factory_order_items foi ON foi.id = r.factory_order_item_id
       LEFT JOIN users u ON u.id = r.received_by
       LEFT JOIN users c ON c.id = r.confirmed_by
       WHERE foi.factory_order_id = ?
       ORDER BY r.received_at DESC`,
      [id]
    );
    res.json({ receipts: rows || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/factory-receipts/pending — fila de conferência da expedição (role >= 2)
// (path separado para não colidir com /api/factory-orders/:id)
app.get('/api/factory-receipts/pending', authenticateToken, requireRoleAtLeast(2), async (req, res) => {
  try {
    const rows = await dbAllAsync(
      `SELECT r.id, r.factory_order_item_id, r.quantity, r.received_by, r.received_at, r.notes,
              u.name AS received_by_name,
              foi.inventory_id, foi.sku AS item_sku, foi.title AS item_title,
              foi.quantity_ordered, foi.quantity_received,
              fo.id AS factory_order_id, fo.code AS factory_order_code, fo.supplier_name
       FROM factory_order_receipts r
       JOIN factory_order_items foi ON foi.id = r.factory_order_item_id
       JOIN factory_orders fo ON fo.id = foi.factory_order_id
       LEFT JOIN users u ON u.id = r.received_by
       WHERE r.status = 'pending'
       ORDER BY r.received_at ASC`
    );
    res.json({ receipts: rows || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/factory-orders/:id/receipts — fábrica registra entrega (apenas DECLARA, fica pendente de conferência)
app.post('/api/factory-orders/:id/receipts', authenticateToken, requireFactoryOrStaff, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const order = await dbGetAsync('SELECT * FROM factory_orders WHERE id = ?', [id]);
    if (!order) return res.status(404).json({ error: 'Lote não encontrado' });
    if (order.status === 'cancelled' || order.status === 'received') {
      return res.status(400).json({ error: `Lote com status "${order.status}" não aceita recebimentos.` });
    }
    const body = req.body || {};
    const rawItems = Array.isArray(body.items) ? body.items : [];
    const entries = rawItems
      .map(it => ({
        item_id: Number(it.item_id),
        quantity: Math.floor(Number(it.quantity || 0)),
        notes: it.notes ? String(it.notes) : null,
      }))
      .filter(it => Number.isFinite(it.item_id) && it.item_id > 0 && it.quantity > 0);
    if (entries.length === 0) {
      return res.status(400).json({ error: 'Informe pelo menos um item com quantidade > 0' });
    }
    const itemIds = entries.map(e => e.item_id);
    const ph = itemIds.map(() => '?').join(',');
    const items = await dbAllAsync(
      `SELECT * FROM factory_order_items WHERE id IN (${ph}) AND factory_order_id = ?`,
      [...itemIds, id]
    );
    if (items.length !== itemIds.length) {
      return res.status(400).json({ error: 'Algum item_id não pertence a este lote' });
    }
    const itemsById = new Map(items.map(i => [i.id, i]));
    // Pendente declarável = ordered - confirmed - (declarado pendente). Não permite declarar mais que sobra.
    const pendingDeclared = await dbAllAsync(
      `SELECT factory_order_item_id, COALESCE(SUM(quantity), 0) AS qtd
       FROM factory_order_receipts
       WHERE status = 'pending' AND factory_order_item_id IN (${ph})
       GROUP BY factory_order_item_id`,
      itemIds
    );
    const declaredById = new Map((pendingDeclared || []).map(r => [r.factory_order_item_id, Number(r.qtd) || 0]));
    for (const e of entries) {
      const it = itemsById.get(e.item_id);
      const declared = declaredById.get(e.item_id) || 0;
      const remaining = Number(it.quantity_ordered) - Number(it.quantity_received) - declared;
      if (e.quantity > remaining) {
        return res.status(400).json({ error: `Quantidade ${e.quantity} excede o pendente (${remaining}) no item ${it.sku || it.id}. Considere o que já foi declarado e ainda não conferido.` });
      }
    }

    // Apenas registra como pending. NÃO mexe em estoque/movimentos. Conferência fará isso.
    for (const e of entries) {
      await dbRunAsync(
        `INSERT INTO factory_order_receipts (factory_order_item_id, quantity, received_by, notes, status)
         VALUES (?, ?, ?, ?, 'pending')`,
        [e.item_id, e.quantity, req.user.id || null, e.notes]
      );
    }
    addLog('INFO', 'FABRICA', `Entrega declarada no lote ${order.code} (${entries.length} linha(s)) por ${req.user.name || req.user.id}. Aguardando conferência.`);
    res.json({ ok: true, status: order.status, pending_confirmation: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/factory-receipts/:rid/confirm — expedição confere e aprova (role >= 2)
// Body: { quantity_confirmed?, divergence_notes? }. quantity_confirmed default = quantity declarada.
app.post('/api/factory-receipts/:rid/confirm', authenticateToken, requireRoleAtLeast(2), async (req, res) => {
  try {
    const rid = Number(req.params.rid);
    const receipt = await dbGetAsync(
      `SELECT r.*, foi.inventory_id, foi.sku, foi.quantity_ordered, foi.quantity_received,
              fo.id AS factory_order_id, fo.code AS factory_order_code, fo.status AS factory_order_status
       FROM factory_order_receipts r
       JOIN factory_order_items foi ON foi.id = r.factory_order_item_id
       JOIN factory_orders fo ON fo.id = foi.factory_order_id
       WHERE r.id = ?`,
      [rid]
    );
    if (!receipt) return res.status(404).json({ error: 'Recebimento não encontrado' });
    if (receipt.status !== 'pending') {
      return res.status(400).json({ error: `Recebimento já processado (status: ${receipt.status})` });
    }
    if (receipt.factory_order_status === 'cancelled') {
      return res.status(400).json({ error: 'Lote cancelado.' });
    }
    const body = req.body || {};
    const declared = Number(receipt.quantity) || 0;
    const qtyConfirmedRaw = body.quantity_confirmed === undefined || body.quantity_confirmed === null || body.quantity_confirmed === ''
      ? declared
      : Number(body.quantity_confirmed);
    const qtyConfirmed = Math.floor(qtyConfirmedRaw);
    if (!Number.isFinite(qtyConfirmed) || qtyConfirmed < 0) {
      return res.status(400).json({ error: 'quantity_confirmed inválido' });
    }
    if (qtyConfirmed > declared) {
      return res.status(400).json({ error: `Não é possível confirmar ${qtyConfirmed} (mais que o declarado pela fábrica: ${declared}). Para receber a mais, peça à fábrica para registrar nova entrega.` });
    }
    const remaining = Number(receipt.quantity_ordered) - Number(receipt.quantity_received);
    if (qtyConfirmed > remaining) {
      return res.status(400).json({ error: `Confirmação de ${qtyConfirmed} excede o pendente do item (${remaining}).` });
    }
    const divergenceNotes = body.divergence_notes ? String(body.divergence_notes).trim() : null;
    if (qtyConfirmed !== declared && !divergenceNotes) {
      return res.status(400).json({ error: 'Há divergência entre a quantidade declarada e a conferida — preencha "divergence_notes" explicando.' });
    }

    await dbRunAsync('BEGIN TRANSACTION');
    try {
      await dbRunAsync(
        `UPDATE factory_order_receipts
         SET status = 'confirmed', quantity_confirmed = ?, confirmed_by = ?, confirmed_at = CURRENT_TIMESTAMP, divergence_notes = ?
         WHERE id = ?`,
        [qtyConfirmed, req.user.id || null, divergenceNotes, rid]
      );
      if (qtyConfirmed > 0) {
        await dbRunAsync(
          `UPDATE factory_order_items SET quantity_received = quantity_received + ? WHERE id = ?`,
          [qtyConfirmed, receipt.factory_order_item_id]
        );
        const inv = await dbGetAsync('SELECT id, quantity FROM inventory WHERE id = ?', [receipt.inventory_id]);
        if (!inv) throw new Error(`Inventário ${receipt.inventory_id} não encontrado`);
        const prev = Number(inv.quantity) || 0;
        const next = prev + qtyConfirmed;
        await dbRunAsync('UPDATE inventory SET quantity = ? WHERE id = ?', [next, receipt.inventory_id]);
        // A3: recebimento aprovado eleva inventory.quantity — avisa canais.
        pushStockForInventoryId(receipt.inventory_id).catch(() => {});
        const reasonParts = [`Recebimento do lote ${receipt.factory_order_code}`];
        if (qtyConfirmed !== declared) reasonParts.push(`(declarado: ${declared}, conferido: ${qtyConfirmed})`);
        if (divergenceNotes) reasonParts.push(`— ${divergenceNotes}`);
        await dbRunAsync(
          `INSERT INTO inventory_movements (inventory_id, movement_type, quantity, previous_quantity, new_quantity, reason, user_id, account_id, movement_date)
           VALUES (?, 'in', ?, ?, ?, ?, ?, NULL, ?)`,
          [receipt.inventory_id, qtyConfirmed, prev, next, reasonParts.join(' '), req.user.id || null, getCurrentDateTimeSP()]
        );
      }
      await dbRunAsync('COMMIT');
    } catch (txErr) {
      try { await dbRunAsync('ROLLBACK'); } catch {}
      throw txErr;
    }
    const newStatus = await recalcFactoryOrderStatus(receipt.factory_order_id);
    addLog('INFO', 'FABRICA', `Conferência aprovada (lote ${receipt.factory_order_code}, item ${receipt.sku}, declarado ${declared} → conferido ${qtyConfirmed}) por ${req.user.name || req.user.id}.`);
    res.json({ ok: true, factory_order_status: newStatus, quantity_confirmed: qtyConfirmed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/factory-receipts/:rid/reject — expedição rejeita o recebimento (role >= 2)
app.post('/api/factory-receipts/:rid/reject', authenticateToken, requireRoleAtLeast(2), async (req, res) => {
  try {
    const rid = Number(req.params.rid);
    const receipt = await dbGetAsync(
      `SELECT r.*, fo.code AS factory_order_code, foi.sku
       FROM factory_order_receipts r
       JOIN factory_order_items foi ON foi.id = r.factory_order_item_id
       JOIN factory_orders fo ON fo.id = foi.factory_order_id
       WHERE r.id = ?`,
      [rid]
    );
    if (!receipt) return res.status(404).json({ error: 'Recebimento não encontrado' });
    if (receipt.status !== 'pending') {
      return res.status(400).json({ error: `Recebimento já processado (status: ${receipt.status})` });
    }
    const body = req.body || {};
    const divergenceNotes = body.divergence_notes ? String(body.divergence_notes).trim() : null;
    if (!divergenceNotes) {
      return res.status(400).json({ error: 'Informe o motivo da rejeição em "divergence_notes".' });
    }
    await dbRunAsync(
      `UPDATE factory_order_receipts
       SET status = 'rejected', quantity_confirmed = 0, confirmed_by = ?, confirmed_at = CURRENT_TIMESTAMP, divergence_notes = ?
       WHERE id = ?`,
      [req.user.id || null, divergenceNotes, rid]
    );
    addLog('INFO', 'FABRICA', `Recebimento rejeitado (lote ${receipt.factory_order_code}, item ${receipt.sku}) por ${req.user.name || req.user.id}. Motivo: ${divergenceNotes}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Export XLSX: aba Unificado (todas as contas) + abas por conta
const sanitizeSheetName = (name) => String(name || '').replace(/[\\/*?:\[\]]/g, '_').slice(0, 31);

app.get('/api/export/sales.xlsx', async (req, res) => {
  try {
    const { dataInicio, dataFim, marketplace } = req.query || {};
    // Sempre buscar TODOS os dados (sem filtro de conta) para gerar Unificado + abas por conta
    const where = [];
    const params = [];
    const dateExpr = reportDateExpr('n');
    if (dataInicio) { where.push(`${dateExpr} >= date(?)`); params.push(`${dataInicio}`); }
    if (dataFim) { where.push(`${dateExpr} <= date(?)`); params.push(`${dataFim}`); }
    if (marketplace) { where.push('n.marketplace = ?'); params.push(marketplace); }
    let whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';
    whereSql = whereSql ? whereSql + ` AND UPPER(REPLACE(COALESCE(n.cliente,''), '.', '')) NOT LIKE '%EBAZARCOMBR LTDA%'` : `WHERE UPPER(REPLACE(COALESCE(n.cliente,''), '.', '')) NOT LIKE '%EBAZARCOMBR LTDA%'`;

    const accountsRows = await dbAllAsync('SELECT id, name FROM bling_accounts');
    const accountNameById = new Map((accountsRows || []).map(r => [Number(r.id), r.name]));
    const getAccountName = (id) => {
      const key = id === null || id === undefined ? defaultBlingAccountId : Number(id);
      if (!Number.isFinite(key)) return 'Sem conta';
      return accountNameById.get(key) || `Conta ${key}`;
    };

    const rows = await dbAllAsync(
      `SELECT n.id AS nota_id, n.account_id, n.valorNota, n.marketplace AS mk_raw, n.numeroLoja,
              ni.sku AS sku_original, ni.quantidade
       FROM notas_expedidas n
       JOIN nota_itens_expedidos ni ON ni.nota_id = n.id AND (ni.account_id = n.account_id OR ni.account_id IS NULL)
       ${whereSql}`,
      params
    );

    const notasResumo = await dbAllAsync(
      `SELECT n.id AS nota_id, n.account_id, n.valorNota, n.marketplace AS mk_raw, n.numeroLoja
       FROM notas_expedidas n
       ${whereSql}`,
      params
    );

    const orderRowsRaw = await dbAllAsync(
      `SELECT n.id AS nota_id, n.numero AS numero, n.marketplace AS mk_raw, n.numeroLoja, n.account_id, n.valorNota AS faturamento, n.dataExpedicao AS data,
             COALESCE(SUM(ni.quantidade), 0) AS itens
       FROM notas_expedidas n
       LEFT JOIN nota_itens_expedidos ni ON ni.nota_id = n.id AND (ni.account_id = n.account_id OR ni.account_id IS NULL)
       ${whereSql}
       GROUP BY n.id
       ORDER BY n.dataExpedicao DESC`,
      params
    );

    const inventory = await dbAllAsync('SELECT id, sku, title, is_composite FROM inventory');
    const skuToItem = {}; for (const p of inventory) skuToItem[p.sku] = p;
    const relations = await dbAllAsync('SELECT main_sku_id, component_sku_id, quantity FROM composite_skus');
    const idToSku = {}; for (const p of inventory) idToSku[p.id] = p.sku;
    const kitMap = new Map();
    for (const r of relations) { const mainSku = idToSku[r.main_sku_id]; const compSku = idToSku[r.component_sku_id]; if (!mainSku || !compSku) continue; if (!kitMap.has(mainSku)) kitMap.set(mainSku, []); kitMap.get(mainSku).push({ compSku, qty: r.quantity }); }

    const itensConvertidos = [];
    const somaPorNota = new Map();
    for (const row of rows) {
      const skuOriginal = String(row.sku_original || '');
      const skuLimpo = limparSkuFinal(skuOriginal);
      let normalizedSku = skuLimpo;
      let title = skuToItem[skuLimpo]?.title || '';
      let quantidade = Number(row.quantidade) || 0;
      let fator = 1;
      const compList = kitMap.get(skuLimpo);
      if (skuToItem[skuLimpo]?.is_composite && Array.isArray(compList) && compList.length === 1) {
        normalizedSku = compList[0].compSku; fator = Number(compList[0].qty) || 1; title = skuToItem[normalizedSku]?.title || title;
      }
      const convertedQty = quantidade * fator;
      const accId = row.account_id != null ? row.account_id : defaultBlingAccountId;
      const mk = row.mk_raw || identificarMarketplace(String(row.numeroLoja || ''), []);
      itensConvertidos.push({ nota_id: row.nota_id, account_id: accId, marketplace: mk || 'Desconhecido', sku: normalizedSku, title, convertedQty, valorNota: Number(row.valorNota) || 0 });
      const soma = somaPorNota.get(row.nota_id) || 0; somaPorNota.set(row.nota_id, soma + convertedQty);
    }

    // Função para construir resumo, itens e pedidos a partir de dados filtrados
    const buildReportData = (notasFiltradas, itensFiltrados, pedidosFiltrados, contaLabel) => {
      const notaIds = new Set(notasFiltradas.map(n => n.nota_id));
      const totalsByMarketplace = new Map();
      for (const n of notasFiltradas) {
        const mk = n.mk_raw || identificarMarketplace(String(n.numeroLoja || ''), []) || 'Desconhecido';
        if (!totalsByMarketplace.has(mk)) totalsByMarketplace.set(mk, { marketplace: mk, pedidosSet: new Set(), faturamento: 0 });
        const b = totalsByMarketplace.get(mk);
        b.pedidosSet.add(n.nota_id);
        b.faturamento += Number(n.valorNota || 0);
      }
      const agg = new Map();
      const pedidosPorMarketplace = new Map();
      for (const it of itensFiltrados) {
        if (!notaIds.has(it.nota_id)) continue;
        const denominador = somaPorNota.get(it.nota_id) || 0;
        const parcela = denominador > 0 ? (it.valorNota * (it.convertedQty / denominador)) : 0;
        const key = `${it.marketplace}|${it.sku}`;
        const atual = agg.get(key) || { marketplace: it.marketplace, sku: it.sku, title: it.title || '', quantidade: 0, faturamento: 0 };
        atual.quantidade += it.convertedQty; atual.faturamento += parcela; if (!atual.title && it.title) atual.title = it.title;
        agg.set(key, atual);
        if (!pedidosPorMarketplace.has(it.marketplace)) pedidosPorMarketplace.set(it.marketplace, new Set());
        pedidosPorMarketplace.get(it.marketplace).add(it.nota_id);
      }
      const porMarketplace = new Map();
      for (const [mk, total] of totalsByMarketplace.entries()) {
        porMarketplace.set(mk, { marketplace: mk, pedidos: total.pedidosSet.size, itens: 0, faturamento: total.faturamento });
      }
      for (const row of agg.values()) {
        if (!porMarketplace.has(row.marketplace)) porMarketplace.set(row.marketplace, { marketplace: row.marketplace, pedidos: 0, itens: 0, faturamento: 0 });
        const b = porMarketplace.get(row.marketplace);
        b.itens += row.quantidade;
        if (!totalsByMarketplace.has(row.marketplace)) b.faturamento += row.faturamento;
      }
      for (const [mk, setNotas] of pedidosPorMarketplace.entries()) {
        const b = porMarketplace.get(mk);
        if (b && b.pedidos === 0) b.pedidos = setNotas.size;
      }
      let resumoRows = Array.from(porMarketplace.values()).sort((a,b)=> (b.faturamento-a.faturamento)||(b.pedidos-a.pedidos)).map(r => ({ Conta: contaLabel, Marketplace: r.marketplace, Pedidos: r.pedidos, Itens: r.itens, Faturamento: Number(r.faturamento||0) }));
      let itensRows = Array.from(agg.values()).sort((a,b)=> (b.faturamento-a.faturamento)||(b.quantidade-a.quantidade)).map(r => ({ Conta: contaLabel, Marketplace: r.marketplace, SKU: r.sku, Título: r.title || '', Qtd: r.quantidade, Receita: Number(r.faturamento||0) }));
      let pedidosRows = pedidosFiltrados.map(r => ({ Conta: contaLabel, Marketplace: r.mk_raw || identificarMarketplace(String(r.numeroLoja || ''), []) || 'Desconhecido', NF: r.numero || r.nota_id, Data: r.data, Itens: Number(r.itens||0), Faturamento: Number(r.faturamento||0) }));
      if (marketplace && marketplace.trim()) {
        const q = marketplace.trim().toLowerCase();
        resumoRows = resumoRows.filter(r => (r.Marketplace || '').toLowerCase().includes(q));
        itensRows = itensRows.filter(r => (r.Marketplace || '').toLowerCase().includes(q));
        pedidosRows = pedidosRows.filter(r => (r.Marketplace || '').toLowerCase().includes(q));
      }
      return { resumoRows, itensRows, pedidosRows };
    };

    // 1) Dados UNIFICADOS (todas as contas)
    const unificado = buildReportData(notasResumo, itensConvertidos, orderRowsRaw, 'Todas');

    // 2) Dados POR CONTA
    const accountIds = [...new Set(notasResumo.map(n => n.account_id != null ? n.account_id : defaultBlingAccountId))].filter(Number.isFinite).sort((a,b)=>a-b);
    const porConta = [];
    for (const accId of accountIds) {
      const notasAcc = notasResumo.filter(n => (n.account_id != null ? n.account_id : defaultBlingAccountId) === accId);
      const itensAcc = itensConvertidos.filter(it => it.account_id === accId);
      const pedidosAcc = orderRowsRaw.filter(o => (o.account_id != null ? o.account_id : defaultBlingAccountId) === accId);
      if (notasAcc.length === 0 && pedidosAcc.length === 0) continue;
      const nomeConta = getAccountName(accId);
      porConta.push({ accountId: accId, nomeConta, ...buildReportData(notasAcc, itensAcc, pedidosAcc, nomeConta) });
    }

    const resumoHeaders = ['Conta','Marketplace','Pedidos','Itens','Faturamento'];
    const itensHeaders = ['Conta','Marketplace','SKU','Título','Qtd','Receita'];
    const pedidosHeaders = ['Conta','Marketplace','NF','Data','Itens','Faturamento'];

    const periodoLabel = (dataInicio && dataFim) ? `Período: ${dataInicio} a ${dataFim}` : (dataInicio ? `A partir de: ${dataInicio}` : '');

    // Uma única aba com seções: Resumo | Itens | Pedidos (menos poluído)
    const buildConsolidatedSheet = (resumoRows, itensRows, pedidosRows, pedidosConverted) => {
      const aoa = [];
      if (periodoLabel) aoa.push([periodoLabel]);
      aoa.push(['RESUMO POR MARKETPLACE']);
      aoa.push(resumoHeaders);
      resumoRows.forEach(r => aoa.push(resumoHeaders.map(h => r[h])));
      aoa.push([]);
      aoa.push(['ITENS VENDIDOS']);
      aoa.push(itensHeaders);
      itensRows.forEach(r => aoa.push(itensHeaders.map(h => r[h])));
      aoa.push([]);
      aoa.push(['PEDIDOS']);
      aoa.push(pedidosHeaders);
      pedidosConverted.forEach(r => aoa.push(pedidosHeaders.map(h => r[h])));
      return aoa;
    };

    const formatConsolidatedSheet = (ws, nResumo, nItens, nPedidos, offset = 0) => {
      const fmtCurr = (col, startR, endR) => {
        for (let R = startR; R <= endR; R++) {
          const addr = xlsx.utils.encode_cell({ r: R, c: col });
          const c = ws[addr];
          if (c && typeof c.v === 'number') c.z = 'R$ #,##0.00';
        }
      };
      const fmtDate = (col, startR, endR) => {
        for (let R = startR; R <= endR; R++) {
          const addr = xlsx.utils.encode_cell({ r: R, c: col });
          const c = ws[addr];
          if (c && (typeof c.v === 'string' || c.v instanceof Date)) {
            try { ws[addr] = { t: 'd', v: new Date(c.v), z: 'yyyy-mm-dd hh:mm' }; } catch {}
          }
        }
      };
      const o = offset;
      // Resumo: após offset, título, header, dados
      if (nResumo > 0) fmtCurr(4, o + 2, o + 1 + nResumo);
      const itensStart = o + 2 + nResumo + 3;
      if (nItens > 0) fmtCurr(5, itensStart, itensStart + nItens - 1);
      const pedidosStart = itensStart + nItens + 3;
      if (nPedidos > 0) { fmtDate(3, pedidosStart, pedidosStart + nPedidos - 1); fmtCurr(5, pedidosStart, pedidosStart + nPedidos - 1); }
    };

    const wb = xlsx.utils.book_new();
    const colWidths = [18, 22, 12, 35, 8, 16];

    // Aba UNIFICADO (uma única aba com 3 seções)
    const unificadoPedidosConv = unificado.pedidosRows.map(r => ({ ...r, Data: r.Data ? new Date(r.Data) : r.Data }));
    const aoaUni = buildConsolidatedSheet(unificado.resumoRows, unificado.itensRows, unificado.pedidosRows, unificadoPedidosConv);
    const wsUni = xlsx.utils.aoa_to_sheet(aoaUni);
    wsUni['!cols'] = colWidths.map(w => ({ wch: w }));
    formatConsolidatedSheet(wsUni, unificado.resumoRows.length, unificado.itensRows.length, unificado.pedidosRows.length, periodoLabel ? 1 : 0);
    xlsx.utils.book_append_sheet(wb, wsUni, sanitizeSheetName('Unificado'));

    // Abas POR CONTA (uma aba por conta com 3 seções)
    const usedNames = new Set(['Unificado']);
    for (const { nomeConta, resumoRows, itensRows, pedidosRows } of porConta) {
      const base = sanitizeSheetName(nomeConta);
      let name = base; let i = 0; while (usedNames.has(name)) name = sanitizeSheetName(`${base} (${++i})`);
      usedNames.add(name);
      const pedidosConv = pedidosRows.map(r => ({ ...r, Data: r.Data ? new Date(r.Data) : r.Data }));
      const aoa = buildConsolidatedSheet(resumoRows, itensRows, pedidosRows, pedidosConv);
      const ws = xlsx.utils.aoa_to_sheet(aoa);
      ws['!cols'] = colWidths.map(w => ({ wch: w }));
      formatConsolidatedSheet(ws, resumoRows.length, itensRows.length, pedidosRows.length, periodoLabel ? 1 : 0);
      xlsx.utils.book_append_sheet(wb, ws, name);
    }

    const inicioSafe = (dataInicio || '').replace(/[^0-9-]/g, '');
    const fimSafe = (dataFim || '').replace(/[^0-9-]/g, '');
    const suffix = inicioSafe && fimSafe ? `_${inicioSafe}_a_${fimSafe}` : (inicioSafe ? `_${inicioSafe}` : '');
    const filename = `relatorio_vendas${suffix}.xlsx`;
    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (e) {
    res.status(500).json({ error: 'Falha ao exportar XLSX', details: e.message });
  }
});

// ====== Upload de tabela de frete (XLSX/CSV)
const upload = multer({ storage: multer.memoryStorage() });

/** Fotos de modelo de anúncio — salvas em client/public/uploads (URL pública para o ML baixar na publicação). */
const uploadAdModelPicture = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(__dirname, '../client/public/uploads');
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (e) {
        return cb(e);
      }
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
      const extFinal = allowed.includes(ext) ? ext : '.jpg';
      cb(null, `ml-${Date.now()}-${Math.random().toString(36).slice(2, 10)}${extFinal}`);
    }
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const m = (file.mimetype || '').toLowerCase();
    if (m.startsWith('image/')) return cb(null, true);
    cb(new Error('Envie apenas imagens (JPEG, PNG, GIF ou WebP)'));
  }
});

app.post('/api/ad-models/upload-picture', (req, res) => {
  uploadAdModelPicture.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload inválido' });
    try {
      if (!req.file) return res.status(400).json({ error: 'Arquivo não enviado' });
      const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
      const host = req.get('host') || 'localhost';
      const url = `${proto}://${host}/uploads/${req.file.filename}`;
      res.json({ url, path: `/uploads/${req.file.filename}`, filename: req.file.filename });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

app.post('/api/reports/shipping-tables/upload', upload.single('file'), async (req, res) => {
  try {
    const { marketplace, name, rule_type } = req.body || {};
    if (!req.file) return res.status(400).json({ error: 'Arquivo não enviado' });
    if (!marketplace || !name || !rule_type) return res.status(400).json({ error: 'marketplace, name e rule_type são obrigatórios' });

    // Suportar planilha conforme imagem: colunas DE | ATÉ | VALOR1 (peso ou volume)
    const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const json = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '' });
    // Encontrar colunas por header aproximado
    let deIdx = 0, ateIdx = 1, valorIdx = 2;
    const header = (json[0] || []).map(h => String(h).toLowerCase());
    header.forEach((h, idx) => {
      if (h.includes('de')) deIdx = idx;
      if (h.includes('até') || h.includes('ate')) ateIdx = idx;
      if (h.includes('valor')) valorIdx = idx;
    });
    const bands = [];
    for (let i = 1; i < json.length; i++) {
      const row = json[i] || [];
      const min = Number(String(row[deIdx]).toString().replace(',', '.'));
      const max = Number(String(row[ateIdx]).toString().replace(',', '.'));
      const price = Number(String(row[valorIdx]).replace(',', '.'));
      if (!isNaN(min) && !isNaN(max) && !isNaN(price)) {
        bands.push({ min, max, price });
      }
    }

    const rules_json = JSON.stringify(bands);
    db.run(`INSERT INTO shipping_tables (marketplace, name, rule_type, rules_json, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [marketplace, name, rule_type, rules_json], function(err){
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID, totalRegras: bands.length });
      });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Upload de pesos por planilha (SKU | PESO)
app.post('/api/reports/inventory/weights/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Arquivo não enviado' });
    const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const json = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (json.length < 2) return res.json({ updated: 0 });
    // Detectar colunas: SKU e PESO
    let skuIdx = 0, pesoIdx = 1;
    const header = (json[0] || []).map(h => String(h).toLowerCase());
    header.forEach((h, idx) => {
      if (h.includes('sku')) skuIdx = idx;
      if (h.includes('peso')) pesoIdx = idx;
    });
    let updated = 0;
    for (let i = 1; i < json.length; i++) {
      const row = json[i] || [];
      const sku = String(row[skuIdx] || '').trim();
      const peso = Number(String(row[pesoIdx]).toString().replace(',', '.'));
      if (!sku || isNaN(peso)) continue;
      await new Promise((resolve) => db.run('UPDATE inventory SET cubic_weight = ? WHERE sku = ?', [peso, sku], function(){ updated += this.changes || 0; resolve(); }));
    }
    res.json({ updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Upload de medidas (SKU | ALTURA(cm) | LARGURA(cm) | COMPRIMENTO(cm) | PESO(kg))
app.post('/api/reports/inventory/measures/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Arquivo não enviado' });
    const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const json = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (json.length < 2) return res.json({ updated: 0 });
    let skuIdx = 0, hIdx = 1, wIdx = 2, lIdx = 3, pesoIdx = 4;
    const header = (json[0] || []).map(h => String(h).toLowerCase());
    header.forEach((h, idx) => {
      if (h.includes('sku')) skuIdx = idx;
      if (h.includes('altura') || h.includes('height')) hIdx = idx;
      if (h.includes('larg') || h.includes('width') || h.includes('largura')) wIdx = idx;
      if (h.includes('comp') || h.includes('length') || h.includes('comprimento')) lIdx = idx;
      if (h.includes('peso') || h.includes('kg')) pesoIdx = idx;
    });
    let updated = 0;
    for (let i = 1; i < json.length; i++) {
      const row = json[i] || [];
      const sku = String(row[skuIdx] || '').trim();
      const h = Number(String(row[hIdx]).toString().replace(',', '.'));
      const w = Number(String(row[wIdx]).toString().replace(',', '.'));
      const l = Number(String(row[lIdx]).toString().replace(',', '.'));
      const peso = Number(String(row[pesoIdx]).toString().replace(',', '.'));
      if (!sku) continue;
      await new Promise((resolve) => db.run(
        'UPDATE inventory SET height_cm = COALESCE(?, height_cm), width_cm = COALESCE(?, width_cm), length_cm = COALESCE(?, length_cm), weight_kg = COALESCE(?, weight_kg) WHERE sku = ?',
        [isNaN(h)? null : h, isNaN(w)? null : w, isNaN(l)? null : l, isNaN(peso)? null : peso, sku],
        function(){ updated += this.changes || 0; resolve(); }
      ));
    }
    res.json({ updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Exportar medidas (CSV)
app.get('/api/reports/inventory/measures/export', async (req, res) => {
  try {
    const rows = await dbAllAsync('SELECT sku, height_cm, width_cm, length_cm, weight_kg FROM inventory ORDER BY sku');
    const header = ['SKU','ALTURA(cm)','LARGURA(cm)','COMPRIMENTO(cm)','PESO(kg)'];
    const lines = [header.join(',')].concat(rows.map(r => [r.sku, r.height_cm ?? '', r.width_cm ?? '', r.length_cm ?? '', r.weight_kg ?? ''].join(',')));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="medidas.csv"');
    res.send(lines.join('\n'));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// Endpoint para contar total de notas fiscais (requisição inicial)
app.get('/api/bling/notas-fiscais/contar', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    const accountId = getAccountIdFromReq(req);
    const tokenObj = await refreshTokenIfNeeded(accountId);
    if (!tokenObj || !tokenObj.access_token) {
      return res.status(401).json({ error: 'Não autenticado no Bling.' });
    }

    const { dataEmissaoInicial, dataEmissaoFinal } = req.query;
    const dataEmissaoInicialParam = normalizeBlingDateParam(dataEmissaoInicial);
    const dataEmissaoFinalParam = normalizeBlingDateParam(dataEmissaoFinal);
    const hasTimeFilter = typeof dataEmissaoInicial === 'string' && dataEmissaoInicial.includes(':');
    const hasDateFilter = Boolean(dataEmissaoInicialParam || dataEmissaoFinalParam);
    const allowFallbackDate = !hasDateFilter && !hasTimeFilter;
    const getApiEndDate = (startDate, endDate) => {
      if (startDate && endDate && startDate === endDate) {
        return shiftDateStr(endDate, 1);
      }
      return endDate;
    };
    const blingGetWithRetry = async (url, tokenObjRef, accountIdRef, attempts = 3) => {
      let lastErr = null;
      for (let i = 0; i < attempts; i++) {
        try {
          return await blingGet(url, tokenObjRef, {}, accountIdRef);
        } catch (err) {
          lastErr = err;
          const status = err?.response?.status;
          if (status === 429 && i < attempts - 1) {
            await delay(1200);
            continue;
          }
          throw err;
        }
      }
      throw lastErr;
    };
    const parseDateForFilter = (value) => {
      if (!value) return null;
      const raw = String(value).trim();
      if (!raw) return null;
      const normalized = normalizeDateWithOffset(raw);
      const d = new Date(normalized);
      if (!Number.isFinite(d.getTime())) return null;
      return d;
    };
    const buildRequestedRange = (startRaw, endRaw) => {
      const s = startRaw ? String(startRaw).trim() : '';
      const e = endRaw ? String(endRaw).trim() : '';
      const startHasTime = s.includes(':');
      const endHasTime = e.includes(':');
      const start = s ? parseDateForFilter(startHasTime ? s : `${s} 00:00:00`) : null;
      const end = e ? parseDateForFilter(endHasTime ? e : `${e} 23:59:59`) : null;
      return { start, end };
    };
    const { start: requestedStart, end: requestedEnd } = buildRequestedRange(dataEmissaoInicial, dataEmissaoFinal);
    let filterStart = requestedStart;
    let filterEnd = requestedEnd;
    const filterByRequestedRange = (items) => {
      if (!Array.isArray(items) || (!filterStart && !filterEnd)) return items || [];
      return items.filter(item => {
        const d = parseDateForFilter(item?.dataEmissao || item?.data_emissao);
        if (!d) return false;
        if (filterStart && d < filterStart) return false;
        if (filterEnd && d > filterEnd) return false;
        return true;
      });
    };
    const endpoint = '/nfe';
    let totalNotas = 0;
    let page = 1;
    let dataStartToUse = dataEmissaoInicialParam;
    let dataEndToUse = dataEmissaoFinalParam;

    logBling('Iniciando contagem de notas fiscais do Bling', { accountId });

    while (true) {
      let url = `${BLING_API_BASE}${endpoint}?limite=100&pagina=${page}`;
      if (dataStartToUse) url += `&dataEmissaoInicial=${encodeURIComponent(dataStartToUse)}`;
      if (dataEndToUse) url += `&dataEmissaoFinal=${encodeURIComponent(dataEndToUse)}`;

      const response = await blingGetWithRetry(url, tokenObj, accountId);

      const dataArr = response.data?.data;
      if (Array.isArray(dataArr) && dataArr.length > 0) {
        totalNotas += filterByRequestedRange(dataArr).length;
        logBling(`Página ${page} - Notas contadas: ${dataArr.length}`, { accountId });
        if (dataArr.length < 100) break; // última página
        page++;
      } else {
        break; // sem mais páginas
      }
    }

    if (totalNotas === 0 && dataEmissaoInicialParam && dataEmissaoFinalParam && allowFallbackDate) {
      const fallbackStart = shiftDateStr(dataEmissaoInicialParam, -1);
      if (fallbackStart && fallbackStart !== dataEmissaoInicialParam) {
        dataStartToUse = fallbackStart;
        dataEndToUse = dataEmissaoFinalParam;
            console.log('[BACKEND DEBUG] Fallback aplicado (contagem) - mantendo range solicitado:', {
              dataStartToUse,
              dataEndToUse,
              filterStart: filterStart ? filterStart.toISOString() : null,
              filterEnd: filterEnd ? filterEnd.toISOString() : null
            });
        page = 1;
        while (true) {
          const apiEndFallback = getApiEndDate(dataStartToUse, dataEndToUse);
          let url = `${BLING_API_BASE}${endpoint}?limite=100&pagina=${page}`;
          if (dataStartToUse) url += `&dataEmissaoInicial=${encodeURIComponent(dataStartToUse)}`;
          if (apiEndFallback) url += `&dataEmissaoFinal=${encodeURIComponent(apiEndFallback)}`;
          const response = await blingGetWithRetry(url, tokenObj, accountId);
          const dataArr = response.data?.data;
          if (Array.isArray(dataArr) && dataArr.length > 0) {
            totalNotas += filterByRequestedRange(dataArr).length;
            logBling(`Página ${page} (fallback) - Notas contadas: ${dataArr.length}`, { accountId });
            if (dataArr.length < 100) break;
            page++;
          } else {
            break;
          }
        }
        if (totalNotas > 0) {
          logBling('Fallback de data aplicado na contagem', { accountId, fallbackStart });
        }
      }
    }

    const importacaoProgresso = getImportacaoProgresso(accountId);
    importacaoProgresso.total = totalNotas;
    logBling('Contagem de notas fiscais concluída', { accountId, total: totalNotas });
    res.json({ total: totalNotas });
  } catch (err) {
    logBling('Erro ao contar notas fiscais', { details: err.response?.data || err.message });
    res.status(500).json({ error: 'Erro ao contar notas fiscais', details: err.response?.data || err.message });
  }
});

// Endpoint para progresso da importação
app.get('/api/importacao/progresso', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  const accountId = getAccountIdFromReq(req);
  const importacaoProgresso = getImportacaoProgresso(accountId);
  console.log('[BACKEND DEBUG] Progresso consultado - status:', importacaoProgresso.status, 'importados:', importacaoProgresso.importados, 'total:', importacaoProgresso.total);
  res.json({
    accountId,
    importados: importacaoProgresso.importados,
    total: importacaoProgresso.total,
    status: importacaoProgresso.status
  });
});

// Rota de login
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email e senha obrigatórios' });
  db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
    if (err || !user) {
      addLog('WARN', 'AUTH', `Tentativa de login falhou: ${email} (usuário não encontrado)`);
      return res.status(401).json({ error: 'Usuário ou senha inválidos' });
    }
    if (!bcrypt.compareSync(password, user.password)) {
      addLog('WARN', 'AUTH', `Tentativa de login falhou: ${email} (senha incorreta)`);
      return res.status(401).json({ error: 'Usuário ou senha inválidos' });
    }
    addLog('INFO', 'AUTH', `Login bem-sucedido: ${user.name} (${user.email}) - Nível ${user.role}`);
    const token = jwt.sign({ id: user.id, name: user.name, email: user.email, role: user.role }, SECRET, { expiresIn: '30d' });
    activeSessions.set(token, {
      userId: user.id, userName: user.name, userEmail: user.email, role: user.role,
      loginTime: new Date().toISOString(), lastActivity: new Date().toISOString(),
      ip: req.ip || req.connection?.remoteAddress || 'unknown'
    });
    addUserAction(user.id, user.name, 'Login', 'Entrou no sistema');
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  });
});

// Renovar JWT sem novo login (aceita token expirado com assinatura válida; app Android usa após 401)
app.post('/api/auth/refresh', (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token não fornecido' });
  if (revokedTokens.has(token)) return res.status(401).json({ error: 'Sessão encerrada pelo administrador' });
  jwt.verify(token, SECRET, { ignoreExpiration: true }, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token inválido' });
    db.get('SELECT id, name, email, role FROM users WHERE id = ?', [user.id], (err2, row) => {
      if (err2 || !row) return res.status(401).json({ error: 'Usuário inválido' });
      activeSessions.delete(token);
      const newToken = jwt.sign(
        { id: row.id, name: row.name, email: row.email, role: row.role },
        SECRET,
        { expiresIn: '30d' }
      );
      activeSessions.set(newToken, {
        userId: row.id,
        userName: row.name,
        userEmail: row.email,
        role: row.role,
        loginTime: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        ip: req.ip || req.connection?.remoteAddress || 'unknown'
      });
      addLog('INFO', 'AUTH', `Token renovado: ${row.name} (${row.email})`);
      res.json({ token: newToken, user: { id: row.id, name: row.name, email: row.email, role: row.role } });
    });
  });
});

// Rota para obter usuário logado
app.get('/api/me', authenticateToken, (req, res) => {
  db.get('SELECT id, name, email, role FROM users WHERE id = ?', [req.user.id], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'Usuário não encontrado' });
    res.json(user);
  });
});

// Rota de logout (apenas para frontend limpar token)
app.post('/api/logout', (req, res) => {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (token) activeSessions.delete(token);
  res.json({ success: true });
});

// ─── Password Reset Request (public) ───
app.post('/api/password-reset-request', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email obrigatório' });
  db.get('SELECT id, name, email FROM users WHERE email = ?', [email], (err, user) => {
    if (err) return res.status(500).json({ error: 'Erro interno' });
    if (!user) return res.json({ success: true, message: 'Se o email existir, a solicitação foi enviada.' });
    db.get('SELECT id FROM password_reset_requests WHERE user_id = ? AND status = ?', [user.id, 'pending'], (err2, existing) => {
      if (existing) return res.json({ success: true, message: 'Solicitação já enviada. Aguarde o administrador.' });
      db.run('INSERT INTO password_reset_requests (user_id, user_email, user_name) VALUES (?, ?, ?)',
        [user.id, user.email, user.name], function(err3) {
          if (err3) return res.status(500).json({ error: 'Erro ao criar solicitação' });
          addLog('INFO', 'AUTH', `Solicitação de reset de senha: ${user.name} (${user.email})`);
          addUserAction(user.id, user.name, 'Solicitação', 'Solicitou reset de senha');
          res.json({ success: true, message: 'Solicitação enviada ao administrador.' });
        });
    });
  });
});

// ─── Admin endpoints ───
app.get('/api/admin/password-reset-requests', authenticateToken, requireAdmin, (req, res) => {
  db.all('SELECT * FROM password_reset_requests ORDER BY created_at DESC LIMIT 50', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.put('/api/admin/password-reset-requests/:id', authenticateToken, requireAdmin, (req, res) => {
  const { id } = req.params;
  const { status, newPassword } = req.body;
  if (status === 'resolved' && newPassword) {
    db.get('SELECT user_id FROM password_reset_requests WHERE id = ?', [id], (err, request) => {
      if (err || !request) return res.status(404).json({ error: 'Solicitação não encontrada' });
      const hash = bcrypt.hashSync(newPassword, 10);
      db.run('UPDATE users SET password = ? WHERE id = ?', [hash, request.user_id], (err2) => {
        if (err2) return res.status(500).json({ error: 'Erro ao atualizar senha' });
        db.run('UPDATE password_reset_requests SET status = ?, resolved_by = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?',
          [status, req.user.id, id]);
        addLog('INFO', 'ADMIN', `Admin ${req.user.name} resetou senha do user_id ${request.user_id}`);
        res.json({ success: true });
      });
    });
  } else {
    db.run('UPDATE password_reset_requests SET status = ?, resolved_by = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?',
      [status || 'rejected', req.user.id, id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
      });
  }
});

app.get('/api/admin/marketplace-connection-log', authenticateToken, requireAdmin, (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 150, 1), 500);
  const provider = (req.query.provider || '').trim();
  let sql = 'SELECT id, created_at, provider, account_id, event, level, detail FROM marketplace_connection_log WHERE 1=1';
  const params = [];
  if (provider) {
    sql += ' AND provider = ?';
    params.push(provider);
  }
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(limit);
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const logs = (rows || []).map((r) => {
      let detail = null;
      if (r.detail) {
        try {
          detail = JSON.parse(r.detail);
        } catch {
          detail = r.detail;
        }
      }
      return { ...r, detail };
    });
    res.json({ logs });
  });
});

app.get('/api/admin/sessions', authenticateToken, requireAdmin, (req, res) => {
  const sessions = [];
  for (const [token, session] of activeSessions.entries()) {
    try {
      jwt.verify(token, SECRET);
      sessions.push({ ...session, tokenPrefix: token.substring(0, 8) + '...' });
    } catch {
      activeSessions.delete(token);
    }
  }
  res.json(sessions);
});

app.delete('/api/admin/sessions/:userId', authenticateToken, requireAdmin, (req, res) => {
  const targetId = parseInt(req.params.userId, 10);
  let count = 0;
  for (const [token, session] of activeSessions.entries()) {
    if (session.userId === targetId) {
      revokedTokens.add(token);
      activeSessions.delete(token);
      count++;
    }
  }
  addLog('INFO', 'ADMIN', `Admin ${req.user.name} desconectou user_id ${targetId} (${count} sessões)`);
  addUserAction(req.user.id, req.user.name, 'Admin', `Desconectou usuário ID ${targetId}`);
  res.json({ success: true, disconnected: count });
});

app.get('/api/admin/user-actions', authenticateToken, requireAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const actions = userActionBuffer.slice(-limit).reverse();
  res.json(actions);
});

app.get('/api/admin/users', authenticateToken, requireAdmin, (req, res) => {
  db.all('SELECT id, name, email, role, created_at FROM users ORDER BY name', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const sessionMap = {};
    for (const [token, session] of activeSessions.entries()) {
      try {
        jwt.verify(token, SECRET);
        sessionMap[session.userId] = { online: true, lastActivity: session.lastActivity, loginTime: session.loginTime };
      } catch { activeSessions.delete(token); }
    }
    const users = (rows || []).map(u => ({ ...u, ...sessionMap[u.id], online: !!sessionMap[u.id] }));
    res.json(users);
  });
});

app.put('/api/admin/users/:id', authenticateToken, requireAdmin, (req, res) => {
  const { name, email, role, password } = req.body;
  const userId = parseInt(req.params.id, 10);
  if (password) {
    const hash = bcrypt.hashSync(password, 10);
    db.run('UPDATE users SET name = ?, email = ?, role = ?, password = ? WHERE id = ?', [name, email, role, hash, userId], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      addLog('INFO', 'ADMIN', `Admin ${req.user.name} editou usuário ID ${userId} (com senha)`);
      res.json({ success: true });
    });
  } else {
    db.run('UPDATE users SET name = ?, email = ?, role = ? WHERE id = ?', [name, email, role, userId], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      addLog('INFO', 'ADMIN', `Admin ${req.user.name} editou usuário ID ${userId}`);
      res.json({ success: true });
    });
  }
});

// Endpoint para obter preferências do usuário logado
app.get('/api/user/settings', authenticateToken, (req, res) => {
  db.get('SELECT settings FROM users WHERE id = ?', [req.user.id], (err, row) => {
    if (err || !row) return res.status(404).json({ error: 'Usuário não encontrado' });
    let settings = {};
    try { if (row.settings) settings = JSON.parse(row.settings); } catch {}
    res.json(settings);
  });
});

// Endpoint para atualizar preferências do usuário logado
app.put('/api/user/settings', authenticateToken, express.json(), (req, res) => {
  db.get('SELECT settings FROM users WHERE id = ?', [req.user.id], (err, row) => {
    if (err || !row) return res.status(404).json({ error: 'Usuário não encontrado' });
    let currentSettings = {};
    try { currentSettings = row.settings ? JSON.parse(row.settings) : {}; } catch {}
    // Faz merge, preservando pinnedSkus e quickReplies se não vierem no body
    const newSettings = { ...currentSettings, ...req.body };
    if (!('pinnedSkus' in req.body) && currentSettings.pinnedSkus) newSettings.pinnedSkus = currentSettings.pinnedSkus;
    if (!('quickReplies' in req.body) && currentSettings.quickReplies) newSettings.quickReplies = currentSettings.quickReplies;
    db.run('UPDATE users SET settings = ? WHERE id = ?', [JSON.stringify(newSettings), req.user.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
    });
  });
});

// Respostas rápidas: { title, text } (atalho + texto). Aceita legado (só string) na leitura.
function normalizeQuickRepliesInput(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const entry of arr.slice(0, 50)) {
    if (typeof entry === 'string') {
      const text = entry.trim();
      if (!text) continue;
      const title = text.length > 48 ? text.slice(0, 48) + '…' : text;
      out.push({ title, text });
    } else if (entry && typeof entry === 'object') {
      const text = String(entry.text != null ? entry.text : '').trim();
      if (!text) continue;
      let title = String(entry.title != null ? entry.title : '').trim();
      if (!title) title = text.length > 48 ? text.slice(0, 48) + '…' : text;
      title = title.slice(0, 80);
      out.push({ title, text });
    }
  }
  return out;
}

// Respostas rápidas do usuário (exclusivas por usuário)
app.get('/api/user/quick-replies', authenticateToken, (req, res) => {
  db.get('SELECT settings FROM users WHERE id = ?', [req.user.id], (err, row) => {
    if (err || !row) return res.status(404).json({ error: 'Usuário não encontrado' });
    let settings = {};
    try { settings = row.settings ? JSON.parse(row.settings) : {}; } catch {}
    const raw = Array.isArray(settings.quickReplies) ? settings.quickReplies : [];
    res.json({ quickReplies: normalizeQuickRepliesInput(raw) });
  });
});

app.put('/api/user/quick-replies', authenticateToken, express.json(), (req, res) => {
  const { quickReplies } = req.body;
  if (!Array.isArray(quickReplies)) return res.status(400).json({ error: 'quickReplies deve ser um array' });
  const sanitized = normalizeQuickRepliesInput(quickReplies);
  db.get('SELECT settings FROM users WHERE id = ?', [req.user.id], (err, row) => {
    if (err || !row) return res.status(404).json({ error: 'Usuário não encontrado' });
    let settings = {};
    try { settings = row.settings ? JSON.parse(row.settings) : {}; } catch {}
    settings.quickReplies = sanitized;
    db.run('UPDATE users SET settings = ? WHERE id = ?', [JSON.stringify(settings), req.user.id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, quickReplies: sanitized });
    });
  });
});

// Endpoint para atualizar o total de notas da importação
app.post('/api/importacao/total', (req, res) => {
  const { total } = req.body;
  if (typeof total === 'number' && total >= 0) {
    const accountId = getAccountIdFromReq(req);
    const importacaoProgresso = getImportacaoProgresso(accountId);
    importacaoProgresso.total = total;
    return res.json({ success: true, total });
  }
  res.status(400).json({ error: 'Total inválido' });
});

// Ajustar início da importação para não sobrescrever total se já houver valor válido
const oldNotasFiscaisHandler = app._router.stack.find(r => r.route && r.route.path === '/api/bling/notas-fiscais');
if (oldNotasFiscaisHandler) {
  const originalHandler = oldNotasFiscaisHandler.route.stack[0].handle;
  oldNotasFiscaisHandler.route.stack[0].handle = async function(req, res, next) {
    const accountId = getAccountIdFromReq(req);
    const importacaoProgresso = getImportacaoProgresso(accountId);
    if (!importacaoProgresso.total || importacaoProgresso.total === 0) {
      // Executa contagem se não houver total
      await originalHandler(req, res, next);
    } else {
      // Mantém o total existente
      await originalHandler(req, res, next);
    }
  };
}

// Endpoint para buscar SKUs fixados do usuário logado
app.get('/api/user/pinned-skus', authenticateToken, (req, res) => {
  console.log('[BACKEND DEBUG] ✅ ROTA API CHAMADA: GET /api/user/pinned-skus - User ID:', req.user.id);
  db.get('SELECT settings FROM users WHERE id = ?', [req.user.id], (err, row) => {
    if (err) {
      console.error('[BACKEND DEBUG] Erro ao buscar usuário:', err.message);
      return res.status(500).json({ error: 'Erro interno do servidor' });
    }
    if (!row) {
      console.error('[BACKEND DEBUG] Usuário não encontrado:', req.user.id);
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    console.log('[BACKEND DEBUG] Settings encontrados:', row.settings);
    let settings = {};
    try { 
      settings = row.settings ? JSON.parse(row.settings) : {}; 
      console.log('[BACKEND DEBUG] Settings parseados:', settings);
    } catch (parseErr) {
      console.error('[BACKEND DEBUG] Erro ao parsear settings:', parseErr.message);
      settings = {};
    }
    
    const pinnedSkus = settings.pinnedSkus || [];
    console.log('[BACKEND DEBUG] Retornando pinnedSkus:', pinnedSkus);
    res.json({ pinnedSkus });
  });
});

// Endpoint para atualizar SKUs fixados do usuário logado
app.put('/api/user/pinned-skus', authenticateToken, express.json(), (req, res) => {
  console.log('[BACKEND DEBUG] PUT /api/user/pinned-skus - User ID:', req.user.id);
  console.log('[BACKEND DEBUG] Body recebido:', req.body);
  
  const { pinnedSkus } = req.body;
  if (!Array.isArray(pinnedSkus)) {
    console.error('[BACKEND DEBUG] pinnedSkus não é um array:', pinnedSkus);
    return res.status(400).json({ error: 'pinnedSkus deve ser um array' });
  }
  
  console.log('[BACKEND DEBUG] pinnedSkus válido:', pinnedSkus);
  
  db.get('SELECT settings FROM users WHERE id = ?', [req.user.id], (err, row) => {
    if (err) {
      console.error('[BACKEND DEBUG] Erro ao buscar usuário:', err.message);
      return res.status(500).json({ error: 'Erro interno do servidor' });
    }
    if (!row) {
      console.error('[BACKEND DEBUG] Usuário não encontrado:', req.user.id);
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    console.log('[BACKEND DEBUG] Settings atuais:', row.settings);
    let settings = {};
    try { 
      settings = row.settings ? JSON.parse(row.settings) : {}; 
      console.log('[BACKEND DEBUG] Settings parseados:', settings);
    } catch (parseErr) {
      console.error('[BACKEND DEBUG] Erro ao parsear settings:', parseErr.message);
      settings = {};
    }
    
    // Faz merge, preservando outras preferências
    const newSettings = { ...settings, pinnedSkus };
    console.log('[BACKEND DEBUG] Novos settings:', newSettings);
    
    db.run('UPDATE users SET settings = ? WHERE id = ?', [JSON.stringify(newSettings), req.user.id], function(err) {
      if (err) {
        console.error('[BACKEND DEBUG] Erro ao salvar pinnedSkus:', err.message);
        return res.status(500).json({ error: err.message });
      }
      console.log('[BACKEND DEBUG] SKUs fixados salvos com sucesso para usuário', req.user.id, pinnedSkus);
      console.log('[BACKEND DEBUG] Rows affected:', this.changes);
      res.json({ success: true, pinnedSkus });
    });
  });
});

// Rota para servir o frontend React (DEVE SER A ÚLTIMA ROTA)
app.get('*', (req, res) => {
  // index.html nunca deve ser cacheado: é o manifesto que aponta para os
  // bundles com hash. Se ficar em cache, o browser carrega JS/CSS antigos.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, '../client/build/index.html'));
});

// Inicialização do servidor
app.listen(PORT, HOST, () => {
  addLog('INFO', 'SERVER', `Servidor rodando em http://${HOST}:${PORT}`);
  addLog('INFO', 'SERVER', `Ambiente: ${process.env.NODE_ENV || 'development'}`);
  addLog('INFO', 'DB', `Banco de dados: ${dbPath}`);
  addLog('INFO', 'SERVER', 'Todas as rotas configuradas e prontas');
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
  console.log(`🌐 Host de bind: ${HOST}`);
  console.log(`📊 Banco de dados: database.sqlite`);

  // Refresh imediato de tokens ML ao iniciar o servidor
  setTimeout(async () => {
    try {
      db.all('SELECT id FROM ml_accounts', async (err, rows) => {
        if (err) return;
        for (const row of rows || []) {
          try {
            const token = await loadMLToken(row.id);
            if (!token || !token.refresh_token) continue;
            const elapsed = (Date.now() - new Date(token.updated_at || token.created_at).getTime()) / 1000;
            const expiresIn = token.expires_in || 21600;
            if (elapsed > expiresIn * 0.5) {
              console.log(`[ML] Startup refresh for account ${row.id} (elapsed: ${Math.round(elapsed)}s / ${expiresIn}s)`);
              await refreshMLTokenIfNeeded(row.id, true);
            }
          } catch (e) { console.error(`[ML] Startup refresh error for account ${row.id}:`, e.message); }
        }
      });
    } catch { /* silent */ }
  }, 5000);

  // Agendador: tenta renovar proativamente a cada 5 minutos
  setInterval(async () => {
    // --- Bling ---
    try {
      db.all('SELECT id, connection_status FROM bling_accounts', async (err, rows) => {
        if (err) return;
        for (const row of rows || []) {
          if (row.connection_status === 'disconnected') continue;
          const accountId = row.id;
          const tokenObj = await loadToken(accountId);
          if (!tokenObj) continue;
          const margemMs = 30 * 60 * 1000;
          const expiraEm = new Date(tokenObj.created_at).getTime() + (tokenObj.expires_in * 1000);
          const faltaMs = expiraEm - Date.now();
          if (faltaMs < margemMs) {
            logBling('Refresh proativo agendado (faltam menos de 30 min para expirar)', { accountId });
            await refreshTokenIfNeeded(accountId);
          }
        }
      });
    } catch (e) { /* silencioso */ }

    // --- Mercado Livre ---
    try {
      db.all('SELECT id FROM ml_accounts', async (err, rows) => {
        if (err) return;
        for (const row of rows || []) {
          const accountId = row.id;
          try {
            const token = await loadMLToken(accountId);
            if (!token || !token.refresh_token) continue;
            const elapsed = (Date.now() - new Date(token.updated_at || token.created_at).getTime()) / 1000;
            const expiresIn = token.expires_in || 21600;
            // Refresh when 2 hours remain (instead of 1 hour) for more safety
            const margemSec = 2 * 60 * 60;
            if (elapsed > expiresIn - margemSec) {
              console.log(`[ML] Refresh proativo para conta ${accountId} (elapsed: ${Math.round(elapsed)}s, expires: ${expiresIn}s, margin: ${margemSec}s)`);
              await refreshMLTokenIfNeeded(accountId, true);
            }
          } catch (e) {
            console.error(`[ML] Erro no refresh proativo conta ${accountId}:`, e.message);
          }
        }
      });
    } catch (e) { /* silencioso */ }

    // --- Shopee ---
    try {
      db.all('SELECT id FROM shopee_accounts', async (err, rows) => {
        if (err) return;
        for (const row of rows || []) {
          const accountId = row.id;
          try {
            const token = await loadShopeeToken(accountId);
            if (!token || !token.refresh_token) continue;
            const refTs = parseSqliteUtcDate(token.updated_at || token.created_at).getTime();
            const elapsed = Number.isFinite(refTs) ? (Date.now() - refTs) / 1000 : Infinity;
            const expiresIn = token.expires_in || 14400;
            // Margem de 90 min: renova com ≥ 1h30 de sobra (token vive 4h).
            const margemSec = 90 * 60;
            if (elapsed > expiresIn - margemSec) {
              console.log(`[Shopee] Refresh proativo para conta ${accountId} (elapsed: ${Math.round(elapsed)}s, expires: ${expiresIn}s, margin: ${margemSec}s)`);
              await refreshShopeeTokenIfNeeded(accountId, true);
            }
          } catch (e) {
            console.error(`[Shopee] Erro no refresh proativo conta ${accountId}:`, e.message);
          }
        }
      });
    } catch (e) { /* silencioso */ }
  }, 5 * 60 * 1000);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Encerrando servidor...');
  db.close((err) => {
    if (err) {
      console.error('Erro ao fechar banco de dados:', err);
    } else {
      console.log('✅ Banco de dados fechado');
    }
    process.exit(0);
  });
});

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Reidentifica marketplaces para notas com marketplace Desconhecido/Outros ou numeroLoja ausente
async function reidentificarMarketplacesAposImportacao(notas, tokenObj, accountId) {
  if (!Array.isArray(notas) || notas.length === 0) return;
  const candidatas = notas.filter(n => {
    const mk = (n && n.marketplace) ? String(n.marketplace) : '';
    return !n || !n.numeroLoja || mk === 'Desconhecido' || mk === 'Outros';
  });
  if (candidatas.length === 0) return;
  try {
    for (const n of candidatas) {
      try {
        const detalheRes = await blingGet(`/nfe/${n.id}`, tokenObj, {}, accountId);
        const detalhe = detalheRes?.data?.data;
        if (!detalhe) continue;
        let numeroLoja = n.numeroLoja ? String(n.numeroLoja).trim() : '';
        if (detalhe.numeroPedidoLoja !== undefined && detalhe.numeroPedidoLoja !== null) {
          numeroLoja = String(detalhe.numeroPedidoLoja).trim();
        } else if (detalhe.pedido && detalhe.pedido.numero) {
          numeroLoja = String(detalhe.pedido.numero).trim();
        } else if (detalhe.numeroPedido && detalhe.numeroPedido !== null) {
          numeroLoja = String(detalhe.numeroPedido).trim();
        }
        const itensNota = Array.isArray(detalhe?.itens) ? detalhe.itens : (Array.isArray(n.itens) ? n.itens : []);
        const mk = identificarMarketplace(numeroLoja || n.numeroLoja, itensNota) || 'Desconhecido';
        if (numeroLoja) n.numeroLoja = numeroLoja;
        if (mk && mk !== 'Desconhecido') n.marketplace = mk;
        const mkLog = n.marketplace || mk;
        console.log(`[LOG DIAGNÓSTICO][REID] numeroLoja: '${n.numeroLoja || numeroLoja || ''}' | identificarMarketplace: '${mkLog}'`);
      } catch (e) {
        // silencioso para não interromper fluxo principal
      }
      await delay(200);
    }
  } catch (_) {
    // silencioso
  }
}

// Função para identificar o marketplace pelo padrão do número do pedido
function identificarMarketplace(numeroPedidoLoja, itens = []) {
  if (!numeroPedidoLoja || typeof numeroPedidoLoja !== 'string') return 'Desconhecido';
  
  // Mercado Livre Full: prioridade máxima, se qualquer item tiver cfop terminando em 6
  const isFull = Array.isArray(itens) && itens.some(item => item.cfop && item.cfop.toString().endsWith('6'));
  if (isFull) return 'Mercado Livre Full';
  
  if (/^ORD/.test(numeroPedidoLoja)) return 'Olist';
  // Shein: pedidos usualmente iniciam com GSH... ou GS...
  if (/^GSH/i.test(numeroPedidoLoja) || /^GS/i.test(numeroPedidoLoja)) return 'Shein';
  if (/^\d{3}-\d{7}-\d{7}$/.test(numeroPedidoLoja)) return 'Amazon';
  // TikTok Shop: 18 dígitos iniciando com 58 (padrão observado)
  if (/^58\d{16}$/.test(numeroPedidoLoja)) return 'TikTok Shop';
  // Mercado Livre: longos numéricos (13+) genéricos
  if (/^\d{13,}$/.test(numeroPedidoLoja)) return 'Mercado Livre';
  if (/^\d{6,8}[A-Z0-9]{5,8}$/i.test(numeroPedidoLoja)) return 'Shopee';
  if (/^\d{10}-[A-Z]$/.test(numeroPedidoLoja)) return 'Leroy Merlin';
  if (/^LU-\d{16}$/.test(numeroPedidoLoja)) return 'Magalu';
  if (/^\d{8}$/.test(numeroPedidoLoja)) return 'Mercado Livre Full';
  if (/^\d{7}$/.test(numeroPedidoLoja)) return 'Madeira & Madeira';
  return 'Outros';
}

// Função auxiliar para buscar localização de um SKU
async function buscarLocalizacaoSku(sku) {
  return new Promise((resolve) => {
    db.get('SELECT location FROM inventory WHERE sku = ?', [sku], (err, row) => {
      if (err || !row) return resolve('');
      resolve(row.location || '');
    });
  });
}