#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Geliştirilmiş OCR Sistemi - Basit ve Etkili
Türkçe optimizasyonu ile
"""

import os
import sys
import json
import re
import gc
import cv2
import numpy as np
from PIL import Image
import pytesseract
from pdf2image import convert_from_path
import logging

# Logging ayarları
logging.basicConfig(level=logging.INFO, format='%(message)s', stream=sys.stderr)
logger = logging.getLogger(__name__)

class SmartOCR:
    """Akıllı OCR sınıfı - basit ve etkili"""
    
    def __init__(self, lang='tur+eng', dpi=300):
        self.lang = lang
        self.dpi = min(dpi, 450)  # Maksimum DPI sınırı
        self.setup_tesseract()
        
        # Türkçe kelime düzeltmeleri
        self.turkish_fixes = {
            # OCR'da sık karışan kelimeler
            'Tanhi': 'Tarihi', 'tanhi': 'tarihi', 'Tarth': 'Tarih',
            'Yen': 'Yeri', 'yen': 'yeri', 'Ginş': 'Giriş', 'ginş': 'giriş',
            'Toni': 'Türü', 'toni': 'türü', 'Türü': 'Türü',
            'Binmi': 'Birimi', 'binmi': 'birimi',
            'Baslama': 'Başlama', 'baslama': 'başlama',
            'edenm': 'ederim', 'Edenm': 'Ederim',
            'Numarasi': 'Numarası', 'numarasi': 'numarası',
            'Kirmlik': 'Kimlik', 'kirmlik': 'kimlik',
            'izntn': 'iznin', 'İzntn': 'İznin',
            'belirtiğim': 'belirttiğim', 'belirtigim': 'belirttiğim',
            'tanhler': 'tarihler', 'Tanhler': 'Tarihler',
            'ORAYI': 'ONAYI', 'orayi': 'onayı',
            'İşveran': 'İşveren', 'işveran': 'işveren',
            'Adi': 'Adı', 'adi': 'adı',
            'imza': 'İmza'
        }
    
    def setup_tesseract(self):
        """Tesseract yolunu ayarla"""
        if os.name == 'nt':  # Windows
            tesseract_paths = [
                os.environ.get('TESSERACT_PATH'),
                r'C:\Program Files\Tesseract-OCR\tesseract.exe',
                r'C:\Users\{}\AppData\Local\Tesseract-OCR\tesseract.exe'.format(os.getenv('USERNAME', '')),
                r'D:\Program Files\Tesseract-OCR\tesseract.exe'
            ]
            
            for path in tesseract_paths:
                if path and os.path.exists(path):
                    pytesseract.pytesseract.tesseract_cmd = path
                    logger.info(f"✅ Tesseract bulundu: {path}")
                    return
            
            logger.warning("⚠️ Tesseract yolu bulunamadı, sistem PATH'i kullanılacak")
    
    def preprocess_image(self, image):
        """Basit görüntü ön işleme"""
        try:
            # PIL -> OpenCV
            img_array = np.array(image)
            if len(img_array.shape) == 3:
                img = cv2.cvtColor(img_array, cv2.COLOR_RGB2BGR)
            else:
                img = cv2.cvtColor(img_array, cv2.COLOR_GRAY2BGR)
            
            # Boyut kontrolü
            h, w = img.shape[:2]
            if max(h, w) > 2500:
                scale = 2500 / max(h, w)
                new_w, new_h = int(w * scale), int(h * scale)
                img = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_LANCZOS4)
            
            # Gri tonlama
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            
            # Kontrast artırma
            enhanced = cv2.convertScaleAbs(gray, alpha=1.3, beta=15)
            
            # Adaptive threshold
            binary = cv2.adaptiveThreshold(
                enhanced, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, 
                cv2.THRESH_BINARY, 11, 2
            )
            
            return Image.fromarray(binary)
            
        except Exception as e:
            logger.error(f"❌ Ön işleme hatası: {e}")
            return image
    
    def is_table_like(self, image):
        """Basit tablo algılama"""
        try:
            img_array = np.array(image)
            
            # Yatay çizgileri algıla
            horizontal_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (50, 1))
            horizontal_lines = cv2.morphologyEx(img_array, cv2.MORPH_OPEN, horizontal_kernel)
            
            # Dikey çizgileri algıla
            vertical_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, 50))
            vertical_lines = cv2.morphologyEx(img_array, cv2.MORPH_OPEN, vertical_kernel)
            
            # Çizgi yoğunluğu
            h_density = np.sum(horizontal_lines > 0) / horizontal_lines.size
            v_density = np.sum(vertical_lines > 0) / vertical_lines.size
            
            # Güçlü tablo sinyali gerekli
            is_table = (h_density > 0.05 and v_density > 0.05)
            
            if is_table:
                logger.info(f"📋 Güçlü tablo algılandı (H:{h_density:.3f}, V:{v_density:.3f})")
            else:
                logger.info(f"📄 Normal döküman (H:{h_density:.3f}, V:{v_density:.3f})")
            
            return is_table
            
        except Exception as e:
            logger.error(f"❌ Tablo algılama hatası: {e}")
            return False
    
    def smart_ocr(self, image):
        """Akıllı OCR - çoklu yaklaşım"""
        try:
            # Farklı OCR konfigürasyonları
            configs = [
                '--psm 4 --oem 1',  # Single column
                '--psm 6 --oem 1',  # Single uniform block
                '--psm 3 --oem 1',  # Fully automatic
                '--psm 1 --oem 1'   # Auto with OSD
            ]
            
            best_text = ""
            best_score = 0
            
            for i, config in enumerate(configs):
                try:
                    logger.info(f"  📝 OCR denemesi {i+1}/{len(configs)}")
                    
                    text = pytesseract.image_to_string(
                        image, lang=self.lang, config=config
                    ).strip()
                    
                    if text and len(text) > 5:
                        # Basit kalite skoru
                        cleaned_text = self.clean_text(text)
                        word_count = len(cleaned_text.split())
                        char_count = len(cleaned_text)
                        unique_words = len(set(cleaned_text.lower().split()))
                        
                        if word_count > 0:
                            diversity = unique_words / word_count
                            score = char_count * diversity * 0.5 + word_count * 2
                            
                            if score > best_score:
                                best_score = score
                                best_text = cleaned_text
                                logger.info(f"    ✅ Yeni en iyi skor: {score:.1f}")
                        
                except Exception as e:
                    logger.info(f"    ❌ Config {i+1} başarısız: {e}")
                    continue
            
            return best_text
            
        except Exception as e:
            logger.error(f"❌ OCR hatası: {e}")
            return ""
    
    def clean_text(self, text):
        """Türkçe metin temizleme"""
        if not text:
            return ""
        
        # Türkçe kelime düzeltmeleri
        for old, new in self.turkish_fixes.items():
            text = text.replace(old, new)
        
        # Tarih düzeltmeleri - daha kapsamlı
        text = re.sub(r'O(\d)', r'0\1', text)  # O2 -> 02
        text = re.sub(r'(\d)O', r'\g<1>0', text)  # 2O -> 20
        text = re.sub(r'(\d{2})\s+O(\d)', r'\1.0\2', text)  # 02 O1 -> 02.01
        text = re.sub(r'(\d{2})\s+(\d{2})\s+(\d{4})', r'\1.\2.\3', text)  # 02 01 2020 -> 02.01.2020
        
        # Tarih formatında I harfi düzeltmeleri (OCR'da 1 rakamı I olarak okunuyor)
        text = re.sub(r'(\d{2})\s+I(\d)', r'\1.0\2', text)  # 02 I1 -> 02.01
        text = re.sub(r'(\d{2})\s+(\d{2})\s+I(\d{4})', r'\1.\2.0\3', text)  # 02 01 I2020 -> 02.01.02020
        text = re.sub(r'(\d{2})\s+I(\d)\s+(\d{4})', r'\1.0\2.\3', text)  # 02 I1 2020 -> 02.01.2020
        
        # T.C düzeltmeleri - daha kapsamlı
        text = re.sub(r'T\s*Ç', 'T.C', text)  # T Ç -> T.C
        text = re.sub(r'T\s*C(?!\w)', 'T.C', text)  # T C -> T.C
        text = re.sub(r'T\s*Ç(?!\w)', 'T.C', text)  # T Ç -> T.C
        text = re.sub(r'T\.Ç', 'T.C', text)  # T.Ç -> T.C
        
        # Geçersiz karakterleri temizle
        text = re.sub(r'[^\w\sğüşıöçĞÜŞİÖÇ.,!?:;()\-=|/]', ' ', text)
        
        # Çoklu boşlukları düzelt
        text = re.sub(r'\s+', ' ', text)
        
        # Form düzeltmeleri
        text = text.replace('T C', 'T.C.')
        text = text.replace('TC', 'T.C.')
        
        # Anlamsız tekrarları filtrele
        words = []
        for word in text.split():
            word = word.strip('.,!?:;()-')
            # Anlamlı kelimeler
            if (len(word) >= 2 and 
                not re.match(r'^[A-Z]{1,2}$', word) and
                not re.match(r'^[.,-]+$', word) and
                word not in ['KE', 'Te', 'Ke', 'TE', 'ke', 'te']):
                words.append(word)
        
        result = ' '.join(words).strip()
        
        # Son temizlik
        result = re.sub(r'\n{3,}', '\n\n', result)
        result = re.sub(r' {2,}', ' ', result)
        
        return result
    
    def ocr_pdf(self, pdf_path):
        """PDF'yi OCR ile işle - basit yaklaşım"""
        try:
            logger.info(f"📄 PDF işleniyor: {os.path.basename(pdf_path)}")
            
            # PDF'yi görüntülere çevir
            try:
                images = convert_from_path(
                    pdf_path,
                    dpi=self.dpi,
                    thread_count=1
                )
            except Exception as e:
                logger.error(f"❌ PDF dönüştürme hatası: {e}")
                return {
                    "success": False,
                    "error": f"PDF dönüştürme hatası: {str(e)}",
                    "text": ""
                }
            
            logger.info(f"📊 {len(images)} sayfa bulundu")
            
            all_pages = []
            
            for page_num, image in enumerate(images, 1):
                logger.info(f"📄 Sayfa {page_num}/{len(images)} işleniyor...")
                
                try:
                    # Görüntüyü ön işle
                    processed_img = self.preprocess_image(image)
                    
                    # Tablo algılama (basit)
                    is_table = self.is_table_like(processed_img)
                    
                    # OCR yap
                    page_text = self.smart_ocr(processed_img)
                    
                    if page_text:
                        # Sayfa başlığı ekle
                        page_content = f"=== SAYFA {page_num} ===\n{page_text}"
                        all_pages.append(page_content)
                        logger.info(f"✅ Sayfa {page_num}: {len(page_text)} karakter")
                    else:
                        logger.warning(f"⚠️ Sayfa {page_num}: Metin bulunamadı")
                
                except Exception as e:
                    logger.error(f"❌ Sayfa {page_num} hatası: {e}")
                    continue
                finally:
                    # Memory temizliği
                    del image
                    gc.collect()
            
            # Final metin
            final_text = "\n\n".join(all_pages)
            
            logger.info(f"🎉 OCR tamamlandı: {len(final_text)} karakter")
            
            return {
                "success": True,
                "text": final_text,
                "pages": len(images),
                "character_count": len(final_text)
            }
            
        except Exception as e:
            logger.error(f"❌ OCR genel hatası: {e}")
            return {
                "success": False,
                "error": str(e),
                "text": ""
            }
        finally:
            gc.collect()

def main():
    """Ana fonksiyon"""
    try:
        # UTF-8 encoding
        import io
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
        
        if len(sys.argv) < 2:
            result = {"success": False, "error": "PDF dosya yolu gerekli"}
            print(json.dumps(result, ensure_ascii=False))
            return
        
        pdf_path = sys.argv[1]
        
        if not os.path.exists(pdf_path):
            result = {"success": False, "error": f"Dosya bulunamadı: {pdf_path}"}
            print(json.dumps(result, ensure_ascii=False))
            return
        
        # OCR ayarları
        lang = os.environ.get("TESSERACT_LANG", "tur+eng")
        dpi = int(os.environ.get("OCR_DPI", "300"))
        
        logger.info(f"🚀 Akıllı OCR başlatılıyor (lang={lang}, dpi={dpi})")
        
        # OCR işlemi
        ocr = SmartOCR(lang=lang, dpi=dpi)
        result = ocr.ocr_pdf(pdf_path)
        
        # Sonucu yazdır
        print(json.dumps(result, ensure_ascii=False))
        
    except Exception as e:
        result = {"success": False, "error": str(e)}
        print(json.dumps(result, ensure_ascii=False))

if __name__ == "__main__":
    main()