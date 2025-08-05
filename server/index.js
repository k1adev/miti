const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const os = require('os');
const fs = require('fs');
const qs = require('qs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Dependências para autenticação
const SECRET = process.env.JWT_SECRET || 'apoli-secret';

// Configuração Bling
const BLING_CLIENT_ID = process.env.BLING_CLIENT_ID;
const BLING_CLIENT_SECRET = process.env.BLING_CLIENT_SECRET;
const BLING_REDIRECT_URI = process.env.BLING_REDIRECT_URI || 'http://localhost:3001/api/bling/callback';
const BLING_AUTH_URL = 'https://www.bling.com.br/Api/v3/oauth/authorize';
const BLING_TOKEN_URL = 'https://www.bling.com.br/Api/v3/oauth/token';
const BLING_API_BASE = 'https://www.bling.com.br/Api/v3';
const TOKEN_FILE = path.join(__dirname, 'bling_token.json');
const LOG_FILE = path.join(__dirname, 'bling_api.log');

// Controle de concorrência para busca de notas fiscais
let isNotasFiscaisFetching = false;

// Cache simples em memória para notas fiscais do Bling
let notasFiscaisCache = {
  key: null, // string com os parâmetros
  data: null, // resultado da última busca
  timestamp: 0 // timestamp em ms
};
const CACHE_DURATION_MS = 2 * 60 * 1000; // 2 minutos

// Função para obter data atual no timezone de São Paulo
function getCurrentDateTimeSP() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).replace(' ', 'T');
}

// Variáveis globais para progresso da importação
let importacaoProgresso = {
  importados: 0,
  total: 0,
  status: 'idle' // 'idle', 'importando', 'concluido', 'erro'
};

function logBling(msg, data) {
  const logMsg = `[${new Date().toISOString()}] ${msg} ${data ? JSON.stringify(data) : ''}`;
  fs.appendFileSync(LOG_FILE, logMsg + '\n');
  console.log(logMsg);
}

function saveToken(tokenObj) {
  return new Promise((resolve, reject) => {
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
       (provider, access_token, refresh_token, expires_in, token_type, created_at, updated_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        'bling',
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
           logBling('Token salvo no banco de dados', { id: this.lastID, ...tokenObj });
           // Limpar tokens antigos após salvar o novo
           cleanOldTokens().then(() => {
             resolve(tokenObj);
           });
         }
      }
    );
  });
}

function loadToken() {
  return new Promise((resolve) => {
    db.get(
      'SELECT * FROM api_tokens WHERE provider = ? ORDER BY updated_at DESC LIMIT 1',
      ['bling'],
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
          logBling('Token carregado do banco de dados', tokenObj);
          resolve(tokenObj);
        } else {
          logBling('Nenhum token encontrado no banco de dados');
          resolve(null);
        }
      }
    );
  });
}

function isTokenValid(tokenObj) {
  if (!tokenObj || !tokenObj.access_token || !tokenObj.expires_in || !tokenObj.created_at) return false;
  const expiresAt = new Date(tokenObj.created_at).getTime() + (tokenObj.expires_in * 1000) - 60000; // 1 min de margem
  return Date.now() < expiresAt;
}

async function refreshTokenIfNeeded() {
  let tokenObj = await loadToken();
  if (tokenObj && isTokenValid(tokenObj)) {
    return tokenObj;
  }
  if (tokenObj && tokenObj.refresh_token) {
    logBling('Renovando token com refresh_token');
    try {
      const data = qs.stringify({
        grant_type: 'refresh_token',
        refresh_token: tokenObj.refresh_token,
        client_id: BLING_CLIENT_ID,
        client_secret: BLING_CLIENT_SECRET,
        redirect_uri: BLING_REDIRECT_URI
      });
      const response = await axios.post(BLING_TOKEN_URL, data, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      const newToken = {
        ...response.data,
        created_at: new Date().toISOString()
      };
      await saveToken(newToken);
      return newToken;
    } catch (err) {
      logBling('Erro ao renovar token', err.response?.data || err.message);
      return null;
    }
  }
  return null;
}

// Função para limpar tokens antigos (manter apenas o mais recente)
function cleanOldTokens() {
  return new Promise((resolve) => {
    db.run(
      `DELETE FROM api_tokens WHERE provider = ? AND id NOT IN (
        SELECT id FROM api_tokens WHERE provider = ? ORDER BY updated_at DESC LIMIT 1
      )`,
      ['bling', 'bling'],
      function(err) {
        if (err) {
          logBling('Erro ao limpar tokens antigos', err.message);
        } else {
          logBling('Tokens antigos removidos', { deletedRows: this.changes });
        }
        resolve();
      }
    );
  });
}

// Middleware
app.use(helmet());
app.use(cors({
  origin: true, // Permite acesso de qualquer origem na rede local
  credentials: true
}));
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../client/public')));
app.use(express.static(path.join(__dirname, '../client/build')));

// Configuração do banco de dados SQLite
const dbPath = process.env.DB_PATH || '/data/database.sqlite';
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Erro ao conectar ao banco de dados:', err);
  } else {
    console.log('Conectado ao banco de dados SQLite em', dbPath);
    initDatabase();
  }
});

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
      notes TEXT,
      is_composite BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

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
      movement_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (inventory_id) REFERENCES inventory (id),
      FOREIGN KEY (user_id) REFERENCES users (id)
    )`);

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
    const adminEmail = 'admin@apoli.com';
    const adminPassword = 'admin123';
    db.get('SELECT * FROM users WHERE email = ?', [adminEmail], (err, row) => {
      if (!row) {
        const hash = bcrypt.hashSync(adminPassword, 10);
        db.run('INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
          ['Administrador', adminEmail, hash, 4],
          (err) => {
            if (err) console.error('Erro ao criar admin:', err);
            else console.log('Usuário admin criado: admin@apoli.com / admin123');
          }
        );
      }
    });

    // Criar tabela de notas expedidas
    db.run(`CREATE TABLE IF NOT EXISTS notas_expedidas (
      id INTEGER PRIMARY KEY,
      numero TEXT,
      codigo TEXT,
      numeroLoja TEXT,
      cliente TEXT,
      valorNota REAL,
      dataExpedicao DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // NOVA TABELA: Tokens da API Bling
    db.run(`CREATE TABLE IF NOT EXISTS api_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL DEFAULT 'bling',
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expires_in INTEGER,
      token_type TEXT DEFAULT 'Bearer',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

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
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token não fornecido' });
  jwt.verify(token, SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token inválido' });
    req.user = user;
    next();
  });
}

// Rotas da API

// Rota para verificar status do servidor
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    database: 'connected'
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

// Rota para logs do sistema
app.get('/api/logs', (req, res) => {
  const logPath = './logs/app.log';
  if (fs.existsSync(logPath)) {
    try {
      const data = fs.readFileSync(logPath, 'utf8');
      // Pega as últimas 100 linhas
      const lines = data.trim().split('\n');
      const lastLines = lines.slice(-100);
      res.json({ logs: lastLines });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao ler o arquivo de log' });
    }
  } else {
    // Logs simulados caso não exista arquivo
    res.json({ logs: [
      '[INFO] Sistema iniciado',
      '[DB] Conectando ao SQLite...',
      '[DB] Conectado com sucesso',
      '[SERVER] Iniciando servidor na porta 3001...',
      '[SERVER] Servidor online',
      '[CORS] Configurado para rede local',
      '[API] Rotas configuradas',
      '[SYSTEM] Monitoramento ativo'
    ] });
  }
});

// Rotas de usuários
app.get('/api/users', (req, res) => {
  db.all('SELECT * FROM users ORDER BY created_at DESC', (err, rows) => {
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
  db.all('SELECT * FROM products ORDER BY created_at DESC', (err, rows) => {
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
  db.all('SELECT * FROM api_config ORDER BY created_at DESC', (err, rows) => {
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
  db.all(`
    SELECT s.*, u.name as user_name, p.name as product_name 
    FROM sales s 
    LEFT JOIN users u ON s.user_id = u.id 
    LEFT JOIN products p ON s.product_id = p.id 
    ORDER BY s.sale_date DESC
  `, (err, rows) => {
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

  query += ' ORDER BY title ASC';

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
    category, supplier, cost_price, selling_price, notes 
  } = req.body;
  
  if (!sku || !title) {
    res.status(400).json({ error: 'SKU e título são obrigatórios' });
    return;
  }

  db.run(`
    INSERT INTO inventory (
      sku, ean, title, quantity, location, min_quantity, max_quantity,
      category, supplier, cost_price, selling_price, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [sku, ean, title, quantity || 0, location, min_quantity || 0, max_quantity, 
      category, supplier, cost_price, selling_price, notes], function(err) {
    if (err) {
      console.error('Erro ao inserir no inventário:', err);
      res.status(500).json({ error: err.message });
      return;
    }
    res.json({ 
      id: this.lastID, 
      sku, ean, title, quantity, location, min_quantity, max_quantity,
      category, supplier, cost_price, selling_price, notes 
    });
  });
});

app.put('/api/inventory/:id', (req, res) => {
  const { id } = req.params;
  const { 
    sku, ean, title, quantity, location, min_quantity, max_quantity, 
    category, supplier, cost_price, selling_price, notes, is_composite 
  } = req.body;
  
  db.run(`
    UPDATE inventory SET 
      sku = ?, ean = ?, title = ?, quantity = ?, location = ?, 
      min_quantity = ?, max_quantity = ?, category = ?, supplier = ?, 
      cost_price = ?, selling_price = ?, notes = ?, is_composite = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [sku, ean, title, quantity, location, min_quantity, max_quantity, 
      category, supplier, cost_price, selling_price, notes, is_composite, id], function(err) {
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
function movimentarComponentesCompostos({ db, mainSkuId, movementType, quantidade, reason, userId, callback }) {
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
              db.run(`INSERT INTO inventory_movements (inventory_id, movement_type, quantity, previous_quantity, new_quantity, reason, user_id, movement_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [componente.component_sku_id, movementType, quantidadeMovimentar, previous_quantity, new_quantity, `Movimentação automática por SKU composto: ${reason || ''}`, userId || null, getCurrentDateTimeSP()], function(err) {
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
  const { movement_type, quantity, reason, user_id } = req.body;
  console.log('[POST /api/inventory/:id/movement]', { id, body: req.body });
  
  if (!movement_type || !quantity) {
    console.error('ERRO DETALHADO: Tipo e quantidade são obrigatórios', { movement_type, quantity });
    res.status(400).json({ error: 'Tipo e quantidade são obrigatórios' });
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
              db.run(`INSERT INTO inventory_movements (inventory_id, movement_type, quantity, previous_quantity, new_quantity, reason, user_id, movement_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [id, movement_type, quantity, previous_quantity, new_quantity, reason || null, user_id || null, getCurrentDateTimeSP()], function(err) {
                if (err) {
                  console.error('ERRO DETALHADO: Falha ao registrar movimentação do SKU composto', err);
                  res.status(500).json({ error: err.message });
                  return;
                }
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
        db.run('UPDATE inventory SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [new_quantity, id], function(err) {
          if (err) {
            console.error('ERRO DETALHADO: Falha ao atualizar estoque do SKU simples', err);
            res.status(500).json({ error: err.message });
            return;
          }
          db.run(`INSERT INTO inventory_movements (inventory_id, movement_type, quantity, previous_quantity, new_quantity, reason, user_id, movement_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [id, movement_type, quantity, previous_quantity, new_quantity, reason || null, user_id || null, getCurrentDateTimeSP()], function(err) {
            if (err) {
              console.error('ERRO DETALHADO: Falha ao registrar movimentação do SKU simples', err);
              res.status(500).json({ error: err.message });
              return;
            }
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

// Importar estoque de CSV (apenas nível 4)
app.post('/api/inventory/import/csv', authenticateToken, requireAdmin, (req, res) => {
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
  const headers = lines[0].split(separator).map(h => h.trim().replace(/"/g, ''));
  const dataLines = lines.slice(1).filter(line => line.trim());
  
  let successCount = 0;
  let errorCount = 0;
  const errors = [];

  db.serialize(() => {
    dataLines.forEach((line, index) => {
      const values = line.split(separator).map(v => v.trim().replace(/"/g, ''));
      const item = {};
      
      headers.forEach((header, i) => {
        item[header] = values[i] || '';
      });

      // Validar dados obrigatórios
      if (!item.SKU || !item.Título) {
        errorCount++;
        errors.push(`Linha ${index + 2}: SKU e Título são obrigatórios`);
        return;
      }

      // Inserir ou atualizar item
      db.run(`
        INSERT OR REPLACE INTO inventory (
          sku, ean, title, quantity, location, min_quantity, max_quantity,
          category, supplier, cost_price, selling_price, notes, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `, [
        item.SKU, item.EAN, item.Título, 
        parseInt(item.Quantidade) || 0, item.Localização,
        parseInt(item['Quantidade Mínima']) || 0, 
        parseInt(item['Quantidade Máxima']) || null,
        item.Categoria, item.Fornecedor,
        parseFloat(item['Preço de Custo']) || null,
        parseFloat(item['Preço de Venda']) || null,
        item.Observações
      ], function(err) {
        if (err) {
          errorCount++;
          errors.push(`Linha ${index + 2}: ${err.message}`);
        } else {
          successCount++;
        }
      });
    });

    // Aguardar todas as operações terminarem
    db.get('SELECT COUNT(*) as count FROM inventory', (err, row) => {
      res.json({
        success: true,
        imported: successCount,
        errors: errorCount,
        errorDetails: errors,
        totalItems: row.count
      });
    });
  });
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

  // Log dos dados recebidos
  console.log('[POST /api/composite-skus] Dados recebidos:', req.body);

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
async function montarNotaFiscalDetalhada(nota, tokenObj) {
  const notaData = nota && nota.data ? nota.data : nota;
  let valorNota = notaData.valorNota;
  let numeroLoja = null;
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
    const detalheRes = await axios.get(`${BLING_API_BASE}/nfe/${notaData.id}`, {
      headers: {
        'Authorization': `Bearer ${tokenObj.access_token}`,
        'Accept': 'application/json'
      }
    });
    detalhe = detalheRes.data?.data;
    if (detalhe) {
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

  return {
    id: notaData.id,
    numero: notaData.numero,
    dataEmissao: notaData.dataEmissao,
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
  
  if (!quantity || quantity <= 0) {
    res.status(400).json({ error: 'Quantidade deve ser maior que zero' });
    return;
  }

  refreshTokenIfNeeded().then(tokenObj => {
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
                new_quantity, reason, user_id, movement_date
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `, [comp.component_sku_id, 'out', consumedQuantity, comp.available_quantity, newQuantity, 
                `Montagem de SKU composto: ${reason || 'Montagem automática'}`, null, getCurrentDateTimeSP()]);

              const notaData = comp && comp.data ? comp.data : comp;
              montarNotaFiscalDetalhada(notaData, tokenObj).then(nota => {
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
    SELECT cs.main_sku_id, msku.sku as main_sku, msku.title as main_title,
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
  
  let query = `
    SELECT m.*, u.name as user_name, i.title as item_title, i.sku as item_sku
    FROM inventory_movements m
    LEFT JOIN users u ON m.user_id = u.id
    LEFT JOIN inventory i ON m.inventory_id = i.id
    WHERE 1=1
  `;
  let params = [];
  
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
  db.get('SELECT COUNT(*) as total FROM inventory_movements', (err, totalRow) => {
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

// Endpoint para gerar URL de autorização
app.get('/api/bling/auth', (req, res) => {
  const state = Math.random().toString(36).substring(7);
  const url = `${BLING_AUTH_URL}?response_type=code&client_id=${BLING_CLIENT_ID}&redirect_uri=${encodeURIComponent(BLING_REDIRECT_URI)}&scope=produtos%20notasfiscais&state=${state}`;
  logBling('URL de autorização gerada', { url });
  res.json({ url, state });
});

// Endpoint de callback para receber o code e trocar pelo token
app.get('/api/bling/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) {
    logBling('Erro no callback', error);
    return res.status(400).send('Erro na autorização: ' + error);
  }
  if (!code) {
    logBling('Callback sem code');
    return res.status(400).send('Código de autorização não recebido.');
  }
  try {
    const data = qs.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: BLING_REDIRECT_URI
    });
    // Montar o header Authorization: Basic base64(client_id:client_secret)
    const basicAuth = Buffer.from(`${BLING_CLIENT_ID}:${BLING_CLIENT_SECRET}`).toString('base64');
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
    await saveToken(tokenObj);
    res.send('<h2>Autorização concluída com sucesso! Você já pode fechar esta janela.</h2>');
  } catch (err) {
    logBling('Erro ao trocar code por token', err.response?.data || err.message);
    res.status(500).send('Erro ao autorizar com o Bling. Tente novamente.');
  }
});

// Endpoint para status da conexão
app.get('/api/bling/status', async (req, res) => {
  const tokenObj = await refreshTokenIfNeeded();
  if (!tokenObj || !tokenObj.access_token) {
    return res.json({ connected: false });
  }
  // Se existe token válido, considera conectado
  return res.json({ connected: true, expires_in: tokenObj.expires_in, created_at: tokenObj.created_at });
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
  db.all('SELECT id, provider, created_at, updated_at FROM api_tokens WHERE provider = ? ORDER BY updated_at DESC', ['bling'], (err, rows) => {
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
    await cleanOldTokens();
    res.json({ message: 'Tokens antigos removidos com sucesso' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao limpar tokens', details: err.message });
  }
});

// Endpoint para buscar notas fiscais eletrônicas (NF-e) do Bling, com filtro opcional de data de emissão e cruzamento com pedidos de venda
app.get('/api/bling/notas-fiscais', async (req, res) => {
  const { dataEmissaoInicial, dataEmissaoFinal, forcarImportacao } = req.query;
  const cacheKey = `${dataEmissaoInicial || ''}_${dataEmissaoFinal || ''}`;
  
  console.log('[BACKEND DEBUG] Endpoint /api/bling/notas-fiscais chamado');
  console.log('[BACKEND DEBUG] Parâmetros:', { dataEmissaoInicial, dataEmissaoFinal, forcarImportacao });
  console.log('[BACKEND DEBUG] Status atual:', importacaoProgresso.status);
  console.log('[BACKEND DEBUG] isNotasFiscaisFetching:', isNotasFiscaisFetching);
  
  if (forcarImportacao && importacaoProgresso.status === 'importando') {
    console.log('[BACKEND DEBUG] Bloqueando - já existe importação em andamento');
    return res.status(429).json({ error: 'Já existe uma importação em andamento. Aguarde terminar.' });
  }
  
  if (
    !forcarImportacao &&
    importacaoProgresso.status === 'concluido' &&
    notasFiscaisCache.data
  ) {
    console.log('[BACKEND DEBUG] Retornando dados do cache (sem verificar cacheKey)');
    return res.json({ data: notasFiscaisCache.data });
  }
  
  if (isNotasFiscaisFetching) {
    console.log('[BACKEND DEBUG] Bloqueando - isNotasFiscaisFetching = true');
    return res.status(429).json({ error: 'Já existe uma busca de notas fiscais em andamento. Aguarde terminar.' });
  }
  
  console.log('[BACKEND DEBUG] Iniciando nova busca/importação');
  isNotasFiscaisFetching = true;
  logBling('Iniciando importação de notas fiscais do Bling', {});
  importacaoProgresso.importados = 0;
  importacaoProgresso.status = 'importando';
  // NÃO zere o total aqui!
  
  // Primeiro, contar o total de notas se não foi fornecido
  if (!importacaoProgresso.total || importacaoProgresso.total === 0) {
    console.log('[BACKEND DEBUG] Fazendo contagem inicial - total atual:', importacaoProgresso.total);
    try {
      let contagemUrl = `${BLING_API_BASE}/nfe?limite=100&pagina=1`;
      if (dataEmissaoInicial) contagemUrl += `&dataEmissaoInicial=${dataEmissaoInicial}`;
      if (dataEmissaoFinal) contagemUrl += `&dataEmissaoFinal=${dataEmissaoFinal}`;
      
      const contagemResponse = await axios.get(contagemUrl, {
        headers: {
          'Authorization': `Bearer ${tokenObj.access_token}`,
          'Accept': 'application/json'
        }
      });
      
      // Se a primeira página tem 100 itens, fazer contagem completa
      if (contagemResponse.data?.data?.length === 100) {
        logBling('Fazendo contagem completa de notas fiscais', {});
        let totalNotas = 0;
        let pageContagem = 1;
        
        while (true) {
          let urlContagem = `${BLING_API_BASE}/nfe?limite=100&pagina=${pageContagem}`;
          if (dataEmissaoInicial) urlContagem += `&dataEmissaoInicial=${dataEmissaoInicial}`;
          if (dataEmissaoFinal) urlContagem += `&dataEmissaoFinal=${dataEmissaoFinal}`;
          
          const responseContagem = await axios.get(urlContagem, {
            headers: {
              'Authorization': `Bearer ${tokenObj.access_token}`,
              'Accept': 'application/json'
            }
          });
          
          const dataArrContagem = responseContagem.data?.data;
          if (Array.isArray(dataArrContagem) && dataArrContagem.length > 0) {
            totalNotas += dataArrContagem.length;
            if (dataArrContagem.length < 100) break;
            pageContagem++;
          } else {
            break;
          }
        }
        importacaoProgresso.total = totalNotas;
        logBling('Contagem completa concluída', { total: totalNotas });
      } else {
        // Se a primeira página tem menos de 100, usar o tamanho da primeira página
        importacaoProgresso.total = contagemResponse.data?.data?.length || 0;
        logBling('Usando contagem da primeira página', { total: importacaoProgresso.total });
      }
    } catch (err) {
      logBling('Erro na contagem inicial, continuando sem total', err.message);
      importacaoProgresso.total = 0; // Continuar sem saber o total
    }
  }
  
  try {
    const tokenObj = await refreshTokenIfNeeded();
    if (!tokenObj || !tokenObj.access_token) {
      console.log('[BACKEND DEBUG] Erro de autenticação Bling');
      isNotasFiscaisFetching = false;
      return res.status(401).json({ error: 'Não autenticado no Bling.' });
    }
    
    console.log('[BACKEND DEBUG] Token válido, iniciando busca das notas');
    const endpoint = '/nfe'; // NF-e
    let allNotas = [];
    let lastError = null;
    let page = 1;
    let totalPaginas = 0;
    
    while (true) {
      let url = `${BLING_API_BASE}${endpoint}?limite=100&pagina=${page}`;
      if (dataEmissaoInicial) url += `&dataEmissaoInicial=${dataEmissaoInicial}`;
      if (dataEmissaoFinal) url += `&dataEmissaoFinal=${dataEmissaoFinal}`;
      
      try {
        const response = await axios.get(url, {
          headers: {
            'Authorization': `Bearer ${tokenObj.access_token}`,
            'Accept': 'application/json'
          }
        });
        
        const dataArr = response.data?.data;
        totalPaginas++;
        logBling(`Página ${page} - Notas retornadas: ${dataArr?.length || 0}`);
        
        if (Array.isArray(dataArr) && dataArr.length > 0) {
          const notasFormatadas = [];
          for (const nota of dataArr) {
            const notaDetalhada = await montarNotaFiscalDetalhada(nota, tokenObj);
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
    importacaoProgresso.status = 'concluido';
    logBling('Importação de notas fiscais - Total páginas', { totalPaginas, totalNotas: allNotas.length });
    
    // Remover duplicatas antes de retornar
    const notasUnicas = [];
    const idsSet = new Set();
    for (const nota of allNotas) {
      if (nota.id && !idsSet.has(nota.id)) {
        notasUnicas.push(nota);
        idsSet.add(nota.id);
      }
    }
    
    if (notasUnicas.length === 0) {
      console.log('[BACKEND DEBUG] Nenhuma nota encontrada');
      logBling('Erro ao buscar notas fiscais (lista)', lastError);
      isNotasFiscaisFetching = false;
      return res.status(404).json({ error: 'Nenhuma nota fiscal encontrada.', details: lastError });
    }
    
    console.log('[BACKEND DEBUG] Importação concluída com sucesso:', notasUnicas.length, 'notas');
    logBling('Importação de notas fiscais concluída', { total: notasUnicas.length });
    console.log("DEBUG - numeroPedidoLoja brutos:", notasUnicas.map(n => n.numeroPedidoLoja));
    
    isNotasFiscaisFetching = false;
    
    // Salvar no cache
    notasFiscaisCache = {
      key: cacheKey,
      data: notasUnicas,
      timestamp: Date.now()
    };
    
    console.log('[BACKEND DEBUG] Retornando dados para o frontend');
    return res.json({ data: notasUnicas });
    
  } catch (err) {
    console.log('[BACKEND DEBUG] Erro fatal na importação:', err.message);
    importacaoProgresso.status = 'erro';
    logBling('Erro ao buscar notas fiscais (fatal)', err.response?.data || err.message);
    isNotasFiscaisFetching = false;
    res.status(500).json({ error: 'Erro ao buscar notas fiscais (fatal)', details: err.response?.data || err.message });
  }
});

// Endpoint de teste para obter todos os dados brutos de pedidos de venda do Bling por numerosLojas[]
app.get('/api/bling/teste-pedidos-vendas', async (req, res) => {
  try {
    const tokenObj = await refreshTokenIfNeeded();
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
    const pedidosRes = await axios.get(pedidosUrl, {
      headers: {
        'Authorization': `Bearer ${tokenObj.access_token}`,
        'Accept': 'application/json'
      }
    });
    return res.json({ data: pedidosRes.data });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar pedidos de venda', details: err.response?.data || err.message });
  }
});

// Endpoint temporário para listar todos os numeroPedidoLoja das notas fiscais
app.get('/api/bling/notas-fiscais/numero-pedido-loja', async (req, res) => {
  try {
    const tokenObj = await refreshTokenIfNeeded();
    if (!tokenObj || !tokenObj.access_token) {
      return res.status(401).json({ error: 'Não autenticado no Bling.' });
    }
    const endpoint = '/nfe';
    let allNumeros = [];
    let page = 1;
    const { dataEmissaoInicial, dataEmissaoFinal } = req.query;
    while (true) {
      let url = `${BLING_API_BASE}${endpoint}?limite=100&pagina=${page}`;
      if (dataEmissaoInicial) url += `&dataEmissaoInicial=${dataEmissaoInicial}`;
      if (dataEmissaoFinal) url += `&dataEmissaoFinal=${dataEmissaoFinal}`;
      const response = await axios.get(url, {
        headers: {
          'Authorization': `Bearer ${tokenObj.access_token}`,
          'Accept': 'application/json'
        }
      });
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
    const tokenObj = await refreshTokenIfNeeded();
    if (!tokenObj || !tokenObj.access_token) {
      return res.status(401).json({ error: 'Não autenticado no Bling.' });
    }
    const { idNotaFiscal } = req.params;
    const url = `${BLING_API_BASE}/nfe/${idNotaFiscal}`;
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${tokenObj.access_token}`,
        'Accept': 'application/json'
      }
    });
    return res.json({ data: response.data });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar nota fiscal', details: err.response?.data || err.message });
  }
});

// Endpoint para salvar nota expedida
app.post('/api/notas-expedidas', (req, res) => {
  const { id, numero, codigo, numeroLoja, cliente, valorNota } = req.body;
  if (!id || !numero) {
    return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
  }
  db.run(`INSERT OR REPLACE INTO notas_expedidas (id, numero, codigo, numeroLoja, cliente, valorNota, dataExpedicao)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [id, numero, codigo, numeroLoja, cliente, valorNota],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
});

// Endpoint para listar ids das notas expedidas
app.get('/api/notas-expedidas', (req, res) => {
  db.all('SELECT id FROM notas_expedidas', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ expedidas: rows.map(r => r.id) });
  });
});

// Endpoint para dashboard: faturamento, vendas e gráfico do mês
app.get('/api/dashboard/faturamento', async (req, res) => {
  // Datas para filtro
  const now = new Date();
  const ano = now.getFullYear();
  const mes = (now.getMonth() + 1).toString().padStart(2, '0');
  const dia = now.getDate().toString().padStart(2, '0');
  const inicioMes = `${ano}-${mes}-01 00:00:00`;
  const inicioAmanha = `${ano}-${mes}-${(parseInt(dia)+1).toString().padStart(2, '0')} 00:00:00`;
  const inicioHoje = `${ano}-${mes}-${dia} 00:00:00`;

  db.all(`SELECT * FROM notas_expedidas WHERE dataExpedicao >= ? AND dataExpedicao < ?`, [inicioMes, inicioAmanha], (err, rows) => {
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
      if (data === `${ano}-${mes}-${dia}`) faturamentoDia += valor;
      if (!vendasPorDia[data]) vendasPorDia[data] = { valor: 0, quantidade: 0 };
      vendasPorDia[data].valor += valor;
      vendasPorDia[data].quantidade++;
    });
    const vendasPorDiaMes = Object.entries(vendasPorDia).map(([dia, obj]) => ({ dia, ...obj }));
    res.json({ faturamentoMes, vendasMes, faturamentoDia, vendasPorDiaMes });
  });
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
// Listar aglutinados
app.get('/api/aglutinados', (req, res) => {
  db.all(
    `SELECT id, data_criacao, marketplaces FROM aglutinados ORDER BY data_criacao DESC`,
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

// Endpoint para contar total de notas fiscais (requisição inicial)
app.get('/api/bling/notas-fiscais/contar', async (req, res) => {
  try {
    const tokenObj = await refreshTokenIfNeeded();
    if (!tokenObj || !tokenObj.access_token) {
      return res.status(401).json({ error: 'Não autenticado no Bling.' });
    }

    const { dataEmissaoInicial, dataEmissaoFinal } = req.query;
    const endpoint = '/nfe';
    let totalNotas = 0;
    let page = 1;

    logBling('Iniciando contagem de notas fiscais do Bling', {});

    while (true) {
      let url = `${BLING_API_BASE}${endpoint}?limite=100&pagina=${page}`;
      if (dataEmissaoInicial) url += `&dataEmissaoInicial=${dataEmissaoInicial}`;
      if (dataEmissaoFinal) url += `&dataEmissaoFinal=${dataEmissaoFinal}`;

      const response = await axios.get(url, {
        headers: {
          'Authorization': `Bearer ${tokenObj.access_token}`,
          'Accept': 'application/json'
        }
      });

      const dataArr = response.data?.data;
      if (Array.isArray(dataArr) && dataArr.length > 0) {
        totalNotas += dataArr.length;
        logBling(`Página ${page} - Notas contadas: ${dataArr.length}`);
        if (dataArr.length < 100) break; // última página
        page++;
      } else {
        break; // sem mais páginas
      }
    }

    importacaoProgresso.total = totalNotas; // Atualiza o progresso global
    logBling('Contagem de notas fiscais concluída', { total: totalNotas });
    res.json({ total: totalNotas });
  } catch (err) {
    logBling('Erro ao contar notas fiscais', err.response?.data || err.message);
    res.status(500).json({ error: 'Erro ao contar notas fiscais', details: err.response?.data || err.message });
  }
});

// Endpoint para progresso da importação
app.get('/api/importacao/progresso', (req, res) => {
  console.log('[BACKEND DEBUG] Progresso consultado - status:', importacaoProgresso.status, 'importados:', importacaoProgresso.importados, 'total:', importacaoProgresso.total);
  res.json({
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
    if (err || !user) return res.status(401).json({ error: 'Usuário ou senha inválidos' });
    if (!bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: 'Usuário ou senha inválidos' });
    const token = jwt.sign({ id: user.id, name: user.name, email: user.email, role: user.role }, SECRET, { expiresIn: '8h' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
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
  res.json({ success: true });
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
    // Faz merge, mas preserva pinnedSkus se não vier no body
    const newSettings = { ...currentSettings, ...req.body };
    if (!('pinnedSkus' in req.body) && currentSettings.pinnedSkus) {
      newSettings.pinnedSkus = currentSettings.pinnedSkus;
    }
    db.run('UPDATE users SET settings = ? WHERE id = ?', [JSON.stringify(newSettings), req.user.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
    });
  });
});

// Endpoint para atualizar o total de notas da importação
app.post('/api/importacao/total', (req, res) => {
  const { total } = req.body;
  if (typeof total === 'number' && total > 0) {
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
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
  console.log(`🌐 Acessível na rede local em http://[SEU_IP]:${PORT}`);
  console.log(`📊 Banco de dados: database.sqlite`);
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

// Função para identificar o marketplace pelo padrão do número do pedido
function identificarMarketplace(numeroPedidoLoja, itens = []) {
  if (!numeroPedidoLoja || typeof numeroPedidoLoja !== 'string') return 'Desconhecido';
  
  // Mercado Livre Full: prioridade máxima, se qualquer item tiver cfop terminando em 6
  const isFull = Array.isArray(itens) && itens.some(item => item.cfop && item.cfop.toString().endsWith('6'));
  if (isFull) return 'Mercado Livre Full';
  
  if (/^ORD/.test(numeroPedidoLoja)) return 'Olist';
  if (/^GSH1C[A-Z0-9]+$/i.test(numeroPedidoLoja)) return 'Shein';
  if (/^\d{3}-\d{7}-\d{7}$/.test(numeroPedidoLoja)) return 'Amazon';
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