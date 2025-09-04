#!/usr/bin/env python3
"""
Basit DOT-OCR Test - Hızlı sonuç için
"""

import os
import json
from pathlib import Path

# Proje kök dizinini ekle
import sys
sys.path.insert(0, str(Path(__file__).parent.parent))

from dot_ocr_service import DotOCRService

def quick_test():
    print("🚀 HIZLI DOT-OCR TESTİ")
    print("=" * 40)

    service = DotOCRService()

    # Test görüntüsü
    test_image = "temp/1.png"

    if not os.path.exists(test_image):
        print(f"❌ Test görüntüsü bulunamadı: {test_image}")
        return

    print(f"📷 Test ediliyor: {os.path.basename(test_image)}")

    # Sadece text_only ile hızlı test
    print("⏳ Metin çıkarımı başlatılıyor...")
    result = service.extract_text(test_image, 'text_only')

    if result['success']:
        print("✅ BAŞARILI!")
        print(f"📊 Karakter: {len(result['text'])}")
        print(f"⏱️ Süre: {result['processing_time']:.2f}s")
        print("\n📝 METİN:")
        print("-" * 30)

        # İlk 300 karakteri göster
        preview = result['text'][:300]
        print(preview)

        if len(result['text']) > 300:
            print("...")

        print("-" * 30)

        # JSON dosyasına kaydet
        with open('dot_ocr_result.json', 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
        print("💾 Sonuç kaydedildi: dot_ocr_result.json")

    else:
        print(f"❌ HATA: {result['error']}")

if __name__ == "__main__":
    quick_test()
