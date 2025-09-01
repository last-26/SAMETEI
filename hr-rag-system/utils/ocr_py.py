#!/usr/bin/env python3
import pytesseract
from PIL import Image, ImageEnhance, ImageFilter, ImageOps
import cv2
import numpy as np
from pdf2image import convert_from_path
import sys
import json
import os
from typing import Dict, Any, List, Tuple
import re

class AdvancedOCR:
    def __init__(self, lang="tur+eng", dpi=450):
        self.lang = lang
        self.dpi = dpi
        
    def preprocess_for_colored_background(self, image):
        """Renkli arka plan üzerindeki metinleri iyileştir"""
        # PIL Image'ı numpy array'e çevir
        img_array = np.array(image)
        
        # BGR'ye çevir (OpenCV formatı)
        if len(img_array.shape) == 3:
            img_bgr = cv2.cvtColor(img_array, cv2.COLOR_RGB2BGR)
        else:
            img_bgr = img_array
        
        # HSV renk uzayına çevir
        hsv = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2HSV)
        
        # Farklı renk aralıklarını tespit et
        color_ranges = [
            # Kırmızı (iki aralık - HSV'de kırmızı 0 ve 180 civarında)
            ([0, 50, 50], [10, 255, 255]),
            ([170, 50, 50], [180, 255, 255]),
            # Mavi
            ([100, 50, 50], [130, 255, 255]),
            # Yeşil
            ([40, 50, 50], [80, 255, 255]),
            # Sarı
            ([20, 50, 50], [40, 255, 255]),
        ]
        
        processed_regions = []
        
        for lower, upper in color_ranges:
            lower = np.array(lower)
            upper = np.array(upper)
            
            # Renk maskesi oluştur
            mask = cv2.inRange(hsv, lower, upper)
            
            # Morfolojik işlemler ile temizle
            kernel = np.ones((3, 3), np.uint8)
            mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
            mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
            
            # Konturları bul
            contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            
            for contour in contours:
                area = cv2.contourArea(contour)
                if area > 500:  # Minimum alan filtresi
                    x, y, w, h = cv2.boundingRect(contour)
                    
                    # Bölgeyi kırp
                    roi = img_bgr[y:y+h, x:x+w]
                    
                    # Bu bölgeyi işle
                    processed = self.enhance_text_region(roi)
                    
                    processed_regions.append({
                        'image': processed,
                        'bbox': (x, y, w, h),
                        'is_vertical': h > w * 1.5  # Dikey metin tespiti
                    })
        
        return processed_regions
    
    def enhance_text_region(self, roi):
        """Metin bölgesini iyileştir"""
        # Gri tonlamaya çevir
        if len(roi.shape) == 3:
            gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
        else:
            gray = roi
        
        # CLAHE (Contrast Limited Adaptive Histogram Equalization)
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8,8))
        enhanced = clahe.apply(gray)
        
        # Adaptive threshold
        thresh = cv2.adaptiveThreshold(enhanced, 255, 
                                     cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                     cv2.THRESH_BINARY, 11, 2)
        
        # Tersine çevir (beyaz arka plan, siyah metin)
        inverted = cv2.bitwise_not(thresh)
        
        # Gürültü azaltma
        denoised = cv2.medianBlur(inverted, 3)
        
        return Image.fromarray(denoised)
    
    def detect_and_rotate_vertical_text(self, image):
        """Dikey metinleri tespit et ve döndür"""
        img_array = np.array(image)
        
        if len(img_array.shape) == 3:
            gray = cv2.cvtColor(img_array, cv2.COLOR_RGB2GRAY)
        else:
            gray = img_array
        
        # Kenar tespiti
        edges = cv2.Canny(gray, 50, 150, apertureSize=3)
        
        # Hough Line Transform ile çizgileri tespit et
        lines = cv2.HoughLinesP(edges, 1, np.pi/180, 100, 
                                minLineLength=100, maxLineGap=10)
        
        if lines is not None:
            # Dikey çizgilerin sayısını kontrol et
            vertical_lines = 0
            horizontal_lines = 0
            
            for line in lines:
                x1, y1, x2, y2 = line[0]
                angle = np.abs(np.arctan2(y2 - y1, x2 - x1) * 180 / np.pi)
                
                if 80 <= angle <= 100:  # Dikey çizgi
                    vertical_lines += 1
                elif angle <= 10 or angle >= 170:  # Yatay çizgi
                    horizontal_lines += 1
            
            # Eğer dikey çizgiler baskınsa, görüntüyü döndür
            if vertical_lines > horizontal_lines * 1.5:
                return image.rotate(90, expand=True)
        
        return image
    
    def process_form_structure(self, image):
        """Form yapısını analiz et ve bölgelere ayır"""
        img_array = np.array(image)
        
        if len(img_array.shape) == 3:
            gray = cv2.cvtColor(img_array, cv2.COLOR_RGB2GRAY)
        else:
            gray = img_array
        
        # Kenar tespiti
        edges = cv2.Canny(gray, 30, 100)
        
        # Konturları bul
        contours, _ = cv2.findContours(edges, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
        
        # Dikdörtgen bölgeleri tespit et
        form_regions = []
        for contour in contours:
            peri = cv2.arcLength(contour, True)
            approx = cv2.approxPolyDP(contour, 0.04 * peri, True)
            
            # Dikdörtgen kontrolü
            if len(approx) == 4:
                x, y, w, h = cv2.boundingRect(approx)
                
                # Minimum boyut filtresi
                if w > 50 and h > 20:
                    roi = image.crop((x, y, x + w, y + h))
                    form_regions.append({
                        'region': roi,
                        'bbox': (x, y, w, h),
                        'is_vertical': h > w * 1.5
                    })
        
        return form_regions
    
    def ocr_with_multiple_configs(self, image, is_vertical=False):
        """Farklı konfigürasyonlarla OCR dene"""
        configs = []
        
        if is_vertical:
            # Dikey metin için özel konfigürasyonlar
            configs = [
                f'--oem 3 --psm 5 -l {self.lang}',  # Dikey metin bloğu
                f'--oem 3 --psm 6 -l {self.lang} rotate=90',  # 90 derece döndürülmüş
            ]
            # Görüntüyü döndür ve tekrar dene
            rotated = image.rotate(90, expand=True)
            configs.append(('rotated', f'--oem 3 --psm 11 -l {self.lang}'))
        else:
            # Yatay metin için konfigürasyonlar
            configs = [
                f'--oem 3 --psm 11 -l {self.lang}',  # Sparse text
                f'--oem 3 --psm 6 -l {self.lang}',   # Uniform block
                f'--oem 3 --psm 8 -l {self.lang}',   # Single word
                f'--oem 3 --psm 3 -l {self.lang}',   # Automatic
            ]
        
        best_text = ""
        best_confidence = 0
        
        for config in configs:
            try:
                if isinstance(config, tuple) and config[0] == 'rotated':
                    # Döndürülmüş görüntü için
                    text = pytesseract.image_to_string(rotated, config=config[1])
                    data = pytesseract.image_to_data(rotated, config=config[1], output_type=pytesseract.Output.DICT)
                else:
                    text = pytesseract.image_to_string(image, config=config)
                    data = pytesseract.image_to_data(image, config=config, output_type=pytesseract.Output.DICT)
                
                # Güven skorunu hesapla
                confidences = [int(c) for c in data['conf'] if int(c) > 0]
                avg_confidence = sum(confidences) / len(confidences) if confidences else 0
                
                # En iyi sonucu seç
                if avg_confidence > best_confidence and text.strip():
                    best_text = text
                    best_confidence = avg_confidence
                    
            except Exception:
                continue
        
        return best_text
    
    def clean_turkish_text(self, text):
        """Türkçe karakterleri düzelt ve metni temizle"""
        # Yanlış tanınan Türkçe karakterleri düzelt
        replacements = {
            'i̇': 'i',
            'I': 'ı',  # Büyük I'yı küçük ı olarak düzelt (kontekste göre)
            '6': 'ğ',  # Bazen 6 olarak tanınır
            '§': 'ş',
            '¢': 'ç',
            '0': 'ö',  # Bazen 0 olarak tanınır
            'U': 'ü',  # Bazen U olarak tanınır
        }
        
        # Kelime bazlı düzeltmeler
        word_replacements = {
            'SIRKET1': 'ŞİRKETİ',
            'IZIN': 'İZİN',
            'YILLIK': 'YILLIK',
            'SAGLIK': 'SAĞLIK',
            'DIGER': 'DİĞER',
            'IMZA': 'İMZA',
            'YONETICI': 'YÖNETİCİ',
            'KIRMIZ1': 'KIRMIZI',
            'MAV1': 'MAVİ',
            'YE§IL': 'YEŞİL',
            'SARI': 'SARI',
        }
        
        # Karakterleri düzelt
        for old, new in replacements.items():
            text = text.replace(old, new)
        
        # Kelimeleri düzelt
        for old, new in word_replacements.items():
            text = re.sub(r'\b' + old + r'\b', new, text, flags=re.IGNORECASE)
        
        # Gereksiz karakterleri temizle
        text = re.sub(r'[^\w\s\-\.\,\:\;\!\?\(\)\/\=\+\*\&\%\$\#\@ğüşıöçĞÜŞİÖÇ]', '', text)
        
        # Çoklu boşlukları tek boşluğa indir
        text = re.sub(r'\s+', ' ', text)
        
        return text.strip()

    def ocr_pdf_to_text(self, pdf_path: str) -> Dict[str, Any]:
        """Ana OCR fonksiyonu - geliştirilmiş versiyon"""
        
        # Progress bar'ı sustur
        old_stderr = sys.stderr
        sys.stderr = open(os.devnull, 'w')
        
        try:
            # PDF'i görüntüye çevir (yüksek DPI ile)
            images = convert_from_path(pdf_path, dpi=self.dpi)
        finally:
            sys.stderr = old_stderr
        
        all_texts = []
        
        for page_num, image in enumerate(images, 1):
            page_texts = []
            
            # 1. Form yapısını analiz et
            form_regions = self.process_form_structure(image)
            
            # 2. Renkli arka planlı bölgeleri işle
            colored_regions = self.preprocess_for_colored_background(image)
            
            # 3. Her renkli bölge için OCR
            for region_info in colored_regions:
                region_img = region_info['image']
                is_vertical = region_info['is_vertical']
                
                # Dikey metinleri özel olarak işle
                if is_vertical:
                    text = self.ocr_with_multiple_configs(region_img, is_vertical=True)
                else:
                    text = self.ocr_with_multiple_configs(region_img, is_vertical=False)
                
                if text.strip():
                    # Türkçe karakterleri düzelt
                    text = self.clean_turkish_text(text)
                    page_texts.append(text)
            
            # 4. Form bölgelerini işle (renkli olmayan alanlar)
            for region_info in form_regions:
                region = region_info['region']
                is_vertical = region_info['is_vertical']
                
                # Görüntüyü iyileştir
                enhancer = ImageEnhance.Contrast(region)
                region = enhancer.enhance(2.0)
                
                # OCR uygula
                text = self.ocr_with_multiple_configs(region, is_vertical=is_vertical)
                
                if text.strip():
                    text = self.clean_turkish_text(text)
                    page_texts.append(text)
            
            # 5. Eğer bölgesel OCR başarısız olduysa, tüm sayfayı dene
            if not page_texts:
                # Görüntüyü ön işle
                enhanced = self.enhance_entire_page(image)
                
                # Farklı PSM modlarıyla dene
                for psm in [11, 6, 3, 4, 12]:
                    config = f'--oem 3 --psm {psm} -l {self.lang}'
                    text = pytesseract.image_to_string(enhanced, config=config)
                    
                    if text.strip():
                        text = self.clean_turkish_text(text)
                        page_texts.append(text)
                        break
            
            # Sayfa metnini birleştir
            if page_texts:
                # Metinleri mantıklı bir sırada birleştir
                page_content = self.organize_page_content(page_texts)
                all_texts.append(f"=== SAYFA {page_num} ===\n{page_content}")
            else:
                all_texts.append(f"=== SAYFA {page_num} ===\n[Metin okunamadı]")
        
        full_text = "\n\n".join(all_texts)
        
        # Son temizlik ve düzeltmeler
        full_text = self.post_process_text(full_text)
        
        return {
            "success": True,
            "text": full_text,
            "total_pages": len(images)
        }
    
    def enhance_entire_page(self, image):
        """Tüm sayfayı iyileştir"""
        # Numpy array'e çevir
        img_array = np.array(image)
        
        # Gri tonlamaya çevir
        if len(img_array.shape) == 3:
            gray = cv2.cvtColor(img_array, cv2.COLOR_RGB2GRAY)
        else:
            gray = img_array
        
        # Denoise
        denoised = cv2.fastNlMeansDenoising(gray, None, 10, 7, 21)
        
        # Sharpen
        kernel = np.array([[-1,-1,-1],
                          [-1, 9,-1],
                          [-1,-1,-1]])
        sharpened = cv2.filter2D(denoised, -1, kernel)
        
        # CLAHE
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8,8))
        enhanced = clahe.apply(sharpened)
        
        # Binary threshold
        _, binary = cv2.threshold(enhanced, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        
        return Image.fromarray(binary)
    
    def organize_page_content(self, texts):
        """Sayfa içeriğini organize et"""
        # Boş olmayan metinleri filtrele
        valid_texts = [t for t in texts if t.strip()]
        
        # Form alanlarını tespit et
        organized = []
        
        for text in valid_texts:
            # Tek kelimelik renkli alanları tespit et (KIRMIZI, MAVİ, vb.)
            if len(text.split()) == 1 and text.upper() in ['KIRMIZI', 'MAVİ', 'YEŞİL', 'SARI']:
                organized.append(f"[RENK ETİKETİ: {text.upper()}]")
            else:
                organized.append(text)
        
        return "\n".join(organized)
    
    def post_process_text(self, text):
        """Son işleme ve düzeltmeler"""
        # Form yapısını düzenle
        text = text.replace("PersonelNo", "Personel No.")
        text = text.replace("Ad soya", "Ad Soyadı")
        text = text.replace("Izin Turi", "İzin Türü")
        text = text.replace("Yillik Izin", "Yıllık İzin")
        text = text.replace("Mazeret Izni", "Mazeret İzni")
        text = text.replace("Saglik Izni", "Sağlık İzni")
        text = text.replace("Diger", "Diğer")
        text = text.replace("Imza", "İmza")
        text = text.replace("Yönetici", "Yönetici")
        
        # Tarih formatlarını düzelt
        text = re.sub(r'(\d+)\s*/\s*(\d+)\s*/\s*(\d+)', r'\1/\2/\3', text)
        
        # Çoklu boşlukları ve satır sonlarını düzenle
        text = re.sub(r'\n{3,}', '\n\n', text)
        text = re.sub(r' {2,}', ' ', text)
        
        return text.strip()

def main():
    try:
        # UTF-8 encoding
        import io
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
        
        if len(sys.argv) < 2:
            print(json.dumps({"success": False, "error": "PDF dosya yolu gerekli"}))
            return
        
        pdf_path = sys.argv[1]
        lang = os.environ.get("TESSERACT_LANG", "tur+eng")
        dpi = int(os.environ.get("OCR_DPI", "450"))
        
        if not os.path.exists(pdf_path):
            print(json.dumps({"success": False, "error": f"Dosya bulunamadı: {pdf_path}"}))
            return
        
        # Advanced OCR sınıfını kullan
        ocr = AdvancedOCR(lang=lang, dpi=dpi)
        result = ocr.ocr_pdf_to_text(pdf_path)
        
        print(json.dumps(result, ensure_ascii=False))
        
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))

if __name__ == "__main__":
    main()