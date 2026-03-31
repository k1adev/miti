const sqlite3 = require('sqlite3').verbose();

console.log('🔧 Corrigindo settings corrompidos...');

const db = new sqlite3.Database('/data/database.sqlite');

// Corrigir settings que contêm HTML
db.run("UPDATE users SET settings = '{\"pinnedSkus\":[]}' WHERE settings LIKE '%<!doctype html>%'", function(err) {
  if (err) {
    console.error('❌ Erro:', err.message);
  } else {
    console.log('✅ Corrigidos:', this.changes, 'usuários com HTML');
  }
  
  // Corrigir settings NULL
  db.run("UPDATE users SET settings = '{\"pinnedSkus\":[]}' WHERE settings IS NULL", function(err) {
    if (err) {
      console.error('❌ Erro:', err.message);
    } else {
      console.log('✅ Corrigidos:', this.changes, 'usuários com settings NULL');
    }
    
    // Verificar resultado
    db.all("SELECT id, name, email, settings FROM users", (err, users) => {
      if (err) {
        console.error('❌ Erro ao verificar:', err.message);
      } else {
        console.log('\n📊 Usuários após correção:');
        users.forEach(user => {
          console.log(`   ${user.name}: ${user.settings}`);
        });
      }
      
      console.log('\n🎉 Correção concluída!');
      db.close();
    });
  });
}); 