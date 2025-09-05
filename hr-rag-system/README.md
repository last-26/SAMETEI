# SAMETEI HR-RAG System

🤖 LibreChat entegrasyonu ile çalışan, HR prosedürleri odaklı RAG + Görsel OCR sistemi

## 🎯 Kısa Özellik Özeti (Güncel)
- **RAG**: HR dokümanları için bağlamlı yanıtlar (MongoDB vektör arama)
- **OCR**: Qwen2.5‑VL‑3B‑Instruct tabanlı gelişmiş görsel OCR
  - Dikey metin için otomatik 90° düzeltme (varsayılan: CV)
  - Tablo/Metin/Form moda göre çıktıyı doğru formatta üretme
  - Tablo modunda çift aşama: grid-dışı notlar + yalnız tablo (TSV/MD/JSON)
  - Yinelenen satır ve etiketlerin otomatik temizlenmesi
- **Fallbacklar**: OpenRouter Vision ve Tesseract (isteğe bağlı)
- **LibreChat**: Uyumlu özel endpoint ve basit kullanım

## 🚀 Hızlı Başlangıç

```bash
cd hr-rag-system
npm install
pip install -r requirements.txt
```

### ENV (önerilen .env)
```env
# Model
QWEN_MODEL_ID=Qwen/Qwen2.5-VL-3B-Instruct
QWEN_LOCAL_FILES_ONLY=1

# Görüntü çözünürlüğü
OCR_MIN_PIXELS=501760
OCR_MAX_PIXELS=802816

# Rotasyon (hız için CV varsayılan)
OCR_ROTATION_MODE=cv        # off|cv|vlm|hybrid
OCR_ROTATION_PROBE=0
OCR_ROTATE_MARGIN=0.12
OCR_PREPROCESS_ENABLED=1

# Token sınırları
OCR_MAIN_MAXTOK=1200
OCR_NOTES_MAXTOK=1200
OCR_TABLE_MAXTOK=1200
OCR_FOCUS_MAXTOK=200

# Opsiyonel: İmza odaklı ekstra tarama (gerekmedikçe 0)
OCR_ENABLE_SIGNATURE_PROBE=0
```

### Qwen OCR Sunucusu
```bash
python qwen_ocr_server.py
# Sağlık: http://localhost:8000/health
```

### Testler
```bash
# Görseli otomatik tanı ve uygun formatta çıkar
node test-qwen.js temp/1.png auto --output=text

# Tablo + notlar (üst/alt başlıklar ardından yalnız tablo)
node test-qwen.js temp/3.png table_text_with_notes

# Yalnız tablo (TSV)
node test-qwen.js temp/3.png table_text_tsv
```

## 🔌 API (LibreChat Uyumlu)
- RAG ve özel OCR akışlarını `http://localhost:3001` üstünden kullanın.
- `config.js` içinde OpenRouter ve RAG ayarları mevcuttur.

## 🧠 OCR Çalışma Mantığı (Özet)
- `strategy` değerine göre prompt ve çıktı tipi ayarlanır: `text | table | form | key_value | auto`.
- Tablo modunda sistem:
  1) Grid‑dışı notları (başlık/alt not) çıkarır ve temizler
  2) Yalnız tabloyu TSV/Markdown/JSON olarak üretir ve birleştirir
- Dikey yazılarda 90° otomatik düzeltme (CV), heuristiklerle güvenli karar
- Yinelenen satırlar/etiketler normalize edilerek elenir

## ⚙️ Sık Ayarlar
- `OCR_ROTATION_MODE`: off|cv|vlm|hybrid (varsayılan: cv)
- `OCR_*_MAXTOK`: ana/nota/tablo için token limitleri
- `OCR_ENABLE_SIGNATURE_PROBE`: İmza kelimeleri yoksa hedefli ek tarama (varsayılan kapalı)

## 📦 Betikler
- `npm run ingest`: `data/procedures` içeriğini vektörle ve yükle
- `scripts/preprocessing/` basit görüntü iyileştirme araçları

## 📈 Notlar
- Büyük görsellerde süreyi azaltmak için `OCR_MAX_PIXELS` değerini düşürebilirsiniz.
- Tablo başlığı eksikse sistem hızlı bir başlık PASS’ı ile TSV başlığını eklemeye çalışır.

---

Güncel sistem: Qwen2.5‑VL OCR ana akış, üstüne RAG; LibreChat ile direkt kullanılabilir. İhtiyaca göre prompt/çıktı tipini `strategy/output` parametreleriyle seçin.
