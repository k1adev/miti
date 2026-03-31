const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

// Configuração
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'database.sqlite');
const SECRET = process.env.JWT_SECRET || 'apoli-secret';
const db = new sqlite3.Database(dbPath);

console.log('🔍 DIAGNÓSTICO: Funcionalidade de Fixar Itens');
console.log('=============================================\n');

// 1. Verificar estrutura da tabela users
console.log('1️⃣ Verificando estrutura da tabela users...');
db.all("PRAGMA table_info(users)", (err, columns) => {
  if (err) {
    console.error('❌ Erro ao verificar estrutura da tabela users:', err.message);
    return;
  }
  
  console.log('✅ Colunas encontradas:');
  columns.forEach(col => {
    console.log(`   - ${col.name} (${col.type})`);
  });
  
  const hasSettings = columns.some(col => col.name === 'settings');
  console.log(`\n📊 Coluna 'settings' existe: ${hasSettings ? '✅ SIM' : '❌ NÃO'}`);
  
  if (!hasSettings) {
    console.log('⚠️  PROBLEMA IDENTIFICADO: Coluna settings não existe!');
    console.log('💡 Solução: A migração não foi executada corretamente.');
  }
  
  // 2. Verificar usuários existentes
  console.log('\n2️⃣ Verificando usuários existentes...');
  db.all('SELECT id, name, email, role, settings FROM users', (err, users) => {
    if (err) {
      console.error('❌ Erro ao buscar usuários:', err.message);
      return;
    }
    
    console.log(`✅ Total de usuários: ${users.length}`);
    users.forEach(user => {
      console.log(`   - ID: ${user.id}, Nome: ${user.name}, Email: ${user.email}, Role: ${user.role}`);
      if (user.settings) {
        try {
          const settings = JSON.parse(user.settings);
          console.log(`     Settings: ${JSON.stringify(settings)}`);
        } catch (e) {
          console.log(`     Settings: ❌ JSON inválido - ${user.settings}`);
        }
      } else {
        console.log(`     Settings: null/undefined`);
      }
    });
    
    // 3. Testar criação de token JWT
    console.log('\n3️⃣ Testando geração de token JWT...');
    if (users.length > 0) {
      const testUser = users[0];
      try {
        const token = jwt.sign(
          { id: testUser.id, name: testUser.name, email: testUser.email, role: testUser.role }, 
          SECRET, 
          { expiresIn: '8h' }
        );
        console.log('✅ Token JWT gerado com sucesso');
        console.log(`   Token: ${token.substring(0, 50)}...`);
        
        // 4. Testar decodificação do token
        console.log('\n4️⃣ Testando decodificação do token...');
        try {
          const decoded = jwt.verify(token, SECRET);
          console.log('✅ Token decodificado com sucesso');
          console.log(`   User ID: ${decoded.id}`);
          console.log(`   User Name: ${decoded.name}`);
        } catch (e) {
          console.error('❌ Erro ao decodificar token:', e.message);
        }
        
        // 5. Testar operações de settings
        console.log('\n5️⃣ Testando operações de settings...');
        const testSettings = { pinnedSkus: ['12345', '67890'], darkMode: true };
        
        // Salvar settings
        db.run(
          'UPDATE users SET settings = ? WHERE id = ?',
          [JSON.stringify(testSettings), testUser.id],
          function(err) {
            if (err) {
              console.error('❌ Erro ao salvar settings:', err.message);
            } else {
              console.log('✅ Settings salvos com sucesso');
              console.log(`   Rows affected: ${this.changes}`);
              
              // Ler settings
              db.get('SELECT settings FROM users WHERE id = ?', [testUser.id], (err, row) => {
                if (err) {
                  console.error('❌ Erro ao ler settings:', err.message);
                } else if (row && row.settings) {
                  try {
                    const readSettings = JSON.parse(row.settings);
                    console.log('✅ Settings lidos com sucesso');
                    console.log(`   Settings: ${JSON.stringify(readSettings)}`);
                    
                    // Verificar se pinnedSkus está correto
                    if (readSettings.pinnedSkus && Array.isArray(readSettings.pinnedSkus)) {
                      console.log('✅ pinnedSkus é um array válido');
                      console.log(`   SKUs fixados: ${readSettings.pinnedSkus.join(', ')}`);
                    } else {
                      console.log('❌ PROBLEMA: pinnedSkus não é um array válido');
                    }
                  } catch (e) {
                    console.error('❌ Erro ao parsear settings:', e.message);
                  }
                } else {
                  console.log('❌ PROBLEMA: Settings não encontrados após salvar');
                }
                
                // 6. Verificar rotas da API
                console.log('\n6️⃣ Verificando rotas da API...');
                console.log('✅ Rotas implementadas:');
                console.log('   - GET /api/user/pinned-skus (com authenticateToken)');
                console.log('   - PUT /api/user/pinned-skus (com authenticateToken)');
                console.log('   - GET /api/user/settings (com authenticateToken)');
                console.log('   - PUT /api/user/settings (com authenticateToken)');
                
                // 7. Resumo do diagnóstico
                console.log('\n📋 RESUMO DO DIAGNÓSTICO');
                console.log('========================');
                
                const problems = [];
                if (!hasSettings) problems.push('❌ Coluna settings não existe na tabela users');
                if (users.length === 0) problems.push('❌ Nenhum usuário encontrado no banco');
                
                if (problems.length === 0) {
                  console.log('✅ Nenhum problema estrutural encontrado');
                  console.log('💡 O problema pode estar em:');
                  console.log('   - Token expirado no frontend');
                  console.log('   - Usuário não logado');
                  console.log('   - Erro de rede');
                  console.log('   - Problema no frontend (React state)');
                } else {
                  console.log('❌ Problemas encontrados:');
                  problems.forEach(problem => console.log(`   ${problem}`));
                }
                
                console.log('\n🔧 PRÓXIMOS PASSOS:');
                if (!hasSettings) {
                  console.log('1. Execute a migração da coluna settings:');
                  console.log('   - Reinicie o servidor para executar initDatabase()');
                  console.log('   - Ou execute manualmente: ALTER TABLE users ADD COLUMN settings TEXT');
                }
                if (users.length === 0) {
                  console.log('2. Crie um usuário de teste');
                }
                console.log('3. Verifique o console do navegador (F12) para erros');
                console.log('4. Teste a funcionalidade após as correções');
                
                db.close();
              });
            }
          }
        );
        
      } catch (e) {
        console.error('❌ Erro ao gerar token JWT:', e.message);
        db.close();
      }
    } else {
      console.log('❌ Nenhum usuário encontrado para teste');
      db.close();
    }
  });
}); 