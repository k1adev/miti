const sqlite3 = require('sqlite3').verbose();

// Configuração para Fly.io
const dbPath = process.env.DB_PATH || '/data/database.sqlite';
const db = new sqlite3.Database(dbPath);

console.log('🔧 CORREÇÃO FLY.IO: Settings Corrompidos');
console.log('========================================\n');

console.log('📊 Informações do ambiente:');
console.log(`   DB_PATH: ${dbPath}`);
console.log(`   NODE_ENV: ${process.env.NODE_ENV}`);
console.log('');

// Função para verificar se uma string é JSON válido
function isJsonValid(str) {
  if (!str) return false;
  try {
    JSON.parse(str);
    return true;
  } catch (e) {
    return false;
  }
}

// Função para verificar se uma string contém HTML
function containsHtml(str) {
  if (!str) return false;
  return str.includes('<!doctype html>') || str.includes('<html') || str.includes('<head>');
}

// Função para corrigir settings corrompidos
function corrigirSettingsCorrompidos() {
  console.log('🔍 Verificando e corrigindo settings corrompidos...\n');
  
  db.all('SELECT id, name, email, settings FROM users', (err, users) => {
    if (err) {
      console.error('❌ Erro ao buscar usuários:', err.message);
      db.close();
      return;
    }
    
    console.log(`📊 Total de usuários: ${users.length}`);
    let corrigidos = 0;
    
    users.forEach(user => {
      console.log(`\n👤 Usuário: ${user.name} (ID: ${user.id})`);
      
      if (!user.settings) {
        console.log('   Status: ❌ Settings null/undefined');
        console.log('   Ação: Inicializando settings...');
        
        const settingsCorrigidos = { pinnedSkus: [] };
        db.run('UPDATE users SET settings = ? WHERE id = ?', [JSON.stringify(settingsCorrigidos), user.id], function(err) {
          if (err) {
            console.error('   ❌ Erro ao corrigir:', err.message);
          } else {
            console.log('   ✅ Settings inicializados');
            corrigidos++;
          }
        });
        
      } else if (containsHtml(user.settings)) {
        console.log('   Status: ❌ Settings contém HTML');
        console.log('   Ação: Corrigindo settings...');
        
        const settingsCorrigidos = { pinnedSkus: [] };
        db.run('UPDATE users SET settings = ? WHERE id = ?', [JSON.stringify(settingsCorrigidos), user.id], function(err) {
          if (err) {
            console.error('   ❌ Erro ao corrigir:', err.message);
          } else {
            console.log('   ✅ Settings corrigidos');
            corrigidos++;
          }
        });
        
      } else if (!isJsonValid(user.settings)) {
        console.log('   Status: ❌ Settings JSON inválido');
        console.log('   Ação: Corrigindo settings...');
        
        const settingsCorrigidos = { pinnedSkus: [] };
        db.run('UPDATE users SET settings = ? WHERE id = ?', [JSON.stringify(settingsCorrigidos), user.id], function(err) {
          if (err) {
            console.error('   ❌ Erro ao corrigir:', err.message);
          } else {
            console.log('   ✅ Settings corrigidos');
            corrigidos++;
          }
        });
        
      } else {
        console.log('   Status: ✅ Settings válidos');
        try {
          const settings = JSON.parse(user.settings);
          console.log(`   Conteúdo: ${JSON.stringify(settings)}`);
        } catch (e) {
          console.log('   ❌ Erro ao parsear settings válidos');
        }
      }
    });
    
    // Aguardar um pouco para as operações assíncronas terminarem
    setTimeout(() => {
      console.log(`\n🎉 CORREÇÃO CONCLUÍDA!`);
      console.log(`✅ ${corrigidos} usuários corrigidos`);
      console.log('\n📋 Próximos passos:');
      console.log('1. Reinicie a aplicação no Fly.io');
      console.log('2. Faça login novamente');
      console.log('3. Teste a funcionalidade de fixar itens');
      
      db.close();
    }, 2000);
  });
}

// Executar correção
corrigirSettingsCorrompidos(); 