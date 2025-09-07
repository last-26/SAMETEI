#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Geliştirilmiş OCR - Qwen Modeli ile Görüntüden Metin Çıkarma
Kullanım: python improved_ocr.py <görüntü_dosyası>
"""

import os
import sys
import io
import base64
import logging
from PIL import Image, ImageEnhance, ImageOps
from transformers import Qwen2_5_VLForConditionalGeneration, AutoProcessor
from qwen_vl_utils import process_vision_info
import torch
import numpy as np

# Logging ayarları
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def load_model():
    """Qwen modelini yükle"""
    global model, processor, device

    try:
        # GPU kontrolü
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        logger.info(f"Kullanılacak cihaz: {device}")

        # Model ID
        model_id = "Qwen/Qwen2.5-VL-3B-Instruct"

        # Processor yükle - daha yüksek çözünürlük limitleri
        processor = AutoProcessor.from_pretrained(
            model_id,
            trust_remote_code=True,
            min_pixels=1024 * 28 * 28,  # Min piksel artırıldı
            max_pixels=2048 * 28 * 28,  # Max piksel artırıldı
        )

        # Model yükle
        model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
            model_id,
            torch_dtype=torch.float16 if torch.cuda.is_available() else torch.float32,
            device_map="auto" if torch.cuda.is_available() else "cpu",
            trust_remote_code=True,
            low_cpu_mem_usage=True,
        )

        model.eval()
        logger.info("✅ Model başarıyla yüklendi!")
        return True

    except Exception as e:
        logger.error(f"❌ Model yükleme hatası: {e}")
        return False

def enhance_image(image):
    """Görüntü kalitesini artır"""
    try:
        # Contrast artırma
        enhancer = ImageEnhance.Contrast(image)
        image = enhancer.enhance(1.5)
        
        # Brightness ayarlama
        enhancer = ImageEnhance.Brightness(image)
        image = enhancer.enhance(1.2)
        
        # Sharpness artırma
        enhancer = ImageEnhance.Sharpness(image)
        image = enhancer.enhance(2.0)
        
        return image
    except Exception as e:
        logger.warning(f"Görüntü iyileştirme uyarısı: {e}")
        return image

def detect_and_correct_rotation(image):
    """Görüntü rotasyonunu tespit et ve düzelt"""
    try:
        # PIL'in EXIF bilgilerini kullanarak otomatik döndürme
        image = ImageOps.exif_transpose(image)
        
        # Ek olarak, görüntüyü numpy array'e çevir
        img_array = np.array(image)
        
        # Basit bir kenar tespiti ile metin yönünü kontrol et
        # (Bu kısım opsiyonel, gerekirse daha gelişmiş algoritmalar kullanılabilir)
        
        return image
    except Exception as e:
        logger.warning(f"Rotasyon düzeltme uyarısı: {e}")
        return image

def preprocess_image(image_path):
    """Görüntüyü gelişmiş ön işleme"""
    try:
        # Görüntüyü aç
        image = Image.open(image_path)
        
        # RGB'ye çevir
        if image.mode != 'RGB':
            image = image.convert('RGB')
        
        # Rotasyonu düzelt
        image = detect_and_correct_rotation(image)
        
        # Görüntü kalitesini artır
        image = enhance_image(image)
        
        # Görüntü boyutunu kontrol et ve gerekirse resize et
        width, height = image.size
        max_dimension = 3000  # Maksimum boyut
        
        if width > max_dimension or height > max_dimension:
            ratio = min(max_dimension/width, max_dimension/height)
            new_width = int(width * ratio)
            new_height = int(height * ratio)
            image = image.resize((new_width, new_height), Image.Resampling.LANCZOS)
            logger.info(f"📐 Görüntü yeniden boyutlandırıldı: {new_width}x{new_height}")
        
        logger.info(f"📷 Görüntü işlendi: {image.size}")
        return image

    except Exception as e:
        logger.error(f"❌ Görüntü yükleme hatası: {e}")
        return None

def image_to_base64(image):
    """Görüntüyü base64'e çevir"""
    try:
        # Buffer'a kaydet
        buffer = io.BytesIO()
        image.save(buffer, format='JPEG', quality=95)  # Kaliteyi artır
        buffer.seek(0)

        # Base64'e çevir
        image_base64 = base64.b64encode(buffer.getvalue()).decode('utf-8')
        return image_base64

    except Exception as e:
        logger.error(f"❌ Base64 çevirme hatası: {e}")
        return None

def extract_text_from_image(image):
    """Görüntüden metin çıkar - geliştirilmiş yaklaşım"""
    try:
        # Base64'e çevir
        image_base64 = image_to_base64(image)
        if not image_base64:
            return None

        # Geliştirilmiş prompt - daha spesifik talimatlar
        prompt = """Bu görüntüdeki TÜM metinleri çıkar. 
        
        KURALLAR:
        1. Her metin parçasını ORIJINAL KONUMUNA ve SIRASINA göre çıkar
        2. Tablo varsa, satır ve sütun yapısını koru
        3. Türkçe karakterleri (ç, ğ, ı, ö, ş, ü) tam olarak koru
        4. Renkli arka planlardaki metinleri de oku
        5. Dikey veya yatay tüm metinleri oku
        6. HİÇBİR metni atlama, tekrarlama veya değiştirme
        7. Form yapısını ve düzenini koru
        8. Boş hücreleri veya alanları da belirt
        
        ÇIKTI FORMATI:
        - Tablolar için satır sonlarında \n kullan, sütunları \t ile ayır.
        - Formlar için alan adı: değer formatını kullan
        - Her bölümü ayrı satırlarda göster
        
        Şimdi görüntüdeki TÜM metinleri tam olarak çıkar:"""

        # Mesajları hazırla
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image", "image": image},
                ],
            }
        ]

        # Model ile çıkarım
        logger.info("🔍 OCR işlemi başlatılıyor...")

        # Chat template uygula
        prompt_text = processor.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True
        )

        # Görsel girişleri işle
        image_inputs, video_inputs = process_vision_info(messages)

        # Tensorları hazırla
        inputs = processor(
            text=[prompt_text],
            images=image_inputs,
            videos=video_inputs,
            padding=True,
            return_tensors="pt",
        ).to(device)

        # Model çıkarımı - artırılmış token limiti
        with torch.no_grad():
            generated_ids = model.generate(
                **inputs,
                max_new_tokens=4096,  # Token limiti 4 katına çıkarıldı
                temperature=0.0,      # Deterministik
                do_sample=False,
                num_beams=3,          # Beam search ile daha iyi sonuçlar
                repetition_penalty=1.2,  # Tekrarları önle
                eos_token_id=getattr(processor.tokenizer, 'eos_token_id', None),
                pad_token_id=getattr(processor.tokenizer, 'pad_token_id', None),
            )

        # Çıktıyı decode et
        generated_ids_trimmed = [
            out_ids[len(in_ids):] for in_ids, out_ids in zip(inputs.input_ids, generated_ids)
        ]

        output_text = processor.batch_decode(
            generated_ids_trimmed,
            skip_special_tokens=True,
            clean_up_tokenization_spaces=False
        )[0]

        logger.info("✅ OCR tamamlandı!")
        return output_text.strip()

    except Exception as e:
        logger.error(f"❌ OCR hatası: {e}")
        return None

def post_process_text(text):
    """OCR sonucunu post-processing ile iyileştir"""
    if not text:
        return ""
    
    import re
    
    # Gereksiz başlangıç metinlerini temizle
    text = re.sub(r"^.*?çıkar[ıi]lan.*?:\s*", "", text, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"^.*?metin.*?:\s*", "", text, flags=re.IGNORECASE | re.DOTALL)
    
    # Code block'lardan çıkar
    fence = re.compile(r"```[a-zA-Z0-9]*\n([\s\S]*?)\n```")
    match = fence.search(text)
    if match:
        text = match.group(1).strip()
    
    # Tekrarlanan satırları tespit et ve kaldır
    lines = text.split('\n')
    unique_lines = []
    prev_line = None
    
    for line in lines:
        # Boş satırları koru ama tekrarları önle
        if line.strip() != prev_line:
            unique_lines.append(line)
            prev_line = line.strip() if line.strip() else prev_line
    
    text = '\n'.join(unique_lines)
    
    # Fazla boşlukları düzenle
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    
    return text.strip()

def process_in_segments(image, segment_size=500):
    """Büyük görüntüleri segmentlere ayırarak işle"""
    width, height = image.size
    results = []
    
    if height > segment_size * 2:  # Eğer görüntü çok uzunsa
        logger.info("📋 Görüntü segmentlere ayrılıyor...")
        
        for y in range(0, height, segment_size):
            # Segment oluştur (biraz overlap ekle)
            overlap = 50  # Piksel cinsinden overlap
            y_start = max(0, y - overlap)
            y_end = min(height, y + segment_size + overlap)
            
            # Segmenti kes
            segment = image.crop((0, y_start, width, y_end))
            
            # Her segmenti OCR'la
            segment_text = extract_text_from_image(segment)
            if segment_text:
                results.append(segment_text)
        
        return "\n".join(results)
    else:
        # Normal işlem
        return extract_text_from_image(image)

def main():
    """Ana fonksiyon"""
    try:
        if len(sys.argv) < 2:
            print("Kullanım: python improved_ocr.py <görüntü_dosyası>")
            print("Örnek: python improved_ocr.py test.png")
            return

        image_name = sys.argv[1]
        image_path = os.path.join("temp", image_name)

        if not os.path.exists(image_path):
            print(f"❌ Dosya bulunamadı: {image_path}")
            return

        print("🚀 Geliştirilmiş OCR başlatılıyor...")
        print(f"📝 Görüntü: {image_path}")

        # Model yükle
        if not load_model():
            print("❌ Model yüklenemedi!")
            return

        # Görüntüyü işle
        image = preprocess_image(image_path)
        if not image:
            print("❌ Görüntü yüklenemedi!")
            return

        # OCR çıkarım - büyük görüntüler için segment bazlı
        width, height = image.size
        if height > 2000:  # Uzun görüntüler için
            raw_text = process_in_segments(image)
        else:
            raw_text = extract_text_from_image(image)
        
        if not raw_text:
            print("❌ OCR başarısız!")
            return

        # Post-processing
        clean_text = post_process_text(raw_text)

        # Sonucu göster
        print("\n" + "="*50)
        print("📝 ÇIKARILAN METİN:")
        print("="*50)
        print(clean_text)
        print("="*50)
        print(f"📊 Karakter sayısı: {len(clean_text)}")

        # Dosyaya kaydet
        output_file = os.path.splitext(image_path)[0] + "_ocr_improved.txt"
        with open(output_file, 'w', encoding='utf-8') as f:
            f.write(clean_text)

        print(f"💾 Sonuç kaydedildi: {output_file}")

    except KeyboardInterrupt:
        print("\n⹠İşlem kullanıcı tarafından durduruldu")
    except Exception as e:
        print(f"❌ Beklenmeyen hata: {e}")

if __name__ == "__main__":
    main()