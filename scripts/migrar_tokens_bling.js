const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

// Configuração do banco de dados (executar na raiz do repo: node scripts/migrar_tokens_bling.js)
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'database.sqlite');
const db = new sqlite3.Database(dbPath);
const TOKEN_FILE = path.join(__dirname, '..', 'server', 'bling_token.json');

console.log('🔄 Iniciando migração de tokens do Bling...');
console.log('📁 Arquivo de token:', TOKEN_FILE);
console.log('🗄️ Banco de dados:', dbPath);

// Verificar se o arquivo existe
if (!fs.existsSync(TOKEN_FILE)) {
  console.log('❌ Arquivo de token não encontrado. Nada para migrar.');
  process.exit(0);
}

// Ler token do arquivo
try {
  const tokenData = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  console.log('✅ Token encontrado no arquivo:', {
    access_token: tokenData.access_token ? '***' + tokenData.access_token.slice(-4) : 'não informado',
    refresh_token: tokenData.refresh_token ? '***' + tokenData.refresh_token.slice(-4) : 'não informado',
    expires_in: tokenData.expires_in,
    created_at: tokenData.created_at
  });

  // Inserir no banco de dados
  const now = new Date().toISOString();
  db.run(
    `INSERT OR REPLACE INTO api_tokens 
     (provider, access_token, refresh_token, expires_in, token_type, created_at, updated_at) 
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      'bling',
      tokenData.access_token,
      tokenData.refresh_token || null,
      tokenData.expires_in || null,
      tokenData.token_type || 'Bearer',
      tokenData.created_at || now,
      now
    ],
    function(err) {
      if (err) {
        console.error('❌ Erro ao salvar token no banco:', err.message);
        process.exit(1);
      } else {
        console.log('✅ Token migrado com sucesso! ID:', this.lastID);
        
        // Fazer backup do arquivo original
        const backupFile = TOKEN_FILE + '.backup.' + Date.now();
        fs.copyFileSync(TOKEN_FILE, backupFile);
        console.log('💾 Backup criado:', backupFile);
        
        // Remover arquivo original
        fs.unlinkSync(TOKEN_FILE);
        console.log('🗑️ Arquivo original removido');
        
        console.log('🎉 Migração concluída com sucesso!');
        process.exit(0);
      }
    }
  );

} catch (error) {
  console.error('❌ Erro ao ler arquivo de token:', error.message);
  process.exit(1);
} 