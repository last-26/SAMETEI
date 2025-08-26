#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const HRRAGSystem = require('../ragSystem');

async function main() {
  try {
    const argDir = process.argv[2];
    const defaultDir = path.join(__dirname, '..', 'data', 'procedures');
    const targetDir = argDir ? path.resolve(argDir) : defaultDir;

    console.log('📥 PDF/DOCX ingest başlıyor...');
    console.log(`📁 Hedef klasör: ${targetDir}`);

    if (!fs.existsSync(targetDir)) {
      console.error(`❌ Klasör bulunamadı: ${targetDir}`);
      process.exit(1);
    }

    const rag = new HRRAGSystem();
    await rag.initialize();

    const inserted = await rag.loadDocumentsFromDir(targetDir);
    console.log(`✅ Ingest tamamlandı: ${inserted.length} chunk eklendi`);

    const stats = await rag.getSystemStats();
    console.log('📊 DB Stats:', stats.database);

    await rag.shutdown();
    process.exit(0);
  } catch (err) {
    console.error('❌ Ingest hatası:', err);
    process.exit(1);
  }
}

main();


