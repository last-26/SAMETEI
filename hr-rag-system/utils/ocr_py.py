#!/usr/bin/env python3
import pytesseract
from PIL import Image
from pdf2image import convert_from_path
import sys
import json
import os
from typing import Dict, Any

def ocr_pdf_to_text(pdf_path: str, lang: str = "tur+eng", dpi: int = 450) -> Dict[str, Any]:
    """Basitleştirilmiş OCR - direkt çalışır"""
    
    # Progress bar'ı sustur
    import sys
    old_stderr = sys.stderr
    sys.stderr = open(os.devnull, 'w')
    
    try:
        # PDF'i görüntüye çevir
        images = convert_from_path(pdf_path, dpi=dpi)
    finally:
        sys.stderr = old_stderr
    
    texts = []
    
    for page_num, image in enumerate(images, 1):
        # PSM 11 ile dene (sparse text - form için en iyi)
        try:
            config = f'--oem 3 --psm 11 -l {lang}'
            text = pytesseract.image_to_string(image, config=config)
            
            # Eğer PSM 11 boş döndü, PSM 6'yı dene
            if not text.strip():
                config = f'--oem 3 --psm 6 -l {lang}'
                text = pytesseract.image_to_string(image, config=config)
            
            # Hala boşsa PSM 3 (otomatik)
            if not text.strip():
                config = f'--oem 3 --psm 3 -l {lang}'
                text = pytesseract.image_to_string(image, config=config)
                
            if text.strip():
                texts.append(f"=== SAYFA {page_num} ===\n{text.strip()}")
            else:
                texts.append(f"=== SAYFA {page_num} ===\n[Metin okunamadı]")
                
        except Exception as e:
            texts.append(f"=== SAYFA {page_num} ===\n[OCR Hatası: {str(e)}]")
    
    full_text = "\n\n".join(texts)
    
    return {
        "success": True,
        "text": full_text,
        "total_pages": len(images)
    }

def main():
    try:
        # UTF-8 encoding
        import sys
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
        
        result = ocr_pdf_to_text(pdf_path, lang=lang, dpi=dpi)
        print(json.dumps(result, ensure_ascii=False))
        
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))

if __name__ == "__main__":
    main()