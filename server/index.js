const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const cheerio = require('cheerio');
const multer = require('multer');
const xlsx = require('xlsx');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const os = require('os');
const fs = require('fs');
const qs = require('qs');
const archiver = require('archiver');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';

// Dependências para autenticação
const SECRET = process.env.JWT_SECRET || 'apoli-secret-' + require('crypto').randomBytes(8).toString('hex');

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

function logBling(msg, data) {
  const logMsg = `[${new Date().toISOString()}] ${msg} ${data ? JSON.stringify(data) : ''}`;
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
app.use(express.static(path.join(__dirname, '../client/public')));
app.use(express.static(path.join(__dirname, '../client/build')));

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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

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

    db.run(`CREATE TABLE IF NOT EXISTS shopee_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      partner_id TEXT,
      partner_key TEXT,
      shop_id TEXT,
      redirect_uri TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

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
    });

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

app.use('/api', (req, res, next) => {
  const fullPath = '/api' + req.path;
  if (PUBLIC_ROUTES.some(r => fullPath === r || fullPath.startsWith(r + '/'))) {
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
  const userRole = role || 1;
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
  // Buscar usuário atual para manter senha se não for enviada
  db.get('SELECT * FROM users WHERE id = ?', [id], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'Usuário não encontrado' });
    let newPassword = user.password;
    if (password && password.length > 0) {
      newPassword = bcrypt.hashSync(password, 10);
    }
    db.run('UPDATE users SET name = ?, email = ?, password = ?, role = ? WHERE id = ?',
      [name, email, newPassword, role, id],
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
        res.json({
          items: rows,
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
    res.json(row);
  });
});

app.post('/api/inventory', (req, res) => {
  const { 
    sku, ean, title, quantity, location, min_quantity, max_quantity, 
    category, supplier, cost_price, selling_price, cubic_weight, notes 
  } = req.body;
  
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
    res.json({ 
      id: this.lastID, 
      sku, ean, title, quantity, location, min_quantity, max_quantity,
      category, supplier, cost_price, selling_price, cubic_weight, notes 
    });
  });
});

app.put('/api/inventory/:id', (req, res) => {
  const { id } = req.params;
  const { 
    sku, ean, title, quantity, location, min_quantity, max_quantity, 
    category, supplier, cost_price, selling_price, cubic_weight, notes, is_composite 
  } = req.body;
  
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
    res.json({ success: true, changes: this.changes });
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

// Middleware para verificar nível de usuário (nível 4 = admin)
function requireAdmin(req, res, next) {
  if (req.user.role < 4) {
    return res.status(403).json({ error: 'Acesso negado. Nível de usuário insuficiente.' });
  }
  next();
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
// Regra importante:
// - SKU existente: atualizar SOMENTE quantidade (preserva kits/compostos e demais atributos)
// - SKU novo: inserir cadastro básico
app.post('/api/inventory/import/csv', async (req, res) => {
  const csvData = req.body.csvData;
  
  if (!csvData) {
    res.status(400).json({ error: 'Dados CSV são obrigatórios' });
    return;
  }

  // Detectar separador: vírgula ou ponto e vírgula
  let separator = ',';
  const firstLine = csvData.split('\n')[0];
  if (firstLine.split(';').length > firstLine.split(',').length) {
    separator = ';';
  }

  const lines = csvData.split('\n');
  const headers = parseCsvLine(lines[0], separator).map(h => h.replace(/"/g, ''));
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
      const qtd = parseInt(String(item.Quantidade || '0').replace(/\./g, '').replace(',', '.'), 10) || 0;

      if (!sku) {
        errorCount++;
        errors.push(`Linha ${index + 2}: SKU é obrigatório`);
        continue;
      }

      const existing = await dbGetAsync(`SELECT id FROM inventory WHERE sku = ? LIMIT 1`, [sku]);
      if (existing) {
        // SKU existente: atualiza apenas estoque
        await dbRunAsync(
          `UPDATE inventory SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [qtd, existing.id]
        );
        successCount++;
        continue;
      }

      // SKU novo: cria cadastro básico (sem impactar outros SKUs)
      const title = String(item.Título || '').trim();
      if (!title) {
        errorCount++;
        errors.push(`Linha ${index + 2}: Título é obrigatório para SKU novo`);
        continue;
      }

      const maxQtyRaw = parseInt(String(item['Quantidade Máxima'] || '').trim(), 10);
      const costRaw = parseFloat(String(item['Preço de Custo'] || '').replace(/\./g, '').replace(',', '.'));
      const sellingRaw = parseFloat(String(item['Preço de Venda'] || '').replace(/\./g, '').replace(',', '.'));
      await dbRunAsync(
        `INSERT INTO inventory (
          sku, ean, title, quantity, location, min_quantity, max_quantity,
          category, supplier, cost_price, selling_price, notes, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [
          sku,
          item.EAN || null,
          title,
          qtd,
          item.Localização || null,
          parseInt(item['Quantidade Mínima'], 10) || 0,
          Number.isFinite(maxQtyRaw) ? maxQtyRaw : null,
          item.Categoria || null,
          item.Fornecedor || null,
          Number.isFinite(costRaw) ? costRaw : null,
          Number.isFinite(sellingRaw) ? sellingRaw : null,
          item.Observações || null
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
  if (fs.existsSync(LOG_FILE)) {
    const logs = fs.readFileSync(LOG_FILE, 'utf8');
    res.type('text/plain').send(logs);
  } else {
    res.type('text/plain').send('Sem logs ainda.');
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
    const resp = await makeRequest(token.access_token);
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
        const resp = await makeRequest(accessAfterRefresh);
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

app.post('/api/ml/callback', async (req, res) => {
  const { topic, resource, user_id, application_id } = req.body || {};
  console.log(`[ML] Notification received: topic=${topic}, resource=${resource}, user_id=${user_id}`);
  res.status(200).json({ ok: true });
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

app.put('/api/ml/stock-config/:id', (req, res) => {
  const { use_real_stock, fictitious_min, fictitious_max, enabled } = req.body;
  db.run(`UPDATE ml_stock_config SET use_real_stock = ?, fictitious_min = ?, fictitious_max = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [use_real_stock ? 1 : 0, fictitious_min || 450, fictitious_max || 499, enabled !== undefined ? (enabled ? 1 : 0) : 1, req.params.id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
});

// ─── ML Stock Push Logic ───
function computeMarketplaceStock(realQty, config) {
  if (realQty <= 0) return 0;
  if (config.use_real_stock) return realQty;
  if (config.fictitious_value && config.fictitious_value >= config.fictitious_min && config.fictitious_value <= config.fictitious_max) {
    return config.fictitious_value;
  }
  const val = Math.floor(Math.random() * (config.fictitious_max - config.fictitious_min + 1)) + config.fictitious_min;
  return val;
}

async function pushStockForInventoryId(inventoryId) {
  // Push to Mercado Livre
  await new Promise((resolve) => {
    db.all(`SELECT sc.*, inv.quantity as real_quantity FROM ml_stock_config sc JOIN inventory inv ON inv.id = sc.inventory_id WHERE sc.inventory_id = ? AND sc.enabled = 1`, [inventoryId], async (err, configs) => {
      if (err || !configs || configs.length === 0) return resolve();
      for (const config of configs) {
        try {
          const qty = computeMarketplaceStock(config.real_quantity, config);
          await mlApiPut(`/items/${config.ml_item_id}`, { available_quantity: qty }, config.ml_account_id);
          db.run('UPDATE ml_stock_config SET fictitious_value = ?, last_pushed_at = CURRENT_TIMESTAMP WHERE id = ?', [qty, config.id]);
          db.run('UPDATE ml_items SET ml_available_quantity = ?, last_synced_at = CURRENT_TIMESTAMP WHERE ml_item_id = ? AND ml_account_id = ?', [qty, config.ml_item_id, config.ml_account_id]);
          console.log(`[ML] Pushed stock for ${config.ml_item_id}: ${qty}`);
        } catch (e) {
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
          const qty = computeMarketplaceStock(config.real_quantity, config);
          await mlApiPut(`/items/${config.ml_item_id}/variations/${config.variation_id}`, { available_quantity: qty }, config.ml_account_id);
          db.run('UPDATE ml_variation_stock_config SET fictitious_value = ?, last_pushed_at = CURRENT_TIMESTAMP WHERE id = ?', [qty, config.id]);
          db.run('UPDATE ml_item_variations SET available_quantity = ? WHERE ml_item_id = ? AND ml_account_id = ? AND variation_id = ?', [qty, config.ml_item_id, config.ml_account_id, config.variation_id]);
          console.log(`[ML] Pushed variation stock for ${config.ml_item_id}/${config.variation_id}: ${qty}`);
        } catch (e) {
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
          const qty = computeMarketplaceStock(config.real_quantity, config);
          await shopeeApiPost('/api/v2/product/update_stock', {
            item_id: parseInt(config.shopee_item_id, 10),
            stock_list: [{ model_id: 0, seller_stock: [{ stock: qty }] }]
          }, config.shopee_account_id);
          db.run('UPDATE shopee_stock_config SET fictitious_value = ?, last_pushed_at = CURRENT_TIMESTAMP WHERE id = ?', [qty, config.id]);
          db.run('UPDATE shopee_items SET shopee_stock = ?, last_synced_at = CURRENT_TIMESTAMP WHERE shopee_item_id = ? AND shopee_account_id = ?', [qty, config.shopee_item_id, config.shopee_account_id]);
          console.log(`[Shopee] Pushed stock for ${config.shopee_item_id}: ${qty}`);
        } catch (e) {
          console.error(`[Shopee] Push stock error for ${config.shopee_item_id}:`, e.response?.data || e.message);
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
      const qty = computeMarketplaceStock(config.real_quantity, config);
      await mlApiPut(`/items/${config.ml_item_id}`, { available_quantity: qty }, config.ml_account_id);
      db.run('UPDATE ml_stock_config SET fictitious_value = ?, last_pushed_at = CURRENT_TIMESTAMP WHERE id = ?', [qty, config.id]);
      db.run('UPDATE ml_items SET ml_available_quantity = ?, last_synced_at = CURRENT_TIMESTAMP WHERE ml_item_id = ? AND ml_account_id = ?', [qty, config.ml_item_id, config.ml_account_id]);
      res.json({ success: true, ml_item_id: config.ml_item_id, pushed_quantity: qty });
    } catch (e) {
      res.status(500).json({ error: 'Erro ao enviar estoque', details: e.response?.data || e.message });
    }
  });
});

app.post('/api/ml/stock/push-all', async (req, res) => {
  const accountId = parseInt(req.query.accountId || req.body.accountId, 10) || 1;
  db.all(`SELECT sc.*, inv.quantity as real_quantity FROM ml_stock_config sc JOIN inventory inv ON inv.id = sc.inventory_id WHERE sc.ml_account_id = ? AND sc.enabled = 1`, [accountId], async (err, configs) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!configs || configs.length === 0) return res.json({ success: true, pushed: 0 });
    let pushed = 0, errors = 0;
    for (const config of configs) {
      try {
        const qty = computeMarketplaceStock(config.real_quantity, config);
        await mlApiPut(`/items/${config.ml_item_id}`, { available_quantity: qty }, config.ml_account_id);
        db.run('UPDATE ml_stock_config SET fictitious_value = ?, last_pushed_at = CURRENT_TIMESTAMP WHERE id = ?', [qty, config.id]);
        db.run('UPDATE ml_items SET ml_available_quantity = ?, last_synced_at = CURRENT_TIMESTAMP WHERE ml_item_id = ? AND ml_account_id = ?', [qty, config.ml_item_id, config.ml_account_id]);
        pushed++;
      } catch { errors++; }
    }
    // Also push variation stock configs for this account
    db.all(`SELECT vc.*, inv.quantity as real_quantity FROM ml_variation_stock_config vc JOIN inventory inv ON inv.id = vc.inventory_id WHERE vc.ml_account_id = ? AND vc.enabled = 1`, [accountId], async (errV, varConfigs) => {
      if (!errV && varConfigs && varConfigs.length > 0) {
        for (const vc of varConfigs) {
          try {
            const qty = computeMarketplaceStock(vc.real_quantity, vc);
            await mlApiPut(`/items/${vc.ml_item_id}/variations/${vc.variation_id}`, { available_quantity: qty }, vc.ml_account_id);
            db.run('UPDATE ml_variation_stock_config SET fictitious_value = ?, last_pushed_at = CURRENT_TIMESTAMP WHERE id = ?', [qty, vc.id]);
            db.run('UPDATE ml_item_variations SET available_quantity = ? WHERE ml_item_id = ? AND ml_account_id = ? AND variation_id = ?', [qty, vc.ml_item_id, vc.ml_account_id, vc.variation_id]);
            pushed++;
          } catch { errors++; }
        }
      }
      res.json({ success: true, pushed, errors, total: configs.length + (varConfigs ? varConfigs.length : 0) });
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
      const qty = computeMarketplaceStock(config.real_quantity, config);
      await mlApiPut(`/items/${config.ml_item_id}/variations/${config.variation_id}`, { available_quantity: qty }, config.ml_account_id);
      db.run('UPDATE ml_variation_stock_config SET fictitious_value = ?, last_pushed_at = CURRENT_TIMESTAMP WHERE id = ?', [qty, config.id]);
      db.run('UPDATE ml_item_variations SET available_quantity = ? WHERE ml_item_id = ? AND ml_account_id = ? AND variation_id = ?', [qty, config.ml_item_id, config.ml_account_id, config.variation_id]);
      res.json({ success: true, variation_id: config.variation_id, pushed_quantity: qty });
    } catch (e) {
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

app.post('/api/ml/templates/import', async (req, res) => {
  const { mlItemId, accountId } = req.body;
  if (!mlItemId || !accountId) return res.status(400).json({ error: 'mlItemId e accountId obrigatórios' });
  try {
    const { item, description } = await fetchFullMLItem(mlItemId, accountId);
    const t = buildTemplateFromMLItem(item, description, accountId);
    db.run(`INSERT INTO ml_item_templates (source_ml_item_id, source_account_id, title, category_id, price, currency_id, condition, buying_mode, listing_type_id, available_quantity, pictures, attributes, variations, description, shipping, sale_terms, video_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [t.source_ml_item_id, t.source_account_id, t.title, t.category_id, t.price, t.currency_id, t.condition, t.buying_mode, t.listing_type_id, t.available_quantity, t.pictures, t.attributes, t.variations, t.description, t.shipping, t.sale_terms, t.video_id],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, id: this.lastID, title: t.title });
      });
  } catch (err) {
    console.error('[ML Templates] Import error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

app.post('/api/ml/templates/import-bulk', async (req, res) => {
  const { mlItemIds, accountId } = req.body;
  if (!Array.isArray(mlItemIds) || !mlItemIds.length || !accountId) {
    return res.status(400).json({ error: 'mlItemIds (array) e accountId obrigatórios' });
  }
  const results = { imported: 0, errors: [] };
  for (const mlItemId of mlItemIds) {
    try {
      const { item, description } = await fetchFullMLItem(mlItemId, accountId);
      const t = buildTemplateFromMLItem(item, description, accountId);
      await new Promise((resolve, reject) => {
        db.run(`INSERT INTO ml_item_templates (source_ml_item_id, source_account_id, title, category_id, price, currency_id, condition, buying_mode, listing_type_id, available_quantity, pictures, attributes, variations, description, shipping, sale_terms, video_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [t.source_ml_item_id, t.source_account_id, t.title, t.category_id, t.price, t.currency_id, t.condition, t.buying_mode, t.listing_type_id, t.available_quantity, t.pictures, t.attributes, t.variations, t.description, t.shipping, t.sale_terms, t.video_id],
          function(err) { err ? reject(err) : resolve(this.lastID); });
      });
      results.imported++;
    } catch (err) {
      results.errors.push({ mlItemId, error: err.response?.data?.message || err.message });
    }
  }
  res.json(results);
});

app.get('/api/ml/templates', (req, res) => {
  const { status, search } = req.query;
  let sql = 'SELECT * FROM ml_item_templates';
  const params = [];
  const conditions = [];
  if (status) { conditions.push('status = ?'); params.push(status); }
  if (search) { conditions.push('(title LIKE ? OR source_ml_item_id LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY created_at DESC';
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ templates: rows || [] });
  });
});

app.get('/api/ml/templates/:id', (req, res) => {
  db.get('SELECT * FROM ml_item_templates WHERE id = ?', [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Template não encontrado' });
    res.json(row);
  });
});

app.put('/api/ml/templates/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const fields = ['title', 'category_id', 'price', 'currency_id', 'condition', 'buying_mode', 'listing_type_id', 'available_quantity', 'pictures', 'attributes', 'variations', 'description', 'shipping', 'sale_terms', 'video_id'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      params.push(typeof req.body[f] === 'object' ? JSON.stringify(req.body[f]) : req.body[f]);
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  updates.push('updated_at = CURRENT_TIMESTAMP');
  params.push(id);
  db.run(`UPDATE ml_item_templates SET ${updates.join(', ')} WHERE id = ?`, params, function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, changes: this.changes });
  });
});

app.delete('/api/ml/templates/:id', (req, res) => {
  db.run('DELETE FROM ml_item_templates WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, deleted: this.changes });
  });
});

app.delete('/api/ml/templates', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids (array) obrigatório' });
  const placeholders = ids.map(() => '?').join(',');
  db.run(`DELETE FROM ml_item_templates WHERE id IN (${placeholders})`, ids, function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, deleted: this.changes });
  });
});

app.post('/api/ml/templates/:id/publish', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { targetAccountId } = req.body;
  if (!targetAccountId) return res.status(400).json({ error: 'targetAccountId obrigatório' });
  try {
    const template = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM ml_item_templates WHERE id = ?', [id], (err, row) => {
        if (err) return reject(err);
        if (!row) return reject(new Error('Template não encontrado'));
        resolve(row);
      });
    });

    const pictures = JSON.parse(template.pictures || '[]');
    const attributes = JSON.parse(template.attributes || '[]');
    const variations = JSON.parse(template.variations || '[]');
    const saleTerms = JSON.parse(template.sale_terms || '[]');

    let title = template.title || '';
    if (title.length > 60) title = title.substring(0, 60);
    const familyNameTpl = String(template.title || '').trim().substring(0, 255) || title;

    const publishAttrs = attributes.filter(a => {
      if (['ITEM_CONDITION'].includes(a.id)) return false;
      return a.value_id || a.value_name;
    });

    const body = {
      title,
      category_id: template.category_id,
      price: template.price,
      currency_id: template.currency_id || 'BRL',
      available_quantity: template.available_quantity || 1,
      buying_mode: template.buying_mode || 'buy_it_now',
      listing_type_id: template.listing_type_id || 'gold_special',
      condition: template.condition || 'new',
      pictures: pictures.map(p => ({ source: p.source })),
      attributes: publishAttrs,
    };
    if (familyNameTpl) body.family_name = familyNameTpl;

    if (variations.length > 0) {
      const validVariations = variations.filter(v =>
        v.attribute_combinations && v.attribute_combinations.length > 0
      );
      if (validVariations.length > 0) {
        body.variations = validVariations.map(v => {
          const variation = {
            attribute_combinations: v.attribute_combinations.map(ac => ({
              id: ac.id,
              value_id: ac.value_id || null,
              value_name: ac.value_name || null
            })).filter(ac => ac.value_id || ac.value_name),
            price: v.price || template.price,
            available_quantity: v.available_quantity || template.available_quantity || 1,
            picture_ids: v.picture_ids || [],
          };
          if (v.seller_custom_field) variation.seller_custom_field = v.seller_custom_field;
          if (v.attributes && v.attributes.length > 0) {
            variation.attributes = v.attributes.filter(a => a.id && (a.value_name || a.value_id));
          }
          return variation;
        });
        finalizeMlPublishBodyWithVariations(body, template.available_quantity || 1);
      }
    }

    if (saleTerms.length > 0) {
      body.sale_terms = saleTerms.filter(t => t.value_id || t.value_name);
    }
    if (template.video_id) body.video_id = template.video_id;

    mlStripTitleIfFamilyVariationListing(body);

    const result = await mlApiPost('/items', body, targetAccountId);

    db.run('UPDATE ml_item_templates SET status = ?, published_ml_item_id = ?, published_account_id = ?, error_message = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      ['published', result.id, targetAccountId, id]);

    if (template.description) {
      try {
        await mlApiPost(`/items/${result.id}/description`, { plain_text: template.description }, targetAccountId);
      } catch (descErr) {
        console.error('[ML Templates] Description post failed:', descErr.response?.data || descErr.message);
      }
    }

    res.json({ success: true, newItemId: result.id, permalink: result.permalink });
  } catch (err) {
    console.error('[ML Templates] Publish error:', err.response?.data || err.message);
    const causes = err.response?.data?.cause || [];
    const errorMessages = causes
      .filter(c => c.type === 'error')
      .map(c => c.message)
      .join('; ');
    const warnMessages = causes
      .filter(c => c.type === 'warning')
      .map(c => c.message)
      .join('; ');
    const errMsg = errorMessages || warnMessages || err.response?.data?.message || err.message;
    db.run('UPDATE ml_item_templates SET status = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      ['error', errMsg, id]);
    res.status(500).json({ error: errMsg, details: err.response?.data });
  }
});

app.post('/api/ml/templates/publish-bulk', async (req, res) => {
  const { templateIds, targetAccountId } = req.body;
  if (!Array.isArray(templateIds) || !templateIds.length || !targetAccountId) {
    return res.status(400).json({ error: 'templateIds (array) e targetAccountId obrigatórios' });
  }
  const results = { published: 0, errors: [] };
  for (const tplId of templateIds) {
    try {
      const template = await new Promise((resolve, reject) => {
        db.get('SELECT * FROM ml_item_templates WHERE id = ?', [tplId], (err, row) => err ? reject(err) : resolve(row));
      });
      if (!template) { results.errors.push({ id: tplId, error: 'Não encontrado' }); continue; }

      const pictures = JSON.parse(template.pictures || '[]');
      const attributes = JSON.parse(template.attributes || '[]');
      const variations = JSON.parse(template.variations || '[]');
      const saleTerms = JSON.parse(template.sale_terms || '[]');

      let title = template.title || '';
      if (title.length > 60) title = title.substring(0, 60);
      const familyNameBulk = String(template.title || '').trim().substring(0, 255) || title;

      const publishAttrs = attributes.filter(a => {
        if (['ITEM_CONDITION'].includes(a.id)) return false;
        return a.value_id || a.value_name;
      });

      const body = {
        title,
        category_id: template.category_id,
        price: template.price,
        currency_id: template.currency_id || 'BRL',
        available_quantity: template.available_quantity || 1,
        buying_mode: template.buying_mode || 'buy_it_now',
        listing_type_id: template.listing_type_id || 'gold_special',
        condition: template.condition || 'new',
        pictures: pictures.map(p => ({ source: p.source })),
        attributes: publishAttrs,
      };
      if (familyNameBulk) body.family_name = familyNameBulk;
      if (variations.length > 0) {
        const validVariations = variations.filter(v =>
          v.attribute_combinations && v.attribute_combinations.length > 0
        );
        if (validVariations.length > 0) {
          body.variations = validVariations.map(v => ({
            attribute_combinations: (v.attribute_combinations || []).map(ac => ({
              id: ac.id, value_id: ac.value_id || null, value_name: ac.value_name || null
            })).filter(ac => ac.value_id || ac.value_name),
            price: v.price || template.price,
            available_quantity: v.available_quantity || template.available_quantity || 1,
            picture_ids: v.picture_ids || [],
            ...(v.seller_custom_field ? { seller_custom_field: v.seller_custom_field } : {}),
            ...(v.attributes && v.attributes.length > 0 ? { attributes: v.attributes.filter(a => a.id && (a.value_name || a.value_id)) } : {})
          }));
          finalizeMlPublishBodyWithVariations(body, template.available_quantity || 1);
        }
      }
      if (saleTerms.length > 0) {
        body.sale_terms = saleTerms.filter(t => t.value_id || t.value_name);
      }
      if (template.video_id) body.video_id = template.video_id;

      mlStripTitleIfFamilyVariationListing(body);

      const result = await mlApiPost('/items', body, targetAccountId);
      db.run('UPDATE ml_item_templates SET status = ?, published_ml_item_id = ?, published_account_id = ?, error_message = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        ['published', result.id, targetAccountId, tplId]);
      if (template.description) {
        try { await mlApiPost(`/items/${result.id}/description`, { plain_text: template.description }, targetAccountId); } catch { /* ignore */ }
      }
      results.published++;
    } catch (err) {
      const causes = err.response?.data?.cause || [];
      const errorMessages = causes.filter(c => c.type === 'error').map(c => c.message).join('; ');
      const errMsg = errorMessages || err.response?.data?.message || err.message;
      db.run('UPDATE ml_item_templates SET status = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['error', errMsg, tplId]);
      results.errors.push({ id: tplId, error: errMsg });
    }
  }
  res.json(results);
});

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

app.get('/api/ad-models/:id', (req, res) => {
  db.get('SELECT * FROM ad_models WHERE id = ?', [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Modelo não encontrado' });
    db.all('SELECT * FROM ad_model_publications WHERE ad_model_id = ?', [row.id], (err2, pubs) => {
      if (err2) return res.status(500).json({ error: err2.message });
      res.json({ ...row, publications: pubs || [] });
    });
  });
});

app.post('/api/ad-models', (req, res) => {
  const { sku, ean, title, category_id, category_name, price, currency_id, condition, buying_mode, listing_type_id,
    available_quantity, pictures, attributes, variations, description, shipping, sale_terms, video_id,
    inventory_id, source_ml_item_id, source_account_id, package_measures } = req.body;
  if (!title) return res.status(400).json({ error: 'Título obrigatório' });
  db.run(`INSERT INTO ad_models (inventory_id, sku, ean, title, category_id, category_name, price, currency_id, condition, buying_mode,
    listing_type_id, available_quantity, pictures, attributes, variations, description, shipping, sale_terms, video_id,
    source_ml_item_id, source_account_id, package_measures)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [inventory_id || null, sku || null, ean || null, title, category_id || null, category_name || null,
      price || 0, currency_id || 'BRL', condition || 'new', buying_mode || 'buy_it_now',
      listing_type_id || 'gold_special', available_quantity || 1,
      typeof pictures === 'object' ? JSON.stringify(pictures) : (pictures || '[]'),
      typeof attributes === 'object' ? JSON.stringify(attributes) : (attributes || '[]'),
      typeof variations === 'object' ? JSON.stringify(variations) : (variations || '[]'),
      description || '', typeof shipping === 'object' ? JSON.stringify(shipping) : (shipping || null),
      typeof sale_terms === 'object' ? JSON.stringify(sale_terms) : (sale_terms || '[]'),
      video_id || null, source_ml_item_id || null, source_account_id || null,
      package_measures != null ? (typeof package_measures === 'object' ? JSON.stringify(package_measures) : package_measures) : null],
    function(err) {
      if (err) {
        if (err.message.includes('UNIQUE constraint')) return res.status(409).json({ error: 'Já existe um modelo com esse SKU' });
        return res.status(500).json({ error: err.message });
      }
      res.json({ success: true, id: this.lastID });
    });
});

app.post('/api/ad-models/import', async (req, res) => {
  const { mlItemId, accountId, sku, ean, inventoryId } = req.body;
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

    db.run(`INSERT INTO ad_models (inventory_id, sku, ean, title, category_id, category_name, price, currency_id, condition, buying_mode,
      listing_type_id, available_quantity, pictures, attributes, variations, description, shipping, sale_terms, video_id,
      source_ml_item_id, source_account_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ${forceOverwrite ? 'ON CONFLICT(sku) DO UPDATE SET ean=excluded.ean, title=excluded.title, category_id=excluded.category_id, category_name=excluded.category_name, price=excluded.price, currency_id=excluded.currency_id, condition=excluded.condition, buying_mode=excluded.buying_mode, listing_type_id=excluded.listing_type_id, available_quantity=excluded.available_quantity, pictures=excluded.pictures, attributes=excluded.attributes, variations=excluded.variations, description=excluded.description, shipping=excluded.shipping, sale_terms=excluded.sale_terms, video_id=excluded.video_id, source_ml_item_id=excluded.source_ml_item_id, source_account_id=excluded.source_account_id, updated_at=CURRENT_TIMESTAMP' : ''}`,
      [inventoryId || null, itemSku, itemEan, t.title, t.category_id, categoryName, t.price, t.currency_id, t.condition,
        t.buying_mode, t.listing_type_id, t.available_quantity, t.pictures, t.attributes, t.variations,
        t.description, t.shipping, t.sale_terms, t.video_id, t.source_ml_item_id, t.source_account_id],
      function(err) {
        if (err) {
          if (err.message.includes('UNIQUE constraint')) return res.status(409).json({ error: 'Já existe um modelo com esse SKU', existingSku: itemSku });
          return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, id: this.lastID, title: t.title, sku: itemSku });
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
    'shipping', 'sale_terms', 'video_id', 'inventory_id', 'package_measures'];
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
    res.json({ success: true, changes: this.changes });
  });
});

app.delete('/api/ad-models/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.run('DELETE FROM ad_model_publications WHERE ad_model_id = ?', [id], () => {
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
  db.run(`DELETE FROM ad_model_publications WHERE ad_model_id IN (${placeholders})`, ids, () => {
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

/** Anúncio com variações: soma available_quantity no item; mantém family_name (ML exige em muitas categorias / preço por variação). */
function finalizeMlPublishBodyWithVariations(body, effectiveQtyFallback) {
  const vars = body.variations;
  if (!Array.isArray(vars) || vars.length === 0) return;
  const sum = vars.reduce((acc, v) => acc + (Number(v && v.available_quantity) || 0), 0);
  const fb = Number(effectiveQtyFallback);
  body.available_quantity = sum > 0 ? sum : (Number.isFinite(fb) && fb > 0 ? fb : 1);
}

/** Com family_name + variations, o ML não aceita title no mesmo POST (body.invalid_fields [title]); título vem dos atributos/variações. */
function mlStripTitleIfFamilyVariationListing(body) {
  if (!body || !body.family_name) return;
  if (Array.isArray(body.variations) && body.variations.length > 0) {
    delete body.title;
  }
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

app.post('/api/ad-models/:id/publish', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { marketplace, accountId, price: overridePrice, listing_type_id: overrideListingType,
    available_quantity: overrideQty, variation_prices: overrideVarPrices } = req.body;
  if (!marketplace || !accountId) return res.status(400).json({ error: 'marketplace e accountId obrigatórios' });
  if (marketplace === 'shopee') return res.status(400).json({ error: 'Publicação na Shopee será implementada em breve. Estrutura preparada.' });
  if (marketplace !== 'ml') return res.status(400).json({ error: 'Marketplace não suportado' });

  try {
    const model = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM ad_models WHERE id = ?', [id], (err, row) => {
        if (err) return reject(err);
        if (!row) return reject(new Error('Modelo não encontrado'));
        resolve(row);
      });
    });

    const pictures = JSON.parse(model.pictures || '[]');
    const attributes = JSON.parse(model.attributes || '[]');
    let variations = normalizeAdModelVariationPictureIds(JSON.parse(model.variations || '[]'), pictures);
    const saleTerms = JSON.parse(model.sale_terms || '[]');

    const effectivePrice = toMlPriceNumber(overridePrice != null ? overridePrice : model.price);
    const effectiveListingType = overrideListingType || model.listing_type_id || 'gold_special';
    const effectiveQty = toMlQuantityInt(overrideQty != null ? overrideQty : model.available_quantity);

    let title = model.title || '';
    if (title.length > 60) title = title.substring(0, 60);
    // User Products (ML): alguns vendedores/categorias exigem family_name no POST /items (erro body.required_fields)
    const familyName = String(model.title || '').trim().substring(0, 255) || title;

    let publishAttrs = attributes.filter(a => {
      if (['ITEM_CONDITION'].includes(a.id)) return false;
      return a.value_id || a.value_name;
    });
    publishAttrs = applyPackageMeasuresToMlAttributes(publishAttrs, parseAdModelPackageMeasures(model));

    const validVariations = variations.filter(v => v.attribute_combinations && v.attribute_combinations.length > 0);

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
      db.run(`INSERT OR REPLACE INTO ad_model_publications (ad_model_id, marketplace, account_id, published_item_id, status, published_at, published_price, published_listing_type)
        VALUES (?, ?, ?, ?, 'published', CURRENT_TIMESTAMP, ?, ?)`,
        [id, 'ml', accountId, first.id, effectivePrice, effectiveListingType]);

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
        });
      if (body.variations.length > 0) finalizeMlPublishBodyWithVariations(body, effectiveQty);
      else { body.available_quantity = effectiveQty; delete body.variations; }
    } else {
      body.available_quantity = effectiveQty;
    }

    if (saleTerms.length > 0) {
      body.sale_terms = mapSaleTermsForMlBody(saleTerms);
    }

    mlStripTitleIfFamilyVariationListing(body);

    console.log('[Ad Models] Publishing to ML:', JSON.stringify({ listing_type: effectiveListingType, price: effectivePrice, variations: body.variations?.length || 0 }));
    const result = await mlApiPost('/items', body, accountId);

    db.run(`INSERT OR REPLACE INTO ad_model_publications (ad_model_id, marketplace, account_id, published_item_id, status, published_at, published_price, published_listing_type)
      VALUES (?, ?, ?, ?, 'published', CURRENT_TIMESTAMP, ?, ?)`,
      [id, 'ml', accountId, result.id, effectivePrice, effectiveListingType]);

    if (model.description) {
      try { await mlApiPost(`/items/${result.id}/description`, { plain_text: model.description }, accountId); } catch {}
    }

    res.json({ success: true, newItemId: result.id, permalink: result.permalink });
  } catch (err) {
    console.error('[Ad Models] Publish error:', err.response?.data || err.message);
    const errMsg = mlApiErrorToUserMessage(err);
    db.run(`INSERT OR REPLACE INTO ad_model_publications (ad_model_id, marketplace, account_id, status, error_message)
      VALUES (?, ?, ?, 'error', ?)`, [id, 'ml', accountId, errMsg]);
    res.status(500).json({ error: errMsg, details: err.response?.data });
  }
});

app.post('/api/ad-models/bulk-publish', async (req, res) => {
  const { marketplace, accountId, items } = req.body;
  if (!marketplace || !accountId || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'marketplace, accountId e items (array) obrigatórios' });
  }
  if (marketplace === 'shopee') return res.status(400).json({ error: 'Publicação na Shopee será implementada em breve.' });
  if (marketplace !== 'ml') return res.status(400).json({ error: 'Marketplace não suportado' });

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
      const familyName = String(model.title || '').trim().substring(0, 255) || title;

      let publishAttrs = attributes.filter(a => {
        if (['ITEM_CONDITION'].includes(a.id)) return false;
        return a.value_id || a.value_name;
      });
      publishAttrs = applyPackageMeasuresToMlAttributes(publishAttrs, parseAdModelPackageMeasures(model));

      const validVariations = variations.filter(v => v.attribute_combinations && v.attribute_combinations.length > 0);

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
        db.run(`INSERT OR REPLACE INTO ad_model_publications (ad_model_id, marketplace, account_id, published_item_id, status, published_at, published_price, published_listing_type)
          VALUES (?, ?, ?, ?, 'published', CURRENT_TIMESTAMP, ?, ?)`,
          [modelId, 'ml', accountId, first.id, effectivePrice, effectiveListingType]);

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
          });
        if (body.variations.length > 0) finalizeMlPublishBodyWithVariations(body, effectiveQty);
        else { body.available_quantity = effectiveQty; delete body.variations; }
      } else {
        body.available_quantity = effectiveQty;
      }

      if (saleTerms.length > 0) {
        body.sale_terms = mapSaleTermsForMlBody(saleTerms);
      }

      mlStripTitleIfFamilyVariationListing(body);

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

      db.run(`INSERT OR REPLACE INTO ad_model_publications (ad_model_id, marketplace, account_id, published_item_id, status, published_at, published_price, published_listing_type)
        VALUES (?, ?, ?, ?, 'published', CURRENT_TIMESTAMP, ?, ?)`,
        [modelId, 'ml', accountId, result.id, effectivePrice, effectiveListingType]);

      if (model.description) {
        try { await mlApiPost(`/items/${result.id}/description`, { plain_text: model.description }, accountId); } catch {}
      }

      results.published++;
    } catch (err) {
      console.error(`[Bulk Publish] Error model ${modelId}:`, err.response?.data || err.message);
      const errMsg = mlApiErrorToUserMessage(err);
      db.run(`INSERT OR REPLACE INTO ad_model_publications (ad_model_id, marketplace, account_id, status, error_message)
        VALUES (?, ?, ?, 'error', ?)`, [modelId, 'ml', accountId, errMsg]);
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
    db.run(`INSERT OR REPLACE INTO api_tokens (id, provider, account_id, access_token, refresh_token, expires_in, token_type, created_at, updated_at)
            VALUES ((SELECT id FROM api_tokens WHERE provider = 'shopee' AND account_id = ?), 'shopee', ?, ?, ?, ?, 'Bearer', ?, CURRENT_TIMESTAMP)`,
      [accountId, accountId, tokenData.access_token, tokenData.refresh_token, tokenData.expire_in || 14400, tokenData.created_at || new Date().toISOString()],
      function(err) { err ? reject(err) : resolve(); });
  });
}

async function refreshShopeeTokenIfNeeded(accountId) {
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
  const elapsed = (Date.now() - new Date(token.updated_at || token.created_at).getTime()) / 1000;
  if (elapsed < (token.expires_in || 14400) - 300) return token;
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
    logMarketplaceConnection('shopee', 'refresh_http_failed', 'ERROR', accountId, {
      status: err.response?.status,
      body: err.response?.data,
      message: err.message
    });
    throw err;
  }
  if (resp.data.error) {
    logMarketplaceConnection('shopee', 'refresh_api_error', 'ERROR', accountId, { error: resp.data.error, message: resp.data.message });
    throw new Error(resp.data.message || resp.data.error);
  }
  await saveShopeeToken(resp.data, accountId);
  return await loadShopeeToken(accountId);
}

async function shopeeApiRequest(method, apiPath, params, body, accountId) {
  const makeRequest = async () => {
    const token = await refreshShopeeTokenIfNeeded(accountId);
    const creds = await getShopeeCredentials(accountId);
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = generateShopeeSign(creds.partnerId, apiPath, timestamp, token.access_token, creds.shopId, creds.partnerKey);
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
  try {
    const resp = await makeRequest();
    if (resp.data.error) throw new Error(resp.data.message || resp.data.error);
    return resp.data;
  } catch (err) {
    if (err.response?.status === 401 || err.response?.status === 403) {
      logMarketplaceConnection('shopee', 'api_auth_challenge', 'WARN', accountId, {
        method, apiPath, status: err.response.status, body: err.response?.data
      });
      console.log(`[Shopee] ${err.response?.status} em ${method} ${apiPath}, tentando refresh e retry...`);
      try {
        const resp = await makeRequest();
        if (resp.data.error) throw new Error(resp.data.message || resp.data.error);
        return resp.data;
      } catch (err2) {
        logMarketplaceConnection('shopee', 'api_retry_failed', 'ERROR', accountId, {
          method, apiPath, message: err2.message, status: err2.response?.status, body: err2.response?.data
        });
        throw err2;
      }
    }
    throw err;
  }
}

async function shopeeApiGet(apiPath, params, accountId) { return shopeeApiRequest('GET', apiPath, params, null, accountId); }
async function shopeeApiPost(apiPath, body, accountId) { return shopeeApiRequest('POST', apiPath, null, body, accountId); }

// --- Shopee Account Management ---

app.get('/api/shopee/accounts', (req, res) => {
  db.all('SELECT id, name, partner_id, partner_key, shop_id, redirect_uri, created_at, updated_at FROM shopee_accounts ORDER BY id', (err, rows) => {
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
  db.run(`UPDATE shopee_stock_config SET use_real_stock = ?, fictitious_min = ?, fictitious_max = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [use_real_stock ? 1 : 0, fictitious_min || 450, fictitious_max || 499, enabled ? 1 : 0, req.params.id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
});

app.post('/api/shopee/stock/push', async (req, res) => {
  const configId = parseInt(req.body.configId, 10);
  if (!configId) return res.status(400).json({ error: 'configId obrigatório' });
  db.get('SELECT sc.*, inv.quantity as real_quantity FROM shopee_stock_config sc JOIN inventory inv ON inv.id = sc.inventory_id WHERE sc.id = ?', [configId], async (err, config) => {
    if (err || !config) return res.status(404).json({ error: 'Config não encontrada' });
    try {
      const qty = computeMarketplaceStock(config.real_quantity, config);
      await shopeeApiPost('/api/v2/product/update_stock', {
        item_id: parseInt(config.shopee_item_id, 10),
        stock_list: [{ model_id: 0, seller_stock: [{ stock: qty }] }]
      }, config.shopee_account_id);
      db.run('UPDATE shopee_stock_config SET fictitious_value = ?, last_pushed_at = CURRENT_TIMESTAMP WHERE id = ?', [qty, config.id]);
      db.run('UPDATE shopee_items SET shopee_stock = ?, last_synced_at = CURRENT_TIMESTAMP WHERE shopee_item_id = ? AND shopee_account_id = ?', [qty, config.shopee_item_id, config.shopee_account_id]);
      res.json({ success: true, shopee_item_id: config.shopee_item_id, pushed_quantity: qty });
    } catch (e) {
      res.status(500).json({ error: 'Erro ao enviar estoque', details: e.response?.data || e.message });
    }
  });
});

app.post('/api/shopee/stock/push-all', async (req, res) => {
  const accountId = parseInt(req.query.accountId || req.body.accountId, 10) || 1;
  db.all(`SELECT sc.*, inv.quantity as real_quantity FROM shopee_stock_config sc JOIN inventory inv ON inv.id = sc.inventory_id WHERE sc.shopee_account_id = ? AND sc.enabled = 1`, [accountId], async (err, configs) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!configs || configs.length === 0) return res.json({ success: true, pushed: 0 });
    let pushed = 0, errors = 0;
    for (const config of configs) {
      try {
        const qty = computeMarketplaceStock(config.real_quantity, config);
        await shopeeApiPost('/api/v2/product/update_stock', {
          item_id: parseInt(config.shopee_item_id, 10),
          stock_list: [{ model_id: 0, seller_stock: [{ stock: qty }] }]
        }, config.shopee_account_id);
        db.run('UPDATE shopee_stock_config SET fictitious_value = ?, last_pushed_at = CURRENT_TIMESTAMP WHERE id = ?', [qty, config.id]);
        db.run('UPDATE shopee_items SET shopee_stock = ?, last_synced_at = CURRENT_TIMESTAMP WHERE shopee_item_id = ? AND shopee_account_id = ?', [qty, config.shopee_item_id, config.shopee_account_id]);
        pushed++;
      } catch (e) {
        errors++;
        console.error(`[Shopee] Push stock error for ${config.shopee_item_id}:`, e.response?.data || e.message);
      }
    }
    res.json({ success: true, pushed, errors });
  });
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

// --- Sync orders from ML ---
app.post('/api/marketplace-orders/sync', async (req, res) => {
  const { marketplace, accountId, dateFrom, dateTo } = req.body;
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

      let allOrders = [];
      let offset = 0;
      let scrollId = null;
      const limit = 50;
      let hasMore = true;

      const baseUrl = `/orders/search?seller=${creds.mlUserId}&sort=date_desc&limit=${limit}`;
      let dateFilter = '';
      if (dateFrom) dateFilter += `&order.date_created.from=${dateFrom}T00:00:00.000-03:00`;
      if (dateTo) dateFilter += `&order.date_created.to=${dateTo}T23:59:59.000-03:00`;
      const searchUrl = baseUrl + dateFilter;

      while (hasMore) {
        try {
          const pageUrl = scrollId ? `${searchUrl}&scroll_id=${encodeURIComponent(scrollId)}` : `${searchUrl}&offset=${offset}`;
          const page = await mlApiGet(pageUrl, accountId);
          const results = page.results || [];
          allOrders = allOrders.concat(results);
          scrollId = page.paging?.scroll_id || null;
          if (scrollId) {
            offset = 0;
            hasMore = results.length === limit;
          } else {
            offset += limit;
            hasMore = results.length === limit && offset < (page.paging?.total || 0);
          }
          if (results.length > 0) console.log(`[MktOrders] Fetched page: ${results.length} results, total so far: ${allOrders.length}`);
        } catch (pageErr) {
          console.error('[MktOrders] Page fetch error:', pageErr.message);
          hasMore = false;
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
          db.get('SELECT id, bling_pedido_id FROM marketplace_orders WHERE marketplace = ? AND marketplace_order_id = ? AND account_id = ?',
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
              shippingMethod = ship.shipping_option?.name || ship.logistic_type || null;
              shippingType = ship.logistic_type || null;
            }
          } catch (shipErr) { console.log('[MktOrders] Shipping fetch error for order', oid, shipErr.message); }
        }

        const orderStatus = innerOrder.status || order.status;

        const buyerName = (`${buyer.first_name || ''} ${buyer.last_name || ''}`.trim()) || buyer.nickname || (shippingAddr?.receiver_name) || '';
        const buyerDoc = buyer.billing_info?.doc_number || null;
        const buyerPhone = buyer.phone ? `${buyer.phone.area_code || ''}${buyer.phone.number || ''}` : null;
        const orderDate = innerOrder.date_created || order.date_created || null;
        const totalAmount = innerOrder.total_amount || order.total_amount || 0;
        const shippingCost = shippingRef?.cost || payment.shipping_cost || 0;

        const paymentMethod = payment.payment_type || payment.payment_method_id || null;
        const paymentStatus = payment.status || orderStatus || null;
        const paymentId = payment.id ? String(payment.id) : null;
        const paymentInstallments = payment.installments || null;
        const paymentDate = payment.date_approved || payment.date_created || null;
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
          db.run('DELETE FROM marketplace_order_items WHERE order_id = ?', [existing.id]);
          insertItems(existing.id);
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
                insertItems(this.lastID);
                resolve();
              });
          });
          synced++;
        }
      }

      console.log(`[MktOrders] ML sync done: ${synced} synced, ${skipped} skipped (already sent to Bling)`);
      res.json({ success: true, total: allOrders.length, synced, skipped });
    } catch (err) {
      console.error('[MktOrders] ML sync error:', err.response?.data || err.message);
      res.status(500).json({ error: 'Erro ao sincronizar pedidos ML', details: err.message });
    }
  } else if (marketplace === 'shopee') {
    // Stub for Shopee - to be implemented
    res.status(501).json({ error: 'Sincronização de pedidos Shopee ainda não implementada' });
  } else {
    res.status(400).json({ error: 'Marketplace não suportado' });
  }
});

// --- List marketplace orders ---
app.get('/api/marketplace-orders', async (req, res) => {
  const { marketplace, accountId, status, search, dateFrom, dateTo, limit: qLimit, offset: qOffset } = req.query;
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
    if (status) {
      const shippingStatuses = ['delivered', 'shipped', 'in_transit', 'ready_to_ship', 'handling', 'not_delivered'];
      if (shippingStatuses.includes(status)) {
        sql += ' AND o.shipping_status = ?';
      } else {
        sql += ' AND o.status = ?';
      }
      params.push(status);
    }
    if (dateFrom) { sql += ' AND o.order_date >= ?'; params.push(dateFrom + 'T00:00:00'); }
    if (dateTo) { sql += ' AND o.order_date <= ?'; params.push(dateTo + 'T23:59:59'); }
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

// --- Send order to Bling (create contact + sales order + generate NF-e) ---
app.post('/api/marketplace-orders/:id/send-to-bling', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { blingAccountId } = req.body;
  if (!blingAccountId) return res.status(400).json({ error: 'blingAccountId obrigatório' });

  try {
    const order = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM marketplace_orders WHERE id = ?', [id], (e, r) => e ? reject(e) : resolve(r));
    });
    if (!order) return res.status(404).json({ error: 'Pedido não encontrado' });
    if (order.bling_pedido_id) return res.status(409).json({ error: 'Pedido já enviado ao Bling', bling_pedido_id: order.bling_pedido_id });

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
    db.run(`UPDATE marketplace_orders SET bling_pedido_id = ?, bling_nfe_id = ?, bling_nfe_status = ?, bling_account_id = ?, status = 'sent_to_bling' WHERE id = ?`,
      [String(blingPedidoId), blingNfeId, blingNfeStatus, blingAccountId, id]);

    res.json({
      success: true,
      bling_pedido_id: blingPedidoId,
      bling_nfe_id: blingNfeId,
      bling_nfe_status: blingNfeStatus
    });
  } catch (err) {
    const errData = err.response?.data;
    const errStatus = err.response?.status;
    console.error(`[MktOrders] Send to Bling error (HTTP ${errStatus}):`, JSON.stringify(errData || err.message));
    console.error(`[MktOrders] Order ID: ${id}, Bling Account: ${req.body.blingAccountId}`);
    db.run(`UPDATE marketplace_orders SET bling_nfe_status = 'error', status = 'error' WHERE id = ?`, [id]);
    const errorMsg = errData?.error?.message || errData?.error?.description || errData?.error || err.message;
    res.status(500).json({ error: `Erro ao enviar para Bling: ${errorMsg}`, details: errData });
  }
});

// --- Bulk send orders to Bling ---
app.post('/api/marketplace-orders/send-to-bling-bulk', async (req, res) => {
  const { orderIds, blingAccountId } = req.body;
  if (!Array.isArray(orderIds) || !orderIds.length || !blingAccountId) {
    return res.status(400).json({ error: 'orderIds (array) e blingAccountId obrigatórios' });
  }

  const results = { sent: 0, errors: [], skipped: 0 };

  for (const orderId of orderIds) {
    try {
      const order = await new Promise((resolve) => {
        db.get('SELECT id, bling_pedido_id FROM marketplace_orders WHERE id = ?', [orderId], (e, r) => resolve(r || null));
      });
      if (!order) { results.errors.push({ id: orderId, error: 'Não encontrado' }); continue; }
      if (order.bling_pedido_id) { results.skipped++; continue; }

      const resp = await axios.post(`http://localhost:${PORT}/api/marketplace-orders/${orderId}/send-to-bling`, { blingAccountId });
      if (resp.data?.success) results.sent++;
      else results.errors.push({ id: orderId, error: resp.data?.error || 'Erro desconhecido' });
    } catch (err) {
      results.errors.push({ id: orderId, error: err.response?.data?.error || err.message });
    }
  }

  res.json(results);
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

    const rawSituacao = safeNum(nfe.situacao);
    const formatNfe = (nfe) => ({
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
    });

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
    const { orderIds } = req.body;
    if (!Array.isArray(orderIds) || !orderIds.length) return res.json({ results: {} });

    const placeholders = orderIds.map(() => '?').join(',');
    const orders = await new Promise((resolve, reject) => {
      db.all(`SELECT id, marketplace_order_id, bling_pedido_id, bling_nfe_id, bling_nfe_numero, bling_account_id FROM marketplace_orders WHERE id IN (${placeholders})`, orderIds, (e, r) => e ? reject(e) : resolve(r || []));
    });

    // Orders that already have nfe_numero cached - return immediately
    const results = {};
    const needsCheck = [];
    for (const o of orders) {
      if (o.bling_nfe_numero) {
        results[o.id] = { nfe_numero: o.bling_nfe_numero, bling_pedido_id: o.bling_pedido_id, bling_nfe_id: o.bling_nfe_id, cached: true };
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

// Relatório de Reposição de Estoque
// Retorna: inventário + vendas 7d/30d, cobertura, qtd sugerida, alertas
// Aceita dataInicio e dataFim (YYYY-MM-DD) para período personalizado de vendas
app.get('/api/reports/replenishment', authenticateToken, requireAdmin, async (req, res) => {
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
      kitMap.get(mainSku).push({ compSku, qty: r.quantity });
    }

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
        let skuNorm = skuLimpo;
        const compList = kitMap.get(skuLimpo);
        if (skuToItem[skuLimpo]?.is_composite && Array.isArray(compList) && compList.length === 1) {
          skuNorm = compList[0].compSku;
        }
        const qtd = Number(r.qtd) || 0;
        const fator = (compList && compList.length === 1) ? (Number(compList[0].qty) || 1) : 1;
        const add = qtd * fator;
        vendasPeriodoBySku.set(skuNorm, (vendasPeriodoBySku.get(skuNorm) || 0) + add);
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
          let skuNorm = skuLimpo;
          const compList = kitMap.get(skuLimpo);
          if (skuToItem[skuLimpo]?.is_composite && Array.isArray(compList) && compList.length === 1) {
            skuNorm = compList[0].compSku;
          }
          const qtd = Number(r.qtd) || 0;
          const fator = (compList && compList.length === 1) ? (Number(compList[0].qty) || 1) : 1;
          const add = qtd * fator;
          map.set(skuNorm, (map.get(skuNorm) || 0) + add);
        }
      };
      normalizeAndAgg(rows7, vendas7BySku);
      normalizeAndAgg(rows30, vendas30BySku);
    }

    const pendingOrders = await dbAllAsync(
      `SELECT inventory_id, SUM(quantity) AS qtd FROM supplier_order_items WHERE status = 'pending' GROUP BY inventory_id`
    );
    const pendingByInvId = new Map((pendingOrders || []).map(r => [r.inventory_id, Number(r.qtd || 0)]));

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
      let alerta = null;
      if (saldo <= 0 && (vendas7 > 0 || vendas30 > 0)) alerta = 'zerado';
      else if (coberturaDias < 7 && mediaDiaria > 0) alerta = 'critico';
      else if (coberturaDias < 14 && mediaDiaria > 0) alerta = 'atencao';
      else if (vendas30 >= 10 && coberturaDias < 21) alerta = 'alto_giro';
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
      });
    }

    const withSales = items.filter(i => i.vendas7 > 0 || i.vendas30 > 0);
    const p80 = withSales.length > 0 ? withSales.sort((a, b) => b.vendas30 - a.vendas30)[Math.floor(withSales.length * 0.2)]?.vendas30 || 0 : 0;
    for (const i of items) {
      if (!i.alerta && i.vendas30 >= p80 && i.vendas30 > 0 && i.coberturaDias < 21) i.alerta = 'alto_giro';
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

app.delete('/api/reports/replenishment/orders/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await dbRunAsync('DELETE FROM supplier_order_items WHERE id = ?', [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
            const elapsed = (Date.now() - new Date(token.updated_at || token.created_at).getTime()) / 1000;
            const expiresIn = token.expires_in || 14400;
            const margemSec = 60 * 60;
            if (elapsed > expiresIn - margemSec) {
              console.log(`[Shopee] Refresh proativo para conta ${accountId} (elapsed: ${Math.round(elapsed)}s, expires: ${expiresIn}s)`);
              await refreshShopeeTokenIfNeeded(accountId);
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