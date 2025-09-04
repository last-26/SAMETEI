#!/usr/bin/env python3
"""
DOT-OCR Basit Test Dosyası
Python servis modülünü test etmek için kullanılır
"""

import os
import sys
import json
from pathlib import Path

# Proje kök dizinini ekle
sys.path.insert(0, str(Path(__file__).parent.parent))
sys.path.insert(0, str(Path(__file__).parent))

from dot_ocr_service import DotOCRService

def test_basic_ocr():
    """Temel OCR testi"""
    print("=" * 50)
    print("🧪 DOT-OCR PYTHON BASİT TEST")
    print("=" * 50)

    # Servis başlat
    service = DotOCRService()

    # Test görüntülerini kontrol et
    test_images = [
        "../temp/1.png",
        "../temp/2.png",
        "../temp/3.PNG",
        "../temp/4.png",
        "../temp/rapor2.png",
        "../temp/test_image.png",
        "../data/procedures/1.png"
    ]

    for image_path in test_images:
        if os.path.exists(image_path):
            print(f"\n📷 Test ediliyor: {os.path.basename(image_path)}")

            try:
                # Farklı çıkarım türlerini test et
                extraction_types = ['table_text_tsv', 'text_only', 'form']

                for ext_type in extraction_types:
                    print(f"\n🔍 Test ediliyor ({ext_type}): {os.path.basename(image_path)}")
                    result = service.extract_text(image_path, ext_type)

                    if result['success']:
                        print("✅ Başarılı!")
                        print(f"📊 Karakter sayısı: {len(result['text'])}")
                        print(".2f")
                        print(f"🎯 Cihaz: {result['device']}")
                        print(f"📋 Çıkarım türü: {result['extraction_type']}")
                        print("\n📝 İLK 300 KARAKTER:")
                        print("-" * 40)
                        text_preview = result['text'][:300].replace('\n', ' | ')
                        print(text_preview + ("..." if len(result['text']) > 300 else ""))
                        print("-" * 40)
                        print(f"✅ {os.path.basename(image_path)} - {ext_type} başarılı!")
                        return  # İlk başarılı testi göster ve çık
                    else:
                        print(f"❌ {ext_type} başarısız: {result['error']}")

            except Exception as e:
                print(f"❌ Hata: {str(e)}")
        else:
            print(f"⚠️ Görüntü bulunamadı: {image_path}")

def test_extraction_types():
    """Farklı çıkarım türlerini test et"""
    print("\n" + "=" * 50)
    print("🔄 DOT-OCR ÇIKARIM TÜRLERİ TESTİ")
    print("=" * 50)

    service = DotOCRService()
    test_image = "../temp/rapor2.png"

    if not os.path.exists(test_image):
        print("⚠️ Test görüntüsü bulunamadı, atlanıyor")
        return

    extraction_types = ['table_text_tsv', 'form', 'text_only', 'structured']

    for ext_type in extraction_types:
        print(f"\n🔍 Test ediliyor: {ext_type}")
        try:
            result = service.extract_text(test_image, ext_type)
            if result['success']:
                print(f"✅ {ext_type}: {len(result['text'])} karakter")
            else:
                print(f"❌ {ext_type}: {result['error']}")
        except Exception as e:
            print(f"❌ {ext_type} hatası: {str(e)}")

def test_service_initialization():
    """Servis başlatma testi"""
    print("\n" + "=" * 50)
    print("🚀 DOT-OCR SERVİS BAŞLATMA TESTİ")
    print("=" * 50)

    try:
        service = DotOCRService()
        success = service.initialize_model()

        if success:
            print("✅ Servis başarıyla başlatıldı")
            print(f"📍 Cihaz: {service.device}")
            print(f"🎯 Model hazır: {service.is_initialized}")
        else:
            print("❌ Servis başlatılamadı")

    except Exception as e:
        print(f"❌ Başlatma hatası: {str(e)}")

def main():
    """Ana test fonksiyonu"""
    print("🚀 DOT-OCR PYTHON TESTLERİ BAŞLATILIYOR...")

    try:
        # Servis başlatma testi
        test_service_initialization()

        # Temel OCR testi
        test_basic_ocr()

        # Çıkarım türleri testi
        test_extraction_types()

        print("\n" + "=" * 50)
        print("✅ TÜM PYTHON TESTLERİ TAMAMLANDI")
        print("=" * 50)

    except Exception as e:
        print(f"❌ Genel hata: {str(e)}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    main()
