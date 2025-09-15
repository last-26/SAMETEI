#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Qwen OCR API Server
Sürekli çalışan model servisi - istemciler API üzerinden bağlanır
"""

import os
import io
import base64
import logging
import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from PIL import Image
from transformers import Qwen2_5_VLForConditionalGeneration, AutoProcessor
from qwen_vl_utils import process_vision_info
import torch
import uvicorn

# Global değişkenler
model = None
processor = None
device = None
model_loaded = False

# Logging ayarları
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Request/Response modelleri
class OCRRequest(BaseModel):
    image: str  # Base64 encoded image
    prompt: str = """TASK: Extract ALL content from the image with intelligent format detection.

SMART CONTENT DETECTION:
1. **FORMS**: Vertical field layout (each field on new line)
2. **TABLES**: Horizontal data layout (TAB-separated columns)
3. **TEXT**: Natural paragraph flow
4. **MIXED**: Preserve each content type appropriately

UNIVERSAL EXTRACTION RULES:
✅ Read EVERY text element systematically
✅ Preserve Turkish characters: ç, ğ, ı, ö, ş, ü, Ç, Ğ, İ, Ö, Ş, Ü
✅ Extract titles, headers, and sections
✅ Complete document scanning - no text should be missed

FORM DETECTION & FORMATTING:
📋 IF FORM DETECTED (field labels, input boxes):
- Each field label on separate line
- Vertical layout (no horizontal tables)
- Preserve field structure and hierarchy
- Include form titles and sections

📊 IF TABLE DETECTED (data rows/columns):
- Use TAB characters between columns
- Use NEWLINE between rows
- Preserve tabular structure

📝 IF REGULAR TEXT:
- Natural paragraph breaks
- Preserve original spacing

QUALITY STANDARDS:
- 100% text coverage - don't skip any visible text
- Exact spelling preservation
- Appropriate format for content type
- Mark unclear text as [?] only if truly unreadable

CRITICAL: Scan the ENTIRE image area systematically. Every piece of visible text should appear in the output."""
    max_tokens: int = 2500  # Daha kapsamlı OCR için artırıldı

class OCRResponse(BaseModel):
    success: bool
    text: str = ""
    error: str = ""
    processing_time: float = 0.0

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Uygulama başlatma ve kapatma lifecycle"""
    # Başlatma
    logger.info("🚀 Qwen OCR API başlatılıyor...")
    await load_model_async()

    yield

    # Kapatma
    logger.info("⏹️ Qwen OCR API kapatılıyor...")
    await cleanup_model()

async def load_model_async():
    """Qwen modelini asenkron yükle"""
    global model, processor, device, model_loaded

    try:
        logger.info("🤖 Qwen modeli yükleniyor...")

        # GPU kontrolü
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        logger.info(f"📊 Kullanılacak cihaz: {device}")

        # Model ID - Hugging Face'den yükle
        model_id = "Qwen/Qwen2.5-VL-3B-Instruct"

        # GPU optimizasyonları
        if torch.cuda.is_available():
            # Memory fraction ayarı
            torch.cuda.set_per_process_memory_fraction(0.85)
            # Diğer optimizasyonlar
            torch.backends.cuda.matmul.allow_tf32 = True
            torch.backends.cudnn.benchmark = True
            os.environ['PYTORCH_CUDA_ALLOC_CONF'] = "max_split_size_mb:256,garbage_collection_threshold:0.6,expandable_segments:True"

        # Processor yükle
        processor = AutoProcessor.from_pretrained(
            model_id,
            trust_remote_code=True,
            min_pixels=640 * 28 * 28,
            max_pixels=1024 * 28 * 28,
        )

        # Model yükle
        model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
            model_id,
            torch_dtype=torch.float16 if torch.cuda.is_available() else torch.float32,
            device_map="auto" if torch.cuda.is_available() else "cpu",
            trust_remote_code=True,
            low_cpu_mem_usage=True,
            max_memory={0: "5.1GB", "cpu": "8GB"} if torch.cuda.is_available() else None,
        )

        model.eval()
        model_loaded = True
        logger.info("✅ Model başarıyla yüklendi ve hazır!")

    except Exception as e:
        logger.error(f"❌ Model yükleme hatası: {e}")
        model_loaded = False
        raise

async def cleanup_model():
    """Model temizliği"""
    global model, processor, device, model_loaded

    try:
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.synchronize()

        model = None
        processor = None
        device = None
        model_loaded = False

        logger.info("🧹 Model temizliği tamamlandı")

    except Exception as e:
        logger.warning(f"Model temizliği hatası: {e}")

# FastAPI uygulaması
app = FastAPI(
    title="Qwen OCR API",
    description="Qwen2.5-VL ile görüntüden metin çıkarma servisi",
    version="1.0.0",
    lifespan=lifespan
)

# CORS ayarları
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
async def root():
    """API durumu"""
    return {
        "status": "running",
        "model_loaded": model_loaded,
        "device": str(device) if device else "not loaded",
        "model": "Qwen/Qwen2.5-VL-3B-Instruct"
    }

@app.get("/health")
async def health_check():
    """Sağlık kontrolü"""
    return {
        "status": "healthy" if model_loaded else "model_not_loaded",
        "model_loaded": model_loaded,
        "gpu_memory": torch.cuda.get_device_properties(0).total_memory / 1024**3 if torch.cuda.is_available() else 0,
        "gpu_used": torch.cuda.memory_allocated(0) / 1024**3 if torch.cuda.is_available() else 0
    }

@app.post("/ocr", response_model=OCRResponse)
async def extract_text(request: OCRRequest, background_tasks: BackgroundTasks):
    """Görüntüden metin çıkarma"""

    if not model_loaded:
        raise HTTPException(status_code=503, detail="Model henüz yüklenmedi")

    import time
    start_time = time.time()

    try:
        # GPU memory cleanup (ConnectionReset önleme)
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        logger.info("🔍 OCR isteği işleniyor...")

        # Base64'ten görüntüyü decode et
        image_data = base64.b64decode(request.image)
        image = Image.open(io.BytesIO(image_data))

        # 1. IMAGE BOYUT OPTİMİZASYONU (PERFORMANS İÇİN KRİTİK)
        original_size = image.size
        image = optimize_image_size(image)
        logger.info(f"📏 Görüntü boyutu: {original_size} → {image.size}")

        # 2. Gelişmiş preprocessing - renkli arka plan problemini çöz
        image = enhance_for_colored_backgrounds(image)
        logger.info("✨ Renkli arka plan optimizasyonu uygulandı")

        # Prompt hazırla
        prompt = request.prompt

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

        # Model çıkarımı
        prompt_text = processor.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True
        )

        image_inputs, video_inputs = process_vision_info(messages)

        inputs = processor(
            text=[prompt_text],
            images=image_inputs,
            videos=video_inputs,
            padding=True,
            return_tensors="pt",
        ).to(device)

        with torch.no_grad():
            # QWEN-UYUMLU GENERATION AYARLARI (sadece desteklenen parametreler)
            generated_ids = model.generate(
                **inputs,
                max_new_tokens=min(request.max_tokens, 1500),  # Hard limit
                do_sample=False,
                num_beams=1,  # Greedy decoding (en hızlı)
                repetition_penalty=1.1,  # Tekrar önleme
                no_repeat_ngram_size=3,  # 3-gram tekrarı engelle
                eos_token_id=getattr(processor.tokenizer, 'eos_token_id', None),
                pad_token_id=getattr(processor.tokenizer, 'pad_token_id', None),
            )

        # Çıktıyı işle
        generated_ids_trimmed = [
            out_ids[len(in_ids):] for in_ids, out_ids in zip(inputs.input_ids, generated_ids)
        ]

        output_text = processor.batch_decode(
            generated_ids_trimmed,
            skip_special_tokens=True,
            clean_up_tokenization_spaces=False
        )[0]

        # Temizle
        clean_text = clean_output_text(output_text)
        processing_time = time.time() - start_time

        # DETAYLI OCR SONUÇ LOGGING
        logger.info(f"⏱️  İşlem süresi: {processing_time:.2f}s")
        logger.info(f"📝 OCR Sonuç Özeti:")
        logger.info(f"   • Ham metin uzunluğu: {len(output_text)} karakter")
        logger.info(f"   • Temiz metin uzunluğu: {len(clean_text)} karakter")
        logger.info(f"   • Satır sayısı: {len(clean_text.splitlines())} satır")
        logger.info(f"   • İlk 100 karakter: '{clean_text[:100]}...'")
        
        # TAM OCR SONUCU LOGGING (DEBUG İÇİN)
        logger.info("="*50)
        logger.info("📄 TAM OCR SONUCU:")
        logger.info("="*50)
        logger.info(clean_text)
        logger.info("="*50)
        logger.info("📤 APP.PY'A GÖNDERİLEN VERİ:")
        logger.info(f"SUCCESS: {True}")
        logger.info(f"TEXT LENGTH: {len(clean_text)}")
        logger.info(f"PROCESSING_TIME: {processing_time:.2f}")
        logger.info("="*50)
        
        return OCRResponse(
            success=True,
            text=clean_text,
            processing_time=processing_time
        )

    except Exception as e:
        processing_time = time.time() - start_time
        logger.error(f"❌ OCR hatası: {e}")

        return OCRResponse(
            success=False,
            error=str(e),
            processing_time=processing_time
        )

def optimize_image_size(image):
    """Görüntü boyutunu OCR performansı için optimize et"""
    MAX_PIXELS = 1024 * 1024  # 1MP max (performans için)
    MIN_PIXELS = 512 * 512    # 0.25MP min (kalite için)
    
    current_pixels = image.width * image.height
    
    # Çok büyükse küçült
    if current_pixels > MAX_PIXELS:
        scale = (MAX_PIXELS / current_pixels) ** 0.5
        new_size = (int(image.width * scale), int(image.height * scale))
        image = image.resize(new_size, Image.LANCZOS)
        logger.info(f"🔽 Görüntü küçültüldü: {current_pixels:,} → {new_size[0]*new_size[1]:,} pixel")
    
    # Çok küçükse büyüt
    elif current_pixels < MIN_PIXELS:
        scale = (MIN_PIXELS / current_pixels) ** 0.5
        new_size = (int(image.width * scale), int(image.height * scale))  
        image = image.resize(new_size, Image.LANCZOS)
        logger.info(f"🔼 Görüntü büyütüldü: {current_pixels:,} → {new_size[0]*new_size[1]:,} pixel")
    
    return image

def enhance_for_colored_backgrounds(image):
    """Renkli arka plan üzerindeki metinleri belirginleştir"""
    from PIL import ImageEnhance, ImageOps
    
    # RGB modunda tut
    if image.mode != 'RGB':
        image = image.convert('RGB')
    
    # Adaptif kontrast
    enhancer = ImageEnhance.Contrast(image)
    image = enhancer.enhance(1.8)  # Daha güçlü kontrast
    
    # Renk doygunluğunu azalt (metni belirginleştir)
    color_enhancer = ImageEnhance.Color(image) 
    image = color_enhancer.enhance(0.3)
    
    # Keskinlik
    sharpness = ImageEnhance.Sharpness(image)
    image = sharpness.enhance(2.0)
    
    return image

def clean_output_text(text):
    """Çıktı metnini temizleme"""
    if not text:
        return ""

    import re

    # Gereksiz başlangıç metinlerini temizle
    text = re.sub(r"^Here is the extracted.*?:\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^Extracted text:\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^The extracted.*?:\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^Bu görseldeki.*?çıkarılabilir:\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^Bu resimdeki.*?çıkarılabilir:\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^Görseldeki.*?çıkarılabilir:\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^İşte.*?metin:\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^Metinler şu şekilde:\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^Aşağıdaki metin.*?:\s*", "", text, flags=re.IGNORECASE)

    # Code block'lardan çıkar
    fence = re.compile(r"```[a-zA-Z0-9]*\n([\s\S]*?)\n```")
    match = fence.search(text)
    if match:
        text = match.group(1).strip()

    # Form belgelerindeki boş alan parantezlerini temizle
    # [Gönderilmemiş], [Boş], [Doldurulmamış], [N/A] vb. gibi parantez içindeki metinleri kaldır
    text = re.sub(r"\[\s*(?:Gönderilmemiş|Boş|Doldurulmamış|N/A|NA|None|Null|Empty|Blank|TBD|To be determined|Belirtilmemiş|Yazılmamış|Eksik|Missing|Unknown|Bilinmiyor|Yok|---|\.\.\.|…|_+|-+|\s+)\s*\]", "", text, flags=re.IGNORECASE)
    
    # Genel olarak köşeli parantez içinde sadece boşluk, tire, nokta vb. olan durumları temizle
    text = re.sub(r"\[\s*[-_.…\s]*\s*\]", "", text)

    # Fazla boşlukları temizle
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)

    return text.strip()

if __name__ == "__main__":
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8000,
        log_level="info",
        # CONNECTION STABILITY İYİLEŞTİRMESİ
        limit_concurrency=3,  # Eşzamanlı istek limiti (GPU için)
        limit_max_requests=1000,  # Maksimum istek sayısı
        timeout_keep_alive=30,  # Keep-alive süresi
        timeout_graceful_shutdown=60,  # Graceful shutdown
        access_log=False  # Performans için access log kapalı
    )
