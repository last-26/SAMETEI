#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
DOT-OCR (GOT-OCR2) Komut Satırı Uygulaması
Tek dosya halinde çalıştırılabilir OCR uygulaması

Kullanım:
    python dotOCR.py <görüntü_dosyası> [--type TYPE] [--output OUTPUT]

Örnekler:
    python dotOCR.py temp/1.png
    python dotOCR.py temp/2.PNG --type text_only
    python dotOCR.py temp/1.png --output result.txt
"""

import os
import sys
import json
import torch
import argparse
import logging
import time
from PIL import Image
from transformers import AutoModel, AutoTokenizer

# Logging konfigürasyonu
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class DOTOCR:
    def __init__(self, model_path=None):
        """
        DOT-OCR başlatıcı

        Args:
            model_path (str): GOT-OCR2 model dizini yolu
        """
        self.model_path = model_path or r"C:\Users\samet\Downloads\GOT-OCR2_0"
        self.model = None
        self.tokenizer = None
        self.is_initialized = False
        self.device = 'cuda' if torch.cuda.is_available() else 'cpu'

        logger.info(f"DOT-OCR başlatılıyor. Cihaz: {self.device}")

    def initialize_model(self):
        """GOT-OCR2 modelini yükle ve başlat"""
        try:
            if not os.path.isdir(self.model_path):
                raise FileNotFoundError(f"Model dizini bulunamadı: {self.model_path}")

            logger.info("Model yükleniyor...")

            # Tokenizer yükleme
            self.tokenizer = AutoTokenizer.from_pretrained(
                self.model_path,
                local_files_only=True,
                trust_remote_code=True
            )

            # Model yükleme
            self.model = AutoModel.from_pretrained(
                self.model_path,
                local_files_only=True,
                trust_remote_code=True,
                torch_dtype=torch.float16 if self.device == 'cuda' else torch.float32,
                device_map=self.device
            ).eval()

            # Generation config ayarları
            if hasattr(self.model, 'generation_config') and self.model.generation_config is not None:
                self.model.generation_config.use_cache = False
                self.model.generation_config.max_new_tokens = 200
                self.model.generation_config.temperature = 0.0
                self.model.generation_config.do_sample = False
                self.model.generation_config.repetition_penalty = 1.0

                # Pad/EOS token ayarları
                eos_id = self.tokenizer.eos_token_id or self.tokenizer.convert_tokens_to_ids('</s>')
                if self.tokenizer.pad_token_id is None and eos_id is not None:
                    self.tokenizer.pad_token = self.tokenizer.eos_token or '</s>'

                pad_id = self.tokenizer.pad_token_id or eos_id
                if pad_id is not None:
                    self.model.generation_config.pad_token_id = pad_id
                    self.model.generation_config.eos_token_id = eos_id

            # Config ayarları
            if hasattr(self.model, 'config') and self.model.config is not None:
                self.model.config.use_cache = False
                if pad_id is not None:
                    self.model.config.pad_token_id = pad_id
                    self.model.config.eos_token_id = eos_id

            self.is_initialized = True
            logger.info("✅ Model başarıyla yüklendi!")
            logger.info(f"📍 Cihaz: {self.device}")
            if self.device == 'cuda':
                logger.info(f"🎮 GPU: {torch.cuda.get_device_name(0)}")

            return True

        except Exception as e:
            logger.error(f"❌ Model yükleme hatası: {e}")
            return False

    def _resize_image(self, image_path, long_edge_max=1600):
        """Görüntüyü hız optimizasyonu için yeniden boyutlandır"""
        try:
            img = Image.open(image_path).convert('RGB')
            w, h = img.size
            long_edge = max(w, h)

            if long_edge <= long_edge_max:
                return image_path

            scale = long_edge_max / float(long_edge)
            new_w, new_h = max(1, int(w * scale)), max(1, int(h * scale))
            img = img.resize((new_w, new_h))

            # Geçici dosya oluştur
            temp_dir = os.path.join(os.path.dirname(image_path), "_runtime")
            os.makedirs(temp_dir, exist_ok=True)
            temp_path = os.path.join(temp_dir, f"resized_{int(time.time())}.png")
            img.save(temp_path, format='PNG')

            return temp_path

        except Exception as e:
            logger.warning(f"Görüntü yeniden boyutlandırma hatası: {e}")
            return image_path

    def _get_extraction_prompt(self):
        """Detaylı extraction prompt - yüksek doğruluk için optimize edilmiş"""
        return (
            "TASK: Extract ALL textual content from the image completely and accurately.\n\n"
            "RULES:\n"
            "1. Extract ONLY the text visible in the image.\n"
            "2. Do NOT add explanations, comments, or extra information.\n"
            "3. Leave empty areas EMPTY (no guessing, no filling).\n"
            "4. Preserve Turkish characters (ç, ğ, ı, ö, ş, ü, Ç, Ğ, İ, Ö, Ş, Ü).\n\n"
            "TABLE FORMATTING:\n"
            "- Separate cells in the same row with TAB (\\t).\n"
            "- End each row with NEWLINE (\\n).\n"
            "- Keep empty cells empty.\n"
            "- Maintain cell order left to right, top to bottom.\n\n"
            "SPECIAL CASES:\n"
            "- Read text on colored backgrounds.\n"
            "- Read vertical/rotated text.\n"
            "- Form fields:\n"
            "  * Filled field → write its content.\n"
            "  * Empty field → leave blank.\n"
            "  * Checkbox → □ (empty) or ☑ (checked).\n"
            "- Preserve numeric values exactly (including dots, commas).\n"
            "- Preserve date formats as written (e.g., ____/__/____).\n\n"
            "OUTPUT:\n"
            "- Plain text only.\n"
            "- Preserve original layout.\n"
            "- No intro or outro text.\n"
            "- No code blocks.\n\n"
            "PRIORITY:\n"
            "1. Accuracy (only 100% certain text).\n"
            "2. Completeness (all readable text).\n"
            "3. Format preservation (tables/forms).\n\n"
            "Uncertain character → [?]\n"
            "Unreadable section → [...]"
        )

    def extract_text(self, image_path, custom_prompt=None):
        """
        Görüntüden metin çıkar

        Args:
            image_path (str): Görüntü dosya yolu
            custom_prompt (str): Özel prompt (varsa)

        Returns:
            dict: Çıkarım sonucu
        """
        try:
            if not self.is_initialized:
                if not self.initialize_model():
                    return {
                        'success': False,
                        'error': 'Model başlatılamadı',
                        'text': ''
                    }

            # Görüntü kontrolü
            if not os.path.exists(image_path):
                return {
                    'success': False,
                    'error': f'Görüntü bulunamadı: {image_path}',
                    'text': ''
                }

            logger.info(f"📷 Görüntü yükleniyor: {os.path.basename(image_path)}")

            # Görüntü yükleme kontrolü
            _ = Image.open(image_path)

            # Hız optimizasyonları
            if torch.cuda.is_available():
                torch.set_float32_matmul_precision('high')
                try:
                    torch.backends.cuda.matmul.allow_tf32 = True
                except:
                    pass

            # Görüntüyü yeniden boyutlandır
            resized_path = self._resize_image(image_path, long_edge_max=1600)

            # Prompt oluştur
            prompt = custom_prompt or self._get_extraction_prompt()

            logger.info("🔍 OCR işlemi başlatılıyor...")

            start_time = time.time()

            with torch.inference_mode():
                try:
                    # GOT-OCR2 için basit metin çıkarımı
                    result = self.model.chat(
                        self.tokenizer,
                        resized_path,
                        question=prompt
                    )
                except TypeError:
                    try:
                        result = self.model.chat(
                            self.tokenizer,
                            resized_path,
                            question=prompt
                        )
                    except TypeError:
                        # Son çare: prompt'suz
                        result = self.model.chat(
                            self.tokenizer,
                            resized_path,
                            ocr_type='ocr'
                        )

            processing_time = time.time() - start_time

            # Geçici dosyayı temizle
            if resized_path != image_path and os.path.exists(resized_path):
                try:
                    os.unlink(resized_path)
                    # _runtime klasörünü de temizle
                    runtime_dir = os.path.dirname(resized_path)
                    if os.path.exists(runtime_dir) and not os.listdir(runtime_dir):
                        os.rmdir(runtime_dir)
                except:
                    pass

            logger.info(".2f")

            return {
                'success': True,
                'text': result,
                'processing_time': processing_time,
                'model': 'GOT-OCR2',
                'device': self.device
            }

        except Exception as e:
            logger.error(f"❌ OCR hatası: {e}")
            return {
                'success': False,
                'error': str(e),
                'text': ''
            }

def main():
    """Komut satırı arayüzü"""
    parser = argparse.ArgumentParser(
        description='DOT-OCR (GOT-OCR2) Komut Satırı Uygulaması',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Kullanım örnekleri:
  python dotOCR.py 1.png                    # temp/1.png dosyasını işle
  python dotOCR.py 2.PNG --output result.txt    # Çıktıyı dosyaya kaydet
  python dotOCR.py temp/image.jpg --custom-prompt "Özel promptunuz"

Not: Sadece dosya adı yazarsanız (örn: 1.png) otomatik olarak temp/ klasöründen aranır.
     Tek kapsamlı prompt kullanılır - RAG sistemi için optimize edilmiştir.
        """
    )

    parser.add_argument('image_path', help='İşlenecek görüntü dosyası')
    parser.add_argument('--model-path', default=r"C:\Users\samet\Downloads\GOT-OCR2_0",
                       help='GOT-OCR2 model dizini yolu')
    parser.add_argument('--custom-prompt', help='Özel prompt')
    parser.add_argument('--output', '-o', help='Çıktı dosyası')
    parser.add_argument('--quiet', '-q', action='store_true', help='Sadece sonucu göster')

    args = parser.parse_args()

    # Dosya yolunu ayarla - eğer sadece dosya adı verilmişse temp klasöründen ara
    if not os.path.exists(args.image_path):
        # Eğer sadece dosya adı verilmişse (path ayırıcı içermiyorsa) temp klasöründen ara
        if os.sep not in args.image_path and '/' not in args.image_path:
            temp_path = os.path.join('temp', args.image_path)
            if os.path.exists(temp_path):
                args.image_path = temp_path
            else:
                print(f"❌ Hata: '{args.image_path}' dosyası bulunamadı")
                print(f"   Temp klasöründen arandı: {temp_path}")
                return 1
        else:
            print(f"❌ Hata: '{args.image_path}' dosyası bulunamadı")
            return 1

    # Servis başlat
    if not args.quiet:
        print("🚀 DOT-OCR başlatılıyor...")
        print(f"📂 Görüntü: {args.image_path}")
        print(f"🤖 Model: {args.model_path}")
        print("-" * 50)

    ocr = DOTOCR(args.model_path)

    # OCR işle
    result = ocr.extract_text(
        args.image_path,
        args.custom_prompt
    )

    # Sonuç göster/gönder
    if args.output:
        if args.output.endswith('.json'):
            with open(args.output, 'w', encoding='utf-8') as f:
                json.dump(result, f, ensure_ascii=False, indent=2)
        else:
            # Text dosyası
            with open(args.output, 'w', encoding='utf-8') as f:
                f.write(result.get('text', ''))

        if not args.quiet:
            print(f"💾 Sonuç {args.output} dosyasına kaydedildi")
    else:
        if result['success']:
            if not args.quiet:
                print("✅ OCR Başarılı!")
                print(f"⏱️  Süre: {result.get('processing_time', 0):.2f}s")
                print("-" * 50)
            print(result['text'])
        else:
            print(f"❌ Hata: {result.get('error', 'Bilinmeyen hata')}")
            return 1

    return 0

if __name__ == "__main__":
    exit(main())
