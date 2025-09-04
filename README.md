<p align="center">
  <img src="client/public/assets/Sametei.jpg" height="160" alt="SAMETEI">
</p>

# SAMETEI

LibreChat tabanlı, çok sağlayıcılı sohbet arayüzü ve İnsan Kaynakları odaklı bir örnek RAG (Retrieval-Augmented Generation) çalışma alanını bir araya getiren uygulama.

## Özellikler
- Çoklu LLM sağlayıcı entegrasyonu (OpenAI uyumlu uçlar, yerel/uzak modeller)
- Modern React/TypeScript istemci (LibreChat UI)
- Node.js tabanlı API ve servisler
- HR belgeleriyle örnek RAG akışı (`hr-rag-system/`)
- Docker ile yerel/production çalıştırma seçenekleri

## Gereksinimler
- Node.js 18+
- npm 9+ veya pnpm/yarn
- Opsiyonel: Docker ve Docker Compose
- Opsiyonel: MongoDB (lokal ya da Docker üzerinden)

## Kurulum
1. Depoyu klonlayın veya proje klasörüne geçin.
2. Bağımlılıkları kurun:
   - Kökten hepsi: `npm run setup` (varsa) veya `npm install --workspaces`
   - Ya da ayrı ayrı: `cd api && npm install`, `cd client && npm install`
3. Ortam değişkenlerini hazırlayın:
   - Kökteki `librechat.yaml` ve ilgili `.env` örneklerini inceleyip kendi anahtarlarınızı ekleyin.
   - Gerekirse `config/` betikleriyle ilk kurulum yardımcılarını kullanın.
4. Geliştirme modunda başlatın:
   - API: `npm run dev` (api klasöründe)
   - İstemci: `npm run dev` (client klasöründe)

## Docker ile Çalıştırma
- Hızlı başlatma: `docker-compose up -d`
- Çoklu servis/otel ayarları için `docker-compose.override.yml` dosyalarını gözden geçirin.

## RAG (hr-rag-system)
- `hr-rag-system/` klasöründe örnek bir HR prosedürleri veri kümesi ve Node.js betikleri bulunur.
- Başlıca adımlar:
  - Gerekli paketleri kurun: `cd hr-rag-system && npm install`
  - Gerekirse MongoDB bağlantısını `config.js` içinde uyarlayın.
  - Veri yükleme: `node scripts/load.js` (veya ilgili betikler)
  - Sunucu: `node api-server.js`

## Kullanışlı Komutlar
```bash
# Kökten
npm run build           # üretim derlemesi
npm run dev             # geliştirme modunda başlatma (monorepo değilse klasörlere girin)

# API/Client içinden
npm run lint
npm test
```

## Sorun Giderme
- Bağımlılık hataları: `node_modules` klasörlerini ve kilit dosyalarını (npm/yarn/pnpm) temizleyip yeniden kurun.
- Docker port çakışmaları: `docker-compose.yml` içindeki portları değiştirin.
- Kimlik doğrulama/LLM erişimi: `.env` ve `librechat.yaml` anahtarlarını kontrol edin.

## Lisans
Bu proje, temel aldığı açık kaynak bileşenlerin lisanslarına saygı gösterir. Ayrıntılar için ilgili klasörlerdeki lisans/metin dosyalarına bakın.