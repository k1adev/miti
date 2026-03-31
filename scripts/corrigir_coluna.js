const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database(path.join(__dirname, '..', 'database.sqlite'));

db.serialize(() => {
  // Atualizar todos os SKUs compostos
  db.all("SELECT DISTINCT main_sku_id FROM composite_skus", (err, rows) => {
    if (err) {
      console.error('Erro ao buscar SKUs compostos:', err.message);
      process.exit(1);
    }
    if (!rows || rows.length === 0) {
      console.log('Nenhum SKU composto encontrado.');
      process.exit(0);
    }
    const ids = rows.map(r => r.main_sku_id);
    db.run(`UPDATE inventory SET is_composite = 1 WHERE id IN (${ids.map(() => '?').join(',')})`, ids, (err) => {
      if (err) {
        console.error('Erro ao atualizar SKUs compostos:', err.message);
        process.exit(1);
      }
      console.log('Todos os SKUs compostos foram marcados corretamente!');
      process.exit(0);
    });
  });
}); 