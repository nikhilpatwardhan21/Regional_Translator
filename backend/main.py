import json
import logging
import os
import tempfile
from typing import List, Optional, Literal

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from openai import AsyncOpenAI
from pydantic import BaseModel, Field

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("regional-captions-backend")

app = FastAPI(title="Regional Translator Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

INDIAN_LANGUAGES = {
    "hi": "Hindi",
    "mr": "Marathi",
    "ta": "Tamil",
    "te": "Telugu",
    "kn": "Kannada",
    "bn": "Bengali",
    "gu": "Gujarati",
    "ml": "Malayalam",
    "pa": "Punjabi",
}

# Read API Keys from environment variable (supports Groq & OpenAI)
groq_key = os.getenv("GROQ_API_KEY")
openai_key = os.getenv("OPENAI_API_KEY")

if groq_key and not groq_key.startswith("your_"):
    logger.info("Configured provider: Groq API")
    client = AsyncOpenAI(api_key=groq_key, base_url="https://api.groq.com/openai/v1")
    STT_MODEL = "whisper-large-v3-turbo"
    CHAT_MODEL = "llama-3.3-70b-versatile"
elif openai_key and not openai_key.startswith("your_"):
    logger.info("Configured provider: OpenAI API")
    client = AsyncOpenAI(api_key=openai_key)
    STT_MODEL = "whisper-1"
    CHAT_MODEL = "gpt-4o-mini"
else:
    logger.warning("No valid GROQ_API_KEY or OPENAI_API_KEY found.")
    client = None
    STT_MODEL = "whisper-large-v3-turbo"
    CHAT_MODEL = "llama-3.3-70b-versatile"

frontend_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "frontend"))
if os.path.exists(frontend_dir):
    app.mount("/studio", StaticFiles(directory=frontend_dir, html=True), name="frontend")


# Pydantic models for request validation
class SubtitleSegment(BaseModel):
    id: Optional[int] = None
    start: float = Field(default=0.0, ge=0.0)
    end: float = Field(default=0.0, ge=0.0)
    original: str = ""
    translated: Optional[str] = ""


class ExportRequest(BaseModel):
    segments: List[SubtitleSegment] = []
    format: Literal["srt", "vtt", "txt"] = "srt"


@app.get("/")
async def root():
    return {
        "status": "ok",
        "message": "TranslateSub Live Captions Backend",
        "studio_url": "/studio",
    }


@app.websocket("/ws/translate")
async def translate_websocket(websocket: WebSocket, lang: str = "hi"):
    await websocket.accept()
    target_language_name = INDIAN_LANGUAGES.get(lang.lower(), "Hindi")
    logger.info(f"WebSocket client connected. Target language: {target_language_name} ({lang})")

    if not client:
        logger.error("GROQ_API_KEY or OPENAI_API_KEY environment variable is missing or empty.")

    try:
        while True:
            audio_bytes = await websocket.receive_bytes()
            if not audio_bytes or len(audio_bytes) < 100:
                continue

            if not client:
                await websocket.send_json({
                    "original": "[Backend Error]",
                    "translated": "API Key missing. Please set GROQ_API_KEY or OPENAI_API_KEY in backend .env file.",
                })
                continue

            tmp_path = None
            try:
                # Write binary chunk to a temporary file
                with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp_file:
                    tmp_file.write(audio_bytes)
                    tmp_path = tmp_file.name

                # 1. Transcribe audio chunk with Whisper
                with open(tmp_path, "rb") as audio_file:
                    stt_response = await client.audio.transcriptions.create(
                        model=STT_MODEL,
                        file=("audio.webm", audio_file),
                    )

                transcript_text = getattr(stt_response, "text", "").strip()

                # Skip empty/silent chunks
                if not transcript_text or len(transcript_text) < 2:
                    logger.info("Silence or unintelligible audio chunk skipped.")
                    continue

                logger.info(f"[STT Original]: {transcript_text}")

                # 2. Translate text into target Indian language
                system_prompt = (
                    f"You are a native spoken dialogue translator. "
                    f"Translate the following transcript into natural spoken-register {target_language_name}. "
                    f"Output ONLY the translated text in {target_language_name} script. "
                    f"Do not include transliterations, notes, context, or quote marks."
                )

                translation_response = await client.chat.completions.create(
                    model=CHAT_MODEL,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": transcript_text},
                    ],
                    temperature=0.3,
                )

                translated_text = translation_response.choices[0].message.content.strip()
                logger.info(f"[Translated - {target_language_name}]: {translated_text}")

                # 3. Send translated text back over WebSocket
                await websocket.send_json({
                    "original": transcript_text,
                    "translated": translated_text,
                })

            except Exception as chunk_err:
                logger.error(f"Error processing audio chunk: {chunk_err}")
                try:
                    await websocket.send_json({
                        "error": f"Audio processing error: {str(chunk_err)}"
                    })
                except Exception:
                    pass
            finally:
                if tmp_path and os.path.exists(tmp_path):
                    try:
                        os.remove(tmp_path)
                    except Exception as clean_err:
                        logger.warning(f"Could not remove temp file {tmp_path}: {clean_err}")

    except WebSocketDisconnect:
        logger.info("WebSocket connection closed cleanly by client.")
    except Exception as ws_err:
        logger.error(f"WebSocket error: {ws_err}")


@app.post("/api/transcribe-file")
async def transcribe_file(file: UploadFile = File(...), lang: str = Form("hi")):
    if not client:
        return {"error": "GROQ_API_KEY or OPENAI_API_KEY environment variable is missing or invalid."}

    target_language_name = INDIAN_LANGUAGES.get(lang.lower(), "Hindi")
    logger.info(f"Processing file upload '{file.filename}' for language {target_language_name}")

    # Check file size
    content = await file.read()
    file_size_mb = len(content) / (1024 * 1024)
    logger.info(f"Uploaded file size: {file_size_mb:.2f} MB")

    ext = os.path.splitext(file.filename)[1] if file.filename else ".mp4"
    if not ext:
        ext = ".mp4"

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp_file:
            tmp_file.write(content)
            tmp_path = tmp_file.name

        # 1. Transcribe with Whisper using verbose_json to retrieve timestamps
        try:
            with open(tmp_path, "rb") as audio_file:
                stt_response = await client.audio.transcriptions.create(
                    model=STT_MODEL,
                    file=(file.filename or f"audio{ext}", audio_file),
                    response_format="verbose_json",
                )
        except Exception as stt_err:
            logger.error(f"STT API Error ({STT_MODEL}): {stt_err}", exc_info=True)
            return {"error": f"Audio Transcription Failed: {str(stt_err)}"}

        raw_segments = getattr(stt_response, "segments", [])
        if not raw_segments:
            text = getattr(stt_response, "text", "").strip()
            if text:
                raw_segments = [{"start": 0.0, "end": 5.0, "text": text}]
            else:
                return {"segments": []}

        # 2. Extract segments and prepare batch translation
        segment_items = []
        for idx, seg in enumerate(raw_segments):
            start = getattr(seg, "start", 0.0) if not isinstance(seg, dict) else seg.get("start", 0.0)
            end = getattr(seg, "end", 0.0) if not isinstance(seg, dict) else seg.get("end", 0.0)
            text = getattr(seg, "text", "").strip() if not isinstance(seg, dict) else seg.get("text", "").strip()
            if text:
                segment_items.append({
                    "id": idx + 1,
                    "start": round(float(start), 2),
                    "end": round(float(end), 2),
                    "original": text,
                })

        if not segment_items:
            return {"segments": []}

        # 3. Batch translate using LLM for speed and context
        texts_to_translate = [item["original"] for item in segment_items]
        system_prompt = (
            f"You are a professional native dialogue translator for Indian languages. "
            f"Translate the following list of audio transcript lines into natural spoken-register {target_language_name}. "
            f"Return ONLY a JSON array of strings containing the exact translated sentences in target language script, "
            f"matching the order of the input array. Do NOT output markdown code blocks or explanations."
        )

        user_content = json.dumps(texts_to_translate, ensure_ascii=False)

        try:
            translation_response = await client.chat.completions.create(
                model=CHAT_MODEL,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_content},
                ],
                temperature=0.3,
            )
            raw_content = translation_response.choices[0].message.content.strip()

            # Clean JSON formatting if wrapped in ```json ... ```
            if raw_content.startswith("```"):
                raw_content = raw_content.split("```")[1]
                if raw_content.startswith("json"):
                    raw_content = raw_content[4:].strip()

            translated_list = json.loads(raw_content)
            for idx, item in enumerate(segment_items):
                if idx < len(translated_list):
                    item["translated"] = translated_list[idx]
                else:
                    item["translated"] = item["original"]
        except Exception as trans_err:
            logger.warning(f"Batch translation error, falling back to original: {trans_err}")
            for item in segment_items:
                item["translated"] = item["original"]

        return {"segments": segment_items}

    except Exception as err:
        logger.error(f"Error processing file transcription: {err}", exc_info=True)
        return {"error": str(err)}
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass


def format_timestamp_srt(seconds: float) -> str:
    hrs = int(seconds // 3600)
    mins = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int(round((seconds - int(seconds)) * 1000))
    return f"{hrs:02d}:{mins:02d}:{secs:02d},{millis:03d}"


def format_timestamp_vtt(seconds: float) -> str:
    hrs = int(seconds // 3600)
    mins = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int(round((seconds - int(seconds)) * 1000))
    return f"{hrs:02d}:{mins:02d}:{secs:02d}.{millis:03d}"


@app.post("/api/export-subtitles")
async def export_subtitles(payload: ExportRequest):
    segments = payload.segments
    fmt = payload.format.lower()

    if fmt == "vtt":
        output = ["WEBVTT\n"]
        for seg in segments:
            start_str = format_timestamp_vtt(seg.start)
            end_str = format_timestamp_vtt(seg.end)
            text = seg.translated or seg.original or ""
            output.append(f"{start_str} --> {end_str}\n{text}\n")
        content = "\n".join(output)
        media_type = "text/vtt"
        filename = "subtitles.vtt"
    elif fmt == "txt":
        output = [seg.translated or seg.original or "" for seg in segments]
        content = "\n\n".join(output)
        media_type = "text/plain"
        filename = "subtitles.txt"
    else:  # SRT
        output = []
        for idx, seg in enumerate(segments, 1):
            start_str = format_timestamp_srt(seg.start)
            end_str = format_timestamp_srt(seg.end)
            text = seg.translated or seg.original or ""
            output.append(f"{idx}\n{start_str} --> {end_str}\n{text}\n")
        content = "\n".join(output)
        media_type = "application/x-subrip"
        filename = "subtitles.srt"

    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )
