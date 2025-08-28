#!/usr/bin/env python3
import cv2
import numpy as np
import pytesseract
from PIL import Image
from pdf2image import convert_from_path
import sys
import json
import os
from typing import Dict, Any


def deskew_image(image):
    """Eğrilik düzeltme"""
    coords = np.column_stack(np.where(image > 0))
    if len(coords) == 0:
        return image
    angle = cv2.minAreaRect(coords)[-1]
    if angle < -45:
        angle = -(90 + angle)
    else:
        angle = -angle
    (h, w) = image.shape[:2]
    center = (w // 2, h // 2)
    M = cv2.getRotationMatrix2D(center, angle, 1.0)
    rotated = cv2.warpAffine(image, M, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    return rotated


def remove_form_lines(image):
    """Form çizgilerini kaldırma"""
    # Yatay çizgileri kaldır
    horizontal_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (40, 1))
    detect_horizontal = cv2.morphologyEx(image, cv2.MORPH_OPEN, horizontal_kernel, iterations=2)
    cnts = cv2.findContours(detect_horizontal, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cnts = cnts[0] if len(cnts) == 2 else cnts[1]
    for c in cnts:
        cv2.drawContours(image, [c], -1, (255, 255, 255), 2)
    
    # Dikey çizgileri kaldır
    vertical_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, 40))
    detect_vertical = cv2.morphologyEx(image, cv2.MORPH_OPEN, vertical_kernel, iterations=2)
    cnts = cv2.findContours(detect_vertical, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cnts = cnts[0] if len(cnts) == 2 else cnts[1]
    for c in cnts:
        cv2.drawContours(image, [c], -1, (255, 255, 255), 2)
    
    return image


def preprocess_image_for_ocr(pil_image):
    """Form görüntüsü için geliştirilmiş ön işleme"""
    # PIL'den OpenCV'ye dönüştür
    img = np.array(pil_image)
    
    # Gri tonlamaya çevir
    if len(img.shape) == 3:
        gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
    else:
        gray = img
    
    # OSD ile rotasyon tespiti (opsiyonel)
    try:
        osd = pytesseract.image_to_osd(gray)
        if 'Rotate: 90' in osd:
            gray = cv2.rotate(gray, cv2.ROTATE_90_COUNTERCLOCKWISE)
        elif 'Rotate: 180' in osd:
            gray = cv2.rotate(gray, cv2.ROTATE_180)
        elif 'Rotate: 270' in osd:
            gray = cv2.rotate(gray, cv2.ROTATE_90_CLOCKWISE)
    except:
        pass
    
    # Eğrilik düzeltme
    gray = deskew_image(gray)
    
    # Form çizgilerini kaldır (opsiyonel - bazen metni de etkileyebilir)
    # gray = remove_form_lines(gray)
    
    # Unsharp masking (keskinleştirme)
    gaussian = cv2.GaussianBlur(gray, (0, 0), 2.0)
    unsharp = cv2.addWeighted(gray, 1.5, gaussian, -0.5, 0)
    
    # CLAHE (Contrast Limited Adaptive Histogram Equalization)
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(12, 12))
    enhanced = clahe.apply(unsharp)
    
    # Bilateral filter - kenarları koruyarak gürültü azaltma
    bilateral = cv2.bilateralFilter(enhanced, 9, 75, 75)
    
    # Adaptif threshold - form metinleri için
    binary = cv2.adaptiveThreshold(bilateral, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, 
                                  cv2.THRESH_BINARY, 31, 11)
    
    # Karakter kalınlaştırma (form metni için)
    kernel = np.ones((2, 2), np.uint8)
    dilated = cv2.dilate(binary, kernel, iterations=1)
    
    # Morfolojik temizlik
    cleaned = cv2.morphologyEx(dilated, cv2.MORPH_CLOSE, np.ones((2, 2), np.uint8))
    cleaned = cv2.morphologyEx(cleaned, cv2.MORPH_OPEN, np.ones((1, 1), np.uint8))
    
    return Image.fromarray(cleaned)


def post_process_text(text):
    """OCR sonrası metin düzeltmeleri"""
    if not text:
        return text
    
    # Yaygın OCR hatalarını düzelt
    replacements = {
        '|': 'I',
        'l': 'I',  # Küçük L -> büyük i
        '0': 'O',  # Sıfır-O karışması (kontekse göre)
        'ı̇': 'i',
        'l̇': 'i',
        'š': 'ş',
        'ž': 'ğ',
        'ð': 'ğ',
        'ý': 'ı',
        'þ': 'ş',
        'ç': 'ç',
        'ö': 'ö',
        'ü': 'ü',
    }
    
    for old, new in replacements.items():
        text = text.replace(old, new)
    
    # Çoklu boşlukları temizle
    text = ' '.join(text.split())
    
    # Form alanı düzeltmeleri
    form_corrections = {
        r'PersoneI\s*No': 'Personel No',
        r'Ad\s+Soyad[iı]': 'Ad Soyadı',
        r'[İi]zin\s+Ba[şs]Iang[ıi][çc]': 'İzin Başlangıç',
        r'[İi]zin\s+Biti[şs]': 'İzin Bitiş',
        r'YIII[ıi]k\s+[İi]zin': 'Yıllık İzin',
        r'Departman': 'Departman',
    }
    
    import re
    for pattern, replacement in form_corrections.items():
        text = re.sub(pattern, replacement, text, flags=re.IGNORECASE)
    
    return text.strip()


def ocr_pdf_to_text(pdf_path: str, lang: str = "tur+eng", dpi: int = 450) -> Dict[str, Any]:
    """PDF'den metin çıkarma - form optimizasyonlu"""
    
    # PDF'i yüksek çözünürlükte görüntülere dönüştür
    images = convert_from_path(pdf_path, dpi=dpi, fmt="PNG")
    texts = []
    
    for page_num, im in enumerate(images, 1):
        # Görüntü ön işleme
        processed = preprocess_image_for_ocr(im)
        
        # Tesseract konfigürasyonu - form için optimize
        cfg_base = f"--oem 3 -l {lang}"
        cfg_base += " -c preserve_interword_spaces=1"
        cfg_base += " -c tessedit_char_whitelist='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzÇĞİÖŞÜçğıöşü .-/:()[]'"
        
        candidates = []
        # Form için en uygun PSM modları (sıralama önemli)
        psm_modes = [
            11,  # Sparse text - formlar için en iyi
            13,  # Raw line - form satırları için
            6,   # Uniform block
            4,   # Single column
            3,   # Automatic
        ]
        
        for psm in psm_modes:
            try:
                config = cfg_base + f' --psm {psm}'
                text = pytesseract.image_to_string(processed, config=config)
                
                if text.strip():
                    # Confidence score ile birlikte sakla
                    try:
                        data = pytesseract.image_to_data(processed, config=config, output_type=pytesseract.Output.DICT)
                        confidences = [int(c) for c in data['conf'] if int(c) > 0]
                        avg_conf = sum(confidences) / len(confidences) if confidences else 0
                    except:
                        avg_conf = 50  # Varsayılan confidence
                    
                    candidates.append({
                        'text': text,
                        'psm': psm,
                        'confidence': avg_conf,
                        'length': len(text.strip())
                    })
            except Exception as e:
                continue
        
        # En iyi sonucu seç (confidence ve uzunluk dengesi)
        if candidates:
            # Confidence ve uzunluğa göre skorlama
            for c in candidates:
                c['score'] = (c['confidence'] / 100) * 0.6 + min(c['length'] / 500, 1.0) * 0.4
            
            best = max(candidates, key=lambda x: x['score'])
            processed_text = post_process_text(best['text'])
            
            if processed_text:
                texts.append(f"=== SAYFA {page_num} (PSM {best['psm']}, Confidence: {best['confidence']:.1f}%) ===\n{processed_text}")
        else:
            texts.append(f"=== SAYFA {page_num} ===\n[Metin okunamadı]")
    
    full_text = "\n\n".join(texts)
    
    return {
        "success": True,
        "text": full_text,
        "total_pages": len(images)
    }


def main():
    """Ana fonksiyon"""
    try:
        if len(sys.argv) < 2:
            print(json.dumps({"success": False, "error": "PDF dosya yolu gerekli"}))
            return
        
        pdf_path = sys.argv[1]
        lang = os.environ.get("TESSERACT_LANG", "tur+eng")
        dpi = int(os.environ.get("OCR_DPI", "450"))
        
        if not os.path.exists(pdf_path):
            print(json.dumps({"success": False, "error": f"Dosya bulunamadı: {pdf_path}"}))
            return
        
        # OCR işlemini çalıştır
        result = ocr_pdf_to_text(pdf_path, lang=lang, dpi=dpi)
        
        # JSON olarak çıktı ver
        print(json.dumps(result, ensure_ascii=False))
        
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))


if __name__ == "__main__":
    main()

import os
import sys
import json
import tempfile
from typing import Dict, Any

try:
    from pdf2image import convert_from_path
    from PIL import Image
    import pytesseract
    import cv2
    import numpy as np
except Exception as e:
    print(json.dumps({"success": False, "error": f"ImportError: {e}"}))
    sys.exit(1)

# Opsiyonel motorlar
try:
    import easyocr  # type: ignore
except Exception:
    easyocr = None
try:
    from paddleocr import PaddleOCR  # type: ignore
except Exception:
    PaddleOCR = None


def deskew_image(gray: np.ndarray) -> np.ndarray:
    edges = cv2.Canny(gray, 50, 150)
    lines = cv2.HoughLines(edges, 1, np.pi / 180, 200)
    if lines is None:
        return gray
    angles = []
    for rho, theta in lines[:,0,:]:
        angle = (theta - np.pi/2) * 180/np.pi
        if -15 < angle < 15:
            angles.append(angle)
    if not angles:
        return gray
    median_angle = float(np.median(angles))
    (h, w) = gray.shape[:2]
    M = cv2.getRotationMatrix2D((w//2, h//2), median_angle, 1.0)
    return cv2.warpAffine(gray, M, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


def remove_form_lines(gray: np.ndarray) -> np.ndarray:
    thr = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 21, 10)
    horizontal = thr.copy()
    cols = horizontal.shape[1]
    horizontal_size = max(20, cols // 30)
    horizontalStructure = cv2.getStructuringElement(cv2.MORPH_RECT, (horizontal_size, 1))
    horizontal = cv2.erode(horizontal, horizontalStructure)
    horizontal = cv2.dilate(horizontal, horizontalStructure)
    vertical = thr.copy()
    rows = vertical.shape[0]
    vertical_size = max(20, rows // 30)
    verticalStructure = cv2.getStructuringElement(cv2.MORPH_RECT, (1, vertical_size))
    vertical = cv2.erode(vertical, verticalStructure)
    vertical = cv2.dilate(vertical, verticalStructure)
    mask = cv2.bitwise_or(horizontal, vertical)
    cleaned = cv2.bitwise_and(gray, gray, mask=cv2.bitwise_not(mask))
    return cleaned


def preprocess_image_for_ocr(pil_image: Image.Image) -> Image.Image:
    img = np.array(pil_image)
    if len(img.shape) == 3:
        gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
    else:
        gray = img

    # Orientation tespiti (OSD) – başarısızsa atla
    try:
        osd = pytesseract.image_to_osd(Image.fromarray(gray))
        if 'Rotate: 90' in osd:
            gray = cv2.rotate(gray, cv2.ROTATE_90_COUNTERCLOCKWISE)
        elif 'Rotate: 180' in osd:
            gray = cv2.rotate(gray, cv2.ROTATE_180)
        elif 'Rotate: 270' in osd:
            gray = cv2.rotate(gray, cv2.ROTATE_90_CLOCKWISE)
    except Exception:
        pass

    gray = deskew_image(gray)
    gray = remove_form_lines(gray)

    # Kontrast ve gürültü azaltma
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    denoised = cv2.fastNlMeansDenoising(enhanced, h=8)

    # Adaptif threshold (formlar için iyi)
    binary = cv2.adaptiveThreshold(denoised, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 11)
    kernel = np.ones((1,1), np.uint8)
    binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel)
    return Image.fromarray(binary)


def ocr_pdf_to_text(pdf_path: str, lang: str = "tur+eng", dpi: int = 300) -> Dict[str, Any]:
    images = convert_from_path(pdf_path, dpi=dpi, fmt="PNG")
    texts = []

    # Hazırla: ensemble için opsiyonel okuyucular
    easy_reader = easyocr.Reader(['tr', 'en']) if easyocr else None
    paddle_reader = PaddleOCR(use_angle_cls=True, lang='tr') if PaddleOCR else None

    def _calc_conf(s: str) -> float:
        if not s:
            return 0.0
        import re
        words = s.split()
        valid = sum(1 for w in words if re.match(r'^[a-zA-ZçğıöşüÇĞİÖŞÜ]+$', w))
        word_ratio = valid / len(words) if words else 0
        specials = len(re.findall(r"[^a-zA-ZçğıöşüÇĞİÖŞÜ0-9\s\.-,:()/]", s))
        special_ratio = 1 - (specials / max(len(s), 1))
        length_score = min(len(s) / 120, 1.0)
        return word_ratio * 0.4 + special_ratio * 0.4 + length_score * 0.2

    for im in images:
        processed = preprocess_image_for_ocr(im)

        # Adaylar: Tesseract psm6/4
        cfg_base = f"--oem 3 -l {lang} -c preserve_interword_spaces=1 -c tessedit_char_blacklist=|~`^*{}<> -c tessedit_char_whitelist=0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZçğıöşüÇĞİÖŞÜ-_/.:()[],'\""
        candidates = []
        try:
            candidates.append(pytesseract.image_to_string(processed, config=cfg_base + ' --psm 6'))
        except Exception:
            pass
        try:
            candidates.append(pytesseract.image_to_string(processed, config=cfg_base + ' --psm 4'))
        except Exception:
            pass

        # EasyOCR
        if easy_reader:
            try:
                res = easy_reader.readtext(np.array(processed))
                candidates.append(' '.join([x[1] for x in res]))
            except Exception:
                pass

        # PaddleOCR
        if paddle_reader:
            try:
                res = paddle_reader.ocr(np.array(processed), cls=True)
                if res and res[0]:
                    candidates.append(' '.join([line[1][0] for line in res[0]]))
            except Exception:
                pass

        # Skorla ve en iyiyi al
        if candidates:
            best = max(candidates, key=_calc_conf)
            texts.append(best.strip())
        else:
            texts.append('')

    full_text = "\n\n".join([t for t in texts if t])
    return {"success": True, "text": full_text, "total_pages": len(images)}


def main():
    try:
        pdf_path = sys.argv[1]
        lang = os.environ.get("TESSERACT_LANG", "tur+eng")
        dpi = int(os.environ.get("OCR_DPI", "300"))
        if not os.path.exists(pdf_path):
            print(json.dumps({"success": False, "error": f"File not found: {pdf_path}"}))
            return
        result = ocr_pdf_to_text(pdf_path, lang=lang, dpi=dpi)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))


if __name__ == "__main__":
    main()


