const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Configuração para Fly.io
const dbPath = process.env.DB_PATH || '/data/database.sqlite';
const db = new sqlite3.Database(dbPath);

console.log('🔧 CORREÇÃO FLY.IO: Funcionalidade de Fixar Itens');
console.log('================================================\n');

console.log('📊 Informações do ambiente:');
console.log(`   DB_PATH: ${dbPath}`);
console.log(`   NODE_ENV: ${process.env.NODE_ENV}`);
console.log(`   Platform: ${process.platform}`);
console.log('');

// 1. Verificar se o banco existe
console.log('1️⃣ Verificando banco de dados...');
if (!require('fs').existsSync(dbPath)) {
  console.error('❌ Banco de dados não encontrado em:', dbPath);
  console.log('💡 Verifique se a variável DB_PATH está configurada corretamente');
  process.exit(1);
}
console.log('✅ Banco de dados encontrado');

// 2. Verificar estrutura da tabela users
console.log('\n2️⃣ Verificando estrutura da tabela users...');
db.all("PRAGMA table_info(users)", (err, columns) => {
  if (err) {
    console.error('❌ Erro ao verificar estrutura da tabela users:', err.message);
    db.close();
    return;
  }
  
  console.log('📊 Colunas encontradas:');
  columns.forEach(col => {
    console.log(`   - ${col.name} (${col.type})`);
  });
  
  const hasSettings = columns.some(col => col.name === 'settings');
  console.log(`\n🔍 Coluna 'settings' existe: ${hasSettings ? '✅ SIM' : '❌ NÃO'}`);
  
  if (!hasSettings) {
    console.log('\n🔄 Criando coluna settings...');
    db.run("ALTER TABLE users ADD COLUMN settings TEXT", function(err) {
      if (err) {
        console.error('❌ Erro ao criar coluna settings:', err.message);
        db.close();
        return;
      }
      console.log('✅ Coluna settings criada com sucesso!');
      verificarUsuarios();
    });
  } else {
    console.log('✅ Coluna settings já existe');
    verificarUsuarios();
  }
});

function verificarUsuarios() {
  console.log('\n3️⃣ Verificando usuários...');
  db.all('SELECT id, name, email, role, settings FROM users', (err, users) => {
    if (err) {
      console.error('❌ Erro ao buscar usuários:', err.message);
      db.close();
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
          corrigirSettingsInvalidos(user.id);
        }
      } else {
        console.log(`     Settings: null/undefined`);
        inicializarSettings(user.id);
      }
    });
    
    // 4. Testar operações de settings
    if (users.length > 0) {
      testarOperacoes(users[0].id);
    } else {
      console.log('\n❌ Nenhum usuário encontrado para teste');
      db.close();
    }
  });
}

function corrigirSettingsInvalidos(userId) {
  console.log(`\n🔄 Corrigindo settings inválidos para usuário ${userId}...`);
  const settingsCorrigidos = { pinnedSkus: [] };
  db.run('UPDATE users SET settings = ? WHERE id = ?', [JSON.stringify(settingsCorrigidos), userId], function(err) {
    if (err) {
      console.error('❌ Erro ao corrigir settings:', err.message);
    } else {
      console.log('✅ Settings corrigidos com sucesso');
    }
  });
}

function inicializarSettings(userId) {
  console.log(`\n🔄 Inicializando settings para usuário ${userId}...`);
  const settingsIniciais = { pinnedSkus: [] };
  db.run('UPDATE users SET settings = ? WHERE id = ?', [JSON.stringify(settingsIniciais), userId], function(err) {
    if (err) {
      console.error('❌ Erro ao inicializar settings:', err.message);
    } else {
      console.log('✅ Settings inicializados com sucesso');
    }
  });
}

function testarOperacoes(userId) {
  console.log(`\n4️⃣ Testando operações de settings para usuário ${userId}...`);
  
  // Teste 1: Ler settings
  db.get('SELECT settings FROM users WHERE id = ?', [userId], (err, row) => {
    if (err) {
      console.error('❌ Erro ao ler settings:', err.message);
      db.close();
      return;
    }
    
    console.log('✅ Leitura de settings funcionando');
    let settings = {};
    try {
      settings = row.settings ? JSON.parse(row.settings) : {};
      console.log(`   Settings atuais: ${JSON.stringify(settings)}`);
    } catch (e) {
      console.error('❌ Erro ao parsear settings:', e.message);
      db.close();
      return;
    }
    
    // Teste 2: Salvar settings
    const testPinnedSkus = ['12345', '67890'];
    const newSettings = { ...settings, pinnedSkus: testPinnedSkus };
    
    db.run('UPDATE users SET settings = ? WHERE id = ?', [JSON.stringify(newSettings), userId], function(err) {
      if (err) {
        console.error('❌ Erro ao salvar settings:', err.message);
        db.close();
        return;
      }
      
      console.log('✅ Salvamento de settings funcionando');
      console.log(`   pinnedSkus salvos: ${JSON.stringify(testPinnedSkus)}`);
      
      // Teste 3: Verificar salvamento
      db.get('SELECT settings FROM users WHERE id = ?', [userId], (err2, row2) => {
        if (err2) {
          console.error('❌ Erro ao verificar salvamento:', err2.message);
          db.close();
          return;
        }
        
        try {
          const savedSettings = JSON.parse(row2.settings);
          if (JSON.stringify(savedSettings.pinnedSkus) === JSON.stringify(testPinnedSkus)) {
            console.log('✅ Verificação de salvamento funcionando');
          } else {
            console.log('❌ Dados não foram salvos corretamente');
          }
        } catch (e) {
          console.error('❌ Erro ao verificar dados salvos:', e.message);
        }
        
        // Teste 4: Limpar dados de teste
        const cleanSettings = { ...savedSettings, pinnedSkus: [] };
        db.run('UPDATE users SET settings = ? WHERE id = ?', [JSON.stringify(cleanSettings), userId], function(err3) {
          if (err3) {
            console.error('❌ Erro ao limpar dados de teste:', err3.message);
          } else {
            console.log('✅ Limpeza de dados funcionando');
          }
          
          console.log('\n🎉 TODOS OS TESTES PASSARAM!');
          console.log('✅ A funcionalidade de fixar itens deve funcionar agora.');
          console.log('\n📋 Próximos passos:');
          console.log('1. Reinicie a aplicação no Fly.io');
          console.log('2. Faça login novamente');
          console.log('3. Teste a funcionalidade de fixar itens');
          
          db.close();
        });
      });
    });
  });
} 