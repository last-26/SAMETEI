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
    prompt: str = """TASK: Extract table data with PERFECT tab-separated formatting.

CRITICAL FORMATTING RULES:
1. Use TAB character (\t) to separate each column - MANDATORY
2. Use NEWLINE (\n) to separate each row - MANDATORY  
3. NO SPACES between columns - ONLY TABS
4. Extract ALL table content including headers

TABLE STRUCTURE:
- First row: Column headers separated by \t
- Following rows: Data cells separated by \t
- Empty cells: Leave empty but keep \t separators
- Multi-line content within cell: Replace newlines with space

TURKISH CHARACTER SUPPORT:
- Preserve Turkish characters (ç, ğ, ı, ö, ş, ü, Ç, Ğ, İ, Ö, Ş, Ü)
- Keep all accented characters exactly as shown

SPECIAL CASES:
- Read text on colored backgrounds
- Read vertical/rotated text  
- Preserve numeric values exactly (including dots, commas)
- Preserve date formats as written

OUTPUT REQUIREMENTS:
- ONLY the table content with \t and \n separators
- NO explanations, NO markdown formatting
- NO code blocks, NO extra text
- Start directly with the header row
- End with the last data row

QUALITY STANDARDS:
- 100% accurate text recognition
- Perfect tab separation between columns
- Complete table structure preservation
- Mark uncertain text as [?] if unclear

Uncertain character → [?]  
Unreadable section → [...]"""
    max_tokens: int = 4096

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
        logger.info("🔍 OCR isteği işleniyor...")

        # Base64'ten görüntüyü decode et
        image_data = base64.b64decode(request.image)
        image = Image.open(io.BytesIO(image_data))

        # Gelişmiş preprocessing - renkli arka plan problemini çöz
        image = enhance_for_colored_backgrounds(image)
        logger.info("Renkli arka plan optimizasyonu uygulandı")

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
            generated_ids = model.generate(
                **inputs,
                max_new_tokens=request.max_tokens,
                temperature=0.0,
                do_sample=False,
                num_beams=1,
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

        logger.info("%.2f", processing_time)
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
        log_level="info"
    )
