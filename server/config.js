require('dotenv').config();

const config = {
  // Configurações do servidor
  server: {
    port: process.env.PORT || 3001,
    host: process.env.HOST || '0.0.0.0',
    environment: process.env.NODE_ENV || 'development'
  },

  // Configurações do banco de dados
  database: {
    path: process.env.DB_PATH || './database.sqlite',
    timeout: 30000,
    verbose: process.env.NODE_ENV === 'development'
  },

  // Configurações de segurança
  security: {
    sessionSecret: process.env.SESSION_SECRET || 'apoli-secret-key-change-in-production',
    corsOrigin: process.env.CORS_ORIGIN || true,
    helmet: {
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          imgSrc: ["'self'", "data:", "https:"],
        },
      },
    }
  },

  // Configurações de upload
  upload: {
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE) || 10485760, // 10MB
    uploadPath: process.env.UPLOAD_PATH || './uploads',
    allowedTypes: ['.csv', '.xlsx', '.xls']
  },

  // Configurações de API externa
  api: {
    timeout: parseInt(process.env.API_TIMEOUT) || 30000,
    retryAttempts: parseInt(process.env.API_RETRY_ATTEMPTS) || 3,
    userAgent: 'Apoli-System/2.0.0'
  },

  // Configurações de log
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    format: process.env.NODE_ENV === 'development' ? 'dev' : 'combined',
    file: process.env.LOG_FILE || './logs/app.log'
  },

  // Configurações de estoque
  inventory: {
    defaultMinQuantity: 0,
    defaultMaxQuantity: 999999,
    enableAlerts: true,
    alertThreshold: 0.1 // 10% do estoque máximo
  },

  // Configurações de SKUs compostos
  compositeSkus: {
    enableAutoAssembly: true,
    requireConfirmation: true,
    maxComponents: 50
  },

  // Configurações de backup
  backup: {
    enabled: true,
    autoBackup: true,
    backupInterval: 24 * 60 * 60 * 1000, // 24 horas
    maxBackups: 10,
    backupPath: './backups'
  }
};

// Validação de configurações
function validateConfig() {
  const errors = [];

  // Validar porta
  if (config.server.port < 1 || config.server.port > 65535) {
    errors.push('Porta deve estar entre 1 e 65535');
  }

  // Validar tamanho máximo de arquivo
  if (config.upload.maxFileSize < 1024 || config.upload.maxFileSize > 100 * 1024 * 1024) {
    errors.push('Tamanho máximo de arquivo deve estar entre 1KB e 100MB');
  }

  // Validar timeout da API
  if (config.api.timeout < 1000 || config.api.timeout > 300000) {
    errors.push('Timeout da API deve estar entre 1s e 5min');
  }

  if (errors.length > 0) {
    throw new Error(`Erros de configuração:\n${errors.join('\n')}`);
  }
}

// Função para obter configuração específica
function get(key) {
  const keys = key.split('.');
  let value = config;
  
  for (const k of keys) {
    if (value && typeof value === 'object' && k in value) {
      value = value[k];
    } else {
      return undefined;
    }
  }
  
  return value;
}

// Função para definir configuração
function set(key, value) {
  const keys = key.split('.');
  let current = config;
  
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (!(k in current) || typeof current[k] !== 'object') {
      current[k] = {};
    }
    current = current[k];
  }
  
  current[keys[keys.length - 1]] = value;
}

// Função para obter configuração de ambiente
function isDevelopment() {
  return config.server.environment === 'development';
}

function isProduction() {
  return config.server.environment === 'production';
}

// Função para obter configuração completa
function getAll() {
  return { ...config };
}

module.exports = {
  config,
  validateConfig,
  get,
  set,
  isDevelopment,
  isProduction,
  getAll
}; 